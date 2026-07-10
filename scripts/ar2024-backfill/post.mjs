// scripts/ar2024-backfill/post.mjs
//
// Post the staged Sep–Dec 2024 AR history through the EXISTING driver-v3
// runner (api/_handlers/internal/ar-backfill/run.js, local harness — same
// code the 2025-01→2026-06 load used), then apply Xoro payment state and
// drive the receipts-reconcile cron until drained.
//
//   node scripts/ar2024-backfill/post.mjs --dir C:\tmp\ar2024            # dry run
//   node scripts/ar2024-backfill/post.mjs --dir C:\tmp\ar2024 --go       # real
//   node scripts/ar2024-backfill/post.mjs --dir ... --go --slice 2024-09-01:2024-09-15
//                                          # post ONE date slice (resumable; the
//                                          # runner skips already-posted invoices)
//   node scripts/ar2024-backfill/post.mjs --dir C:\tmp\ar2024 --receipts-only
//                                          # payment state + receipts + final checks
//
// Safety:
//   • Preflight re-asserts the staging tie-out (every invoice's staged rows
//     sum exactly to its header) and reports any already-posted overlap.
//   • The runner is idempotent (unique (entity_id, invoice_number) → 23505
//     skip), so re-runs never double-post.
//   • After posting, any window invoice left without accrual_je_id (a
//     crash between header insert and JE post) fails the run loudly.
//   • Payment state upserts into ar_xoro_payment_state (the same table the
//     nightly rest_invoice_sync push feeds); receipts post via the daily
//     ar-receipts-reconcile cron handler — DR 1051 factored / 1030 house,
//     posting_date = FullPaymentDate — exactly the 2025-history convention.

import { resolve } from "node:path";
import {
  ENTITY_CODE, MONTHLY_TARGETS, ROOT, WINDOW_HI, WINDOW_LO,
  adminClient, assertMonthlyTargets, httpPostJson, loadEnv, loadHeaders,
  runSql, sqlQuote, startLocalHandler,
} from "./lib.mjs";

const args = process.argv.slice(2);
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : "C:\\tmp\\ar2024";
const go = args.includes("--go");
const receiptsOnly = args.includes("--receipts-only");
const sliceIdx = args.indexOf("--slice");
const slice = sliceIdx >= 0 ? args[sliceIdx + 1].split(":") : null;

const env = loadEnv();
const admin = adminClient(env);

// --repair: a hard process crash between the runner's header insert and its
// JE post strands an ar_invoices row with accrual_je_id NULL (the runner's
// own rollback only covers in-process JE failures). Delete stranded window
// headers (+ lines) that no JE references so the next slice re-posts them.
if (args.includes("--repair")) {
  const rows = await runSql(env, `
with stranded as (
  select a.id from ar_invoices a
  where a.invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}'
    and a.accrual_je_id is null
    and not exists (select 1 from journal_entries je where je.source_table='ar_invoices' and je.source_id = a.id::text)
),
del_lines as (delete from ar_invoice_lines l using stranded s where l.ar_invoice_id = s.id returning 1),
del_inv as (delete from ar_invoices a using stranded s where a.id = s.id returning a.invoice_number)
select (select count(*) from del_lines) lines_deleted, (select count(*) from del_inv) invoices_deleted;`);
  console.log("repair:", JSON.stringify(rows));
  process.exit(0);
}

const { headers } = loadHeaders(dir);
assertMonthlyTargets(headers);

// Zero-dollar invoices are skipped by the runner by design (total<=0 →
// continue; same convention as the 2025 load) — exclude them from the
// expected posted counts. They carry $0.00 so dollar ties are unaffected.
const zeroInvs = [...headers.values()].filter((h) => h.totalCents <= 0);
console.log(`headers: ${headers.size} (${zeroInvs.length} are $0 invoices the runner will skip by convention)`);

if (!receiptsOnly) {
  // ── preflight: staging tie-out + overlap ──────────────────────────────────
  const values = [...headers.values()].map((h) => `(${sqlQuote(h.inv)},${h.totalCents})`).join(",");
  const [tie] = await runSql(env, `
with expected(inv, cents) as (values ${values}),
staged as (
  select invoice_number inv, round(sum(net_amount)*100)::bigint cents
  from ip_sales_history_wholesale
  where txn_date between '${WINDOW_LO}' and '${WINDOW_HI}' and invoice_number is not null
  group by invoice_number
)
select count(*) filter (where s.cents is distinct from e.cents) mismatches,
       count(*) total
from expected e left join staged s on s.inv = e.inv;`);
  if (Number(tie.mismatches) !== 0) throw new Error(`Staging tie-out FAILED (${tie.mismatches} mismatches) — run stage.mjs first`);
  console.log(`preflight: staging ties for all ${tie.total} invoices`);

  const [overlap] = await runSql(env, `
with nums(n) as (values ${[...headers.keys()].map((i) => `(${sqlQuote(i)})`).join(",")})
select count(*) already from ar_invoices a join nums on nums.n = a.invoice_number;`);
  console.log(`preflight: ${overlap.already} of ${headers.size} invoice numbers already in ar_invoices (idempotent skip applies)`);

  // ── run the driver month by month (or one --slice) ────────────────────────
  const srv = await startLocalHandler(resolve(ROOT, "api", "_handlers", "internal", "ar-backfill", "run.js"));
  const months = slice ? [slice] : [
    ["2024-09-01", "2024-09-30"], ["2024-10-01", "2024-10-31"],
    ["2024-11-01", "2024-11-30"], ["2024-12-01", "2024-12-31"],
  ];
  const runIds = [];
  try {
    for (const [start, end] of months) {
      const t0 = Date.now();
      const res = await httpPostJson(`${srv.url}/api/internal/ar-backfill/run`,
        { start_date: start, end_date: end, dry_run: !go });
      const j = res.json;
      if (!res.ok) throw new Error(`runner failed for ${start}: ${JSON.stringify(j)}`);
      runIds.push(j.backfill_run_id);
      console.log(`${start}..${end} ${go ? "POSTED" : "dry-run"}: invoices=${j.invoices_created} je=${j.je_created} unmatched_customers=${j.unmatched_customers} skipped_cogs=${j.skipped_cogs} months_failed=${j.months_failed} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      if (j.months_failed > 0) throw new Error(`runner reported failed month: ${JSON.stringify(j.months)}`);
      const expected = [...headers.values()].filter((h) => h.date >= start && h.date <= end && h.totalCents > 0).length;
      if (j.invoices_created !== expected) {
        console.warn(`  NOTE: created ${j.invoices_created}, expected ${expected} (re-runs skip already-posted invoices)`);
      }
    }
  } finally { await srv.close(); }

  if (!go) { console.log("dry-run complete — re-run with --go to post."); process.exit(0); }

  // ── post-run integrity: no headers stranded without a JE ──────────────────
  const [stranded] = await runSql(env, `
select count(*) n from ar_invoices
where invoice_date between '${WINDOW_LO}' and '${WINDOW_HI}' and accrual_je_id is null;`);
  if (Number(stranded.n) !== 0) throw new Error(`${stranded.n} window invoices have no accrual JE — repair before verifying`);

  // Any synthesized HIST_* customers would mean a resolution regression —
  // every 2024 customer already exists (probed before build).
  const [synth] = await runSql(env, `
select count(*) n from bf_unmatched_customers_log
where backfill_run_id in (${runIds.map((r) => sqlQuote(r)).join(",")});`);
  console.log(`unmatched/synthesized customers this run: ${synth.n}`);
  if (Number(synth.n) !== 0) throw new Error("Customer resolution fell back to synthesis — investigate bf_unmatched_customers_log");

  if (slice) { console.log("slice complete — run remaining slices, then --receipts-only."); process.exit(0); }
}

// ── payment state (headers carry Status + Full Payment Date) ────────────────
const states = [...headers.values()]
  .filter((h) => h.totalCents > 0)
  .map((h) => ({
    invoice_number: h.inv,
    payment_status: h.status || null,
    full_payment_date: h.fullPaymentDate,
    synced_at: new Date().toISOString(),
  }));
let upserted = 0;
for (let i = 0; i < states.length; i += 500) {
  const { error } = await admin.from("ar_xoro_payment_state")
    .upsert(states.slice(i, i + 500), { onConflict: "entity_id,invoice_number", ignoreDuplicates: false });
  if (error) throw new Error(`payment-state upsert chunk ${i} failed: ${error.message}`);
  upserted += Math.min(500, states.length - i);
}
console.log(`payment state upserted for ${upserted} invoices`);

// ── receipts: drive the daily cron until it stops posting ───────────────────
const cron = await startLocalHandler(resolve(ROOT, "api", "_handlers", "cron", "ar-receipts-reconcile.js"));
let totalPosted = 0;
try {
  for (let i = 0; i < 80; i++) {
    const res = await httpPostJson(`${cron.url}/api/cron/ar-receipts-reconcile`, {});
    const j = res.json;
    if (!res.ok) throw new Error(`receipts cron failed: ${JSON.stringify(j)}`);
    totalPosted += j.posted;
    console.log(`receipts pass ${i + 1}: scanned=${j.scanned} posted=${j.posted} no_state=${j.skipped_no_state} unpaid=${j.skipped_unpaid} existing=${j.skipped_existing_je} errors=${j.errors?.length || 0}`);
    if (j.errors?.length) throw new Error(`receipts cron errors: ${JSON.stringify(j.errors.slice(0, 5))}`);
    if (j.posted === 0) break;
  }
} finally { await cron.close(); }
console.log(`receipts posted total: ${totalPosted}`);
console.log("POST OK — run verify.mjs for the six gates.");
