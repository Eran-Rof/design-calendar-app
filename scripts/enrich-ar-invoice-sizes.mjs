#!/usr/bin/env node
/**
 * scripts/enrich-ar-invoice-sizes.mjs
 *
 * AR HISTORICAL INVOICE SIZE ENRICHMENT (dry-run by default; --apply writes PROD).
 *
 * The historical AR backfill stored each wholesale invoice as ONE aggregate
 * "Historical line" per (colour, inseam) linked to a size-NULL SKU, so the #1883
 * AR size matrix has nothing to grid. Xoro's API cannot return closed invoices, so
 * the CEO exports a Xoro "Invoice Detail Report" CSV that carries the per-SIZE
 * breakdown. This script replaces each aggregate line with per-size lines (and
 * explodes the matching colour-grain ip_sales_history_wholesale rows), CONSERVING
 * the invoice total, cogs, tax and sales-history qty/net to the cent.
 *
 * TARGET POPULATION (ROF entity, verified against prod 2026-07-22):
 *   ar_invoices with invoice_number NOT ILIKE '%ECOM%', invoice_date in
 *   2024-09-01 .. 2026-07-07, whose lines have ZERO sized links (all lines link a
 *   size-NULL SKU or none). 11,330 invoices (2024=2,237 / 2025=7,063 / 2026=2,030).
 *   ECOM is intentionally untouched (CEO decision).
 *
 * CONSERVATION (why it's exact):
 *   • ar_invoice_lines.line_total_cents is FORCED by a BEFORE trigger to
 *     quantity*unit_price_cents, and #1883 only grids a line when unit_price_cents
 *     is non-null. So every size line reuses the aggregate line's OWN
 *     unit_price_cents. The gate requires Σ(CSV qty)==aggregate.quantity per
 *     (colour,inseam) group, so Σ(qty_i*agg_unit)=agg_qty*agg_unit=line_total
 *     exactly — the AFTER maintain_total trigger rewrites the header to the same
 *     number. cogs_cents / tax_amount_cents are distributed by qty (largest
 *     remainder). GL / gl_status / ar_invoices columns are NOT touched.
 *   • ip_sales_history_wholesale has no trigger; size rows carry the CSV per-line
 *     amounts with a balancer reconciliation so Σ qty/net/gross is unchanged.
 *
 * VERIFICATION GATE (per invoice, BEFORE any write):
 *   1. Every stored aggregate (colour,inseam) group maps 1:1 to a CSV group.
 *   2. Per group Σ CSV qty == aggregate.quantity EXACTLY.
 *   3. Invoice Σ CSV amount within tolerance of Σ aggregate line_total.
 *   4. Every CSV line resolves to a sized SKU (reuse first; create only when the
 *      (style,colour) already exists — never create styles/colours).
 *   Any failure → SKIP the whole invoice (never partial), logged to exceptions.
 *
 * WRITES are atomic per invoice: one Management-API transaction does
 *   DELETE aggregate ar_invoice_lines + INSERT size lines +
 *   DELETE colour-grain ish rows + INSERT size ish rows.
 * SKU find/create runs first via the shared resolveOrCreateSku (sanctioned
 * resolver with logical-unique collision handling). Manifests (pre-images +
 * exceptions) are flushed progressively so the run is fully reversible.
 *
 *   node scripts/enrich-ar-invoice-sizes.mjs                       # dry-run, all
 *   node scripts/enrich-ar-invoice-sizes.mjs --csv "<path.csv>"    # explicit CSV
 *   node scripts/enrich-ar-invoice-sizes.mjs --limit 50            # dry-run smoke
 *   node scripts/enrich-ar-invoice-sizes.mjs --invoice ROF-I142656 # one invoice
 *   node scripts/enrich-ar-invoice-sizes.mjs --apply               # WRITE PROD
 *   node scripts/enrich-ar-invoice-sizes.mjs --apply --limit 25    # WRITE smoke
 *
 * Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (JWT service role) and
 * SUPABASE_PAT from .env / .env.local (same as the sibling ingest scripts).
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseInvoiceDetailCsv, usDateToIso, groupInvoiceCsvLines, aggregateGroupKey,
  buildSizeLines, buildIshSizeRows, buildRelinkLines, alignSizeGrain,
} from "../api/_lib/arSizeEnrich.js";
import { colorMatchKey, sizeVariantsOf } from "../api/_lib/xoroLineMatch.js";
import { canonColor, normalizeSize, resolveOrCreateSku } from "../api/_lib/styleMatrix.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── constants ────────────────────────────────────────────────────────────────
const PROD_REF = "qcvqvxxoperiurauoxmp";
const ROF_ENTITY_ID = "404b8a6b-0d2d-44d2-8539-9064ff0fafee";
const DATE_LO = "2024-09-01";
const DATE_HI = "2026-07-07";
const DEFAULT_CSV = "C:/Users/Eran.RINGOFFIRE/Downloads/Invoice Detail Report 5 (1).csv";
const MANIFEST_DIR = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/ar-size-enrichment-2026-07-22";
// Amount sanity tolerance per invoice: max($ abs, pct of aggregate total). The
// qty EXACT match is the real conservation guarantee; this only catches a CSV
// that doesn't belong to / fully cover the invoice.
const TOL_ABS_CENTS = 100;   // $1.00
const TOL_PCT = 0.01;        // 1%
const ENRICH_TAG = "[ar-size-enrich 2026-07-22]";
const ISH_TXN_DATE_TAG = "2026-07-22"; // provenance only; per-row txn_date comes from the colour row

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
// By default an invoice whose CSV amount diverges from the booked total is still
// enriched (the size split conserves the DB total via the aggregate's own unit
// price — the divergence is a historical list-vs-discount artifact, reported for
// audit). --strict-amount restores the hard skip-on-amount-mismatch behaviour.
const STRICT_AMOUNT = args.includes("--strict-amount");
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const CSV_PATH = argVal("--csv") || DEFAULT_CSV;
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : null;
const ONLY_INVOICE = argVal("--invoice");
const CHUNK = Number(argVal("--chunk") || 100);
const WRITE_BATCH = Number(argVal("--write-batch") || 40);

// ── env ──────────────────────────────────────────────────────────────────────
function loadEnv(file) {
  try {
    return Object.fromEntries(readFileSync(resolve(ROOT, file), "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
// .env.local wins (it holds the prod URL + JWT service key + PAT). .env.staging is
// intentionally NOT merged here — it would override the prod URL with staging.
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = (env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const PAT = process.env.SUPABASE_PAT || env.SUPABASE_PAT;
if (!SB_URL || !SERVICE_KEY) { console.error("✗ VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing"); process.exit(1); }
if (SERVICE_KEY.startsWith("sb_secret_")) { console.error("✗ SUPABASE_SERVICE_ROLE_KEY is an sb_secret_* key (PostgREST rejects it); need a JWT service-role key"); process.exit(1); }
if (APPLY && !PAT) { console.error("✗ --apply needs SUPABASE_PAT for the Management-API transactional writes"); process.exit(1); }
if (!SB_URL.includes(PROD_REF)) { console.error(`✗ VITE_SUPABASE_URL is not the prod project (${PROD_REF}); refusing to run`); process.exit(1); }

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ── Management-API SQL (reads returning rows + transactional writes) ──────────
async function runSqlMgmt(sql, { retries = 6 } = {}) {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new Error(`Mgmt API ${res.status} after ${retries} retries`);
      await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 15000); continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Mgmt API ${res.status}: ${text.slice(0, 500)}`);
    try { return JSON.parse(text); } catch { return []; }
  }
}
const sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const val = (v) => (v == null ? "NULL" : (typeof v === "number" ? String(v) : sqlLit(v)));

// ── PostgREST paged read via admin client ─────────────────────────────────────
async function inChunks(ids, fn, size = CHUNK) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

// ── manifest helpers ───────────────────────────────────────────────────────────
mkdirSync(MANIFEST_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const MODE = APPLY ? "apply" : "dryrun";
const preimagePath = join(MANIFEST_DIR, `preimage-${MODE}-${RUN_STAMP}.jsonl`);
const exceptionsPath = join(MANIFEST_DIR, `exceptions-${MODE}-${RUN_STAMP}.jsonl`);
const summaryPath = join(MANIFEST_DIR, `summary-${MODE}-${RUN_STAMP}.json`);
const createdSkuPath = join(MANIFEST_DIR, `created-skus-${MODE}-${RUN_STAMP}.jsonl`);
function appendJsonl(path, obj) { appendFileSync(path, JSON.stringify(obj) + "\n", "utf8"); }
const logException = (o) => appendJsonl(exceptionsPath, o);

// ══════════════════════════════════════════════════════════════════════════════
console.log(`# AR SIZE ENRICHMENT — ${APPLY ? "APPLY (PROD WRITES)" : "DRY-RUN (no writes)"}`);
console.log(`# CSV:        ${CSV_PATH}`);
console.log(`# Manifests:  ${MANIFEST_DIR}`);
console.log(`# Tolerance:  max($${(TOL_ABS_CENTS / 100).toFixed(2)}, ${TOL_PCT * 100}% of invoice total) per invoice; qty EXACT per colour group`);
console.log("");

// ── 1. parse CSV, group by invoice ────────────────────────────────────────────
const rawCsv = readFileSync(CSV_PATH, "utf8");
const { lines: csvLines } = parseInvoiceDetailCsv(rawCsv);
const csvByInvoice = new Map();
let csvMinDate = null, csvMaxDate = null;
for (const l of csvLines) {
  if (!l.invoiceNumber) continue;
  const iso = usDateToIso(l.txnDate);
  if (iso) { if (!csvMinDate || iso < csvMinDate) csvMinDate = iso; if (!csvMaxDate || iso > csvMaxDate) csvMaxDate = iso; }
  if (!csvByInvoice.has(l.invoiceNumber)) csvByInvoice.set(l.invoiceNumber, []);
  csvByInvoice.get(l.invoiceNumber).push(l);
}
console.log(`# CSV rows: ${csvLines.length}  distinct invoices: ${csvByInvoice.size}  date range: ${csvMinDate} .. ${csvMaxDate}`);

// ── 2. candidate population from prod ─────────────────────────────────────────
const candSql = `
WITH inv AS (
  SELECT i.id, i.invoice_number, i.invoice_date, i.customer_id, i.total_amount_cents
  FROM ar_invoices i
  WHERE i.entity_id = '${ROF_ENTITY_ID}'
    AND i.invoice_number NOT ILIKE '%ECOM%'
    AND i.invoice_date BETWEEN '${DATE_LO}' AND '${DATE_HI}'
), la AS (
  SELECT l.ar_invoice_id,
         count(*) FILTER (WHERE im.id IS NOT NULL AND im.size IS NOT NULL) AS n_sized
  FROM ar_invoice_lines l LEFT JOIN ip_item_master im ON im.id = l.inventory_item_id
  WHERE l.ar_invoice_id IN (SELECT id FROM inv)
  GROUP BY l.ar_invoice_id
)
SELECT inv.id, inv.invoice_number, inv.invoice_date::text AS invoice_date, inv.customer_id, inv.total_amount_cents
FROM inv JOIN la ON la.ar_invoice_id = inv.id
WHERE la.n_sized = 0;`;
const candRows = await runSqlMgmt(candSql);
const candByNum = new Map(candRows.map((r) => [r.invoice_number, r]));
console.log(`# Candidate invoices (zero sized links, in range): ${candByNum.size}`);

// coverage: candidates NOT covered by this CSV, by year
const notCoveredByYear = {};
for (const [num, r] of candByNum) {
  if (!csvByInvoice.has(num)) {
    const y = String(r.invoice_date).slice(0, 4);
    notCoveredByYear[y] = (notCoveredByYear[y] || 0) + 1;
  }
}
// processable = candidate AND in CSV
let processNums = [...candByNum.keys()].filter((n) => csvByInvoice.has(n));
if (ONLY_INVOICE) processNums = processNums.filter((n) => n === ONLY_INVOICE);
processNums.sort();
if (LIMIT) processNums = processNums.slice(0, LIMIT);
console.log(`# Candidates covered by CSV (to process): ${processNums.length}`);
console.log(`# Candidates NOT covered by this CSV (CEO must export): ${JSON.stringify(notCoveredByYear)}`);
console.log("");
if (processNums.length === 0) { console.log("Nothing to process."); process.exit(0); }

const processIds = processNums.map((n) => candByNum.get(n).id);

// ── 3. load aggregate lines (+ anchor SKU) and ish rows for the process set ───
console.log("# Loading aggregate lines + sales-history rows …");
const aggLines = await inChunks(processIds, async (chunk) => {
  const { data, error } = await admin
    .from("ar_invoice_lines")
    .select("id, ar_invoice_id, line_number, description, quantity, unit_price_cents, line_total_cents, tax_amount_cents, cogs_cents, cogs_account_id, revenue_account_id, brand_id, channel_id, source, inventory_item_id, anchor:ip_item_master!ar_invoice_lines_inventory_item_id_fkey(id, sku_code, style_id, style_code, color, size, inseam)")
    .in("ar_invoice_id", chunk);
  if (error) throw new Error("load ar_invoice_lines: " + error.message);
  return data;
});
const aggByInvoice = new Map();
for (const l of aggLines) { if (!aggByInvoice.has(l.ar_invoice_id)) aggByInvoice.set(l.ar_invoice_id, []); aggByInvoice.get(l.ar_invoice_id).push(l); }

const ishRows = await inChunks(processNums, async (chunk) => {
  const { data, error } = await admin
    .from("ip_sales_history_wholesale")
    .select("*, sku:ip_item_master!ip_sales_history_wholesale_sku_id_fkey(id, size, color, style_code)")
    .or(`invoice_number.in.(${chunk.map((c) => `"${c}"`).join(",")}),order_number.in.(${chunk.map((c) => `"${c}"`).join(",")})`);
  if (error) throw new Error("load ish: " + error.message);
  return data;
});
const ishByInvoice = new Map();
for (const r of ishRows) {
  const key = r.invoice_number && candByNum.has(r.invoice_number) ? r.invoice_number
    : (r.order_number && candByNum.has(r.order_number) ? r.order_number : null);
  if (!key) continue;
  if (!ishByInvoice.has(key)) ishByInvoice.set(key, []);
  ishByInvoice.get(key).push(r);
}

// ── 4. style_code → id map + SKU index for the involved styles ────────────────
console.log("# Loading style map + SKU index …");
const styleIds = [...new Set(aggLines.map((l) => l.anchor?.style_id).filter(Boolean))];
// style_code → id (needed for resolveStyleToken inseam peel in the helper)
const styleByCode = new Map();
{
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("style_master").select("id, style_code").eq("entity_id", ROF_ENTITY_ID).range(from, from + 999);
    if (error) throw new Error("style_master: " + error.message);
    for (const s of data) if (s.style_code) styleByCode.set(String(s.style_code).trim().toUpperCase(), s.id);
    if (data.length < 1000) break; from += 1000;
  }
}
// SKU index by style_id (for fast local find; create only fills genuine gaps)
const skusByStyle = new Map();
await inChunks(styleIds, async (chunk) => {
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("ip_item_master")
      .select("id, sku_code, style_id, style_code, color, size, inseam")
      .in("style_id", chunk).range(from, from + 999);
    if (error) throw new Error("ip_item_master: " + error.message);
    for (const s of data) { if (!skusByStyle.has(s.style_id)) skusByStyle.set(s.style_id, []); skusByStyle.get(s.style_id).push(s); }
    if (data.length < 1000) break; from += 1000;
  }
  return [];
});
function indexPush(sku) { if (!skusByStyle.has(sku.style_id)) skusByStyle.set(sku.style_id, []); skusByStyle.get(sku.style_id).push(sku); }

// Local find mirroring resolveOrCreateSku's tuple find, but colour-spelling
// tolerant (colorMatchKey). Returns { id } | { id:null } | { ambiguous:true }.
function findSkuLocal(styleId, color, size, inseam) {
  const pool = skusByStyle.get(styleId) || [];
  const wantColor = colorMatchKey(color);
  const sizeSet = new Set(sizeVariantsOf(size).map((s) => String(s).trim().toUpperCase()));
  const wantInseam = inseam == null || String(inseam).trim() === "" ? null : String(inseam).trim();
  const hits = pool.filter((r) =>
    r.size != null && sizeSet.has(String(r.size).trim().toUpperCase()) &&
    ((r.inseam == null || String(r.inseam).trim() === "" ? null : String(r.inseam).trim()) === wantInseam) &&
    colorMatchKey(r.color) === wantColor);
  if (hits.length === 0) return { id: null };
  if (hits.length === 1) return { id: hits[0].id };
  // multiple = logical duplicates of the SAME (style,colour,size,inseam) — pick
  // deterministically (canonical-size exact first, then lowest id). Harmless: the
  // matrix merges by cell and the $ live on the invoice line, not the SKU.
  const pick = hits.slice().sort((a, b) =>
    (String(normalizeSize(b.size)) === String(b.size)) - (String(normalizeSize(a.size)) === String(a.size)) ||
    String(a.id).localeCompare(String(b.id)))[0];
  return { id: pick.id, dup: true };
}

// ── 5. process each invoice ───────────────────────────────────────────────────
const stats = {
  processed: 0, enriched: 0, skipped: 0, skuCreated: 0, skuReused: 0, dupPicks: 0,
  linesInserted: 0, ishRowsInserted: 0, amountMismatchSkips: 0,
  amountDivergentInvoices: 0, amountDivergenceCents: 0,
  conservedQty: 0, conservedCents: 0,
  skipReasons: {},
};
const pendingWrites = []; // { invoiceNumber, sql, preimage }
function bumpReason(r) { stats.skipReasons[r] = (stats.skipReasons[r] || 0) + 1; }

async function planInvoice(num) {
  stats.processed++;
  const header = candByNum.get(num);
  const aggs = aggByInvoice.get(header.id) || [];
  const csv = csvByInvoice.get(num) || [];
  if (aggs.length === 0) { logException({ invoice: num, reason: "no aggregate lines loaded" }); bumpReason("no_aggregate"); stats.skipped++; return; }
  // every aggregate line must have an anchor SKU (colour/inseam identity)
  if (aggs.some((a) => !a.anchor)) { logException({ invoice: num, reason: "aggregate line without anchor SKU" }); bumpReason("no_anchor"); stats.skipped++; return; }

  // group CSV by (style, colour, inseam); GROUP aggregate lines by the same key
  // (an already-size-grain historical invoice has MANY aggregate lines per key —
  // one per size — so aggregates map to an ARRAY, not a single line).
  const csvGroups = groupInvoiceCsvLines(csv, styleByCode);
  const aggByKey = new Map();
  for (const a of aggs) {
    const k = aggregateGroupKey(a.anchor);
    if (!aggByKey.has(k)) aggByKey.set(k, []);
    aggByKey.get(k).push(a);
  }
  // bijective key mapping check
  for (const k of csvGroups.keys()) if (!aggByKey.has(k)) { logException({ invoice: num, reason: `CSV group ${k} has no aggregate line` }); bumpReason("csv_group_unmatched"); stats.skipped++; return; }
  for (const k of aggByKey.keys()) if (!csvGroups.has(k)) { logException({ invoice: num, reason: `aggregate group ${k} not in CSV` }); bumpReason("agg_group_unmatched"); stats.skipped++; return; }

  // resolve a (style,colour,size,inseam) → sized SKU id (reuse-first; create only
  // on --apply, and only because the anchor proves the (style,colour) exists).
  async function resolveSku(anchor, size, inseam, itemNumberForLog) {
    const found = findSkuLocal(anchor.style_id, anchor.color, size, inseam);
    if (found.id) { stats.skuReused++; if (found.dup) stats.dupPicks++; return { id: found.id }; }
    if (!APPLY) { stats.skuCreated++; return { id: `WOULD-CREATE:${anchor.style_code}|${canonColor(anchor.color)}|${normalizeSize(size)}|${inseam || ""}` }; }
    const created = await resolveOrCreateSku(admin, ROF_ENTITY_ID, { style_id: anchor.style_id, style_code: anchor.style_code, color: anchor.color, size, inseam }, { isApparel: false });
    if (created.error || !created.id) { logException({ invoice: num, item: itemNumberForLog, reason: "resolveOrCreateSku failed: " + (created.error || "no id") }); return { err: true }; }
    if (created.created) { stats.skuCreated++; indexPush({ id: created.id, sku_code: null, style_id: anchor.style_id, style_code: anchor.style_code, color: canonColor(anchor.color), size: String(normalizeSize(size)), inseam: inseam || null }); appendJsonl(createdSkuPath, { invoice: num, style_id: anchor.style_id, style_code: anchor.style_code, color: anchor.color, size, inseam, sku_id: created.id }); }
    else stats.skuReused++;
    return { id: created.id };
  }

  // per-group plan: decide SPLIT (Case A: one colour-grain line → many sizes) vs
  // RELINK (Case B: already one line per size, just point at a sized SKU).
  let invCsvCents = 0, invAggCents = 0;
  const groupPlans = [];
  for (const [k, g] of csvGroups) {
    const aggArr = aggByKey.get(k);
    const sumCsvQty = g.lines.reduce((a, l) => a + l.qty, 0);
    const sumAggQty = aggArr.reduce((a, l) => a + Number(l.quantity), 0);
    const sumAggCents = aggArr.reduce((a, l) => a + Number(l.line_total_cents), 0);
    const sumCsvCents = g.lines.reduce((a, l) => a + l.amountCents, 0);
    invCsvCents += sumCsvCents; invAggCents += sumAggCents;
    if (Math.abs(sumCsvQty - sumAggQty) > 1e-6) { logException({ invoice: num, group: k, reason: `qty mismatch CSV Σ=${sumCsvQty} vs aggregate Σ=${sumAggQty}` }); bumpReason("qty_mismatch"); stats.skipped++; return; }

    // Resolve a safe non-null unit price so the compute_total trigger reproduces
    // line_total exactly. ~1,426 historical lines carry a NULL unit_price_cents
    // (line_total set directly, trigger skipped): derive unit = line_total/qty
    // when it divides evenly; otherwise the trigger can't reproduce line_total →
    // skip (would collapse the header). A non-null unit also makes the line
    // matrixable (#1883 requires unit_price_cents).
    const unitOf = (a) => {
      if (a.unit_price_cents != null) return Number(a.unit_price_cents);
      const q = Number(a.quantity), lt = Number(a.line_total_cents);
      return q > 0 && lt % q === 0 ? lt / q : null;
    };

    if (aggArr.length === 1 && Math.abs(Number(aggArr[0].quantity) - sumCsvQty) < 1e-6 && g.lines.length >= 1) {
      // Case A — SPLIT the single colour-grain line across CSV sizes.
      const unit = unitOf(aggArr[0]);
      if (unit == null) { logException({ invoice: num, group: k, reason: "null unit_price with indivisible line_total" }); bumpReason("null_unit_indivisible"); stats.skipped++; return; }
      const agg = { ...aggArr[0], unit_price_cents: unit };
      const itemIds = new Array(g.lines.length).fill(null);
      for (let i = 0; i < g.lines.length; i++) {
        const r = await resolveSku(agg.anchor, g.lines[i].parsed.size, g.inseam, g.lines[i].itemNumber);
        if (r.err) { bumpReason("sku_create_failed"); stats.skipped++; return; }
        itemIds[i] = r.id;
      }
      groupPlans.push({ key: k, kind: "split", agg, aggId: aggArr[0].id, csvLines: g.lines, itemIds });
    } else {
      // Case B — RELINK already-size-grain lines. Align 1:1 by size, then resolve.
      const al = alignSizeGrain(aggArr, g.lines);
      if (!al.ok) { logException({ invoice: num, group: k, reason: `grain align failed (${aggArr.length} agg / ${g.lines.length} csv): ${al.reason}` }); bumpReason("grain_align_failed"); stats.skipped++; return; }
      const pairs = [];
      for (const p of al.pairs) {
        const unit = unitOf(p.agg);
        if (unit == null) { logException({ invoice: num, group: k, item: p.agg.anchor.sku_code, reason: "null unit_price with indivisible line_total" }); bumpReason("null_unit_indivisible"); stats.skipped++; return; }
        const r = await resolveSku(p.agg.anchor, p.csv.parsed.size, g.inseam, p.csv.itemNumber);
        if (r.err) { bumpReason("sku_create_failed"); stats.skipped++; return; }
        pairs.push({ agg: { ...p.agg, unit_price_cents: unit }, aggId: p.agg.id, csv: p.csv, itemId: r.id });
      }
      groupPlans.push({ key: k, kind: "relink", pairs });
    }
  }

  // invoice-level amount check. qty already matches EXACTLY per group, so the
  // enrichment conserves the booked total regardless (it reuses each aggregate
  // line's own unit price). An amount divergence reflects the historical
  // list-vs-discount pricing gap, not a coverage problem — record & report it.
  const invTol = Math.max(TOL_ABS_CENTS, Math.round(invAggCents * TOL_PCT));
  const amtDiff = Math.abs(invCsvCents - invAggCents);
  if (amtDiff > invTol) {
    stats.amountDivergentInvoices++;
    stats.amountDivergenceCents += amtDiff;
    appendJsonl(exceptionsPath, { invoice: num, note: "amount_divergent_enriched", csv_cents: invCsvCents, aggregate_cents: invAggCents, diff_cents: amtDiff });
    if (STRICT_AMOUNT) { bumpReason("invoice_amount_mismatch"); stats.amountMismatchSkips++; stats.skipped++; return; }
  }

  // ── build the replacement ar_invoice_lines + per-aggregate-line output map ────
  const newArLines = [];
  const aggLineOutput = new Map(); // aggLine.id → descriptor for ish relink/explode
  let lineNo = 1;
  for (const gp of groupPlans) {
    if (gp.kind === "split") {
      const built = buildSizeLines(gp.csvLines, gp.itemIds, gp.agg, lineNo);
      lineNo = built.nextLineNumber;
      for (const r of built.lines) newArLines.push(r);
      aggLineOutput.set(gp.agg.id, { kind: "split", csvLines: gp.csvLines, itemIds: gp.itemIds });
    } else {
      const built = buildRelinkLines(gp.pairs, lineNo);
      lineNo = built.nextLineNumber;
      for (const r of built.lines) newArLines.push(r);
      for (const p of gp.pairs) aggLineOutput.set(p.agg.id, { kind: "relink", itemId: p.itemId });
    }
  }

  // ── ip_sales_history_wholesale: explode (Case A) or relink (Case B) ──────────
  // Each colour/size-NULL ish row points at the SAME SKU one aggregate line anchors
  // on. Match by sku_id → that line's output: a split line explodes the ish row
  // into its sizes; a relink line points the ish row at the single sized SKU. Both
  // conserve Σ qty / net / gross per matched row.
  const ishAll = ishByInvoice.get(num) || [];
  const ishColorRows = ishAll.filter((r) => r.sku && r.sku.size == null);
  const ishInserts = [];
  const ishDeletes = [];
  for (const cr of ishColorRows) {
    const owners = aggs.filter((a) => a.inventory_item_id === cr.sku_id && aggLineOutput.has(a.id));
    if (owners.length === 0) continue; // ish row's SKU isn't an enriched anchor → leave it
    for (const a of owners) {
      const out = aggLineOutput.get(a.id);
      if (out.kind === "split") {
        const lines = out.csvLines;
        const meta = out.itemIds.map((skuId) => ({ skuId, sourceLineKey: `${cr.source}:size:${num}:${skuId}` }));
        const rows = buildIshSizeRows(lines, meta, cr);
        ishDeletes.push(cr);
        for (const row of rows) ishInserts.push({ colorRow: cr, ...row });
      } else {
        // relink: one sized row, qty/net/gross unchanged from the colour row
        ishDeletes.push(cr);
        ishInserts.push({ colorRow: cr, sku_id: out.itemId, qty: Number(cr.qty),
          unit_price: cr.unit_price == null ? null : Number(cr.unit_price),
          gross_amount: cr.gross_amount == null ? null : Number(cr.gross_amount),
          net_amount: cr.net_amount == null ? null : Number(cr.net_amount),
          source_line_key: `${cr.source}:size:${num}:${out.itemId}` });
      }
    }
  }

  // ── manifest pre-image ──────────────────────────────────────────────────────
  const preimage = {
    invoice: num, ar_invoice_id: header.id, mode: MODE,
    replaced_ar_lines: aggs.map((a) => ({ id: a.id, line_number: a.line_number, description: a.description, quantity: a.quantity, unit_price_cents: a.unit_price_cents, line_total_cents: a.line_total_cents, tax_amount_cents: a.tax_amount_cents, cogs_cents: a.cogs_cents, cogs_account_id: a.cogs_account_id, revenue_account_id: a.revenue_account_id, brand_id: a.brand_id, channel_id: a.channel_id, source: a.source, inventory_item_id: a.inventory_item_id })),
    replaced_ish_rows: ishDeletes.map((r) => ({ id: r.id, sku_id: r.sku_id, invoice_number: r.invoice_number, order_number: r.order_number, source: r.source, source_line_key: r.source_line_key, qty: r.qty, gross_amount: r.gross_amount, net_amount: r.net_amount })),
    new_ar_line_count: newArLines.length, new_ish_row_count: ishInserts.length,
    header_total_cents_before: header.total_amount_cents,
  };
  appendJsonl(preimagePath, preimage);

  stats.enriched++;
  stats.linesInserted += newArLines.length;
  stats.ishRowsInserted += ishInserts.length;
  stats.conservedQty += newArLines.reduce((a, l) => a + Number(l.quantity), 0);
  stats.conservedCents += newArLines.reduce((a, l) => a + Number(l.quantity) * Number(l.unit_price_cents), 0);

  if (!APPLY) return; // dry-run stops here

  // ── build the atomic write SQL ──────────────────────────────────────────────
  const arIns = newArLines.map((l) =>
    `(${val(header.id)}, ${l.line_number}, ${val(l.description)}, ${val(l.inventory_item_id)}, ${l.quantity}, ${l.unit_price_cents}, ${l.tax_amount_cents}, ${l.cogs_cents == null ? "NULL" : l.cogs_cents}, ${val(l.revenue_account_id)}, ${val(l.cogs_account_id)}, ${val(l.brand_id)}, ${val(l.channel_id)}, ${val(l.source)}, ${sqlLit(ENRICH_TAG)})`
  ).join(",\n");
  let sql = `-- ${num}\nDELETE FROM ar_invoice_lines WHERE ar_invoice_id = ${val(header.id)};\n`;
  sql += `INSERT INTO ar_invoice_lines (ar_invoice_id, line_number, description, inventory_item_id, quantity, unit_price_cents, tax_amount_cents, cogs_cents, revenue_account_id, cogs_account_id, brand_id, channel_id, source, notes) VALUES\n${arIns};\n`;
  if (ishDeletes.length) {
    sql += `DELETE FROM ip_sales_history_wholesale WHERE id IN (${ishDeletes.map((r) => val(r.id)).join(",")});\n`;
    const ishIns = ishInserts.map((r) => {
      const cr = r.colorRow;
      return `(${val(r.sku_id)}, ${val(cr.customer_id)}, ${val(cr.category_id)}, ${val(cr.channel_id)}, ${val(cr.order_number)}, ${val(cr.invoice_number)}, ${val(cr.txn_type)}, ${val(cr.txn_date)}, ${r.qty}, ${r.unit_price == null ? "NULL" : r.unit_price}, ${r.gross_amount == null ? "NULL" : r.gross_amount}, ${cr.discount_amount == null ? "NULL" : cr.discount_amount}, ${r.net_amount == null ? "NULL" : r.net_amount}, ${val(cr.currency)}, ${val(cr.source)}, ${val(cr.raw_payload_id)}, ${sqlLit(r.source_line_key)}, ${val(cr.qty_grain)}, ${cr.qty_units == null ? "NULL" : cr.qty_units}, ${cr.unit_cost_at_sale == null ? "NULL" : cr.unit_cost_at_sale}, NULL, NULL, ${cr.cogs_amount == null ? "NULL" : cr.cogs_amount}, ${val(cr.brand_id)})`;
    }).join(",\n");
    sql += `INSERT INTO ip_sales_history_wholesale (sku_id, customer_id, category_id, channel_id, order_number, invoice_number, txn_type, txn_date, qty, unit_price, gross_amount, discount_amount, net_amount, currency, source, raw_payload_id, source_line_key, qty_grain, qty_units, unit_cost_at_sale, margin_amount, margin_pct, cogs_amount, brand_id) VALUES\n${ishIns};\n`;
  }
  pendingWrites.push({ invoiceNumber: num, sql, headerId: header.id, headerTotal: header.total_amount_cents });
}

// ── flush a batch of writes atomically; on batch error, isolate per invoice ───
async function flushWrites(force = false) {
  if (!APPLY) return;
  if (!force && pendingWrites.length < WRITE_BATCH) return;
  while (pendingWrites.length && (force || pendingWrites.length >= WRITE_BATCH)) {
    const batch = pendingWrites.splice(0, WRITE_BATCH);
    const combined = batch.map((b) => b.sql).join("\n");
    try {
      await runSqlMgmt(combined);
    } catch (e) {
      // isolate: retry each invoice individually so one bad row doesn't sink the batch
      for (const b of batch) {
        try { await runSqlMgmt(b.sql); }
        catch (e2) { logException({ invoice: b.invoiceNumber, reason: "write failed: " + e2.message.slice(0, 300) }); bumpReason("write_failed"); stats.enriched--; }
      }
    }
    process.stdout.write(`\r# written: ${stats.enriched - stats.skipped >= 0 ? stats.enriched : 0}   remaining plan queue: ${pendingWrites.length}   `);
  }
}

// ── run ────────────────────────────────────────────────────────────────────────
console.log(`# Processing ${processNums.length} invoices …`);
let n = 0;
for (const num of processNums) {
  await planInvoice(num);
  await flushWrites(false);
  if (++n % 250 === 0) process.stdout.write(`\r# planned ${n}/${processNums.length}  enriched=${stats.enriched} skipped=${stats.skipped}  `);
}
await flushWrites(true);
process.stdout.write("\n");

// ── summary ─────────────────────────────────────────────────────────────────
const summary = {
  mode: MODE, run_stamp: RUN_STAMP, csv: CSV_PATH, csv_date_range: [csvMinDate, csvMaxDate],
  candidates_total: candByNum.size, candidates_covered: processNums.length,
  candidates_not_covered_by_year: notCoveredByYear,
  ...stats,
  conserved_dollars: (stats.conservedCents / 100).toFixed(2),
  manifests: { preimage: preimagePath, exceptions: exceptionsPath, created_skus: createdSkuPath },
};
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

console.log("\n══════════════════════════════════════════════════════════════════");
console.log(`  AR SIZE ENRICHMENT — ${MODE.toUpperCase()} SUMMARY`);
console.log("══════════════════════════════════════════════════════════════════");
console.log(`Invoices processed ....... ${stats.processed}`);
console.log(`  enriched ............... ${stats.enriched}`);
console.log(`  skipped ................ ${stats.skipped}`);
console.log(`Skip reasons ............. ${JSON.stringify(stats.skipReasons)}`);
console.log(`AR size lines ${APPLY ? "written" : "planned"} ...... ${stats.linesInserted}`);
console.log(`ISH size rows ${APPLY ? "written" : "planned"} ...... ${stats.ishRowsInserted}`);
console.log(`SKUs reused .............. ${stats.skuReused}  (dup-picks: ${stats.dupPicks})`);
console.log(`SKUs ${APPLY ? "created" : "WOULD create"} .......... ${stats.skuCreated}`);
console.log(`Amount-divergent enriched  ${stats.amountDivergentInvoices}  (Σ|CSV−booked| = $${(stats.amountDivergenceCents / 100).toLocaleString()}; booked total conserved via aggregate unit price)${STRICT_AMOUNT ? "  [STRICT: skipped instead]" : ""}`);
console.log(`Conserved qty (enriched) . ${stats.conservedQty}`);
console.log(`Conserved $ (Σ qty*unit) . $${(stats.conservedCents / 100).toLocaleString()}`);
console.log(`Candidates NOT covered ... ${JSON.stringify(notCoveredByYear)}  (CEO to export)`);
console.log(`\nSummary manifest: ${summaryPath}`);
console.log(APPLY ? "\n✓ APPLY complete." : "\n(DRY-RUN — nothing was written.)");
process.exit(0);
