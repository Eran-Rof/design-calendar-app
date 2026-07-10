#!/usr/bin/env node
// AP bill-history posting driver: turns the staged Bills register
// (ap_bill_register_import, see scripts/import-bills-register.mjs) plus the
// held payments staging (ap_payment_import) into a complete, tied-out AP
// history in the GL.
//
// Usage:
//   node scripts/post-bills-register.mjs <phase> [--dry-run] [--limit=N]
// Phases (run in order):
//   reconcile      report staged vs invoices vs payments — NO writes
//   link-invoices  upsert invoices rows (source 'xoro_bills_register'), link staging
//   accruals       post per-bill accrual JEs, oldest first
//   deltas         true-up #1662-posted bills to the register header totals
//   relief         post discount/credit/prepayment relief JEs
//   payments       post the held payment JEs from ap_payment_import
//   residuals      per-vendor paid-vs-payments residual adjustments (8002)
//   verify         GL 2000 vs register target + per-vendor + tie-out engine
//
// Accounting model (documented in docs/tangerine/user-guide/13-accounts-payable.md):
//   accrual   DR 1201 (Suppliers/Manufacturer) | vendor default expense | 8007
//             CR 2000 (subledger vendor)                    @ Total Amount
//   relief    DR 2000 (vendor)  CR 5005 (discounts + vendor credits)
//                               CR 1308 (prepayments applied)
//   payment   DR 2000 (vendor)  CR mapped payment account   @ Paid Amount
//             (cash only — Σ(Amount − Paid) over payments ≡ Σ relief over
//              bills to the cent, so the non-cash slice posts at bill level;
//              zero-cash payment docs get no JE)
//   residual  DR/CR 2000 (vendor) vs 8002 for Σbills.paid − Σpayments.paid
//
// Dates: JE dates = SOURCE dates (bill date / payment date / modified date),
// clamped to the 2024-08-31 opening cutover — no GL periods exist before
// 2024-08 and the entity hard-lock sits at 2024-07-31. No opening-balance JE
// exists for 2000, so pre-cutover open bills accrue AT 2024-08-31.
//
// Idempotency: every JE carries a stable (source_table, source_id, basis)
// key enforced by uq_je_source_basis — reruns skip already-posted work, and a
// duplicate-key race heals by adopting the existing JE.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) { console.error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CUTOVER = "2024-08-31";          // Xoro opening-balance date
const EXPORT_DATE = "2026-07-08";      // register + payments export date
const clampDate = (d) => (d && d < CUTOVER ? CUTOVER : d);
const $ = (c) => ((c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (cents) => {
  const neg = cents < 0; const abs = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

async function fetchAll(table, select, mod = (q) => q) {
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

async function loadContext() {
  const { data: entity, error: eErr } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (eErr || !entity) throw new Error("ROF entity not found");
  const codes = ["1201", "8007", "2000", "5005", "1308", "8002"];
  const { data: accts, error: aErr } = await admin.from("gl_accounts")
    .select("id, code, name").eq("entity_id", entity.id).in("code", codes);
  if (aErr) throw new Error(aErr.message);
  const byCode = new Map((accts || []).map((a) => [a.code, a.id]));
  for (const c of codes) if (!byCode.get(c)) throw new Error(`GL account ${c} missing`);
  return { entity_id: entity.id, acct: Object.fromEntries(codes.map((c) => [c, byCode.get(c)])) };
}

const loadStaging = () => fetchAll("ap_bill_register_import", "*", (q) => q.order("bill_number", { ascending: true }));
const loadPayments = () => fetchAll("ap_payment_import", "*", (q) => q.order("payment_number", { ascending: true }));
const loadInvoicesByNumber = async () => {
  const rows = await fetchAll("invoices", "id, invoice_number, vendor_id, source, gl_status, total_amount_cents, paid_amount_cents, accrual_je_id", (q) => q.order("id", { ascending: true }));
  return new Map(rows.map((r) => [r.invoice_number, r]));
};

// Signed JE line helper: cents>0 → debit, cents<0 → credit. Skips zero.
function addSigned(lines, account_id, cents, memo, subledger) {
  if (!cents) return;
  lines.push({
    line_number: lines.length + 1,
    account_id,
    debit: cents > 0 ? dollars(cents) : "0",
    credit: cents < 0 ? dollars(-cents) : "0",
    memo,
    ...(subledger ? { subledger_type: "vendor", subledger_id: subledger } : {}),
  });
}

async function postJe(payload, healQuery) {
  const { data: jeId, error } = await admin.rpc("gl_post_journal_entry", { payload });
  if (!error) return { jeId };
  if (/duplicate key|uq_je_source/i.test(error.message || "")) {
    const { data: existing } = await healQuery();
    if (existing) return { jeId: existing.id, healed: true };
  }
  return { error: error.message };
}

const healBy = (source_table, source_id) => () =>
  admin.from("journal_entries").select("id")
    .eq("source_table", source_table).eq("source_id", source_id)
    .eq("basis", "ACCRUAL").maybeSingle();

// Vendor default expense accounts, validated like the #1666 sweep.
async function vendorExpenseMap(entity_id, vendorIds) {
  const out = new Map();
  const ids = [...new Set(vendorIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await admin.from("vendors")
      .select("id, default_gl_expense_account_id")
      .in("id", ids.slice(i, i + 300)).not("default_gl_expense_account_id", "is", null);
    if (error) throw new Error(error.message);
    for (const v of data || []) out.set(v.id, v.default_gl_expense_account_id);
  }
  if (out.size) {
    const acctIds = [...new Set(out.values())];
    const { data: ok, error } = await admin.from("gl_accounts").select("id")
      .eq("entity_id", entity_id).in("id", acctIds)
      .eq("is_postable", true).eq("is_control", false).eq("status", "active");
    if (error) throw new Error(error.message);
    const okSet = new Set((ok || []).map((a) => a.id));
    for (const [vid, aid] of [...out]) if (!okSet.has(aid)) out.delete(vid);
  }
  return out;
}

const INVENTORY_VENDOR_TYPES = new Set(["Suppliers", "Manufacturer"]);

// ── phases ───────────────────────────────────────────────────────────────────

async function phaseReconcile() {
  const staged = await loadStaging();
  const pays = await loadPayments();
  const invByNum = await loadInvoicesByNumber();

  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
  console.log(`staged bills: ${staged.length}  Σtotal $${$(sum(staged, (b) => b.total_cents))}  Σpaid $${$(sum(staged, (b) => b.paid_cents))}  Σdue $${$(sum(staged, (b) => b.due_cents))}`);
  console.log(`  Σdiscounts $${$(sum(staged, (b) => b.discounts_cents))}  Σcredits $${$(sum(staged, (b) => b.credits_cents))} (vendor credits $${$(sum(staged, (b) => b.vendor_credits_cents))} + prepayments $${$(sum(staged, (b) => b.prepayments_cents))})`);
  console.log(`TARGET GL 2000 (Σ Amount Due): $${$(sum(staged, (b) => b.due_cents))}`);

  const noVendor = staged.filter((b) => !b.vendor_id);
  console.log(`staged without vendor_id: ${noVendor.length}`);

  // overlap with already-posted #1662 accruals
  let overlapPosted = 0, overlapPostedCents = 0, totalMismatch = [];
  let overlapUnposted = 0, native = 0, fresh = 0;
  for (const b of staged) {
    const inv = invByNum.get(b.bill_number);
    if (!inv) { fresh++; continue; }
    if (!["xoro_ap", "xoro_bills_register"].includes(inv.source)) { native++; continue; }
    if (inv.gl_status === "posted") {
      overlapPosted++; overlapPostedCents += b.total_cents;
      if (Number(inv.total_amount_cents) !== Number(b.total_cents)) totalMismatch.push({ bill: b.bill_number, register: b.total_cents, invoices: inv.total_amount_cents });
      if (inv.vendor_id !== b.vendor_id) console.log(`  vendor mismatch on posted bill ${b.bill_number}: invoices ${inv.vendor_id} vs register ${b.vendor_id}`);
    } else overlapUnposted++;
  }
  console.log(`overlap with invoices: ${overlapPosted} already POSTED (dedupe, $${$(overlapPostedCents)}), ${overlapUnposted} present-unposted, ${native} native-source collisions, ${fresh} new to invoices`);
  if (totalMismatch.length) {
    console.log(`⚠️ ${totalMismatch.length} posted bills where register total ≠ posted total:`);
    for (const m of totalMismatch.slice(0, 20)) console.log(`   ${m.bill}: register $${$(m.register)} vs posted $${$(m.invoices)}`);
  } else console.log("register totals MATCH posted invoice totals on every overlapping bill");

  // posted invoices NOT in the register (accrued from the Xoro pull; stay as-is)
  const stagedNums = new Set(staged.map((b) => b.bill_number));
  const notInRegister = [...invByNum.values()].filter((i) => i.source === "xoro_ap" && i.gl_status === "posted" && !stagedNums.has(i.invoice_number));
  console.log(`posted xoro_ap invoices NOT in register: ${notInRegister.length} ($${$(sum(notInRegister, (i) => Number(i.total_amount_cents)))})`);
  for (const i of notInRegister.slice(0, 10)) console.log(`   ${i.invoice_number} $${$(Number(i.total_amount_cents))}`);

  // payments
  console.log(`\npayments staged: ${pays.length}  Σamount $${$(sum(pays, (p) => p.amount_cents))}  Σapplied $${$(sum(pays, (p) => p.paid_amount_cents))}  held(no JE): ${pays.filter((p) => !p.je_id).length}`);
  const anomalies = pays.filter((p) => p.paid_amount_cents > p.amount_cents);
  console.log(`payments with applied > amount: ${anomalies.length}`);

  // per-vendor residual: Σbills.paid − Σpayments.applied
  const byVendorBills = new Map(), byVendorPays = new Map();
  for (const b of staged) byVendorBills.set(b.vendor_id, (byVendorBills.get(b.vendor_id) || 0) + b.paid_cents);
  for (const p of pays) byVendorPays.set(p.vendor_id, (byVendorPays.get(p.vendor_id) || 0) + p.paid_amount_cents);
  const vendorIds = new Set([...byVendorBills.keys(), ...byVendorPays.keys()]);
  const residuals = [...vendorIds].map((v) => ({ v, r: (byVendorBills.get(v) || 0) - (byVendorPays.get(v) || 0) })).filter((x) => x.r !== 0);
  const names = new Map((await fetchAll("vendors", "id, name")).map((v) => [v.id, v.name]));
  console.log(`\nper-vendor residuals (bills paid − payments applied): ${residuals.length} vendors, net $${$(sum(residuals, (x) => x.r))}`);
  for (const x of residuals.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 20)) console.log(`   ${names.get(x.v) || x.v}: $${$(x.r)}`);

  // cutover shape
  const pre = staged.filter((b) => b.bill_date < CUTOVER);
  console.log(`\nbills dated before cutover ${CUTOVER}: ${pre.length} ($${$(sum(pre, (b) => b.total_cents))}, all accrue AT ${CUTOVER}); open among them: ${pre.filter((b) => b.due_cents !== 0).length}`);
  console.log(`bills dated exactly ${CUTOVER}: ${staged.filter((b) => b.bill_date === CUTOVER).length} (dsantiago opening-AP backfills — accrued normally; no opening 2000 JE exists)`);
}

async function phaseLinkInvoices({ dryRun, limit }) {
  const staged = await loadStaging();
  const invByNum = await loadInvoicesByNumber();
  let inserted = 0, updated = 0, linked = 0, skippedNative = 0, errors = 0;

  for (const b of staged.slice(0, limit || staged.length)) {
    if (!b.vendor_id) { errors++; console.error(`  ${b.bill_number}: no vendor_id — run import with --create-vendors`); continue; }
    const existing = invByNum.get(b.bill_number);
    const paidCents = b.total_cents - b.due_cents; // subledger open = register Amount Due
    try {
      if (!existing) {
        if (dryRun) { inserted++; continue; }
        const { data, error } = await admin.from("invoices").insert({
          vendor_id: b.vendor_id,
          invoice_number: b.bill_number,
          invoice_date: b.bill_date,
          due_date: b.due_date,
          posting_date: clampDate(b.bill_date),
          currency: "USD",
          subtotal: Number(dollars(b.total_cents)),
          tax: 0,
          total: Number(dollars(b.total_cents)),
          total_amount_cents: b.total_cents,
          paid_amount_cents: paidCents,
          status: b.status === "Paid" ? "paid" : "approved",
          paid_at: b.status === "Paid" ? (b.modified_date || b.bill_date) : null,
          source: "xoro_bills_register",
          invoice_kind: "vendor_bill",
          gl_status: "unposted",
          description: `Xoro bills register backfill (${b.vendor_type || "bill"}, ${b.store || "-"})`,
          notes: b.vendor_bill_number ? `Vendor bill# ${b.vendor_bill_number}` : null,
        }).select("id").single();
        if (error) throw new Error(error.message);
        invByNum.set(b.bill_number, { id: data.id, invoice_number: b.bill_number, vendor_id: b.vendor_id, source: "xoro_bills_register", gl_status: "unposted", total_amount_cents: b.total_cents });
        if (!b.invoice_id) await admin.from("ap_bill_register_import").update({ invoice_id: data.id }).eq("id", b.id);
        inserted++;
      } else if (["xoro_ap", "xoro_bills_register"].includes(existing.source)) {
        if (dryRun) { updated++; continue; }
        const patch = { paid_amount_cents: paidCents, source: "xoro_bills_register" };
        // Adopt register totals ONLY while unposted (the 24 zero-total pull
        // stubs); a POSTED bill's total is already in the GL — mismatches are
        // reported by `reconcile`, never silently patched.
        if (existing.gl_status !== "posted" && Number(existing.total_amount_cents) !== Number(b.total_cents)) {
          patch.total_amount_cents = b.total_cents;
          patch.subtotal = Number(dollars(b.total_cents));
          patch.total = Number(dollars(b.total_cents));
        }
        const { error } = await admin.from("invoices").update(patch).eq("id", existing.id);
        if (error) throw new Error(error.message);
        if (b.invoice_id !== existing.id) await admin.from("ap_bill_register_import").update({ invoice_id: existing.id }).eq("id", b.id);
        updated++;
      } else {
        skippedNative++;
        console.log(`  ${b.bill_number}: existing invoice has foreign source ${existing.source} — left alone`);
      }
      linked++;
    } catch (e) {
      errors++;
      console.error(`  ${b.bill_number}: ${e.message}`);
    }
  }
  console.log(`link-invoices${dryRun ? " (dry-run)" : ""}: ${inserted} inserted, ${updated} updated/frozen, ${skippedNative} native skipped, ${errors} errors`);
  if (errors) process.exit(1);
}

async function phaseAccruals({ dryRun, limit }) {
  const ctx = await loadContext();
  const staged = (await loadStaging())
    .filter((b) => !b.accrual_je_id)
    .sort((a, b) => (a.bill_date < b.bill_date ? -1 : a.bill_date > b.bill_date ? 1 : a.bill_number < b.bill_number ? -1 : 1));
  const invByNum = await loadInvoicesByNumber();
  const expenseByVendor = await vendorExpenseMap(ctx.entity_id, staged.map((b) => b.vendor_id));

  let posted = 0, postedCents = 0, deduped = 0, dedupedCents = 0, zero = 0, errors = 0, done = 0;
  for (const b of staged) {
    if (limit && done >= limit) break;
    done++;
    const inv = invByNum.get(b.bill_number);
    if (!inv || !b.invoice_id) { errors++; console.error(`  ${b.bill_number}: no linked invoice — run link-invoices`); continue; }

    if (b.total_cents === 0) {
      zero++;
      if (!dryRun && b.skip_reason !== "zero_total") await admin.from("ap_bill_register_import").update({ skip_reason: "zero_total" }).eq("id", b.id);
      continue;
    }
    // Dedupe vs the #1662 per-bill sweep: the invoice already carries an
    // accrual JE. Adopt it into staging so relief/verify see the linkage.
    if (inv.gl_status === "posted" && inv.accrual_je_id) {
      deduped++; dedupedCents += b.total_cents;
      if (!dryRun) await admin.from("ap_bill_register_import").update({ accrual_je_id: inv.accrual_je_id, skip_reason: "already_posted_1662" }).eq("id", b.id);
      continue;
    }

    const posting_date = clampDate(b.bill_date);
    const drAccount = INVENTORY_VENDOR_TYPES.has(b.vendor_type)
      ? ctx.acct["1201"]
      : (expenseByVendor.get(b.vendor_id) || ctx.acct["8007"]);
    const lines = [];
    addSigned(lines, drAccount, b.total_cents, `${INVENTORY_VENDOR_TYPES.has(b.vendor_type) ? "Goods" : "Services/expense"} — bill ${b.bill_number}`);
    addSigned(lines, ctx.acct["2000"], -b.total_cents, `AP — bill ${b.bill_number}`, b.vendor_id);

    if (dryRun) { posted++; postedCents += b.total_cents; continue; }
    const payload = {
      entity_id: ctx.entity_id,
      basis: "ACCRUAL",
      journal_type: "ap_invoice_historical",
      posting_date,
      source_module: "ap",
      source_table: "invoices",
      source_id: inv.id,
      description: `Xoro AP bill ${b.bill_number} (register backfill)`,
      audit_reason: `AP bill-history backfill from Xoro Bills register ${EXPORT_DATE} — bill ${b.bill_number}${posting_date !== b.bill_date ? ` (bill date ${b.bill_date} pre-cutover, posted at opening ${CUTOVER})` : ""}`,
      lines,
    };
    const r = await postJe(payload, healBy("invoices", inv.id));
    if (r.error) { errors++; console.error(`  ${b.bill_number}: ${r.error}`); continue; }
    await admin.from("invoices").update({ gl_status: "posted", accrual_je_id: r.jeId, posting_date }).eq("id", inv.id);
    await admin.from("ap_bill_register_import").update({ accrual_je_id: r.jeId }).eq("id", b.id);
    posted++; postedCents += b.total_cents;
    if (posted % 200 === 0) console.log(`  … ${posted} accruals posted ($${$(postedCents)})`);
  }
  console.log(`accruals${dryRun ? " (dry-run)" : ""}: ${posted} posted ($${$(postedCents)}), ${deduped} deduped vs #1662 ($${$(dedupedCents)}), ${zero} zero-total skipped, ${errors} errors`);
  if (errors) process.exit(1);
}

// True-up the #1662-posted bills whose register header total differs from the
// Xoro line-sum total their accrual JE used (24 bills found in reconcile —
// freight/tax lines missing from the API pull, small ± diffs). The register is
// the CEO-delivered source of truth: post a delta JE (same DR routing as the
// accrual, ± against 2000) AND align invoices.total_amount_cents so GL,
// subledger, and register all say the same number.
async function phaseDeltas({ dryRun, limit }) {
  const ctx = await loadContext();
  const staged = await loadStaging();
  const invByNum = await loadInvoicesByNumber();
  const expenseByVendor = await vendorExpenseMap(ctx.entity_id, staged.map((b) => b.vendor_id));

  let posted = 0, netCents = 0, errors = 0, done = 0;
  for (const b of staged) {
    const inv = invByNum.get(b.bill_number);
    if (!inv || inv.gl_status !== "posted" || !inv.accrual_je_id) continue;
    // Only bills whose accrual pre-dates this backfill can diverge; bills we
    // posted ourselves used the register total (accrual JE id === staging's).
    if (b.accrual_je_id && b.skip_reason !== "already_posted_1662") continue;
    const delta = b.total_cents - Number(inv.total_amount_cents);
    if (delta === 0) continue;
    if (limit && done >= limit) break;
    done++;

    const posting_date = clampDate(b.bill_date);
    const drAccount = INVENTORY_VENDOR_TYPES.has(b.vendor_type)
      ? ctx.acct["1201"]
      : (expenseByVendor.get(b.vendor_id) || ctx.acct["8007"]);
    const lines = [];
    addSigned(lines, drAccount, delta, `Register true-up — bill ${b.bill_number}`);
    addSigned(lines, ctx.acct["2000"], -delta, `AP register true-up — bill ${b.bill_number}`, b.vendor_id);

    if (dryRun) { posted++; netCents += delta; console.log(`  would true-up ${b.bill_number}: $${$(delta)}`); continue; }
    const payload = {
      entity_id: ctx.entity_id,
      basis: "ACCRUAL",
      journal_type: "ap_adjustment_historical",
      posting_date,
      source_module: "ap",
      source_table: "ap_bill_register_import",
      source_id: `delta:${b.id}`,
      description: `AP register true-up — bill ${b.bill_number}`,
      audit_reason: `AP bill-history backfill (Bills register ${EXPORT_DATE}) — bill ${b.bill_number} was accrued from the Xoro API line-sum at $${$(Number(inv.total_amount_cents))} (#1662); the register header total is $${$(b.total_cents)}. Delta $${$(delta)} posted so AP 2000 ties to the register.`,
      lines,
    };
    const r = await postJe(payload, healBy("ap_bill_register_import", `delta:${b.id}`));
    if (r.error) { errors++; console.error(`  ${b.bill_number}: ${r.error}`); continue; }
    const { error: uErr } = await admin.from("invoices").update({
      total_amount_cents: b.total_cents,
      subtotal: Number(dollars(b.total_cents)),
      total: Number(dollars(b.total_cents)),
    }).eq("id", inv.id);
    if (uErr) { errors++; console.error(`  ${b.bill_number}: JE ${r.jeId} posted but invoice total update failed: ${uErr.message}`); continue; }
    posted++; netCents += delta;
    console.log(`  true-up ${b.bill_number}: $${$(delta)} (JE ${r.jeId}${r.healed ? " existing" : ""})`);
  }
  console.log(`deltas${dryRun ? " (dry-run)" : ""}: ${posted} posted, net CR 2000 $${$(netCents)}, ${errors} errors`);
  if (errors) process.exit(1);
}

async function phaseRelief({ dryRun, limit }) {
  const ctx = await loadContext();
  const staged = (await loadStaging())
    .filter((b) => !b.relief_je_id && (b.discounts_cents + b.credits_cents) !== 0)
    .sort((a, b) => ((a.modified_date || a.bill_date) < (b.modified_date || b.bill_date) ? -1 : 1));

  let posted = 0, postedCents = 0, errors = 0, done = 0;
  for (const b of staged) {
    if (limit && done >= limit) break;
    done++;
    const relief = b.discounts_cents + b.credits_cents; // credits = vendor credits + prepayments
    const discountsAndVendorCredits = b.discounts_cents + b.vendor_credits_cents;
    const posting_date = clampDate(b.modified_date || b.bill_date);
    const lines = [];
    addSigned(lines, ctx.acct["2000"], relief, `AP relief — bill ${b.bill_number} (discounts/credits/prepayments applied)`, b.vendor_id);
    addSigned(lines, ctx.acct["5005"], -discountsAndVendorCredits, `Discounts $${$(b.discounts_cents)} + vendor credits $${$(b.vendor_credits_cents)} — bill ${b.bill_number}`);
    addSigned(lines, ctx.acct["1308"], -b.prepayments_cents, `Prepayments applied — bill ${b.bill_number}`);
    if (lines.length < 2) continue;

    if (dryRun) { posted++; postedCents += relief; continue; }
    const payload = {
      entity_id: ctx.entity_id,
      basis: "ACCRUAL",
      journal_type: "ap_relief_historical",
      posting_date,
      source_module: "ap",
      source_table: "ap_bill_register_import",
      source_id: b.id,
      description: `AP non-payment relief — bill ${b.bill_number}`,
      audit_reason: `AP bill-history backfill (Bills register ${EXPORT_DATE}) — non-payment relief for bill ${b.bill_number}: discounts $${$(b.discounts_cents)}, vendor credits $${$(b.vendor_credits_cents)} → 5005, prepayments applied $${$(b.prepayments_cents)} → 1308. Dated to bill Modified date (application date proxy).`,
      lines,
    };
    const r = await postJe(payload, healBy("ap_bill_register_import", b.id));
    if (r.error) { errors++; console.error(`  ${b.bill_number}: ${r.error}`); continue; }
    await admin.from("ap_bill_register_import").update({ relief_je_id: r.jeId }).eq("id", b.id);
    posted++; postedCents += relief;
    if (posted % 100 === 0) console.log(`  … ${posted} relief JEs posted ($${$(postedCents)})`);
  }
  console.log(`relief${dryRun ? " (dry-run)" : ""}: ${posted} posted ($${$(postedCents)} DR 2000), ${errors} errors`);
  if (errors) process.exit(1);
}

async function phasePayments({ dryRun, limit }) {
  const ctx = await loadContext();
  const pays = (await loadPayments())
    .filter((p) => !p.je_id)
    .sort((a, b) => (a.payment_date < b.payment_date ? -1 : a.payment_date > b.payment_date ? 1 : a.payment_number < b.payment_number ? -1 : 1));

  // Cash-only model. The two exports prove that Σ(Amount − Paid Amount) over
  // payments equals Σ(discounts + credits + prepayments applied) over bills
  // TO THE CENT ($6,229,033.16): a payment doc's non-cash slice is exactly
  // the discount/credit/prepayment application, which we post at BILL level
  // instead (the register carries the precise 5005-vs-1308 split; the
  // payment file does not). So the payment JE moves only CASH:
  // DR 2000 / CR mapped account at Paid Amount. Zero-cash payment docs
  // (pure credit/prepayment applications) intentionally get NO JE — their GL
  // effect lives in the bill relief JEs. Crediting the banks at full Amount
  // would overstate cash outflow by $6.23M.
  let posted = 0, appliedCents = 0, zeroCash = 0, errors = 0, done = 0;
  for (const p of pays) {
    if (limit && done >= limit) break;
    done++;
    if (!p.vendor_id || !p.gl_account_id) { errors++; console.error(`  ${p.payment_number}: missing vendor/account`); continue; }
    const applied = Number(p.paid_amount_cents) || 0;
    if (applied === 0) { zeroCash++; continue; }

    const posting_date = clampDate(p.payment_date);
    const lines = [];
    addSigned(lines, ctx.acct["2000"], applied, `Payment ${p.payment_number} — ${p.vendor_name}`, p.vendor_id);
    addSigned(lines, p.gl_account_id, -applied, `Cash out — ${p.payment_account} — payment ${p.payment_number}`);

    if (dryRun) { posted++; appliedCents += applied; continue; }
    const payload = {
      entity_id: ctx.entity_id,
      basis: "ACCRUAL",
      journal_type: "ap_payment_historical",
      posting_date,
      source_module: "ap",
      source_table: "ap_payment_import",
      source_id: p.payment_number,
      description: `AP payment ${p.payment_number} — ${p.vendor_name}`,
      audit_reason: `AP payment-history backfill (Payments export ${EXPORT_DATE}) — payment ${p.payment_number}: cash $${$(applied)} from ${p.payment_account} relieves 2000 (vendor subledger). Non-cash slice (Amount − Paid = $${$((Number(p.amount_cents) || 0) - applied)}) is discount/credit/prepayment application, posted at bill level from the register${posting_date !== p.payment_date ? ` (payment date ${p.payment_date} pre-cutover, posted at opening ${CUTOVER})` : ""}.`,
      lines,
    };
    const r = await postJe(payload, healBy("ap_payment_import", p.payment_number));
    if (r.error) { errors++; console.error(`  ${p.payment_number}: ${r.error}`); continue; }
    await admin.from("ap_payment_import").update({ je_id: r.jeId }).eq("payment_number", p.payment_number);
    posted++; appliedCents += applied;
    if (posted % 200 === 0) console.log(`  … ${posted} payments posted ($${$(appliedCents)})`);
  }
  console.log(`payments${dryRun ? " (dry-run)" : ""}: ${posted} posted — DR 2000 $${$(appliedCents)}; ${zeroCash} zero-cash payment docs intentionally without JE (their relief posts at bill level from the register), ${errors} errors`);
  if (errors) process.exit(1);
}

async function phaseResiduals({ dryRun }) {
  const ctx = await loadContext();
  const staged = await loadStaging();
  const pays = await loadPayments();
  const byVendorBills = new Map(), byVendorPays = new Map();
  for (const b of staged) byVendorBills.set(b.vendor_id, (byVendorBills.get(b.vendor_id) || 0) + b.paid_cents);
  for (const p of pays) byVendorPays.set(p.vendor_id, (byVendorPays.get(p.vendor_id) || 0) + Number(p.paid_amount_cents));
  const vendorIds = [...new Set([...byVendorBills.keys(), ...byVendorPays.keys()])].filter(Boolean);
  const names = new Map((await fetchAll("vendors", "id, name")).map((v) => [v.id, v.name]));

  let posted = 0, netCents = 0, errors = 0;
  for (const v of vendorIds) {
    const r = (byVendorBills.get(v) || 0) - (byVendorPays.get(v) || 0);
    if (r === 0) continue;
    // r > 0: register says more was paid than the payments file applied
    // (payments outside the export window / not exported) → relieve 2000.
    // r < 0: payments applied to bills that aren't in the register → put back.
    const lines = [];
    addSigned(lines, ctx.acct["2000"], r, `AP paid-vs-payments residual — ${names.get(v) || v}`, v);
    addSigned(lines, ctx.acct["8002"], -r, `Offset — Σbills.paid − Σpayments.applied for ${names.get(v) || v}`);

    if (dryRun) { posted++; netCents += r; console.log(`  would post ${names.get(v) || v}: $${$(r)}`); continue; }
    const payload = {
      entity_id: ctx.entity_id,
      basis: "ACCRUAL",
      journal_type: "ap_adjustment_historical",
      posting_date: EXPORT_DATE,
      source_module: "ap",
      source_table: "ap_bill_register_import",
      source_id: `residual:${v}`,
      description: `AP backfill residual — ${names.get(v) || v}`,
      audit_reason: `AP bill-history backfill (Bills register ${EXPORT_DATE}) — per-vendor residual: register Σ Amount Paid minus payments-export Σ applied = $${$(r)} for ${names.get(v) || v}. Booked to 8002 Reconciliation Discrepancies so AP 2000 ties to the register's open balance.`,
      lines,
    };
    const r2 = await postJe(payload, healBy("ap_bill_register_import", `residual:${v}`));
    if (r2.error) { errors++; console.error(`  ${names.get(v) || v}: ${r2.error}`); continue; }
    posted++; netCents += r;
    console.log(`  residual ${names.get(v) || v}: $${$(r)} (JE ${r2.jeId}${r2.healed ? " existing" : ""})`);
  }
  console.log(`residuals${dryRun ? " (dry-run)" : ""}: ${posted} posted, net DR 2000 $${$(netCents)}, ${errors} errors`);
  if (errors) process.exit(1);
}

async function phaseVerify() {
  const ctx = await loadContext();
  const staged = await loadStaging();
  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
  const target = sum(staged, (b) => b.due_cents);

  // GL 2000 (posted, ACCRUAL) via v_trial_balance — *_cents columns are TRUE
  // integer cents as of the gl_reports_true_cents migration (2026-07-09).
  const { data: tb, error: tbErr } = await admin.from("v_trial_balance")
    .select("code, debit_cents, credit_cents").eq("entity_id", ctx.entity_id)
    .eq("basis", "ACCRUAL").in("code", ["2000", "1308", "5005", "8002"]);
  if (tbErr) throw new Error(tbErr.message);
  const toC = (v) => Math.round(Number(v || 0));
  for (const row of tb || []) {
    const net = toC(row.debit_cents) - toC(row.credit_cents);
    console.log(`GL ${row.code}: net ${net <= 0 ? "CR" : "DR"} $${$(Math.abs(net))}`);
    if (row.code === "2000") {
      const gl2000cr = -net;
      console.log(`AP 2000 vs register target: GL $${$(gl2000cr)} CR vs Σ Amount Due $${$(target)} → diff $${$(gl2000cr - target)}`);
    }
  }

  // per-vendor: GL 2000 by vendor subledger (paginated line walk) vs register Σ due
  const glByVendor = new Map();
  {
    const lines = await fetchAll(
      "journal_entry_lines",
      "debit, credit, subledger_id, journal_entries!inner(status)",
      (q) => q.eq("account_id", ctx.acct["2000"]).eq("journal_entries.status", "posted").order("id", { ascending: true }),
    );
    for (const l of lines) {
      const net = Math.round(Number(l.credit || 0) * 100) - Math.round(Number(l.debit || 0) * 100); // CR-normal
      glByVendor.set(l.subledger_id, (glByVendor.get(l.subledger_id) || 0) + net);
    }
  }
  const byVendorDue = new Map();
  for (const b of staged) byVendorDue.set(b.vendor_id, (byVendorDue.get(b.vendor_id) || 0) + b.due_cents);
  const names = new Map((await fetchAll("vendors", "id, name")).map((v) => [v.id, v.name]));
  console.log("\ntop-10 register open vendors — GL 2000 subledger vs register Σ due:");
  for (const [v, c] of [...byVendorDue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const gl = glByVendor.get(v) || 0;
    console.log(`  ${names.get(v) || v}: GL $${$(gl)} vs register $${$(c)} → diff $${$(gl - c)}`);
  }
  const glVendorTotal = [...glByVendor.values()].reduce((s, x) => s + x, 0);
  console.log(`GL 2000 total across vendor subledgers: $${$(glVendorTotal)}`);

  // tie-out engine (#1665)
  const { runControlTieouts } = await import("../api/_lib/accounting/tieouts.js");
  const { rows, meta } = await runControlTieouts(admin, ctx.entity_id);
  const ap = rows.find((r) => r.account_code === "2000");
  console.log(`\ntie-out engine AP 2000: status=${ap.status} gl=$${$(ap.gl_cents)} subledger=$${$(ap.subledger_cents)} diff=$${$(ap.diff_cents)} (posted bills considered: ${meta.ap_posted_bills})`);
}

// ── entry ────────────────────────────────────────────────────────────────────
const phase = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;

const phases = {
  reconcile: phaseReconcile,
  "link-invoices": phaseLinkInvoices,
  accruals: phaseAccruals,
  deltas: phaseDeltas,
  relief: phaseRelief,
  payments: phasePayments,
  residuals: phaseResiduals,
  verify: phaseVerify,
};
if (!phases[phase]) {
  console.error(`usage: node scripts/post-bills-register.mjs <${Object.keys(phases).join("|")}> [--dry-run] [--limit=N]`);
  process.exit(1);
}
phases[phase]({ dryRun, limit }).catch((e) => { console.error(e); process.exit(1); });
