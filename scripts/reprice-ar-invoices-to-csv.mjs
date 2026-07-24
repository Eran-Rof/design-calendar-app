#!/usr/bin/env node
/**
 * scripts/reprice-ar-invoices-to-csv.mjs
 *
 * AR historical invoice REPRICE / FILL to the Xoro CSV (dry-run default; --apply
 * writes PROD). Follow-up to #1898's size ENRICHMENT (which conserved each
 * invoice's booked total). Here we intentionally CHANGE the subledger total of the
 * invoices whose stored `ar_invoices.total_amount_cents` disagrees with the Xoro
 * "Invoice Detail Report" CSV, to bring the AR subledger into agreement with the
 * Xoro GL. Covers two shapes:
 *   • REPRICE  — an already-size-grain invoice booked at LIST while Xoro invoiced
 *                a DISCOUNTED amount (subledger > CSV).
 *   • FILL     — an under-captured invoice whose historical aggregate is MISSING
 *                styles the CSV carries (subledger < CSV).
 *   • FILL-EQUAL (--fill-equal) — an aggregate-only invoice (zero sized lines,
 *                e.g. a single styleless "Historical line") whose booked total
 *                ALREADY equals the CSV and the GL. The default pass skips these
 *                as "already correct"; #1898's enrichment skipped them because the
 *                aggregate has no style/colour to group-match. This mode rebuilds
 *                ONLY such invoices — content changes, header total does NOT.
 * All are handled by REBUILDING the invoice's lines to exactly the CSV, priced at
 * the CSV amount, so the post-fix total == CSV total.
 *
 * GL-LINKAGE PRE-CHECK (established 2026-07-22; see project memory):
 *   ar_invoices totals are SUBLEDGER-ONLY — no journal_entry has source_table
 *   ='ar_invoices' (verified 0). GL revenue/AR is posted independently by the
 *   Xoro GL mirror (journal_type='xoro_gl_mirror'), linked via ar_invoices
 *   .accrual_je_id. So changing a subledger total posts NOTHING to the GL; it only
 *   re-states the subledger. To guarantee the change IMPROVES (never breaks) the
 *   AR↔GL tie we gate on the GL: an invoice is only rebuilt when
 *     |CSV total − GL AR debit| <= tolerance   (CSV == the Xoro receivable).
 *   This EXCLUDES ecom-like invoices that carry web "Shipping income" (where GL AR
 *   = merchandise + shipping > CSV merchandise) and any genuine CSV≠GL mismatch —
 *   both are ITEMIZED to a manifest for the CEO/controller, never auto-corrected.
 *   Because no JE is touched, closed periods (FY24/25, Jan–May 2026) receive NO
 *   posting — the subledger correction simply moves onto the already-posted GL.
 *
 *   node scripts/reprice-ar-invoices-to-csv.mjs                         # dry-run all
 *   node scripts/reprice-ar-invoices-to-csv.mjs --invoice PT-I004445    # one
 *   node scripts/reprice-ar-invoices-to-csv.mjs --apply                 # WRITE PROD
 *   node scripts/reprice-ar-invoices-to-csv.mjs --fill-equal [--apply]  # equal-total aggregate-only fill
 *
 * Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (JWT) + SUPABASE_PAT.
 */
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseInvoiceDetailCsv, groupInvoiceCsvLines, buildRepriceLines, buildIshSizeRows,
} from "../api/_lib/arSizeEnrich.js";
import { colorMatchKey, sizeVariantsOf, resolveStyleToken } from "../api/_lib/xoroLineMatch.js";
import { canonColor, normalizeSize, resolveOrCreateSku } from "../api/_lib/styleMatrix.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const ROF_ENTITY_ID = "404b8a6b-0d2d-44d2-8539-9064ff0fafee";
const DATE_LO = "2024-09-01", DATE_HI = "2026-07-07";
const CLOSED_THRU = "2026-05"; // FY24/25 + Jan–May 2026 closed
const CSV_FILES = [
  "C:/Users/Eran.RINGOFFIRE/Downloads/Invoice Detail Report 5 (1).csv",
  "C:/Users/Eran.RINGOFFIRE/Downloads/Invoice Detail Report 5 (2).csv",
  "C:/Users/Eran.RINGOFFIRE/Downloads/Invoice Detail Report 5 (3).csv",
];
const MANIFEST_DIR = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/ar-size-enrichment-2026-07-22";
const TOL_CENTS = 5;                    // GL/CSV equality tolerance
const REPRICE_TAG = "[ar-size-reprice 2026-07-22]";
const FILL_EQUAL_TAG = "[ar-size-fill-equal 2026-07-22]";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FILL_EQUAL = args.includes("--fill-equal");
const NOTES_TAG = FILL_EQUAL ? FILL_EQUAL_TAG : REPRICE_TAG;
const ISH_KEY_KIND = FILL_EQUAL ? "fillequal" : "reprice";
const FILE_PREFIX = FILL_EQUAL ? "fillequal" : "reprice";
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const ONLY_INVOICE = argVal("--invoice");
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : null;
const CSV_OVERRIDE = args.filter((a, i) => args[i - 1] === "--csv");
const WRITE_BATCH = Number(argVal("--write-batch") || 40);

function loadEnv(file) {
  try { return Object.fromEntries(readFileSync(resolve(ROOT, file), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = (env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const PAT = process.env.SUPABASE_PAT || env.SUPABASE_PAT;
if (!SB_URL || !SERVICE_KEY || SERVICE_KEY.startsWith("sb_secret_")) { console.error("✗ need VITE_SUPABASE_URL + JWT SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!SB_URL.includes(PROD_REF)) { console.error(`✗ not prod (${PROD_REF})`); process.exit(1); }
if (APPLY && !PAT) { console.error("✗ --apply needs SUPABASE_PAT"); process.exit(1); }
const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function runSqlMgmt(sql, { retries = 6 } = {}) {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) });
    if (res.status === 429 || res.status >= 500) { if (attempt >= retries) throw new Error(`Mgmt API ${res.status} after ${retries} retries`); await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 15000); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`Mgmt API ${res.status}: ${text.slice(0, 400)}`);
    try { return JSON.parse(text); } catch { return []; }
  }
}
const sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const val = (v) => (v == null ? "NULL" : (typeof v === "number" ? String(v) : sqlLit(v)));
async function inChunks(ids, fn, size = 100) { const out = []; for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size)))); return out; }

mkdirSync(MANIFEST_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const MODE = APPLY ? "apply" : "dryrun";
const preimagePath = join(MANIFEST_DIR, `${FILE_PREFIX}-preimage-${MODE}-${STAMP}.jsonl`);
const itemizePath = join(MANIFEST_DIR, `${FILE_PREFIX}-itemize-${MODE}-${STAMP}.jsonl`);
const summaryPath = join(MANIFEST_DIR, `${FILE_PREFIX}-summary-${MODE}-${STAMP}.json`);
const appendJsonl = (p, o) => appendFileSync(p, JSON.stringify(o) + "\n", "utf8");

console.log(`# AR ${FILL_EQUAL ? "FILL-EQUAL (aggregate-only, total unchanged)" : "REPRICE/FILL"} to CSV — ${APPLY ? "APPLY (PROD WRITES)" : "DRY-RUN"}`);
console.log(`# GL gate: rebuild only when |CSV − GL AR| <= ${TOL_CENTS}c (SHIP/ecom + mismatch itemized)`);

// ── 1. parse CSVs → per-invoice line sets (dedupe across files by most-lines) ─
const files = CSV_OVERRIDE.length ? CSV_OVERRIDE : CSV_FILES;
const csvByInvoice = new Map();
for (const f of files) {
  const { lines } = parseInvoiceDetailCsv(readFileSync(f, "utf8"));
  const perFile = new Map();
  for (const l of lines) { if (!l.invoiceNumber) continue; if (!perFile.has(l.invoiceNumber)) perFile.set(l.invoiceNumber, []); perFile.get(l.invoiceNumber).push(l); }
  for (const [inv, ls] of perFile) { const cur = csvByInvoice.get(inv); if (!cur || ls.length > cur.length) csvByInvoice.set(inv, ls); }
}
const csvTotalCents = (inv) => (csvByInvoice.get(inv) || []).reduce((a, l) => a + Math.round(l.amountCents), 0);
console.log(`# CSV invoices: ${csvByInvoice.size}`);

// ── 2. target selection: in-range wholesale invoices + GL AR / merch / ship ──
// --fill-equal only targets aggregate-only invoices (zero size-grain lines); the
// filter is essential — without it every already-enriched invoice (equal totals
// by construction) would be pointlessly rebuilt.
const unsizedFilter = FILL_EQUAL ? `
    AND NOT EXISTS (
      SELECT 1 FROM ar_invoice_lines sl JOIN ip_item_master sim ON sim.id = sl.inventory_item_id
      WHERE sl.ar_invoice_id = i.id AND sim.size IS NOT NULL)` : "";
const selSql = `
WITH inv AS (
  SELECT i.id, i.invoice_number, to_char(i.invoice_date,'YYYY-MM') period, i.invoice_date::text idate, i.total_amount_cents, i.accrual_je_id
  FROM ar_invoices i WHERE i.entity_id='${ROF_ENTITY_ID}'
    AND i.invoice_number NOT ILIKE '%ECOM%' AND i.invoice_date BETWEEN '${DATE_LO}' AND '${DATE_HI}'${unsizedFilter})
SELECT inv.id, inv.invoice_number, inv.period, inv.idate, inv.total_amount_cents,
  round(coalesce((SELECT sum(l.debit) FROM journal_entry_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.journal_entry_id=inv.accrual_je_id AND a.name ILIKE '%Accounts Receivable%'),0)*100)::bigint gl_ar,
  round(coalesce((SELECT sum(l.credit) FROM journal_entry_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.journal_entry_id=inv.accrual_je_id AND a.account_type='revenue' AND a.name ILIKE '%Sales Revenue%'),0)*100)::bigint gl_merch,
  round(coalesce((SELECT sum(l.credit) FROM journal_entry_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.journal_entry_id=inv.accrual_je_id AND (a.name ILIKE '%Shipping%' OR a.name ILIKE '%Freight%' OR a.name ILIKE '%tax%')),0)*100)::bigint gl_ship
FROM inv;`;
console.log("# Loading target invoices + GL amounts …");
const invRows = await runSqlMgmt(selSql);
const byNum = new Map(invRows.map((r) => [r.invoice_number, r]));

// classify
const target = []; const itemize = [];
for (const r of invRows) {
  const cur = Number(r.total_amount_cents), glAr = Number(r.gl_ar), glMerch = Number(r.gl_merch), glShip = Number(r.gl_ship);
  const csvLs = csvByInvoice.get(r.invoice_number);
  if (!csvLs) continue;
  const csv = csvTotalCents(r.invoice_number);
  // default: fix invoices whose total DISAGREES with CSV; --fill-equal: the
  // opposite — rebuild content only where the total already agrees.
  if (FILL_EQUAL ? Math.abs(cur - csv) > TOL_CENTS : Math.abs(cur - csv) <= TOL_CENTS) continue;
  if (Math.abs(csv - glAr) <= TOL_CENTS) { target.push(r); }    // CLEAN: CSV == GL receivable
  else {
    const kind = Math.abs(csv - glMerch) <= TOL_CENTS && glAr > csv ? "ship_ecom" : "mismatch";
    itemize.push({ invoice: r.invoice_number, period: r.period, closed: r.period <= CLOSED_THRU, kind, current_cents: cur, csv_cents: csv, gl_merch_cents: glMerch, gl_ship_cents: glShip, gl_ar_cents: glAr });
  }
}
for (const it of itemize) appendJsonl(itemizePath, it);
let targetNums = target.map((r) => r.invoice_number);
if (ONLY_INVOICE) targetNums = targetNums.filter((n) => n === ONLY_INVOICE);
targetNums.sort();
if (LIMIT) targetNums = targetNums.slice(0, LIMIT);
console.log(`# CLEAN targets (CSV==GL AR, needs fix): ${target.length}   ITEMIZED (ship/ecom + mismatch): ${itemize.length}`);
console.log(`#   itemize breakdown: ${JSON.stringify(itemize.reduce((m, i) => ((m[i.kind] = (m[i.kind] || 0) + 1), m), {}))}`);
if (targetNums.length === 0) { console.log("Nothing to rebuild."); writeFileSync(summaryPath, JSON.stringify({ mode: MODE, target: target.length, itemize: itemize.length }, null, 2)); process.exit(0); }

// ── 3. load current lines + ish for targets ──────────────────────────────────
const targetIds = targetNums.map((n) => byNum.get(n).id);
console.log(`# Loading current lines + ish for ${targetNums.length} targets …`);
const curLines = await inChunks(targetIds, async (chunk) => {
  const { data, error } = await admin.from("ar_invoice_lines").select("id, ar_invoice_id, line_number, description, quantity, unit_price_cents, line_total_cents, tax_amount_cents, cogs_cents, cogs_account_id, revenue_account_id, brand_id, channel_id, source, inventory_item_id").in("ar_invoice_id", chunk);
  if (error) throw new Error("load lines: " + error.message); return data;
});
const linesByInv = new Map();
for (const l of curLines) { if (!linesByInv.has(l.ar_invoice_id)) linesByInv.set(l.ar_invoice_id, []); linesByInv.get(l.ar_invoice_id).push(l); }
const ishRows = await inChunks(targetNums, async (chunk) => {
  const { data, error } = await admin.from("ip_sales_history_wholesale").select("*").or(`invoice_number.in.(${chunk.map((c) => `"${c}"`).join(",")}),order_number.in.(${chunk.map((c) => `"${c}"`).join(",")})`);
  if (error) throw new Error("load ish: " + error.message); return data;
});
const ishByInv = new Map();
for (const r of ishRows) { const k = byNum.has(r.invoice_number) ? r.invoice_number : (byNum.has(r.order_number) ? r.order_number : null); if (!k) continue; if (!ishByInv.has(k)) ishByInv.set(k, []); ishByInv.get(k).push(r); }

// ── 4. style map + SKU index (styles referenced by the target CSV lines) ─────
console.log("# Loading style map + SKU index …");
const styleByCode = new Map();
{ let from = 0; for (;;) { const { data, error } = await admin.from("style_master").select("id, style_code").eq("entity_id", ROF_ENTITY_ID).range(from, from + 999); if (error) throw new Error("style_master: " + error.message); for (const s of data) if (s.style_code) styleByCode.set(String(s.style_code).trim().toUpperCase(), s.id); if (data.length < 1000) break; from += 1000; } }
const wantStyleIds = new Set();
for (const n of targetNums) for (const l of csvByInvoice.get(n) || []) { const { styleId } = resolveStyleToken(styleByCode, l.itemNumber.split("-")[0]); if (styleId) wantStyleIds.add(styleId); }
const skusByStyle = new Map();
await inChunks([...wantStyleIds], async (chunk) => { let from = 0; for (;;) { const { data, error } = await admin.from("ip_item_master").select("id, sku_code, style_id, style_code, color, size, inseam").in("style_id", chunk).range(from, from + 999); if (error) throw new Error("ip_item_master: " + error.message); for (const s of data) { if (!skusByStyle.has(s.style_id)) skusByStyle.set(s.style_id, []); skusByStyle.get(s.style_id).push(s); } if (data.length < 1000) break; from += 1000; } return []; });
function indexPush(s) { if (!skusByStyle.has(s.style_id)) skusByStyle.set(s.style_id, []); skusByStyle.get(s.style_id).push(s); }
function findSkuLocal(styleId, color, size, inseam) {
  const pool = skusByStyle.get(styleId) || [];
  const wantColor = colorMatchKey(color);
  const sizeSet = new Set(sizeVariantsOf(size).map((s) => String(s).trim().toUpperCase()));
  const wantInseam = inseam == null || String(inseam).trim() === "" ? null : String(inseam).trim();
  const hits = pool.filter((r) => r.size != null && sizeSet.has(String(r.size).trim().toUpperCase()) && ((r.inseam == null || String(r.inseam).trim() === "" ? null : String(r.inseam).trim()) === wantInseam) && colorMatchKey(r.color) === wantColor);
  if (hits.length === 0) return { id: null };
  if (hits.length === 1) return { id: hits[0].id };
  const pick = hits.slice().sort((a, b) => (String(normalizeSize(b.size)) === String(b.size)) - (String(normalizeSize(a.size)) === String(a.size)) || String(a.id).localeCompare(String(b.id)))[0];
  return { id: pick.id };
}

// ── 5. process ───────────────────────────────────────────────────────────────
const stats = { processed: 0, rebuilt: 0, skipped: 0, linesWritten: 0, ishWritten: 0, skuCreated: 0, skuReused: 0, skipReasons: {} };
const byPeriodDelta = {};
const pending = [];
const bump = (r) => (stats.skipReasons[r] = (stats.skipReasons[r] || 0) + 1);

async function resolveSku(styleId, styleCode, color, size, inseam, num) {
  const found = findSkuLocal(styleId, color, size, inseam);
  if (found.id) { stats.skuReused++; return { id: found.id }; }
  if (!APPLY) { stats.skuCreated++; return { id: `WOULD:${styleCode}|${canonColor(color)}|${normalizeSize(size)}|${inseam || ""}` }; }
  const c = await resolveOrCreateSku(admin, ROF_ENTITY_ID, { style_id: styleId, style_code: styleCode, color, size, inseam }, { isApparel: false , source: "ar_reprice_csv" });
  if (c.error || !c.id) return { err: c.error || "no id" };
  if (c.created) { stats.skuCreated++; indexPush({ id: c.id, sku_code: null, style_id: styleId, style_code: styleCode, color: canonColor(color), size: String(normalizeSize(size)), inseam: inseam || null }); } else stats.skuReused++;
  return { id: c.id };
}

async function planInvoice(num) {
  stats.processed++;
  const r = byNum.get(num);
  const cur = linesByInv.get(r.id) || [];
  const csvLs = csvByInvoice.get(num) || [];
  const csvCents = csvTotalCents(num);
  // defaults from an existing line (brand/channel/revenue/source) + current Σcogs
  const tmpl = cur[0] || {};
  const totalCogs = cur.reduce((a, l) => a + (l.cogs_cents == null ? 0 : Number(l.cogs_cents)), 0) || null;
  const defaults = { brand_id: tmpl.brand_id ?? null, channel_id: tmpl.channel_id ?? null, revenue_account_id: tmpl.revenue_account_id ?? null, cogs_account_id: tmpl.cogs_account_id ?? null, source: tmpl.source || "manual", totalCogsCents: totalCogs };

  // resolve each CSV line → sized SKU (style via resolveStyleToken; colour from CSV)
  const groups = groupInvoiceCsvLines(csvLs, styleByCode);
  const orderedCsv = []; const itemIds = [];
  for (const g of groups.values()) {
    for (const line of g.lines) {
      const styleId = resolveStyleToken(styleByCode, line.parsed.style_code).styleId;
      if (!styleId) { appendJsonl(itemizePath, { invoice: num, kind: "unresolved_style", item: line.itemNumber }); bump("unresolved_style"); stats.skipped++; return; }
      const res = await resolveSku(styleId, line.parsed.style_code, line.parsed.color, line.parsed.size, g.inseam, num);
      if (res.err) { appendJsonl(itemizePath, { invoice: num, kind: "sku_create_failed", item: line.itemNumber, reason: res.err }); bump("sku_create_failed"); stats.skipped++; return; }
      orderedCsv.push(line); itemIds.push(res.id);
    }
  }
  const built = buildRepriceLines(orderedCsv, itemIds, defaults, 1);
  // gate: rebuilt total must equal CSV total AND (pre-gated) the GL AR
  if (built.sumCents !== csvCents) { appendJsonl(itemizePath, { invoice: num, kind: "sum_drift", built: built.sumCents, csv: csvCents }); bump("sum_drift"); stats.skipped++; return; }

  // ish size rows from CSV (template from an existing ish row)
  const ishCur = ishByInv.get(num) || [];
  const t = ishCur[0] || null;
  const ishInserts = [];
  let seq = 0;
  for (let i = 0; i < orderedCsv.length; i++) {
    const l = orderedCsv[i]; const skuId = itemIds[i]; const amt = l.amountCents / 100;
    ishInserts.push({ sku_id: skuId, customer_id: t?.customer_id ?? null, category_id: t?.category_id ?? null, channel_id: t?.channel_id ?? null, order_number: t?.order_number ?? null, invoice_number: num, txn_type: t?.txn_type || "invoice", txn_date: t?.txn_date || r.idate, qty: l.qty, unit_price: l.qty ? amt / l.qty : null, gross_amount: amt, discount_amount: null, net_amount: amt, currency: t?.currency ?? null, source: t?.source || "excel", raw_payload_id: t?.raw_payload_id ?? null, source_line_key: `${t?.source || "excel"}:${ISH_KEY_KIND}:${num}:${skuId}:${seq++}`, qty_grain: t?.qty_grain || "unit", brand_id: t?.brand_id ?? defaults.brand_id });
  }

  const delta = built.sumCents - Number(r.total_amount_cents);
  const yr = r.period.slice(0, 4);
  byPeriodDelta[yr] = byPeriodDelta[yr] || { n: 0, delta_cents: 0, closed: 0 };
  byPeriodDelta[yr].n++; byPeriodDelta[yr].delta_cents += delta; if (r.period <= CLOSED_THRU) byPeriodDelta[yr].closed++;

  appendJsonl(preimagePath, { invoice: num, ar_invoice_id: r.id, mode: MODE, period: r.period, total_before: Number(r.total_amount_cents), total_after: built.sumCents, csv_cents: csvCents, gl_ar_cents: Number(r.gl_ar), replaced_lines: cur.map((l) => ({ id: l.id, line_number: l.line_number, quantity: l.quantity, unit_price_cents: l.unit_price_cents, line_total_cents: l.line_total_cents, cogs_cents: l.cogs_cents, inventory_item_id: l.inventory_item_id })), replaced_ish_ids: ishCur.map((x) => x.id), new_line_count: built.lines.length, new_ish_count: ishInserts.length });

  stats.rebuilt++; stats.linesWritten += built.lines.length; stats.ishWritten += ishInserts.length;
  if (!APPLY) return;

  const arIns = built.lines.map((l) => `(${val(r.id)}, ${l.line_number}, ${val(l.description)}, ${val(l.inventory_item_id)}, ${l.quantity}, ${l.unit_price_cents == null ? "NULL" : l.unit_price_cents}, ${l.line_total_cents}, ${l.tax_amount_cents}, ${l.cogs_cents == null ? "NULL" : l.cogs_cents}, ${val(l.revenue_account_id)}, ${val(l.cogs_account_id)}, ${val(l.brand_id)}, ${val(l.channel_id)}, ${val(l.source)}, ${sqlLit(NOTES_TAG)})`).join(",\n");
  let sql = `-- ${num}\nDELETE FROM ar_invoice_lines WHERE ar_invoice_id = ${val(r.id)};\n`;
  sql += `INSERT INTO ar_invoice_lines (ar_invoice_id, line_number, description, inventory_item_id, quantity, unit_price_cents, line_total_cents, tax_amount_cents, cogs_cents, revenue_account_id, cogs_account_id, brand_id, channel_id, source, notes) VALUES\n${arIns};\n`;
  if (ishCur.length) sql += `DELETE FROM ip_sales_history_wholesale WHERE id IN (${ishCur.map((x) => val(x.id)).join(",")});\n`;
  if (ishInserts.length) {
    const ishV = ishInserts.map((x) => `(${val(x.sku_id)}, ${val(x.customer_id)}, ${val(x.category_id)}, ${val(x.channel_id)}, ${val(x.order_number)}, ${val(x.invoice_number)}, ${val(x.txn_type)}, ${val(x.txn_date)}, ${x.qty}, ${x.unit_price == null ? "NULL" : x.unit_price}, ${x.gross_amount == null ? "NULL" : x.gross_amount}, NULL, ${x.net_amount == null ? "NULL" : x.net_amount}, ${val(x.currency)}, ${val(x.source)}, ${val(x.raw_payload_id)}, ${sqlLit(x.source_line_key)}, ${val(x.qty_grain)}, ${val(x.brand_id)})`).join(",\n");
    sql += `INSERT INTO ip_sales_history_wholesale (sku_id, customer_id, category_id, channel_id, order_number, invoice_number, txn_type, txn_date, qty, unit_price, gross_amount, discount_amount, net_amount, currency, source, raw_payload_id, source_line_key, qty_grain, brand_id) VALUES\n${ishV};\n`;
  }
  pending.push({ num, sql });
}

async function flush(force) {
  if (!APPLY) return;
  while (pending.length && (force || pending.length >= WRITE_BATCH)) {
    const batch = pending.splice(0, WRITE_BATCH);
    try { await runSqlMgmt(batch.map((b) => b.sql).join("\n")); }
    catch { for (const b of batch) { try { await runSqlMgmt(b.sql); } catch (e2) { appendJsonl(itemizePath, { invoice: b.num, kind: "write_failed", reason: e2.message.slice(0, 300) }); bump("write_failed"); stats.rebuilt--; } } }
  }
}

console.log(`# Processing ${targetNums.length} …`);
let n = 0;
for (const num of targetNums) { await planInvoice(num); await flush(false); if (++n % 200 === 0) process.stdout.write(`\r# ${n}/${targetNums.length} rebuilt=${stats.rebuilt} skipped=${stats.skipped}  `); }
await flush(true);
process.stdout.write("\n");

const summary = { mode: MODE, fill_equal: FILL_EQUAL, stamp: STAMP, csv_invoices: csvByInvoice.size, clean_targets: target.length, itemized: itemize.length, itemize_breakdown: itemize.reduce((m, i) => ((m[i.kind] = (m[i.kind] || 0) + 1), m), {}), ...stats, by_period_delta: Object.fromEntries(Object.entries(byPeriodDelta).map(([k, v]) => [k, { n: v.n, closed: v.closed, delta_dollars: (v.delta_cents / 100).toFixed(2) }])), manifests: { preimage: preimagePath, itemize: itemizePath } };
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
console.log("\n══════════ REPRICE/FILL SUMMARY (" + MODE + ") ══════════");
console.log(`CLEAN targets ......... ${target.length}`);
console.log(`  rebuilt ............. ${stats.rebuilt}`);
console.log(`  skipped ............. ${stats.skipped}  ${JSON.stringify(stats.skipReasons)}`);
console.log(`Lines ${APPLY ? "written" : "planned"} ......... ${stats.linesWritten}   ish ${APPLY ? "written" : "planned"}: ${stats.ishWritten}`);
console.log(`SKUs reused/${APPLY ? "created" : "would-create"} ... ${stats.skuReused} / ${stats.skuCreated}`);
console.log(`ITEMIZED (not touched)  ${itemize.length}  ${JSON.stringify(summary.itemize_breakdown)}`);
console.log(`By-period total Δ:`);
for (const [y, v] of Object.entries(summary.by_period_delta)) console.log(`  ${y}: n=${v.n} closed=${v.closed} Δ=$${v.delta_dollars}`);
console.log(`Summary: ${summaryPath}`);
console.log(APPLY ? "✓ APPLY complete." : "(DRY-RUN — no writes.)");
process.exit(0);
