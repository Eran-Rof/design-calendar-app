// scripts/ar2024-backfill/fix-line-totals.mjs
//
// Repair for the gross-vs-net line-total clobber (found 2026-07-10 during
// the Sep–Dec 2024 load's header tie-out):
//
//   ar_invoice_lines_compute_total_trg (BEFORE INSERT/UPDATE) overwrites
//   line_total_cents := quantity × unit_price_cents whenever BOTH are set —
//   so every DISCOUNTED line (Xoro net Amount < list unit_price × qty) the
//   runner inserted got silently re-totaled to GROSS, and
//   ar_invoice_lines_maintain_total rolled the gross into
//   ar_invoices.total_amount_cents. The accrual JEs were NOT affected (they
//   post the staged net directly), which is how the GL revenue tied to the
//   registry while the invoice documents didn't.
//
// What this does (window = 2024-09-01..2024-12-31):
//   1. Re-derives each posted line's correct NET from its staging row
//      (ip_sales_history_wholesale joined 1:1 on invoice_number + sku_id) and
//      updates mismatched lines: line_total_cents = net, unit_price_cents =
//      NULL (a discounted line has no unit price that reproduces its total;
//      NULL also disarms the compute trigger). The maintain-total trigger
//      re-rolls ar_invoices.total_amount_cents automatically.
//   2. Deletes the receipt JEs of the affected PAID invoices (they credited
//      AR at the clobbered GROSS) and resets paid_amount_cents=0 — these JEs
//      are same-session artifacts of this load, so deletion (status→draft to
//      pass journal_entry_lines_immutable, then delete) beats reversal noise.
//      Re-run `post.mjs --receipts-only` afterwards to re-post them at the
//      correct totals.
//
// The runner itself is root-fixed in the same PR (run.js only sends
// unit_price_cents when it exactly reproduces the net line total).
//
//   node scripts/ar2024-backfill/fix-line-totals.mjs            # dry report
//   node scripts/ar2024-backfill/fix-line-totals.mjs --go       # apply

import { WINDOW_HI, WINDOW_LO, loadEnv, runSql } from "./lib.mjs";

const go = process.argv.includes("--go");
const env = loadEnv();

// 1:1 join guard — a duplicated (invoice, sku) staging pair would corrupt.
const [amb] = await runSql(env, `
select count(*) n from (
  select invoice_number, sku_id from ip_sales_history_wholesale
  where txn_date between '${WINDOW_LO}' and '${WINDOW_HI}' and invoice_number is not null
  group by 1, 2 having count(*) > 1
) x;`);
if (Number(amb.n) !== 0) throw new Error(`${amb.n} ambiguous (invoice, sku) staging pairs — cannot repair by join`);

const MISMATCH_SQL = `
select l.id, round(s.net_amount*100)::bigint correct_cents, l.line_total_cents current_cents
from ar_invoice_lines l
join ar_invoices a on a.id = l.ar_invoice_id
join ip_sales_history_wholesale s
  on s.invoice_number = a.invoice_number and s.sku_id = l.inventory_item_id
where a.invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}'
  and round(s.net_amount*100)::bigint <> l.line_total_cents`;

const [scope] = await runSql(env, `
with m as (${MISMATCH_SQL})
select count(*) lines, sum(current_cents - correct_cents) overshoot_cents from m;`);
console.log(`lines to fix: ${scope.lines}, gross-vs-net overshoot: $${(Number(scope.overshoot_cents || 0) / 100).toFixed(2)}`);

if (!go) { console.log("dry run — re-run with --go to apply."); process.exit(0); }

// 1. Fix the lines (maintain-total trigger re-rolls invoice totals per row).
const [fixed] = await runSql(env, `
with m as (${MISMATCH_SQL}),
upd as (
  update ar_invoice_lines l
  set line_total_cents = m.correct_cents, unit_price_cents = null
  from m where l.id = m.id
  returning l.ar_invoice_id
)
select count(*) lines_fixed, count(distinct ar_invoice_id) invoices_touched from upd;`);
console.log("fixed:", JSON.stringify(fixed));

// 2. Remove the receipts that credited AR at the clobbered gross, and reset
//    the paid stamp so the receipts cron re-posts them at the correct total.
//    Sequential statements (NOT one wCTE — the immutable/period-lock triggers
//    fired by the deletes must SEE the status demotion, and same-statement
//    CTE effects are invisible to each other). The Management API runs the
//    script in one session, so the temp table carries the affected set.
const [receipts] = await runSql(env, `
select set_config('app.audit_reason','AR Sep-Dec 2024 backfill repair: receipt JEs credited AR at trigger-clobbered GROSS totals; deleted same-session and re-posted at corrected NET (see PR ar2024 backfill)', false);

create temp table _ar2024_fix_inv as
select distinct a.id
from ar_invoices a
join journal_entries je on je.source_module = 'xoro_receipts' and je.source_id = a.id::text
where a.invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}'
  and a.paid_amount_cents <> a.total_amount_cents
  and a.paid_amount_cents > 0;

create temp table _ar2024_fix_je as
select je.id from journal_entries je
join _ar2024_fix_inv f on je.source_id = f.id::text
where je.source_module = 'xoro_receipts';

update journal_entries je set status = 'draft' where je.id in (select id from _ar2024_fix_je);
delete from journal_entry_lines jel where jel.journal_entry_id in (select id from _ar2024_fix_je);
delete from journal_entries je where je.id in (select id from _ar2024_fix_je);
update ar_invoices a set paid_amount_cents = 0 where a.id in (select id from _ar2024_fix_inv);

select (select count(*) from _ar2024_fix_je) receipt_jes_deleted,
       (select count(*) from _ar2024_fix_inv) invoices_paid_reset;`);
console.log("receipts cleanup:", JSON.stringify(receipts));

// 3. Confirm the window now ties invoice-by-invoice at the document level.
const [after] = await runSql(env, `
select count(*) n from (
  select a.id from ar_invoices a
  join ar_invoice_lines l on l.ar_invoice_id = a.id
  where a.invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}'
  group by a.id, a.total_amount_cents
  having sum(l.line_total_cents) <> a.total_amount_cents
) x;`);
console.log(`invoices where lines != total after fix: ${after.n}`);
console.log("DONE — now re-run post.mjs --receipts-only, then verify.mjs.");
