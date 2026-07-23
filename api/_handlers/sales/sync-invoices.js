// POST /api/sales/sync-invoices — scriptable wholesale-sales-history ingest.
//
// Mirrors src/inventory-planning/services/excelIngestService.ts::ingestSalesExcel
// but server-side: accepts the nightly InvoiceDetail*.csv (gzipped, multipart),
// auto-creates missing items + customers, and upserts into
// ip_sales_history_wholesale with source="xoro_invoice_csv".
//
// Existing browser-modal uploads use source="excel"; this endpoint uses a
// distinct source so manual + automated rows live side-by-side without
// colliding on (source, source_line_key).
//
//   curl -F "invoices=@InvoiceDetail<ts>.csv.gz" \
//        -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/sales/sync-invoices

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import formidable from "formidable";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { canonSku, canonStyleColor } from "../../_lib/sku-canon.js";
import { canonCodeKey, codeBareKey } from "../../_lib/customers/customerCodeKey.js";
import { buildCustomerLookup, resolveExistingCustomerId, loadLiveCustomers } from "../../_lib/customers/matchCustomer.js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";
import {
  deriveSalesGrainFields,
  detectPackPricedAsUnit,
  findSiblingPpkMaster,
  isChargebackReversalRow,
  parsePackSizeFromRaw,
  SUSPICIOUS_PRICE_RATIO,
} from "../../_lib/sales-grain.js";
import { detectSoStore } from "../../_lib/ats-parse.js";
import { distinctInvoiceNumbers, fetchEnrichedInvoiceSet, partitionEnriched, ENRICHED_PREFIXES } from "../../_lib/salesEnrichGuard.js";

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };
const CHUNK = 500;
// Match the source value the browser modal writes (excelIngestService.ts)
// so re-runs UPSERT against existing rows instead of duplicating them.
// The (source, source_line_key) unique constraint dedupes correctly only
// when both halves match — see project_invoice_sync_built.md.
const SOURCE = "excel";

function pickFile(files, ...keys) {
  for (const k of keys) {
    const v = files[k];
    if (v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

function decompressIfGzipped(file) {
  if (!file) return null;
  const buf = readFileSync(file.filepath);
  const name = String(file.originalFilename || "").toLowerCase();
  const isGzip = name.endsWith(".gz")
    || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
  if (!isGzip) return file.filepath;
  const decompressed = gunzipSync(buf);
  const outPath = `${file.filepath}.decompressed`;
  writeFileSync(outPath, decompressed);
  return outPath;
}

function readCsvRows(filepath) {
  const buffer = readFileSync(filepath);
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

function toNum(v) {
  if (v == null || v === "") return null;
  const cleaned = String(v).replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Xoro typically emits MM/DD/YYYY in CSV invoice exports.
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const A = parseInt(m[1], 10), B = parseInt(m[2], 10), y = m[3];
    let month, day;
    if (A > 12) { day = A; month = B; }
    else if (B > 12) { month = A; day = B; }
    else { month = A; day = B; }
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Mirror the canon() used in excelIngestService.ts for customer keys.
// Uppercase, single-space collapsed — matches what wholesaleRepo.listCustomers
// indexes against.
function canonName(raw) {
  return String(raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}
// canonCodeKey / codeBareKey (customer_code minting + matching) live in
// _lib/customers/customerCodeKey.js so the ingest and its unit test share them.

// Map Sale Store + Customer to a channel_code. detectSoStore handles the
// store-string fuzzy match (covers Xoro variants like "Psycho Tuna" and
// "Prebook - Psycho Tuna"). For PT we then split on Customer: rows where
// the customer is "Shopify psychotuna" are ecom and route to PT ECOM;
// everything else under PT stays wholesale.
function resolveChannelCode(saleStore, customerName) {
  const base = detectSoStore("", saleStore || "", "");
  if (base === "PT" && canonName(customerName) === "SHOPIFY PSYCHOTUNA") {
    return "PT ECOM";
  }
  return base;
}

// Ecom channels never sell PPK packs — they're always per-each direct-to-
// consumer. The PPK detector + token routing skip these so the natural
// 5–6× retail markup doesn't get mistaken for pack-priced-as-unit.
//
// Belt-and-suspenders: also treat any customer whose name contains
// "shopify" as ecom. resolveChannelCode catches the canonical
// "Shopify psychotuna" string, but variants ("shopify_psychotuna",
// "Shopify - Psycho Tuna", new Shopify storefronts, etc.) would slip
// past the channel mapping and land in PT wholesale otherwise.
const ECOM_CHANNEL_CODES = new Set(["ROF ECOM", "PT ECOM"]);
function isEcomCandidate(c) {
  if (ECOM_CHANNEL_CODES.has(resolveChannelCode(c.saleStore, c.customerName))) return true;
  if (c.customerName && /shopify/i.test(c.customerName)) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const tok = String(req.headers.authorization || "").slice(-8);
  const rl = rateLimit(`sales-sync:${tok}`, RATE_LIMIT);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retry_after_s));
    return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });
  }

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Supabase not configured" });
  }
  const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  const requestId = randomUUID();
  const form = formidable({ maxFileSize: 30 * 1024 * 1024, multiples: false });
  let files;
  try {
    [, files] = await form.parse(req);
  } catch (e) {
    return res.status(400).json({ error: "Multipart parse error", details: e.message });
  }

  const file = pickFile(files, "invoices", "invoice_detail", "sales");
  if (!file) {
    return res.status(400).json({
      error: "Missing 'invoices' field",
      details: "Expected the InvoiceDetail*.csv (gzip OK; also accepts: invoice_detail, sales)",
    });
  }

  let csvRows;
  try {
    const path = decompressIfGzipped(file);
    csvRows = readCsvRows(path);
  } catch (e) {
    return res.status(400).json({ error: "CSV decode failed", details: e.message });
  }

  const counts = {
    request_id: requestId,
    csv_rows: csvRows.length,
    skipped_grand_total: 0,
    skipped_no_sku: 0,
    skipped_no_date: 0,
    skipped_zero_qty: 0,
    skipped_cb_reversal: 0,
    ppk_token_routed: 0,
    avg_cost_lookups: 0,
    new_items_created: 0,
    new_customers_created: 0,
    duplicates_prevented: 0,
    deleted_before_insert: 0,
    sales_upserted: 0,
    duplicates_merged: 0,
    errors: [],
  };

  // ── Pass 1: parse + collect candidates + dedupe missing items/customers ─
  const candidates = [];
  const missingSkus = new Map();      // canonSku → src row
  const missingCustomers = new Map(); // canonName → display name

  for (const r of csvRows) {
    const saleStore = str(r["Sale Store"]);
    if (saleStore.toLowerCase() === "grand total") {
      counts.skipped_grand_total++;
      continue;
    }

    const itemNumber = str(r["Item Number"]);
    if (!itemNumber) { counts.skipped_no_sku++; continue; }
    const sku = canonStyleColor(itemNumber);
    if (!sku) { counts.skipped_no_sku++; continue; }

    const txnDate = toIsoDate(r["Txn Date"]);
    if (!txnDate) { counts.skipped_no_date++; continue; }

    const qty = toNum(r["Qty"]);
    if (qty == null || qty <= 0) { counts.skipped_zero_qty++; continue; }

    const customerName = str(r["Customer"]) || null;
    const unitPrice = toNum(r["Unit Price"]);
    // Xoro's "Amount" column = net charged after the per-line discount.
    // Reading qty × unit_price (the pre-PR-#227 path) ignores Shopify
    // promos / staff discounts / size-curve pricing and overstates
    // revenue by 5–15% on PT ECOM / ROF ECOM, depending on which
    // promos were active that week. When Amount is present, it's the
    // truth; fall back to qty × unit_price only when Amount is missing
    // (rare — legacy or hand-uploaded CSVs without that column).
    const amount = toNum(r["Amount"]);
    const invoiceNumber = str(r["Invoice Number"]) || null;
    const description = str(r["Description"]);

    if (isChargebackReversalRow(itemNumber, description)) {
      counts.skipped_cb_reversal++;
      continue;
    }

    if (!missingSkus.has(sku)) {
      missingSkus.set(sku, { itemNumber, description });
    }
    if (customerName) {
      const ck = canonName(customerName);
      if (!missingCustomers.has(ck)) missingCustomers.set(ck, customerName);
    }

    candidates.push({
      sku,
      // Original Xoro Item Number — preserved so we can classify pack
      // vs unit grain in Pass 2 before canonStyleColor strips the PPK
      // token. Without this we can't tell which grain Xoro recorded.
      rawItemNumber: itemNumber,
      txnDate, qty, unitPrice, amount, invoiceNumber,
      customerName,
      customerKey: customerName ? canonName(customerName) : null,
      // Space-stripped key for matching against customer_code (see canonCodeKey).
      customerCodeKey: customerName ? canonCodeKey(customerName) : null,
      saleStore: saleStore || null,
    });
  }

  // ── Resolve existing items (chunked select by sku_code) ──────────────────
  // Also pull pack_size + unit_cost so Pass 2 can classify grain and
  // snapshot the per-unit cost for margin computation.
  const skuToId = new Map();
  const skuToMaster = new Map();
  const allSkus = Array.from(missingSkus.keys());
  for (let i = 0; i < allSkus.length; i += CHUNK) {
    const chunk = allSkus.slice(i, i + CHUNK);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code, style_code, pack_size, unit_cost")
      .in("sku_code", chunk);
    if (error) { counts.errors.push(`item lookup chunk ${i}: ${error.message}`); continue; }
    for (const row of data ?? []) {
      skuToId.set(row.sku_code, row.id);
      skuToMaster.set(row.sku_code, {
        sku_code: row.sku_code,
        style_code: row.style_code,
        pack_size: row.pack_size,
        unit_cost: row.unit_cost,
      });
    }
  }

  // ── Pull sibling PPK masters for the grain-detector ─────────────────────
  // For every unit-grain master we just resolved, also pull its PPK
  // sibling (style_code + "PPK", preserving variant suffix). The detector
  // uses these to reclassify pack-priced lines that were coded under the
  // unit-grain SKU. Without preloading we'd have one round-trip per
  // suspect row — this is one extra bulk select instead.
  const siblingPpkCodes = new Set();
  for (const [, m] of skuToMaster) {
    if (!m.style_code || (m.pack_size && Number(m.pack_size) > 1)) continue;
    const variantSuffix = m.sku_code.slice(m.style_code.length);
    // Master uses two PPK naming conventions; preload both so the
    // PPK-token routing pass + findSiblingPpkMaster can resolve either.
    siblingPpkCodes.add(`${m.style_code}PPK${variantSuffix}`);
    siblingPpkCodes.add(`${m.style_code}-PPK${variantSuffix}`);
    // Mis-tagged style_code fallback: if the master row's style_code
    // already contains "-PPK", re-derive the true base from the sku
    // (sku ends in "-COLOR"; strip back to the last dash, drop "-PPK").
    const lastDash = m.sku_code.lastIndexOf("-");
    if (lastDash > 0) {
      const prefix    = m.sku_code.slice(0, lastDash);
      const colorSuf  = m.sku_code.slice(lastDash); // includes leading "-"
      const trueStyle = prefix.replace(/-?PPK\d*$/i, "");
      if (trueStyle && trueStyle !== m.style_code) {
        siblingPpkCodes.add(`${trueStyle}PPK${colorSuf}`);
        siblingPpkCodes.add(`${trueStyle}-PPK${colorSuf}`);
      }
    }
  }
  const siblingsToFetch = [...siblingPpkCodes].filter(code => !skuToMaster.has(code));
  for (let i = 0; i < siblingsToFetch.length; i += CHUNK) {
    const chunk = siblingsToFetch.slice(i, i + CHUNK);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code, style_code, pack_size, unit_cost")
      .in("sku_code", chunk);
    if (error) { counts.errors.push(`sibling PPK lookup chunk ${i}: ${error.message}`); continue; }
    for (const row of data ?? []) {
      skuToId.set(row.sku_code, row.id);
      skuToMaster.set(row.sku_code, {
        sku_code: row.sku_code,
        style_code: row.style_code,
        pack_size: row.pack_size,
        unit_cost: row.unit_cost,
      });
    }
  }

  // Bulk-create items missing from master. canonStyleColor strips size, so
  // each new row is style+color grain — same as the browser ingest.
  const newItems = [];
  for (const [sku, src] of missingSkus) {
    if (skuToId.has(sku)) continue;
    const dash = sku.indexOf("-");
    const style = dash > 0 ? sku.slice(0, dash) : sku;
    const colorTail = dash > 0 ? sku.slice(dash + 1) : null;
    const row = {
      sku_code: sku,
      style_code: style,
      color: colorTail,
      uom: "each",
      active: true,
    };
    if (src.description) row.description = src.description;
    newItems.push(row);
  }
  if (newItems.length > 0) {
    // Bucket by column-signature (description present/absent) to dodge
    // PGRST102 "All object keys must match" on heterogeneous bulk upserts.
    const buckets = new Map();
    for (const it of newItems) {
      const sig = Object.keys(it).sort().join(",");
      if (!buckets.has(sig)) buckets.set(sig, []);
      buckets.get(sig).push(it);
    }
    for (const [, bucket] of buckets) {
      for (let i = 0; i < bucket.length; i += CHUNK) {
        const chunk = bucket.slice(i, i + CHUNK);
        const { data, error } = await admin
          .from("ip_item_master")
          .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: false })
          .select("id, sku_code");
        if (error) {
          counts.errors.push(`item upsert chunk ${i}: ${error.message}`);
          continue;
        }
        for (const row of data ?? []) {
          skuToId.set(row.sku_code, row.id);
          // New items default to pack_size=1, unit_cost=null. inferQtyGrain
          // will return 'unit' (no PPK conversion), margin will be NULL.
          // Re-look-up style_code from the upsert response (might not
          // be in the bucket payload if it was inferred from the dash).
          const inferredStyle = row.sku_code.indexOf("-") > 0
            ? row.sku_code.slice(0, row.sku_code.indexOf("-"))
            : row.sku_code;
          skuToMaster.set(row.sku_code, {
            sku_code: row.sku_code,
            style_code: inferredStyle,
            pack_size: 1,
            unit_cost: null,
          });
        }
        counts.new_items_created += chunk.length;
      }
    }
  }

  // ── Resolve customers (lookup by code, exact name, AND normalized name) ──
  // Read ALL live customers once (base `customers` table, deleted_at IS NULL —
  // NOT the ip_customer_master view, which exposes merged-away tombstones). This
  // lets the guard below match on a NORMALIZED name (uppercase + strip all
  // non-alphanumerics) so casing/punctuation drift attaches to the existing
  // customer instead of forking a duplicate (#1824).
  const customerCodeToId = new Map();
  const customerNameToId = new Map();
  let custLookup = buildCustomerLookup([]);
  if (missingCustomers.size > 0) {
    let liveCustomers = [];
    try {
      liveCustomers = await loadLiveCustomers(admin);
    } catch (e) { counts.errors.push(`customer load: ${e.message}`); }
    custLookup = buildCustomerLookup(liveCustomers);
    for (const c of liveCustomers) {
      if (c.customer_code) customerCodeToId.set(codeBareKey(c.customer_code), c.id);
      if (c.name) customerNameToId.set(canonName(c.name), c.id);
    }
  }

  // Bulk-create customers we still haven't found — GUARDED against creating a
  // normalized-name duplicate of an existing customer.
  const newCustomers = [];
  for (const [canonKey, displayName] of missingCustomers) {
    // customerCodeToId is keyed by the bare space-stripped code, so compare with
    // the stripped form of the name key (canonKey is canonName, i.e. spaced).
    if (customerNameToId.has(canonKey) || customerCodeToId.has(canonCodeKey(canonKey))) continue;
    // Normalized-name guard: attach to an existing live customer whose name
    // normalizes to the same key rather than forking (AMAZON FBM → Amazon FBM,
    // US Apparel → U.S. Apparel). resolveExistingCustomerId also re-checks the
    // bare code key for completeness.
    const existingId = resolveExistingCustomerId(custLookup, {
      customerCode: `EXCEL:${canonCodeKey(canonKey)}`,
      name: displayName,
    });
    if (existingId) {
      customerNameToId.set(canonKey, existingId);
      customerCodeToId.set(canonCodeKey(canonKey), existingId);
      counts.duplicates_prevented = (counts.duplicates_prevented ?? 0) + 1;
      continue;
    }
    // Mint the code in the canonical space-stripped form so the
    // onConflict=customer_code upsert merges into any existing legacy row
    // instead of forking a duplicate (EXCEL:BRIGSURFSHOP, not EXCEL:BRIG SURF SHOP).
    newCustomers.push({
      customer_code: `EXCEL:${canonCodeKey(canonKey)}`,
      name: displayName,
    });
  }
  if (newCustomers.length > 0) {
    for (let i = 0; i < newCustomers.length; i += CHUNK) {
      const chunk = newCustomers.slice(i, i + CHUNK);
      const { data, error } = await admin
        .from("ip_customer_master")
        .upsert(chunk, { onConflict: "customer_code", ignoreDuplicates: false })
        .select("id, customer_code, name");
      if (error) {
        counts.errors.push(`customer create chunk ${i}: ${error.message}`);
        continue;
      }
      for (const row of data ?? []) {
        customerCodeToId.set(codeBareKey(row.customer_code), row.id);
        if (row.name) customerNameToId.set(canonName(row.name), row.id);
      }
      counts.new_customers_created += chunk.length;
    }
  }

  // ── Resolve channel ids for the store column ────────────────────────────
  // Sale Store from Xoro ("ROF", "ROF ECOM", "PT", plus Xoro variants
  // like "Psycho Tuna") is funnelled through detectSoStore so we get
  // the canonical ATS code. Each row's channel_id is then looked up
  // from ip_channel_master. Missing channel rows or unknown stores
  // fall through as NULL so the row still upserts cleanly.
  const channelCodeToId = new Map();
  {
    const { data, error } = await admin
      .from("ip_channel_master")
      .select("id, channel_code")
      .in("channel_code", ["ROF", "ROF ECOM", "PT", "PT ECOM"]);
    if (error) {
      counts.errors.push(`channel lookup: ${error.message}`);
    } else {
      for (const row of data ?? []) channelCodeToId.set(row.channel_code, row.id);
    }
  }

  // ── Pass 2a-pre: PPK-token routing ──────────────────────────────────────
  // When the raw Xoro Item Number carries an explicit "PPK<digits>"
  // token (e.g. "RBB1438N-BLACK-PPK48"), route the sale to the
  // pack-grain master row instead of the each-grain BASE-COLOR row.
  // The token IS the signal — no price/ratio guard needed, unlike the
  // post-hoc detector below which exists for legacy rows missing the
  // token. findSiblingPpkMaster handles both master naming forms
  // ("{style}PPK{suffix}" and "{style}-PPK{suffix}") plus the
  // mis-tagged-style_code fallback.
  for (const c of candidates) {
    if (isEcomCandidate(c)) continue; // ecom is always eaches — never PPK
    if (!parsePackSizeFromRaw(c.rawItemNumber)) continue;
    const unitMaster = skuToMaster.get(c.sku);
    if (!unitMaster) continue;
    if (Number(unitMaster.pack_size) > 1) continue; // already pack-grain
    const sibling = findSiblingPpkMaster(unitMaster, skuToMaster);
    if (!sibling) continue;
    c.sku = sibling.sku_code; // upserts now target the PPK master
    counts.ppk_token_routed += 1;
  }

  // ── Pass 2a-cost: per-row avg cost from ip_item_avg_cost ────────────────
  // ip_item_avg_cost is the Xoro Item Costing Report ingest (handled by
  // api/_handlers/xoro/sync-item-costing.js). It carries per-size +
  // per-PPK rows keyed by the FULL raw Xoro sku — exactly the
  // granularity master.unit_cost lacks. We fetch the avg_cost for every
  // candidate's raw sku in one batch and pass it into
  // deriveSalesGrainFields as the authoritative cost. Master cost
  // remains the fallback for rows the avg-cost report doesn't cover.
  const avgCostByRawCanon = new Map();
  {
    const rawCanonSet = new Set(
      candidates.map(c => canonSku(c.rawItemNumber)).filter(Boolean)
    );
    const rawCanonList = [...rawCanonSet];
    for (let i = 0; i < rawCanonList.length; i += CHUNK) {
      const chunk = rawCanonList.slice(i, i + CHUNK);
      const { data, error } = await admin
        .from("ip_item_avg_cost")
        .select("sku_code, avg_cost")
        .in("sku_code", chunk);
      if (error) { counts.errors.push(`avg cost lookup chunk ${i}: ${error.message}`); continue; }
      for (const row of data ?? []) {
        const v = Number(row.avg_cost);
        if (Number.isFinite(v) && v > 0) {
          avgCostByRawCanon.set(row.sku_code, v);
          counts.avg_cost_lookups += 1;
        }
      }
    }
  }

  // ── Pass 2a: grain detector — reclassify pack-priced unit lines ─────────
  // Xoro occasionally records a wholesale prepack line under the unit-
  // grain SKU. Detector identifies these by their suspicious unit_price
  // (≥ SUSPICIOUS_PRICE_RATIO × master.unit_cost) and verifies against
  // a customer-specific reference per-unit price from history. When
  // confirmed (price ≈ reference × pack_size within ±5%), the candidate
  // is re-routed to the sibling PPK master row. See sales-grain.js.
  //
  // Pre-pass: find suspect (sku_id, customer_id) pairs so we can fetch
  // historical reference prices in a single batch query.
  const suspectPairs = new Set();
  const suspectByIdx = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (isEcomCandidate(c)) continue; // ecom is always eaches — never PPK
    const m = skuToMaster.get(c.sku);
    if (!m || !m.style_code) continue;
    const packSize = Number(m.pack_size) || 1;
    if (packSize > 1) continue;
    const cost = Number(m.unit_cost) || 0;
    if (cost <= 0) continue;
    if ((Number(c.unitPrice) || 0) < cost * SUSPICIOUS_PRICE_RATIO) continue;
    const skuId = skuToId.get(c.sku);
    const custId = c.customerKey
      ? (customerNameToId.get(c.customerKey) ?? customerCodeToId.get(c.customerCodeKey) ?? null)
      : null;
    if (!skuId || !custId) continue;
    const sibling = findSiblingPpkMaster(m, skuToMaster);
    if (!sibling) continue;
    suspectPairs.add(`${skuId}|${custId}`);
    suspectByIdx.set(i, { skuId, custId, master: m, sibling });
  }

  // Batch-load historical unit prices for the suspect pairs.
  // SAME (customer_id, sku_id) lookup, last 24 months, capped per
  // pair to keep the response size bounded.
  const refPricesByPair = new Map(); // `${skuId}|${custId}` → number[]
  if (suspectPairs.size > 0) {
    const pairs = [...suspectPairs];
    const skuIds = [...new Set(pairs.map(p => p.split("|")[0]))];
    const custIds = [...new Set(pairs.map(p => p.split("|")[1]))];
    for (let i = 0; i < skuIds.length; i += CHUNK) {
      const skuChunk = skuIds.slice(i, i + CHUNK);
      for (let j = 0; j < custIds.length; j += CHUNK) {
        const custChunk = custIds.slice(j, j + CHUNK);
        const { data, error } = await admin
          .from("ip_sales_history_wholesale")
          .select("sku_id, customer_id, unit_price")
          .in("sku_id", skuChunk)
          .in("customer_id", custChunk)
          .gte("txn_date", new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10))
          .not("unit_price", "is", null)
          .limit(5000);
        if (error) { counts.errors.push(`grain reference lookup: ${error.message}`); continue; }
        for (const row of data ?? []) {
          const key = `${row.sku_id}|${row.customer_id}`;
          if (!suspectPairs.has(key)) continue; // narrow to the cartesian filter
          if (!refPricesByPair.has(key)) refPricesByPair.set(key, []);
          refPricesByPair.get(key).push(Number(row.unit_price));
        }
      }
    }
  }

  // Also fold in same-batch peer prices so a first-time ingest with
  // both pack-priced and unit-priced rows for the same (customer, sku)
  // can still establish a reference within the batch.
  for (const c of candidates) {
    const skuId = skuToId.get(c.sku);
    const custId = c.customerKey
      ? (customerNameToId.get(c.customerKey) ?? customerCodeToId.get(c.customerCodeKey) ?? null)
      : null;
    if (!skuId || !custId) continue;
    const key = `${skuId}|${custId}`;
    if (!suspectPairs.has(key)) continue;
    if (!refPricesByPair.has(key)) refPricesByPair.set(key, []);
    refPricesByPair.get(key).push(Number(c.unitPrice));
  }

  // Apply detection + reclassify.
  counts.pack_priced_as_unit_reclassified = 0;
  for (const [idx, info] of suspectByIdx) {
    const refPrices = refPricesByPair.get(`${info.skuId}|${info.custId}`) || [];
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: candidates[idx].unitPrice,
      unitMaster: info.master,
      masterByCode: skuToMaster,
      historicalUnitPrices: refPrices,
    });
    if (!sibling) continue;
    // Reclassify: swap to PPK sibling SKU. raw item-number gets the
    // PPK suffix so `inferQtyGrain` reads it as pack-grain downstream
    // (PPK_TOKEN_RE in sales-grain.js matches /\bPPK\d*/).
    const original = candidates[idx].sku;
    candidates[idx].sku = sibling.sku_code;
    candidates[idx].rawItemNumber = sibling.sku_code;
    counts.pack_priced_as_unit_reclassified += 1;
    counts.errors.push(`[grain-reclassify] ${original} → ${sibling.sku_code} (unit_price=${candidates[idx].unitPrice}, customer_key=${candidates[idx].customerKey})`);
  }

  // ── Pass 2: build sales rows ─────────────────────────────────────────────
  const out = [];
  for (const c of candidates) {
    const skuId = skuToId.get(c.sku);
    if (!skuId) { counts.skipped_no_sku++; continue; }
    const customerId = c.customerKey
      ? (customerNameToId.get(c.customerKey) ?? customerCodeToId.get(c.customerCodeKey) ?? null)
      : null;

    // Match the line-key format the browser modal uses so the same invoice
    // line collides on the (source, source_line_key) unique constraint.
    const lineKey = c.invoiceNumber
      ? `excel:inv:${c.invoiceNumber}:${c.sku}:${c.txnDate}`
      : `excel:${c.sku}:${c.txnDate}:${c.qty}`;

    // Gross = the undiscounted list price × qty. Net = what the
    // customer actually paid (Xoro's "Amount" column). Discount =
    // gross − net. Fall back to gross when Amount wasn't supplied
    // — keeps the pre-fix behaviour for legacy CSVs that lack the
    // column rather than introducing a NULL net for them.
    const grossAmount = c.unitPrice != null ? c.unitPrice * c.qty : null;
    const netAmount   = c.amount != null && c.amount !== 0
      ? c.amount
      : grossAmount;
    const discountAmount = (grossAmount != null && netAmount != null && grossAmount > netAmount)
      ? grossAmount - netAmount
      : null;
    const grainFields = deriveSalesGrainFields({
      rawItemNumber: c.rawItemNumber,
      qty: c.qty,
      netAmount,
      master: skuToMaster.get(c.sku),
      avgCostPerRawQty: avgCostByRawCanon.get(canonSku(c.rawItemNumber)),
    });

    out.push({
      sku_id: skuId,
      customer_id: customerId,
      category_id: null,
      channel_id: channelCodeToId.get(resolveChannelCode(c.saleStore, c.customerName)) ?? null,
      order_number: null,
      invoice_number: c.invoiceNumber,
      txn_type: c.invoiceNumber ? "invoice" : "ship",
      txn_date: c.txnDate,
      qty: c.qty,
      unit_price: c.unitPrice,
      gross_amount: grossAmount,
      discount_amount: discountAmount,
      net_amount: netAmount,
      currency: "USD",
      source: SOURCE,
      raw_payload_id: null,
      source_line_key: lineKey,
      ...grainFields,
    });
  }

  // Aggregate rows sharing a source_line_key (size variants collapse).
  const merged = new Map();
  for (const row of out) {
    const key = row.source_line_key;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, row); continue; }
    counts.duplicates_merged++;
    const eQty = Number(existing.qty) || 0;
    const rQty = Number(row.qty) || 0;
    const totalQty = eQty + rQty;
    const eUp = existing.unit_price != null ? Number(existing.unit_price) : null;
    const rUp = row.unit_price != null ? Number(row.unit_price) : null;
    let mergedUp = null;
    if (eUp != null && rUp != null && totalQty > 0) mergedUp = (eUp * eQty + rUp * rQty) / totalQty;
    else if (eUp != null) mergedUp = eUp;
    else if (rUp != null) mergedUp = rUp;
    existing.qty = totalQty;
    existing.unit_price = mergedUp;
    // Sum the actual gross / net / discount across the merged rows
    // instead of recomputing from unit_price × qty (which would drop
    // the per-line discount captured from Xoro's "Amount" column).
    const eGross    = Number(existing.gross_amount ?? 0);
    const rGross    = Number(row.gross_amount      ?? 0);
    const eNet      = Number(existing.net_amount   ?? 0);
    const rNet      = Number(row.net_amount        ?? 0);
    const eDiscount = existing.discount_amount != null ? Number(existing.discount_amount) : 0;
    const rDiscount = row.discount_amount      != null ? Number(row.discount_amount)      : 0;
    const mergedGross = eGross + rGross;
    const mergedNet   = eNet   + rNet;
    const mergedDiscount = eDiscount + rDiscount;
    existing.gross_amount    = mergedGross;
    existing.net_amount      = mergedNet;
    existing.discount_amount = mergedDiscount > 0 ? mergedDiscount : null;
    // Re-derive qty_units + margin from the merged qty + net. Grain
    // stays the same (both rows share source_line_key → same sku →
    // same rawItemNumber classification). unit_cost_at_sale is also
    // unchanged. Rescale qty_units + recompute margin from the merged
    // totals. Recovers pack_size from the pre-merge qty_units:qty ratio
    // (preserves whatever precision the master had).
    const inferredPackSize = existing.qty_grain === "pack" && eQty > 0
      ? existing.qty_units / eQty
      : 1;
    existing.qty_units = existing.qty_grain === "pack"
      ? totalQty * inferredPackSize
      : totalQty;
    existing.cogs_amount = existing.unit_cost_at_sale != null
      ? existing.qty_units * existing.unit_cost_at_sale
      : null;
    if (mergedNet != null && existing.unit_cost_at_sale != null && mergedNet > 0) {
      const newMarginAmount = mergedNet - existing.qty_units * existing.unit_cost_at_sale;
      existing.margin_amount = newMarginAmount;
      existing.margin_pct = newMarginAmount / mergedNet;
    } else {
      existing.margin_amount = null;
      existing.margin_pct = null;
    }
  }
  let aggregated = Array.from(merged.values());

  // ── Size-enrichment guard ─────────────────────────────────────────────
  // The AR size-enrichment ops (#1898/#1902/#1909) replace an invoice's
  // colour-grain rows with per-size rows under different source_line_keys,
  // so this upsert would happily RE-INSERT the colour aggregate on top and
  // double that invoice's history (2026-07-23 incident: 19,081 rows /
  // 3.5M phantom units). Skip any invoice that already carries enriched
  // rows — the size-grain history is strictly richer than the colour
  // aggregate the CSV would recreate.
  {
    const invoiceNums = distinctInvoiceNumbers(aggregated);
    const enrichedSet = await fetchEnrichedInvoiceSet(admin, invoiceNums, { errors: counts.errors });
    const { kept, skipped } = partitionEnriched(aggregated, enrichedSet);
    aggregated = kept;
    counts.skipped_size_enriched_rows = skipped.length;
    counts.skipped_size_enriched_invoices = new Set(skipped.map((r) => r.invoice_number)).size;
  }

  // Default: incremental upsert — matching (source, source_line_key)
  // rows get UPDATEd, new ones INSERTed, orphans stay. This is the
  // right cadence for nightly runs where the CSV is a rolling window.
  //
  // Opt-in: `?mode=replace` wipes all source="excel" rows first, then
  // inserts fresh. Use this for first-time setup or when the CSV is
  // known to be the complete authoritative dataset and you want
  // orphans cleared. Safety guard: refuse the wipe if the parsed CSV
  // produces fewer than 1000 aggregated rows.
  const url = new URL(req.url, `https://${req.headers.host}`);
  const mode = (url.searchParams.get("mode") || "").toLowerCase();
  const replace = mode === "replace";

  if (replace) {
    const REPLACE_FLOOR = 1000;
    if (aggregated.length < REPLACE_FLOOR) {
      return res.status(200).json({
        processed: false,
        error: `mode=replace requested but CSV produced only ${aggregated.length} rows (floor: ${REPLACE_FLOOR}). Refusing to wipe.`,
        ...counts,
      });
    }
    // Enriched size-grain rows share source="excel" but must SURVIVE the
    // wipe — they're the richer replacement for colour aggregates this
    // insert would recreate (see the size-enrichment guard above).
    let del = admin
      .from("ip_sales_history_wholesale")
      .delete({ count: "exact" })
      .eq("source", SOURCE);
    for (const p of ENRICHED_PREFIXES) del = del.not("source_line_key", "like", `${p}%`);
    const { error: delError, count: deletedCount } = await del;
    if (delError) {
      counts.errors.push(`pre-insert wipe failed: ${delError.message}`);
      return res.status(500).json({ processed: false, ...counts });
    }
    counts.deleted_before_insert = deletedCount ?? 0;
  }

  for (let i = 0; i < aggregated.length; i += CHUNK) {
    const chunk = aggregated.slice(i, i + CHUNK);
    const { error } = replace
      ? await admin.from("ip_sales_history_wholesale").insert(chunk)
      : await admin
          .from("ip_sales_history_wholesale")
          .upsert(chunk, { onConflict: "source,source_line_key", ignoreDuplicates: false });
    if (error) {
      counts.errors.push(`sales write chunk ${i}: ${error.message}`);
      continue;
    }
    counts.sales_upserted += chunk.length;
  }
  counts.mode = replace ? "replace" : "incremental";

  return res.status(200).json({ processed: true, ...counts });
}
