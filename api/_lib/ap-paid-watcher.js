// api/_lib/ap-paid-watcher.js
//
// AP AmountPaid delta-watcher core — the go-forward guard for the #1668 AP
// history backfill (GL 2000 = Bills-register Σ Amount Due, to the cent).
//
// FEED MODE: register-comparison. The live Xoro bill feed (rest_ap_sync.py →
// /api/ap/sync-bills, bill/getbill) carries only a DERIVED Paid/Partial/Unpaid
// status — no AmountPaid amounts, no payment dates, no payment accounts — and
// it deliberately skips register-backfilled invoices (source
// 'xoro_bills_register' is frozen). Paid-amount truth therefore only arrives
// via the manual Bills-register + Payments exports (import-bills-register.mjs
// + the payments staging), which the CEO re-exports at cutover. This watcher
// compares the LATEST imported staging state against what is posted and
// processes the deltas — so a fresh register/payments import lands in the GL
// automatically on the next nightly run (or an immediate manual trigger).
//
// What a run does (all idempotent — re-runs post nothing new):
//   1. Payments: ap_payment_import rows without a JE and with cash applied
//      post exactly like #1668 phasePayments — DR 2000 (vendor subledger) /
//      CR the mapped payment account @ Paid Amount, journal_type
//      'ap_payment_historical', dated to the SOURCE payment_date (clamped to
//      the 2024-08-31 opening cutover). JE key: (ap_payment_import,
//      payment_number) — shared with the #1668 script, so either can run
//      first and the other heals/skips. Zero-cash payment docs get no JE
//      (their GL effect is the bill-level relief), matching #1668.
//   2. Relief deltas: per register bill, discounts+vendor credits → 5005 and
//      prepayments applied → 1308 beyond what previous relief JEs posted go
//      out as an incremental relief JE (DR 2000 / CR 5005 / CR 1308,
//      journal_type 'ap_relief_historical', dated to the bill's Modified
//      date — the register's application-date proxy, per #1668).
//      invoices.paid_amount_cents is re-aligned to (total − due) so the
//      06:00 subledger tie-out compares GL against the FRESH register state.
//   3. Anomalies (alerted; only header_drift_repaired is auto-fixed):
//        paid_decreased      register Amount Paid went DOWN vs the baseline
//        total_changed       REGISTER total moved vs the processed baseline
//                            (needs the post-bills-register `deltas` phase;
//                            auto-clears once invoices.total_amount_cents
//                            matches the new register total)
//        header_drift_repaired  the FROZEN invoice header was rewritten by
//                            something else while the register total is
//                            unchanged (2026-07-12: the Xoro-account-truth
//                            enrich window rewrote 2,679 headers to REST
//                            line-sums, collapsing the AP subledger by
//                            $10.13M while GL 2000 stayed correct) — the
//                            watcher restores the header to the register
//                            total (GL truth) and reports it; no JE.
//        relief_decreased    discounts/credits/prepayments went DOWN
//        new_bill            register row never accrued (fresh-import bill —
//                            run the post-bills-register phases / AP sweep)
//        payment_unresolved  cash payment doc without vendor or GL account
//        vendor_cash_drift   register Σ Amount Paid − posted payment cash −
//                            posted 8002 residuals ≠ 0 for a vendor (e.g. a
//                            register landed without its Payments export).
//                            Stateless — re-alerts nightly until resolved.
//                            While a vendor drifts, its bills' paid baselines
//                            do NOT advance and their invoices keep the
//                            uncovered cash slice OPEN — the subledger only
//                            ever moves atomically with the GL.
//   4. Run log: one ap_paid_watcher_runs row per run (drives the Sync Health
//      'ap_paid_watcher' feed row).
//
// Dates are ALWAYS source dates (payment_date / modified_date / bill_date),
// never today — non-negotiable (feedback_xoro_date_matches_source).

const CUTOVER = "2024-08-31"; // Xoro opening-balance date; no GL periods before
const clampDate = (d) => (d && d < CUTOVER ? CUTOVER : d);

const dollars = (cents) => {
  const neg = cents < 0; const abs = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};
const usd = (cents) => `$${((cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function fetchAll(admin, table, select, mod = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select(select).range(from, from + 999);
    q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// Signed JE line helper (post-bills-register convention): cents>0 → debit,
// cents<0 → credit. Skips zero lines.
function addSigned(lines, account_id, cents, memo, vendorId) {
  if (!cents) return;
  lines.push({
    line_number: lines.length + 1,
    account_id,
    debit: cents > 0 ? dollars(cents) : "0",
    credit: cents < 0 ? dollars(-cents) : "0",
    memo,
    ...(vendorId ? { subledger_type: "vendor", subledger_id: vendorId } : {}),
  });
}

// Post via gl_post_journal_entry; a uq_je_source_basis duplicate heals by
// adopting the existing JE (idempotent re-runs / crash recovery).
async function postJe(admin, payload) {
  const { data: jeId, error } = await admin.rpc("gl_post_journal_entry", { payload });
  if (!error) return { jeId };
  if (/duplicate key|uq_je_source/i.test(error.message || "")) {
    const { data: existing } = await admin.from("journal_entries").select("id")
      .eq("source_table", payload.source_table).eq("source_id", payload.source_id)
      .eq("basis", "ACCRUAL").maybeSingle();
    if (existing) return { jeId: existing.id, healed: true };
  }
  return { error: error.message };
}

async function loadContext(admin) {
  const { data: entity, error: eErr } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (eErr || !entity) throw new Error("ROF entity not found");
  const codes = ["2000", "5005", "1308"];
  const { data: accts, error: aErr } = await admin.from("gl_accounts")
    .select("id, code").eq("entity_id", entity.id).in("code", codes);
  if (aErr) throw new Error(aErr.message);
  const acct = Object.fromEntries((accts || []).map((a) => [a.code, a.id]));
  for (const c of codes) if (!acct[c]) throw new Error(`GL account ${c} missing`);
  return { entity_id: entity.id, acct };
}

// runApPaidWatcher(admin, { dryRun }) → result summary. Never throws for
// per-row problems (collected into result.errors / result.anomalies); throws
// only on unusable context (missing entity/accounts/tables).
export async function runApPaidWatcher(admin, { dryRun = false } = {}) {
  const ctx = await loadContext(admin);
  const result = {
    entity_id: ctx.entity_id,
    mode: "register-comparison",
    dry_run: dryRun,
    bills_checked: 0,
    payments_posted: 0,
    payments_posted_cents: 0,
    relief_posted: 0,
    relief_posted_cents: 0,
    paid_delta_bills: 0,
    paid_delta_cents: 0,
    paid_delta_pending: 0,
    paid_delta_pending_cents: 0,
    headers_repaired: 0,
    invoices_realigned: 0,
    baselines_initialized: 0,
    anomalies: [],
    errors: [],
  };
  const anomaly = (type, detail) => result.anomalies.push({ type, ...detail });

  // ── 1. Payments: post held cash payment docs (phasePayments semantics) ────
  const pays = (await fetchAll(admin, "ap_payment_import",
    "payment_number, payment_date, vendor_name, vendor_id, gl_account_id, payment_account, amount_cents, paid_amount_cents, je_id"))
    .sort((a, b) => (a.payment_date < b.payment_date ? -1 : a.payment_date > b.payment_date ? 1 : a.payment_number < b.payment_number ? -1 : 1));

  for (const p of pays) {
    if (p.je_id) continue;
    const applied = Number(p.paid_amount_cents) || 0;
    if (applied === 0) continue; // zero-cash doc: relief posts at bill level (#1668)
    if (!p.vendor_id || !p.gl_account_id) {
      anomaly("payment_unresolved", { payment_number: p.payment_number, vendor_name: p.vendor_name, cents: applied });
      continue;
    }
    if (dryRun) { result.payments_posted++; result.payments_posted_cents += applied; continue; }
    const posting_date = clampDate(p.payment_date);
    const lines = [];
    addSigned(lines, ctx.acct["2000"], applied, `Payment ${p.payment_number} — ${p.vendor_name}`, p.vendor_id);
    addSigned(lines, p.gl_account_id, -applied, `Cash out — ${p.payment_account} — payment ${p.payment_number}`);
    const r = await postJe(admin, {
      entity_id: ctx.entity_id,
      basis: "ACCRUAL",
      journal_type: "ap_payment_historical",
      posting_date,
      source_module: "ap",
      source_table: "ap_payment_import",
      source_id: p.payment_number,
      description: `AP payment ${p.payment_number} — ${p.vendor_name}`,
      audit_reason: `AP paid-delta watcher — payment ${p.payment_number}: cash ${usd(applied)} from ${p.payment_account} relieves 2000 (vendor subledger), dated to the source payment date${posting_date !== p.payment_date ? ` (payment date ${p.payment_date} pre-cutover, posted at opening ${CUTOVER})` : ""}. Non-cash slice posts at bill level from the register.`,
      lines,
    });
    if (r.error) { result.errors.push({ payment_number: p.payment_number, error: r.error }); continue; }
    const { error: uErr } = await admin.from("ap_payment_import").update({ je_id: r.jeId }).eq("payment_number", p.payment_number);
    if (uErr) { result.errors.push({ payment_number: p.payment_number, error: `JE ${r.jeId} posted but je_id update failed: ${uErr.message}` }); continue; }
    result.payments_posted++; result.payments_posted_cents += applied;
  }

  // ── 2. Register bills: relief deltas + paid-baseline movement ─────────────
  const bills = await fetchAll(admin, "ap_bill_register_import",
    "id, bill_number, bill_date, modified_date, status, vendor_id, vendor_name, invoice_id, accrual_je_id, relief_je_id, skip_reason, total_cents, paid_cents, due_cents, discounts_cents, credits_cents, vendor_credits_cents, prepayments_cents, paid_processed_cents, total_processed_cents, relief_5005_processed_cents, relief_1308_processed_cents",
    (q) => q.order("bill_number", { ascending: true }));

  // Posted invoice totals, for total-change detection + paid re-alignment.
  const invByNumber = new Map();
  const invById = new Map();
  for (const inv of await fetchAll(admin, "invoices",
    "id, invoice_number, source, gl_status, total_amount_cents, paid_amount_cents",
    (q) => q.in("source", ["xoro_ap", "xoro_bills_register"]).order("id", { ascending: true }))) {
    invById.set(inv.id, inv);
    // by-number is a fallback only — zero-total xoro_ap stubs share bill
    // numbers with register bills (2026-07-12 false-anomaly storm), so the
    // staging row's invoice_id linkage always wins.
    if (!invByNumber.has(inv.invoice_number) || inv.source === "xoro_bills_register") {
      invByNumber.set(inv.invoice_number, inv);
    }
  }

  // ── 2a. Per-vendor cash drift (stateless; re-alerts until resolved) ───────
  // register Σ Amount Paid − posted payment-doc cash − posted 8002 residuals
  // must be 0 per vendor. Non-zero = payments export missing/incomplete for
  // that vendor. Computed BEFORE the bill loop because paid-state may only
  // move ATOMICALLY with the GL: bills of drifted vendors keep their paid
  // baseline and their invoices keep the uncovered cash slice OPEN until the
  // cash actually posts (2026-07-12 follow-up hardening).
  const driftByVendor = new Map();
  try {
    const regPaid = new Map(), payCash = new Map(), resid = new Map();
    for (const b of bills) if (b.vendor_id) regPaid.set(b.vendor_id, (regPaid.get(b.vendor_id) || 0) + (Number(b.paid_cents) || 0));
    if (dryRun) {
      // Count rows that HAVE a JE plus rows step 1 would have posted.
      for (const p of pays) {
        const wouldPost = !p.je_id && (Number(p.paid_amount_cents) || 0) > 0 && p.vendor_id && p.gl_account_id;
        if ((p.je_id || wouldPost) && p.vendor_id) payCash.set(p.vendor_id, (payCash.get(p.vendor_id) || 0) + (Number(p.paid_amount_cents) || 0));
      }
    } else {
      // Re-read: the in-memory `pays` rows don't reflect step 1's je_id writes.
      const fresh = await fetchAll(admin, "ap_payment_import", "vendor_id, paid_amount_cents", (q) => q.not("je_id", "is", null));
      for (const p of fresh) if (p.vendor_id) payCash.set(p.vendor_id, (payCash.get(p.vendor_id) || 0) + (Number(p.paid_amount_cents) || 0));
    }
    const residJes = await fetchAll(admin, "journal_entries", "id, source_id",
      (q) => q.eq("source_table", "ap_bill_register_import").eq("basis", "ACCRUAL").like("source_id", "residual:%").eq("status", "posted"));
    if (residJes.length) {
      const lines = await fetchAll(admin, "journal_entry_lines", "journal_entry_id, account_id, debit, credit, subledger_id",
        (q) => q.in("journal_entry_id", residJes.map((j) => j.id)).eq("account_id", ctx.acct["2000"]));
      for (const l of lines) {
        const cents = Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100);
        if (l.subledger_id) resid.set(l.subledger_id, (resid.get(l.subledger_id) || 0) + cents);
      }
    }
    for (const [v, cents] of regPaid) {
      const drift = cents - (payCash.get(v) || 0) - (resid.get(v) || 0);
      if (drift !== 0) driftByVendor.set(v, drift);
    }
    if (driftByVendor.size) {
      const ids = [...driftByVendor.keys()].slice(0, 100);
      const { data: vnames } = await admin.from("vendors").select("id, name").in("id", ids);
      const nameById = new Map((vnames || []).map((v) => [v.id, v.name]));
      for (const [v, cents] of driftByVendor) anomaly("vendor_cash_drift", { vendor_name: nameById.get(v) || v, drift_cents: cents });
    }
  } catch (e) {
    result.errors.push({ error: `vendor cash-drift check failed: ${e?.message || String(e)}` });
  }

  for (const b of bills) {
    result.bills_checked++;
    const n = (v) => Number(v) || 0;

    if (!b.vendor_id) { anomaly("new_bill", { bill_number: b.bill_number, vendor_name: b.vendor_name, reason: "no vendor_id — re-run import with --create-vendors" }); continue; }

    // Never-baselined row = bill from a fresh register import.
    if (b.paid_processed_cents == null) {
      if (!b.accrual_je_id && b.skip_reason !== "zero_total") {
        anomaly("new_bill", { bill_number: b.bill_number, vendor_name: b.vendor_name, total_cents: n(b.total_cents), reason: "never accrued — run post-bills-register link-invoices + accruals (or let the xoro_ap sweep post it), then re-run the watcher" });
        continue;
      }
      // Just accrued by the script/sweep: initialize baselines from posted state.
      b.paid_processed_cents = n(b.paid_cents);
      b.total_processed_cents = n(b.total_cents);
      b.relief_5005_processed_cents = b.relief_je_id ? n(b.discounts_cents) + n(b.vendor_credits_cents) : 0;
      b.relief_1308_processed_cents = b.relief_je_id ? n(b.prepayments_cents) : 0;
      if (!dryRun) {
        const { error } = await admin.from("ap_bill_register_import").update({
          paid_processed_cents: b.paid_processed_cents,
          total_processed_cents: b.total_processed_cents,
          relief_5005_processed_cents: b.relief_5005_processed_cents,
          relief_1308_processed_cents: b.relief_1308_processed_cents,
        }).eq("id", b.id);
        if (error) { result.errors.push({ bill_number: b.bill_number, error: `baseline init failed: ${error.message}` }); continue; }
      }
      result.baselines_initialized++;
    }

    // The staging row's invoice_id linkage is authoritative; by-number is a
    // fallback for rows linked before invoice_id was stamped.
    const inv = (b.invoice_id && invById.get(b.invoice_id)) || invByNumber.get(b.bill_number);

    // Total drift — two distinct cases:
    //   (a) REGISTER-side change (fresh import changed the bill total vs the
    //       processed baseline): the GL accrual is stale → alert; needs the
    //       post-bills-register `deltas` phase (true-up JE + invoice
    //       alignment). Auto-clears once invoices.total_amount_cents matches
    //       the new register total (deltas ran), adopting the new baseline.
    //   (b) INVOICE-side corruption (register total unchanged but the frozen
    //       invoice header was rewritten — 2026-07-12: the Xoro-account-truth
    //       enrich window rewrote 2,679 headers to REST line-sums, collapsing
    //       the AP subledger by $10.13M while the GL stayed right): the GL is
    //       correct → AUTO-REPAIR the header back to the register total and
    //       report it loudly (header_drift_repaired) so recurrence is visible.
    if (n(b.total_cents) !== n(b.total_processed_cents)) {
      if (inv && n(inv.total_amount_cents) === n(b.total_cents)) {
        // deltas phase already re-aligned the GL/invoice → adopt new baseline.
        if (!dryRun) {
          const { error } = await admin.from("ap_bill_register_import").update({ total_processed_cents: n(b.total_cents) }).eq("id", b.id);
          if (error) { result.errors.push({ bill_number: b.bill_number, error: `total baseline adopt failed: ${error.message}` }); continue; }
        }
        b.total_processed_cents = n(b.total_cents);
      } else {
        anomaly("total_changed", { bill_number: b.bill_number, vendor_name: b.vendor_name, register_cents: n(b.total_cents), processed_cents: n(b.total_processed_cents), invoice_cents: inv ? n(inv.total_amount_cents) : null });
        continue;
      }
    } else if (inv && inv.gl_status === "posted" && n(inv.total_amount_cents) !== n(b.total_cents)) {
      const wasCents = n(inv.total_amount_cents);
      if (!dryRun) {
        const { error } = await admin.from("invoices").update({
          total_amount_cents: n(b.total_cents),
          subtotal: Number(dollars(n(b.total_cents))),
          total: Number(dollars(n(b.total_cents))),
        }).eq("id", inv.id);
        if (error) { result.errors.push({ bill_number: b.bill_number, error: `header repair failed: ${error.message}` }); continue; }
      }
      inv.total_amount_cents = n(b.total_cents);
      result.headers_repaired++;
      anomaly("header_drift_repaired", { bill_number: b.bill_number, vendor_name: b.vendor_name, register_cents: n(b.total_cents), was_cents: wasCents, auto_fixed: true });
    }

    // Relief deltas (register application state beyond what relief JEs posted).
    const target5005 = n(b.discounts_cents) + n(b.vendor_credits_cents);
    const target1308 = n(b.prepayments_cents);
    const d5005 = target5005 - n(b.relief_5005_processed_cents);
    const d1308 = target1308 - n(b.relief_1308_processed_cents);
    if (d5005 < 0 || d1308 < 0) {
      anomaly("relief_decreased", { bill_number: b.bill_number, vendor_name: b.vendor_name, d5005_cents: d5005, d1308_cents: d1308 });
      continue;
    }
    if (d5005 + d1308 > 0) {
      const posting_date = clampDate(b.modified_date || b.bill_date);
      const firstRelief = !b.relief_je_id;
      // First relief on a bill uses the #1668 phaseRelief key (staging id) so
      // the script and the watcher stay mutually idempotent; increments get a
      // key that encodes the cumulative target (stable per register state).
      const source_id = firstRelief ? b.id : `reliefdelta:${b.id}:${target5005 + target1308}`;
      if (!dryRun) {
        const lines = [];
        addSigned(lines, ctx.acct["2000"], d5005 + d1308, `AP relief — bill ${b.bill_number} (discounts/credits/prepayments applied)`, b.vendor_id);
        addSigned(lines, ctx.acct["5005"], -d5005, `Discounts + vendor credits — bill ${b.bill_number}`);
        addSigned(lines, ctx.acct["1308"], -d1308, `Prepayments applied — bill ${b.bill_number}`);
        const r = await postJe(admin, {
          entity_id: ctx.entity_id,
          basis: "ACCRUAL",
          journal_type: "ap_relief_historical",
          posting_date,
          source_module: "ap",
          source_table: "ap_bill_register_import",
          source_id,
          description: `AP non-payment relief — bill ${b.bill_number}${firstRelief ? "" : " (register delta)"}`,
          audit_reason: `AP paid-delta watcher — register shows ${usd(d5005)} discounts/vendor credits and ${usd(d1308)} prepayments applied on bill ${b.bill_number} beyond what relief JEs posted. DR 2000 (vendor subledger) / CR 5005 / CR 1308, dated to the bill Modified date (application-date proxy, per #1668).`,
          lines,
        });
        if (r.error) { result.errors.push({ bill_number: b.bill_number, error: r.error }); continue; }
        const patch = {
          relief_5005_processed_cents: target5005,
          relief_1308_processed_cents: target1308,
          ...(firstRelief ? { relief_je_id: r.jeId } : {}),
        };
        const { error: uErr } = await admin.from("ap_bill_register_import").update(patch).eq("id", b.id);
        if (uErr) { result.errors.push({ bill_number: b.bill_number, error: `relief JE ${r.jeId} posted but baseline update failed: ${uErr.message}` }); continue; }
      }
      result.relief_posted++; result.relief_posted_cents += d5005 + d1308;
    }

    // AmountPaid movement vs baseline. Cash itself posts from payment docs
    // (step 1). ATOMICITY (2026-07-12 hardening): the subledger may only move
    // with the GL — if the vendor's cash drift is non-zero (payments export
    // missing/incomplete), the paid baseline does NOT advance and the
    // invoice keeps the uncovered cash slice OPEN; the drift anomaly nags
    // nightly until the payments land, then everything advances together.
    const vendorDrift = driftByVendor.get(b.vendor_id) || 0;
    const dPaid = n(b.paid_cents) - n(b.paid_processed_cents);
    if (dPaid < 0) {
      anomaly("paid_decreased", { bill_number: b.bill_number, vendor_name: b.vendor_name, register_cents: n(b.paid_cents), baseline_cents: n(b.paid_processed_cents) });
      continue;
    }
    if (dPaid > 0) {
      if (vendorDrift !== 0) {
        result.paid_delta_pending++; result.paid_delta_pending_cents += dPaid;
      } else {
        result.paid_delta_bills++; result.paid_delta_cents += dPaid;
        if (!dryRun) {
          const { error } = await admin.from("ap_bill_register_import").update({ paid_processed_cents: n(b.paid_cents) }).eq("id", b.id);
          if (error) { result.errors.push({ bill_number: b.bill_number, error: `paid baseline update failed: ${error.message}` }); continue; }
        }
      }
    }

    // Re-align the AP subledger to the register (invoices open = Amount Due),
    // exactly like #1668 link-invoices, so the 06:00 tie-out checks GL
    // against FRESH register state — but only to the extent the GL actually
    // moved: the uncovered cash slice (dPaid while the vendor drifts) stays
    // open. Source dates only (modified/bill date).
    if (inv && !dryRun) {
      const uncovered = vendorDrift !== 0 ? dPaid : 0;
      const paidAmt = n(b.total_cents) - n(b.due_cents) - uncovered;
      if (n(inv.paid_amount_cents) !== paidAmt) {
        const fullyCovered = uncovered === 0;
        const { error } = await admin.from("invoices").update({
          paid_amount_cents: paidAmt,
          status: b.status === "Paid" && fullyCovered ? "paid" : "approved",
          paid_at: b.status === "Paid" && fullyCovered ? (b.modified_date || b.bill_date) : null,
        }).eq("id", inv.id);
        if (error) result.errors.push({ bill_number: b.bill_number, error: `invoice re-align failed: ${error.message}` });
        else result.invoices_realigned++;
      }
    }
  }

  // ── 3. Run log (Sync Health freshness) ────────────────────────────────────
  if (!dryRun) {
    const { error } = await admin.from("ap_paid_watcher_runs").insert({
      entity_id: ctx.entity_id,
      status: result.errors.length ? "error" : result.anomalies.length ? "anomalies" : "ok",
      bills_checked: result.bills_checked,
      payments_posted: result.payments_posted,
      payments_posted_cents: result.payments_posted_cents,
      relief_posted: result.relief_posted,
      relief_posted_cents: result.relief_posted_cents,
      paid_delta_bills: result.paid_delta_bills,
      paid_delta_cents: result.paid_delta_cents,
      anomalies: result.anomalies.length,
      details: {
        invoices_realigned: result.invoices_realigned,
        baselines_initialized: result.baselines_initialized,
        headers_repaired: result.headers_repaired,
        paid_delta_pending: result.paid_delta_pending,
        paid_delta_pending_cents: result.paid_delta_pending_cents,
        anomalies: result.anomalies.slice(0, 50),
        errors: result.errors.slice(0, 50),
      },
    });
    if (error) result.errors.push({ error: `run-log insert failed: ${error.message}` });
  }

  return result;
}

export const __test_only__ = { clampDate, dollars, addSigned };
