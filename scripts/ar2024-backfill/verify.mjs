// scripts/ar2024-backfill/verify.mjs
//
// The six verification gates for the Sep–Dec 2024 AR historical backfill.
// All must pass before the load is called done:
//   1. Per-month posted count + $ ties the invoice registry to the cent
//      (adjusted only for the 23 documented $0-invoice runner skips).
//   2. Every posted invoice: sum(ar_invoice_lines) == invoice total == header.
//   3. All JEs balanced (per-JE and global GL imbalance = 0.00).
//   4. income_statement RPC (ACCRUAL) shows the expected revenue; prints
//      revenue / COGS / blended margin per month.
//   5. GL 2000 AP unchanged at $9,947,831.51; control-account tie-outs
//      (1105/1107/1108 AR + 2000 AP, #1665 machinery) still pass.
//   6. 2025+ data untouched (23,404 invoices / 48,759 lines baseline).
//
//   node scripts/ar2024-backfill/verify.mjs --dir C:\tmp\ar2024

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ENTITY_CODE, MONTHLY_TARGETS, ROOT, WINDOW_HI, WINDOW_LO,
  adminClient, assertMonthlyTargets, loadEnv, loadHeaders, runSql, sqlQuote,
} from "./lib.mjs";

const args = process.argv.slice(2);
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : "C:\\tmp\\ar2024";

const env = loadEnv();
const admin = adminClient(env);
const { headers } = loadHeaders(dir);
assertMonthlyTargets(headers);
const zeroByMonth = {};
for (const h of headers.values()) {
  if (h.totalCents <= 0) {
    const m = h.date.slice(0, 7);
    zeroByMonth[m] = (zeroByMonth[m] || 0) + 1;
  }
}

const { data: entity } = await admin.from("entities").select("id").eq("code", ENTITY_CODE).maybeSingle();
if (!entity) throw new Error("ROF entity not found");

// #1668 tied 2000 to the cent at $9,947,831.51 on 2026-07-09; the nightly
// AP sweep (#1662) keeps posting real bills daily, so the live balance
// legitimately drifts. The load-invariant we prove is (a) the balance equals
// the immediately-pre-load snapshot (pass --ap2000-baseline <cents>) and
// (b) STRUCTURALLY none of this load's journal types ever touch 2000.
const apArgIdx = args.indexOf("--ap2000-baseline");
const AP_2000_BASELINE_CENTS = apArgIdx >= 0 ? Number(args[apArgIdx + 1]) : 1006143354;
const AR_2025_BASELINE = { invoices: 23404, lines: 48759 };

let failures = 0;
const gate = (n, ok, detail) => {
  console.log(`GATE ${n}: ${ok ? "PASS" : "FAIL"} — ${detail}`);
  if (!ok) failures++;
};

// ── Gate 1: monthly count + $ tie ───────────────────────────────────────────
const monthsRows = await runSql(env, `
select to_char(invoice_date,'YYYY-MM') m, count(*) n, sum(total_amount_cents)::bigint cents
from ar_invoices
where invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}'
group by 1 order by 1;`);
{
  let ok = true;
  const details = [];
  for (const [m, t] of Object.entries(MONTHLY_TARGETS)) {
    const got = monthsRows.find((r) => r.m === m) || { n: 0, cents: 0 };
    const expectedCount = t.count - (zeroByMonth[m] || 0);
    const pass = Number(got.n) === expectedCount && Number(got.cents) === t.cents;
    if (!pass) ok = false;
    details.push(`${m}: ${got.n}/${expectedCount} inv, $${(Number(got.cents) / 100).toFixed(2)}/$${(t.cents / 100).toFixed(2)}${pass ? "" : "  <-- MISMATCH"}`);
  }
  gate(1, ok, `\n  ${details.join("\n  ")}`);
}

// ── Gate 2: line sums == invoice totals == header totals ────────────────────
const values = [...headers.values()].filter((h) => h.totalCents > 0)
  .map((h) => `(${sqlQuote(h.inv)},${h.totalCents})`).join(",");
const [g2] = await runSql(env, `
with expected(inv, cents) as (values ${values}),
inv as (
  select a.id, a.invoice_number, a.total_amount_cents,
         (select coalesce(sum(l.line_total_cents),0) from ar_invoice_lines l where l.ar_invoice_id = a.id) line_sum
  from ar_invoices a
  where a.invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}'
)
select
  (select count(*) from inv where line_sum <> total_amount_cents) lines_vs_total_mismatch,
  (select count(*) from expected e left join inv i on i.invoice_number = e.inv
    where i.id is null or i.total_amount_cents <> e.cents) header_vs_total_mismatch,
  (select count(*) from inv) posted,
  (select count(*) from expected) expected_n;`);
gate(2, Number(g2.lines_vs_total_mismatch) === 0 && Number(g2.header_vs_total_mismatch) === 0,
  `posted=${g2.posted} expected=${g2.expected_n} lines-vs-total mismatches=${g2.lines_vs_total_mismatch} header-vs-total mismatches=${g2.header_vs_total_mismatch}`);

// ── Gate 3: JEs balanced ────────────────────────────────────────────────────
const [g3] = await runSql(env, `
select
  (select count(*) from (
     select jel.journal_entry_id
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     where je.posting_date between '${WINDOW_LO}' and '${WINDOW_HI}'
     group by jel.journal_entry_id
     having round(sum(jel.debit)*100) <> round(sum(jel.credit)*100)
  ) x) window_unbalanced,
  (select round(sum(jel.debit - jel.credit)*100)::bigint
     from journal_entry_lines jel
     join journal_entries je on je.id = jel.journal_entry_id
     where je.status = 'posted') global_imbalance_cents;`);
gate(3, Number(g3.window_unbalanced) === 0 && Number(g3.global_imbalance_cents) === 0,
  `window unbalanced JEs=${g3.window_unbalanced} global imbalance=${(Number(g3.global_imbalance_cents) / 100).toFixed(2)}`);

// ── Gate 4: income statement per month ──────────────────────────────────────
{
  let ok = true;
  const lines = [];
  for (const [m, t] of Object.entries(MONTHLY_TARGETS)) {
    const from = `${m}-01`;
    const to = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const { data, error } = await admin.rpc("income_statement", {
      p_entity_id: entity.id, p_basis: "ACCRUAL", p_from_date: from, p_to_date: to,
    });
    if (error) throw new Error(`income_statement RPC failed for ${m}: ${error.message}`);
    let rev = 0, cogs = 0;
    const byCode = {};
    for (const r of data || []) {
      if (r.account_type === "revenue") { rev += Number(r.amount_cents); byCode[r.code] = Number(r.amount_cents); }
      if (r.account_type === "expense" && /^50/.test(r.code)) cogs += Number(r.amount_cents);
    }
    const pass = rev === t.cents;
    if (!pass) ok = false;
    lines.push(`${m}: revenue $${(rev / 100).toFixed(2)} (target $${(t.cents / 100).toFixed(2)})${pass ? "" : " <-- MISMATCH"} · COGS $${(cogs / 100).toFixed(2)} · margin ${(rev > 0 ? ((rev - cogs) / rev) * 100 : 0).toFixed(1)}% · by acct ${JSON.stringify(Object.fromEntries(Object.entries(byCode).map(([k, v]) => [k, (v / 100).toFixed(2)])))}`);
  }
  gate(4, ok, `\n  ${lines.join("\n  ")}`);
}

// ── Gate 5: AP 2000 unchanged + control tie-outs ────────────────────────────
const [g5] = await runSql(env, `
select
  (select round(sum(jel.credit - jel.debit)*100)::bigint
   from journal_entry_lines jel
   join journal_entries je on je.id = jel.journal_entry_id
   join gl_accounts ga on ga.id = jel.account_id
   where je.status='posted' and je.basis='ACCRUAL' and ga.code='2000' and ga.entity_id='${entity.id}') balance_cents,
  (select count(*)
   from journal_entry_lines jel
   join journal_entries je on je.id = jel.journal_entry_id
   join gl_accounts ga on ga.id = jel.account_id
   where ga.code='2000' and je.journal_type in ('ar_invoice_historical','ar_receipt_xoro')) ar_lines_on_2000;`);
const ap2000Ok = Number(g5.balance_cents) === AP_2000_BASELINE_CENTS && Number(g5.ar_lines_on_2000) === 0;

// Control tie-outs: 1107 (+$48,995.48) and 1108 (−$55,587.12) were ALREADY
// breaking before this load (pre-load snapshot 2026-07-10, nightly-feed
// drift unrelated to 2024 history). The load-invariant is that the diffs are
// UNCHANGED to the cent — i.e. the 2024 invoices + receipts are internally
// consistent between GL and subledger.
const TIEOUT_BASELINE_CENTS = { 1105: 0, 1107: 4899548, 1108: -5558712, 2000: 0 };
let tieOk = true, tieDetail = "";
try {
  const tieouts = await import(pathToFileURL(resolve(ROOT, "api", "_lib", "accounting", "tieouts.js")).href);
  const { rows } = await tieouts.runControlTieouts(admin, entity.id);
  tieOk = rows.every((r) => Number(r.diff_cents || 0) === (TIEOUT_BASELINE_CENTS[r.account_code] ?? 0));
  tieDetail = rows.map((r) => `${r.account_code}:${r.status}${r.waived ? "(waived)" : ""} diff=${(Number(r.diff_cents || 0) / 100).toFixed(2)} (baseline ${((TIEOUT_BASELINE_CENTS[r.account_code] ?? 0) / 100).toFixed(2)})`).join(" · ");
} catch (e) {
  tieOk = false;
  tieDetail = `tieouts import/run failed: ${e.message}`;
}
gate(5, ap2000Ok && tieOk,
  `GL 2000 = $${(Number(g5.balance_cents) / 100).toFixed(2)} (pre-load snapshot $${(AP_2000_BASELINE_CENTS / 100).toFixed(2)}, AR-load lines on 2000: ${g5.ar_lines_on_2000}) · tie-outs: ${tieDetail}`);

// ── Gate 6: 2025+ untouched ─────────────────────────────────────────────────
const [g6] = await runSql(env, `
select
  (select count(*) from ar_invoices where invoice_date >= '2025-01-01') inv_2025,
  (select count(*) from ar_invoice_lines l join ar_invoices a on a.id = l.ar_invoice_id
    where a.invoice_date >= '2025-01-01') lines_2025;`);
gate(6, Number(g6.inv_2025) === AR_2025_BASELINE.invoices && Number(g6.lines_2025) === AR_2025_BASELINE.lines,
  `2025+ invoices=${g6.inv_2025} (baseline ${AR_2025_BASELINE.invoices}) lines=${g6.lines_2025} (baseline ${AR_2025_BASELINE.lines})`);

// ── extras for the report ───────────────────────────────────────────────────
const [extra] = await runSql(env, `
select
  (select count(*) from ar_invoice_lines l join ar_invoices a on a.id=l.ar_invoice_id
     join ip_item_master m on m.id = l.inventory_item_id
   where a.invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}' and m.sku_code='AR2024-FREIGHT') freight_lines,
  (select count(*) from ar_invoice_lines l join ar_invoices a on a.id=l.ar_invoice_id
     join ip_item_master m on m.id = l.inventory_item_id
   where a.invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}' and m.sku_code='AR2024-NODETAIL') summary_lines,
  (select count(*) from ar_invoice_lines l join ar_invoices a on a.id=l.ar_invoice_id
   where a.invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}') total_lines,
  (select count(*) from ar_invoices where invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}' and paid_amount_cents > 0) paid_invoices,
  (select count(*) from journal_entries where journal_type='ar_receipt_xoro' and posting_date between '${WINDOW_LO}' and '2026-12-31'
     and source_id in (select id::text from ar_invoices where invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}')) receipt_jes;`);
console.log("extras:", JSON.stringify(extra));

console.log(failures === 0 ? "\nALL SIX GATES PASS" : `\n${failures} GATE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
