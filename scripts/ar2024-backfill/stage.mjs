// scripts/ar2024-backfill/stage.mjs
//
// Stage the Sep–Dec 2024 AR sources into ip_sales_history_wholesale so the
// existing ar-backfill runner (driver v3) can post them.
//
//   node scripts/ar2024-backfill/stage.mjs --dir C:\tmp\ar2024 [--skip-sync]
//
// Steps:
//   1. Load + tie the invoice registry (5,373 invoices, monthly targets to
//      the cent) and the item detail (verbatim Xoro lines).
//   2. Feed the filtered detail CSV through the PRODUCTION ingest handler
//      (api/_handlers/sales/sync-invoices.js, local harness) — identical
//      SKU/customer/channel resolution, PPK routing, grain + avg-cost logic
//      the 2025+ history went through. source='excel', upsert-idempotent.
//   3. Create two inactive pseudo-items (AR2024-FREIGHT / AR2024-NODETAIL)
//      — ip_sales_history_wholesale.sku_id is NOT NULL, so synthetic rows
//      need a master row. active=false keeps them out of planning pickers.
//   4. Insert freight top-up rows (header total − item lines, source=
//      'ar2024_synth') so every invoice's lines sum EXACTLY to its header.
//      Customer/channel/txn_date are copied from the invoice's item rows —
//      the runner groups by (invoice_number, txn_date, customer_id).
//   5. Insert one summary row per header-only invoice (1,051 invoices with
//      zero item lines in Xoro — confirmed by two independent exports):
//      Macys micro-invoices are consignment-style → revenue-only (no cost);
//      wholesale ones carry estimated COGS at the period blended cost ratio
//      of the SKU-lined invoices, per channel (ROF / PT wholesale).
//   6. Assert per-invoice staged totals == header totals for ALL invoices.
//
// Idempotent: re-runs upsert the same source_line_keys.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENTITY_CODE, FREIGHT_SKU, MACYS_NAME, MONTHLY_TARGETS, PENNY_ADJUST_CENTS,
  ROOT, SUMMARY_SKU, SYNTH_SOURCE, WINDOW_HI, WINDOW_LO,
  adminClient, assertMonthlyTargets, loadDetailRows, loadEnv, loadHeaders,
  money, runSql, sqlQuote, startLocalHandler, toCents, usDateToIso,
} from "./lib.mjs";

const args = process.argv.slice(2);
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : "C:\\tmp\\ar2024";
const skipSync = args.includes("--skip-sync");

const env = loadEnv();
const admin = adminClient(env);

// ── 1. sources + tie-out ────────────────────────────────────────────────────
const { headers, excluded } = loadHeaders(dir);
assertMonthlyTargets(headers);
console.log(`headers: ${headers.size} invoices in window; ${excluded.length} out-of-window rows excluded (already-loaded Jan-2025 re-exports)`);

const detailRows = loadDetailRows(dir, headers);
console.log(`detail: ${detailRows.length} item rows belong to the header set`);

// Per-invoice expected item-line sum (rows the sync handler will keep:
// item number present, qty > 0, not a chargeback reversal) + penny adjust.
const keptSumByInv = new Map();
const pennyLeft = { ...PENNY_ADJUST_CENTS };
const outRows = [];
let zeroPricedRows = 0;
for (const src of detailRows) {
  let r = src;
  const inv = String(r["Invoice Number"] || "").trim();
  const h = headers.get(inv);
  const txn = usDateToIso(r["Txn Date"]);
  if (txn !== h.date) throw new Error(`Line txn_date ${txn} != header date ${h.date} for ${inv} — grouping would split; halt`);
  const item = String(r["Item Number"] || "").trim();
  const desc = String(r["Description"] || "").trim();
  const qty = money(r["Qty"]) ?? 0;
  const kept = Boolean(item) && qty > 0 && !(/CBREVERSAL/i.test(item) && /cb\s*reversal/i.test(desc));
  let amtCents = toCents(money(r["Amount"]) ?? 0);
  if (kept && pennyLeft[inv]) {
    amtCents += pennyLeft[inv];
    delete pennyLeft[inv];
    r = { ...r, Amount: (amtCents / 100).toFixed(2) };
  }
  // Xoro records some fully-discounted lines with Amount=0 but a real Unit
  // Price. The ingest falls back to qty × unit_price when Amount is 0, which
  // would overstate the invoice vs its header — zero the price so the line
  // stages at $0 (the header's own valuation of it). 679 rows / $26,998.27
  // gross in this window.
  if (kept && amtCents === 0 && (money(r["Unit Price"]) ?? 0) * qty > 0) {
    r = { ...r, "Unit Price": "0" };
    zeroPricedRows++;
  }
  outRows.push(r);
  if (kept) keptSumByInv.set(inv, (keptSumByInv.get(inv) || 0) + amtCents);
}
if (Object.keys(pennyLeft).length) throw new Error(`Penny-adjust invoices not found in detail: ${Object.keys(pennyLeft).join(", ")}`);
console.log(`fully-discounted lines re-priced to $0: ${zeroPricedRows}`);

// ── 2. production ingest (local harness) ────────────────────────────────────
if (!skipSync) {
  const cols = ["Txn Date", "Item Number", "Description", "Sale Store", "Qty", "Amount", "Invoice Number", "Customer", "Unit Price", "Full Payment Date", "Invoice Payment Status"];
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(","), ...outRows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");

  process.env.DESIGN_CALENDAR_API_TOKEN ||= "ar2024-local-harness";
  const srv = await startLocalHandler(resolve(ROOT, "api", "_handlers", "sales", "sync-invoices.js"), { parseJsonBody: false });
  try {
    const form = new FormData();
    form.append("invoices", new Blob([csv], { type: "text/csv" }), "InvoiceDetail_ar2024_sepdec.csv");
    const res = await fetch(`${srv.url}/api/sales/sync-invoices`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.DESIGN_CALENDAR_API_TOKEN}` },
      body: form,
    });
    const j = await res.json();
    if (!res.ok || !j.processed) throw new Error(`sync-invoices failed: ${JSON.stringify(j).slice(0, 2000)}`);
    console.log("sync-invoices:", JSON.stringify({
      csv_rows: j.csv_rows, sales_upserted: j.sales_upserted, duplicates_merged: j.duplicates_merged,
      new_items_created: j.new_items_created, new_customers_created: j.new_customers_created,
      ppk_token_routed: j.ppk_token_routed, pack_priced_as_unit_reclassified: j.pack_priced_as_unit_reclassified,
      avg_cost_lookups: j.avg_cost_lookups, skipped_zero_qty: j.skipped_zero_qty,
      errors: (j.errors || []).length,
    }));
    if ((j.errors || []).some((e) => !/^\[grain-reclassify\]/.test(e))) {
      console.error("sync-invoices errors:", j.errors.filter((e) => !/^\[grain-reclassify\]/.test(e)).slice(0, 20));
      throw new Error("sync-invoices reported hard errors — halt");
    }
  } finally { await srv.close(); }
}

// ── 3. pseudo-items ─────────────────────────────────────────────────────────
const pseudoItems = [
  { sku_code: FREIGHT_SKU, style_code: FREIGHT_SKU, description: "Freight & other charges — AR Sep-Dec 2024 backfill top-up (header minus item lines)", uom: "each", active: false, is_apparel: false, pack_size: 1 },
  { sku_code: SUMMARY_SKU, style_code: SUMMARY_SKU, description: "Invoice summary — AR Sep-Dec 2024 backfill (no item detail exists in Xoro)", uom: "each", active: false, is_apparel: false, pack_size: 1 },
];
{
  const { data, error } = await admin.from("ip_item_master")
    .upsert(pseudoItems, { onConflict: "sku_code", ignoreDuplicates: false })
    .select("id, sku_code");
  if (error) throw new Error(`pseudo-item upsert failed: ${error.message}`);
  var pseudoIdByCode = new Map(data.map((r) => [r.sku_code, r.id]));
}
console.log("pseudo-items:", Object.fromEntries(pseudoIdByCode));

// ── staged item rows (paged read; PostgREST caps at 1000/page) ──────────────
const staged = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await admin.from("ip_sales_history_wholesale")
    .select("invoice_number, customer_id, channel_id, txn_date, net_amount, qty, unit_cost_at_sale")
    .gte("txn_date", WINDOW_LO).lte("txn_date", WINDOW_HI)
    .eq("source", "excel")
    .not("invoice_number", "is", null)
    .order("id", { ascending: true })
    .range(from, from + 999);
  if (error) throw new Error(`staged read failed: ${error.message}`);
  staged.push(...(data || []));
  if (!data || data.length < 1000) break;
}
console.log(`staged item rows in window: ${staged.length}`);

const byInv = new Map();
for (const r of staged) {
  if (!headers.has(r.invoice_number)) throw new Error(`Staged row for unknown invoice ${r.invoice_number} in window — halt`);
  const g = byInv.get(r.invoice_number) || { sumCents: 0, customer_id: r.customer_id, channel_id: r.channel_id, txn_date: r.txn_date, keys: new Set() };
  g.sumCents += toCents(Number(r.net_amount) || 0);
  g.keys.add(`${r.customer_id}|${r.txn_date}`);
  byInv.set(r.invoice_number, g);
}
for (const [inv, g] of byInv) {
  if (g.keys.size > 1) throw new Error(`Invoice ${inv} staged with multiple (customer, txn_date) groups — the runner would split it; halt`);
  const expect = keptSumByInv.get(inv);
  if (expect == null || expect !== g.sumCents) {
    throw new Error(`Invoice ${inv}: staged net ${g.sumCents}c != expected item sum ${expect}c — halt`);
  }
}

// ── channel + blended cost ratios (per wholesale channel) ───────────────────
const { data: channels } = await admin.from("ip_channel_master").select("id, channel_code").in("channel_code", ["ROF", "PT", "ROF ECOM", "PT ECOM"]);
const chanIdByCode = new Map((channels || []).map((c) => [c.channel_code, c.id]));
const chanCodeById = new Map((channels || []).map((c) => [c.id, c.channel_code]));

// COGS the runner will actually post per row = round(round(cost*100) × qty)
// (native-grain qty × per-unit snapshot cost — the driver-v3 formula). The
// blended ratio for header-only estimates uses the same formula so the
// estimate matches what the SKU-lined invoices post to 5010/5012.
const ratioAgg = {}; // channel code → { cogs, net } over rows WITH resolved cost
for (const r of staged) {
  const code = chanCodeById.get(r.channel_id);
  if (code !== "ROF" && code !== "PT") continue; // wholesale only
  if (r.unit_cost_at_sale == null || !(Number(r.qty) > 0)) continue;
  ratioAgg[code] ??= { cogs: 0, net: 0 };
  ratioAgg[code].cogs += Math.round(Math.round(Number(r.unit_cost_at_sale) * 100) * Number(r.qty)) / 100;
  ratioAgg[code].net += Number(r.net_amount) || 0;
}
const ratios = Object.fromEntries(Object.entries(ratioAgg).map(([k, v]) => [k, v.net > 0 ? v.cogs / v.net : 0]));
console.log("blended cost ratios (SKU-lined wholesale rows with cost):", JSON.stringify(ratios));
if (!(ratios.ROF > 0.05 && ratios.ROF < 0.95)) throw new Error(`ROF blended cost ratio ${ratios.ROF} implausible — halt`);

// ── 4. freight top-up rows ──────────────────────────────────────────────────
const freightRows = [];
let freightCents = 0;
for (const [inv, g] of byInv) {
  const delta = headers.get(inv).totalCents - g.sumCents;
  if (delta === 0) continue;
  if (delta < 0) throw new Error(`Invoice ${inv}: item lines exceed header by ${-delta}c — halt (penny-adjust list incomplete?)`);
  freightCents += delta;
  freightRows.push({
    sku_id: pseudoIdByCode.get(FREIGHT_SKU),
    customer_id: g.customer_id,
    channel_id: g.channel_id,
    invoice_number: inv,
    txn_type: "invoice",
    txn_date: g.txn_date,
    qty: 0, qty_grain: "unit", qty_units: 0,
    unit_price: null,
    gross_amount: delta / 100,
    net_amount: delta / 100,
    currency: "USD",
    source: SYNTH_SOURCE,
    source_line_key: `ar2024:freight:${inv}`,
  });
}

// ── 5. header-only summary rows ─────────────────────────────────────────────
const unlined = [...headers.values()].filter((h) => !byInv.has(h.inv));
const summaryNames = [...new Set(unlined.map((h) => h.customer))];
const custIdByName = new Map();
const canonName = (s) => String(s).trim().toUpperCase().replace(/\s+/g, " ");
{
  const { data, error } = await admin.from("ip_customer_master").select("id, name").in("name", summaryNames);
  if (error) throw new Error(`ip_customer_master lookup failed: ${error.message}`);
  for (const c of data || []) custIdByName.set(canonName(c.name), c.id);
  // Fallback for spacing/case variants the exact IN() missed.
  for (const n of summaryNames) {
    if (custIdByName.has(canonName(n))) continue;
    const { data: alt } = await admin.from("ip_customer_master").select("id, name").ilike("name", n.trim());
    if (alt?.length === 1) custIdByName.set(canonName(n), alt[0].id);
    else if ((alt?.length ?? 0) > 1) throw new Error(`Customer name "${n}" matches ${alt.length} ip_customer_master rows — resolve manually`);
  }
}
const summaryRows = [];
const treatment = { revenue_only: { n: 0, cents: 0 }, est_cogs: { n: 0, cents: 0, cogsCents: 0 } };
for (const h of unlined) {
  const custId = custIdByName.get(h.customer.toUpperCase().replace(/\s+/g, " "));
  if (!custId) throw new Error(`Header-only invoice ${h.inv}: customer "${h.customer}" not in ip_customer_master — halt`);
  const chanCode = h.inv.startsWith("PT") ? "PT" : "ROF"; // all 1,051 are wholesale (ROF-I / PT-I prefixes)
  const isMacys = h.customer === MACYS_NAME;
  const estCogsCents = isMacys ? null : Math.round((ratios[chanCode] ?? ratios.ROF) * h.totalCents);
  if (isMacys) { treatment.revenue_only.n++; treatment.revenue_only.cents += h.totalCents; }
  else { treatment.est_cogs.n++; treatment.est_cogs.cents += h.totalCents; treatment.est_cogs.cogsCents += estCogsCents; }
  // est-COGS rows use qty=1 so the runner's cogs = round(unit_cost*100)*qty
  // reproduces the estimate exactly; Macys keeps the header qty (no cost math).
  const qty = isMacys ? Math.max(1, Math.round(h.qty)) : 1;
  summaryRows.push({
    sku_id: pseudoIdByCode.get(SUMMARY_SKU),
    customer_id: custId,
    channel_id: chanIdByCode.get(chanCode),
    invoice_number: h.inv,
    txn_type: "invoice",
    txn_date: h.date,
    qty, qty_grain: "unit", qty_units: qty,
    unit_price: null,
    gross_amount: h.totalCents / 100,
    net_amount: h.totalCents / 100,
    currency: "USD",
    source: SYNTH_SOURCE,
    source_line_key: `ar2024:summary:${h.inv}`,
    unit_cost_at_sale: estCogsCents != null ? estCogsCents / 100 : null,
    cogs_amount: estCogsCents != null ? estCogsCents / 100 : null,
    margin_amount: estCogsCents != null ? (h.totalCents - estCogsCents) / 100 : null,
    margin_pct: estCogsCents != null && h.totalCents > 0 ? (h.totalCents - estCogsCents) / h.totalCents : null,
  });
}

for (const [label, rows] of [["freight", freightRows], ["summary", summaryRows]]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("ip_sales_history_wholesale")
      .upsert(rows.slice(i, i + 500), { onConflict: "source,source_line_key", ignoreDuplicates: false });
    if (error) throw new Error(`${label} upsert chunk ${i} failed: ${error.message}`);
  }
  console.log(`${label} rows upserted: ${rows.length}`);
}
console.log(`freight top-up: ${freightRows.length} rows, $${(freightCents / 100).toFixed(2)}`);
console.log(`header-only treatments: revenue-only (Macys) ${treatment.revenue_only.n} / $${(treatment.revenue_only.cents / 100).toFixed(2)}; est-COGS ${treatment.est_cogs.n} / $${(treatment.est_cogs.cents / 100).toFixed(2)} (est COGS $${(treatment.est_cogs.cogsCents / 100).toFixed(2)})`);

// ── 6. final staging tie-out (SQL, per invoice, all 5,373) ──────────────────
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
       count(*) total,
       coalesce(sum(s.cents),0) staged_cents,
       coalesce(sum(e.cents),0) expected_cents
from expected e left join staged s on s.inv = e.inv;`);
console.log("staging tie-out:", JSON.stringify(tie));
if (Number(tie.mismatches) !== 0 || Number(tie.staged_cents) !== Number(tie.expected_cents)) {
  throw new Error("Staging tie-out FAILED — do not post");
}
console.log("STAGE OK — every invoice's staged lines sum exactly to its header total.");
