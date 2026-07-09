// api/_lib/bank-mirror/mirror.js
//
// Xoro → Tangerine bank reconciliation mirror.
//
// ── Why a register mirror and not an API pull ───────────────────────────
// All ROF bank accounts are reconciled IN XORO through 2026-05-31; Plaid is
// configured (P6-2: api/_lib/plaid, api/webhooks/plaid.js, bank-feed-sync)
// but not live. Xoro's REST API exposes NO bank-account, bank-transaction,
// deposit, payment or reconciliation endpoint under any private-app scope we
// hold — probed 2026-07-08 across ~30 path variants and all four credential
// pairs; the only cash-adjacent surface is bill/getbill's per-bill
// AmountPaid header (no payment date/account grain). The generic
// {"Message":"An error has occurred."} HTTP 500 is Xoro's out-of-scope
// signature (see memory project_xoro_integration).
//
// The richest bank-grain Xoro dataset we have is the Payments register
// export staged in ap_payment_import by #1668 (2,685 payment docs,
// 2024-07 → 2026-07, each carrying payment_number, SOURCE payment_date,
// the Xoro payment account — already resolved to a GL account — and the
// paid amount). Xoro reconciled these against the physical bank statements
// through 2026-05-31, so the register IS the reconciled bank activity.
// This module mirrors it into the P6 bank tables:
//
//   bank_accounts       one row per real account (3 Valley checking
//                       accounts, the AmEx/Chase credit cards, the
//                       Rosenthal factor-advance facility, Xoro's Cash
//                       Clearing box). "Bank Leumi" names in Xoro map to
//                       the VALLEY GL accounts (1001/1002/1003) — Leumi
//                       never gets its own account. Account numbers are
//                       masked to last-4 (no full numbers anywhere).
//   bank_transactions   source='xoro_mirror', external_txn_id =
//                       payment_number (stable → idempotent upsert),
//                       posted_date = SOURCE payment date (never import
//                       date), amount_cents signed (negative = money out).
//   bank_recon_runs     one row per (account, month), source='xoro_mirror';
//                       months ending on/before RECONCILED_THROUGH are
//                       marked reconciled when the mirror ties to the GL.
//
// ── Known one-sidedness (report it, don't hide it) ──────────────────────
// The register only carries PAYMENTS (money out). AR receipts (money in)
// exist in NO Tangerine table yet (ar_receipts is empty; the AR history
// driver posts invoices, not receipts), so both the mirror and the GL cash
// accounts are outflow-only and GL cash balances are large negatives.
// The mirror⇄GL tie-out below proves the two agree with each other; the
// missing-deposit side is quantified by the tie-out/report, and the Plaid
// feed (or an AR-receipts backfill) is what eventually fills it.
//
// ── Basis note ──────────────────────────────────────────────────────────
// The P6 bank_recon_compute RPC sums CASH-basis JEs, but every JE on the
// cash accounts is ACCRUAL (the posting engine does not emit CASH siblings
// for these flows), so this module computes GL balances itself on
// basis='ACCRUAL' and writes the run rows directly. The RPC still serves
// the operator's manual flow; a stray "Compute" click on a mirror-managed
// run is healed by the nightly resync.
//
// journal_entry_lines.debit/credit are numeric DOLLARS (v_trial_balance
// misnomer gotcha, #1665) — dollarsToCents at the boundary, integer cents
// everywhere else.

import { dollarsToCents } from "../accounting/tieouts.js";

/** Last month-end Xoro reconciled against physical bank statements. */
export const RECONCILED_THROUGH = "2026-05-31";

/** First GL period (Xoro opening-balance cutover month end 2024-08-31). */
export const MIRROR_START = "2024-08-01";

/**
 * Mirror account catalog, keyed by GL account code. xoro_names lists the
 * payment_account labels seen in the register (Xoro's "Bank Leumi" naming
 * maps to the Valley GL accounts — the CEO-confirmed rule).
 * kind 'other' = not a depository/CC account (factor facility, clearing box);
 * they are mirrored so every register row lands somewhere visible, but the
 * cash tie-out reports them as their own category.
 */
export const MIRROR_ACCOUNTS = [
  { code: "1001", kind: "checking", mask: "7801", institution: "Valley National Bank", tieout: "bank" },
  { code: "1002", kind: "checking", mask: "1300", institution: "Valley National Bank", tieout: "bank" },
  { code: "1003", kind: "checking", mask: "1500", institution: "Valley National Bank", tieout: "bank" },
  { code: "2101", kind: "credit_card", mask: null, institution: "American Express", tieout: "credit_card" },
  { code: "2102", kind: "credit_card", mask: null, institution: "American Express", tieout: "credit_card" },
  { code: "2103", kind: "credit_card", mask: null, institution: "American Express", tieout: "credit_card" },
  { code: "2104", kind: "credit_card", mask: "1007", institution: "American Express", tieout: "credit_card" },
  { code: "2105", kind: "credit_card", mask: null, institution: "Chase", tieout: "credit_card" },
  { code: "2106", kind: "credit_card", mask: null, institution: "Chase", tieout: "credit_card" },
  { code: "2107", kind: "credit_card", mask: null, institution: "Chase", tieout: "credit_card" },
  { code: "2108", kind: "credit_card", mask: "0031", institution: "Chase", tieout: "credit_card" },
  { code: "1051", kind: "other", mask: null, institution: "Rosenthal & Rosenthal", tieout: "factor" },
  { code: "1020", kind: "other", mask: null, institution: null, tieout: "clearing" },
];

/** GL codes the register maps to that are NOT bank-like — never mirrored. */
export const EXCLUDED_PAYMENT_GL_CODES = ["3004"]; // Opening Balance Equity

const PAGE = 1000; // PostgREST silent cap — always paginate.

export async function fetchAllPages(admin, buildQuery) {
  const out = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await buildQuery(admin).range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += rows.length;
  }
  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Last day of the month containing ISO date d (YYYY-MM-DD). */
export function monthEndISO(d) {
  const [y, m] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/**
 * Ensure a bank_accounts row exists per MIRROR_ACCOUNTS entry whose GL
 * account exists. Returns Map(gl_code → {bank_account row, gl account}).
 * Existing rows (any feed_source — e.g. a future Plaid link on the same GL
 * account) are reused, never duplicated: lookup is by gl_account_id.
 */
export async function ensureMirrorBankAccounts(admin, entityId) {
  const codes = MIRROR_ACCOUNTS.map((a) => a.code);
  const { data: gls, error: gErr } = await admin
    .from("gl_accounts")
    .select("id, code, name, normal_balance")
    .eq("entity_id", entityId)
    .in("code", codes);
  if (gErr) throw new Error(`gl_accounts read failed: ${gErr.message}`);
  const glByCode = new Map((gls || []).map((g) => [g.code, g]));

  const glIds = (gls || []).map((g) => g.id);
  const { data: existing, error: bErr } = await admin
    .from("bank_accounts")
    .select("id, gl_account_id, name, feed_source, account_kind, is_active")
    .eq("entity_id", entityId)
    .in("gl_account_id", glIds.length ? glIds : ["00000000-0000-0000-0000-000000000000"]);
  if (bErr) throw new Error(`bank_accounts read failed: ${bErr.message}`);
  const byGlId = new Map((existing || []).map((b) => [b.gl_account_id, b]));

  const out = new Map();
  for (const spec of MIRROR_ACCOUNTS) {
    const gl = glByCode.get(spec.code);
    if (!gl) continue; // chart doesn't have it — skip quietly, tie-out flags missing codes
    let bank = byGlId.get(gl.id);
    if (!bank) {
      const { data: created, error: cErr } = await admin
        .from("bank_accounts")
        .insert({
          entity_id: entityId,
          gl_account_id: gl.id,
          name: gl.name.replace(/\s+/g, " ").trim(),
          account_kind: spec.kind,
          institution_name: spec.institution,
          mask: spec.mask,
          feed_source: "xoro_mirror",
        })
        .select("id, gl_account_id, name, feed_source, account_kind, is_active")
        .single();
      if (cErr) throw new Error(`bank_accounts insert (${spec.code}) failed: ${cErr.message}`);
      bank = created;
    }
    out.set(spec.code, { spec, gl, bank });
  }
  return out;
}

/**
 * Upsert bank_transactions from the ap_payment_import register.
 * Idempotent on (bank_account_id, external_txn_id=payment_number). Only feed
 * columns are written — match state (status / matched_je_line_id) survives
 * re-runs. Zero-amount payment docs (credits-only applications) are skipped:
 * they never touched a bank.
 *
 * @returns {Promise<{upserted:number, skipped_zero:number, excluded:Array}>}
 */
export async function syncMirrorTransactions(admin, entityId, accounts) {
  const staging = await fetchAllPages(admin, (a) =>
    a
      .from("ap_payment_import")
      .select("payment_number, payment_date, vendor_name, payment_method, payment_account, paid_amount_cents, gl_account_id, je_id, status")
      .order("payment_number", { ascending: true }),
  );

  const accountByGlId = new Map();
  for (const { gl, bank, spec } of accounts.values()) accountByGlId.set(gl.id, { bank, spec });

  const rows = [];
  const excluded = [];
  let skippedZero = 0;
  for (const p of staging) {
    const cents = Math.round(Number(p.paid_amount_cents) || 0);
    if (cents === 0) { skippedZero += 1; continue; }
    const hit = p.gl_account_id ? accountByGlId.get(p.gl_account_id) : null;
    if (!hit) {
      excluded.push({ payment_number: p.payment_number, payment_account: p.payment_account, paid_cents: cents });
      continue;
    }
    rows.push({
      entity_id: entityId,
      bank_account_id: hit.bank.id,
      source: "xoro_mirror",
      external_txn_id: p.payment_number,
      posted_date: p.payment_date, // SOURCE date, never import date
      amount_cents: -cents, // register rows are payments = money out
      description: `Xoro payment ${p.payment_number} — ${p.vendor_name || "?"}`,
      merchant_name: p.vendor_name || null,
      category: hit.spec.tieout === "factor"
        ? ["xoro_payment", "factor_settlement"]
        : ["xoro_payment"],
      pending: false,
      raw_payload: {
        payment_number: p.payment_number,
        payment_method: p.payment_method,
        payment_account: p.payment_account,
        register_status: p.status,
        je_id: p.je_id,
      },
    });
  }

  let upserted = 0;
  for (const batch of chunk(rows, 500)) {
    const { error } = await admin
      .from("bank_transactions")
      .upsert(batch, { onConflict: "bank_account_id,external_txn_id" });
    if (error) throw new Error(`bank_transactions upsert failed: ${error.message}`);
    upserted += batch.length;
  }
  return { upserted, skipped_zero: skippedZero, excluded, staging_rows: staging.length };
}

/** All mirror bank_transactions for the entity (paginated). */
async function loadMirrorTxns(admin, entityId) {
  return fetchAllPages(admin, (a) =>
    a
      .from("bank_transactions")
      .select("id, bank_account_id, external_txn_id, posted_date, amount_cents, status, matched_je_line_id, raw_payload")
      .eq("entity_id", entityId)
      .eq("source", "xoro_mirror")
      .order("id", { ascending: true }),
  );
}

/** Posted ACCRUAL JE lines on one GL account (paginated, joined dates). */
async function loadGlLines(admin, entityId, glAccountId) {
  const rows = await fetchAllPages(admin, (a) =>
    a
      .from("journal_entry_lines")
      .select("id, journal_entry_id, debit, credit, journal_entries!inner(posting_date, status, basis, entity_id, source_table)")
      .eq("account_id", glAccountId)
      .eq("journal_entries.status", "posted")
      .eq("journal_entries.basis", "ACCRUAL")
      .eq("journal_entries.entity_id", entityId)
      .order("id", { ascending: true }),
  );
  return rows.map((r) => ({
    id: r.id,
    journal_entry_id: r.journal_entry_id,
    posting_date: r.journal_entries.posting_date,
    source_table: r.journal_entries.source_table,
    net_debit_cents: dollarsToCents(r.debit) - dollarsToCents(r.credit),
  }));
}

/**
 * Match mirror transactions to GL lines.
 *
 * Pass 1 — register linkage: each register payment already knows the JE the
 * AP backfill posted for it (raw_payload.je_id); the matching line is the
 * one on THIS account inside that JE with the same net amount. Confidence
 * 100.
 *
 * Pass 2 — amount + date window (±3 days): remaining unmatched txns vs GL
 * lines on the same account not consumed by any match. Confidence 90 same
 * day, 75 within window. This is the pass that will pick up AR-receipt JEs
 * once that backfill lands, and any manual JEs that mirror real bank moves.
 *
 * @returns match summary + the leftover GL-only lines (per account) so the
 * caller can report "books know about money the register doesn't".
 */
export async function runMirrorMatch(admin, entityId, accounts, { now = new Date().toISOString() } = {}) {
  const txns = await loadMirrorTxns(admin, entityId);
  const byAccount = new Map(); // bank_account_id → txns
  for (const t of txns) {
    if (!byAccount.has(t.bank_account_id)) byAccount.set(t.bank_account_id, []);
    byAccount.get(t.bank_account_id).push(t);
  }

  const summary = { pass1: 0, pass2: 0, already_matched: 0, unmatched: 0, amount_mismatches: [], gl_only: {} };
  const auditRows = [];

  for (const { spec, gl, bank } of accounts.values()) {
    const acctTxns = byAccount.get(bank.id) || [];
    if (!acctTxns.length) continue;
    const lines = await loadGlLines(admin, entityId, gl.id);
    const linesByJe = new Map();
    for (const l of lines) {
      if (!linesByJe.has(l.journal_entry_id)) linesByJe.set(l.journal_entry_id, []);
      linesByJe.get(l.journal_entry_id).push(l);
    }

    // Lines already consumed by previous runs.
    const consumed = new Set();
    for (const t of acctTxns) if (t.matched_je_line_id) consumed.add(t.matched_je_line_id);

    const updates = []; // {id, matched_je_line_id, match_confidence}

    // ── Pass 1: register JE linkage ────────────────────────────────────
    for (const t of acctTxns) {
      if (t.status !== "unmatched") { summary.already_matched += 1; continue; }
      const jeId = t.raw_payload?.je_id;
      if (!jeId) continue;
      const candidates = (linesByJe.get(jeId) || []).filter((l) => !consumed.has(l.id));
      // Bank txn amount −X (money out) ↔ JE line net CREDIT X on this account
      // (net_debit_cents = −X), i.e. the two carry the SAME signed value.
      const hit = candidates.find((l) => l.net_debit_cents === t.amount_cents);
      if (hit) {
        consumed.add(hit.id);
        updates.push({ id: t.id, matched_je_line_id: hit.id, match_confidence: 100 });
        t.status = "matched"; t.matched_je_line_id = hit.id;
        summary.pass1 += 1;
      } else if (candidates.length) {
        summary.amount_mismatches.push({
          account: spec.code, payment: t.external_txn_id, txn_cents: t.amount_cents,
          je_line_cents: candidates[0].net_debit_cents,
        });
      }
    }

    // ── Pass 2: amount + date window on the same account ───────────────
    const openLines = lines.filter((l) => !consumed.has(l.id));
    const bucket = new Map(); // amount_cents → [lines]
    for (const l of openLines) {
      const k = String(l.net_debit_cents);
      if (!bucket.has(k)) bucket.set(k, []);
      bucket.get(k).push(l);
    }
    const dayDiff = (a, b) => Math.abs(Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86_400_000));
    for (const t of acctTxns) {
      if (t.status !== "unmatched") continue;
      const cands = (bucket.get(String(t.amount_cents)) || []).filter((l) => !consumed.has(l.id));
      let best = null;
      let bestDelta = Infinity;
      for (const l of cands) {
        const d = dayDiff(l.posting_date, t.posted_date);
        if (d <= 3 && d < bestDelta) { best = l; bestDelta = d; }
      }
      if (best) {
        consumed.add(best.id);
        updates.push({ id: t.id, matched_je_line_id: best.id, match_confidence: bestDelta === 0 ? 90 : 75 });
        t.status = "matched"; t.matched_je_line_id = best.id;
        summary.pass2 += 1;
      }
    }

    summary.unmatched += acctTxns.filter((t) => t.status === "unmatched").length;

    // GL lines with no register counterpart (the books-only side).
    const glOnly = lines.filter((l) => !consumed.has(l.id));
    if (glOnly.length) {
      summary.gl_only[spec.code] = {
        n: glOnly.length,
        net_debit_cents: glOnly.reduce((s, l) => s + l.net_debit_cents, 0),
        sample: glOnly.slice(0, 5).map((l) => ({ je: l.journal_entry_id, date: l.posting_date, cents: l.net_debit_cents, src: l.source_table })),
      };
    }

    // Persist matches + audit trail.
    for (const u of updates) {
      const { error } = await admin
        .from("bank_transactions")
        .update({
          status: "matched",
          matched_je_line_id: u.matched_je_line_id,
          matched_at: now,
          match_confidence: u.match_confidence,
        })
        .eq("id", u.id)
        .eq("status", "unmatched"); // never clobber operator work
      if (error) throw new Error(`bank_transactions match update failed: ${error.message}`);
      auditRows.push({
        entity_id: entityId,
        bank_transaction_id: u.id,
        action: "match",
        je_line_id: u.matched_je_line_id,
        notes: `auto: xoro_mirror ${u.match_confidence === 100 ? "register JE linkage" : "amount+date window"} (confidence ${u.match_confidence})`,
      });
    }
  }

  for (const batch of chunk(auditRows, 500)) {
    const { error } = await admin.from("bank_match_audit").insert(batch);
    if (error) throw new Error(`bank_match_audit insert failed: ${error.message}`);
  }
  return summary;
}

/**
 * Upsert one bank_recon_runs row per (mirror account, month) from MIRROR_START
 * through the current month.
 *
 * Sign convention follows the P6 RPC: balances are reported on the account's
 * NORMAL side (DEBIT-normal: DR−CR; CREDIT-normal: CR−DR) so a credit-card
 * balance reads as positive-owed. The "statement" side is the mirror running
 * total under the same convention. diff = gl + uncleared − statement (P6
 * formula): a txn the GL missed is in both statement and uncleared → cancels;
 * residual diff = books-only lines or amount drift.
 *
 * Months ending ≤ RECONCILED_THROUGH: status reconciled when diff=0 else
 * flagged (Xoro reconciled these against physical statements — a nonzero
 * diff means Tangerine's GL disagrees with the register, which the operator
 * must see, not have painted over). Later months stay in_progress.
 * Runs with source='manual' (operator-owned) are never touched.
 */
export async function computeMirrorReconRuns(admin, entityId, accounts, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const periods = await fetchAllPages(admin, (a) =>
    a
      .from("gl_periods")
      .select("id, starts_on, ends_on")
      .eq("entity_id", entityId)
      .gte("starts_on", MIRROR_START)
      .lte("starts_on", today)
      .order("starts_on", { ascending: true }),
  );

  const txns = await loadMirrorTxns(admin, entityId);
  const txnsByAccount = new Map();
  for (const t of txns) {
    if (!txnsByAccount.has(t.bank_account_id)) txnsByAccount.set(t.bank_account_id, []);
    txnsByAccount.get(t.bank_account_id).push(t);
  }

  const existing = await fetchAllPages(admin, (a) =>
    a
      .from("bank_recon_runs")
      .select("id, bank_account_id, period_id, source, status")
      .eq("entity_id", entityId)
      .order("id", { ascending: true }),
  );
  const existingByKey = new Map(existing.map((r) => [`${r.bank_account_id}|${r.period_id}`, r]));

  const out = { upserted: 0, reconciled: 0, flagged: 0, in_progress: 0, skipped_manual: 0, rows: [] };

  for (const { spec, gl, bank } of accounts.values()) {
    const sign = gl.normal_balance === "CREDIT" ? -1 : 1;
    const acctTxns = (txnsByAccount.get(bank.id) || []).sort((a, b) => (a.posted_date < b.posted_date ? -1 : 1));
    const lines = (await loadGlLines(admin, entityId, gl.id)).sort((a, b) => (a.posting_date < b.posting_date ? -1 : 1));

    for (const p of periods) {
      const key = `${bank.id}|${p.id}`;
      const prior = existingByKey.get(key);
      if (prior && prior.source === "manual") { out.skipped_manual += 1; continue; }

      const end = p.ends_on;
      let stmt = 0, unc = 0, glc = 0;
      for (const t of acctTxns) {
        if (t.posted_date > end) break;
        stmt += sign * t.amount_cents;
        if (t.status === "unmatched") unc += sign * t.amount_cents;
      }
      for (const l of lines) {
        if (l.posting_date > end) break;
        glc += sign * l.net_debit_cents;
      }
      const diff = glc + unc - stmt;
      const closedMonth = end <= RECONCILED_THROUGH;
      const status = !closedMonth ? "in_progress" : diff === 0 ? "reconciled" : "flagged";

      const row = {
        entity_id: entityId,
        bank_account_id: bank.id,
        period_id: p.id,
        bank_statement_balance_cents: stmt,
        gl_balance_cents: glc,
        uncleared_txn_cents: unc,
        reconciled_diff_cents: diff,
        status,
        source: "xoro_mirror",
        notes: closedMonth
          ? `Xoro mirror: register reconciled in Xoro through ${RECONCILED_THROUGH}${diff !== 0 ? `; GL disagrees by ${(diff / 100).toFixed(2)} — see gap report` : ""}`
          : "Xoro mirror: open month (post Xoro-reconciliation window)",
        reconciled_at: status === "reconciled" ? new Date().toISOString() : null,
      };
      const { error } = await admin
        .from("bank_recon_runs")
        .upsert(row, { onConflict: "bank_account_id,period_id" });
      if (error) throw new Error(`bank_recon_runs upsert (${spec.code} ${end}) failed: ${error.message}`);
      out.upserted += 1;
      out[status === "reconciled" ? "reconciled" : status === "flagged" ? "flagged" : "in_progress"] += 1;
      out.rows.push({ code: spec.code, month_end: end, stmt_cents: stmt, gl_cents: glc, uncleared_cents: unc, diff_cents: diff, status });
    }
  }
  return out;
}

/**
 * Full mirror pipeline: ensure accounts → sync txns → match → recon runs.
 * Used by scripts/import-xoro-bank-history.mjs and the nightly cron.
 */
export async function runFullMirrorSync(admin, { entityId, today } = {}) {
  if (!entityId) {
    const { data: entity, error } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    if (error || !entity) throw new Error("Default entity (ROF) not found");
    entityId = entity.id;
  }
  const accounts = await ensureMirrorBankAccounts(admin, entityId);
  const sync = await syncMirrorTransactions(admin, entityId, accounts);
  const match = await runMirrorMatch(admin, entityId, accounts);
  const recon = await computeMirrorReconRuns(admin, entityId, accounts, today ? { today } : {});
  return {
    entity_id: entityId,
    accounts: [...accounts.values()].map(({ spec, bank }) => ({ code: spec.code, bank_account_id: bank.id, name: bank.name })),
    sync,
    match,
    recon: { ...recon, rows: undefined },
    recon_rows: recon.rows,
  };
}
