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
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

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
    new_items_created: 0,
    new_customers_created: 0,
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
    const invoiceNumber = str(r["Invoice Number"]) || null;
    const description = str(r["Description"]);

    if (!missingSkus.has(sku)) {
      missingSkus.set(sku, { itemNumber, description });
    }
    if (customerName) {
      const ck = canonName(customerName);
      if (!missingCustomers.has(ck)) missingCustomers.set(ck, customerName);
    }

    candidates.push({
      sku, txnDate, qty, unitPrice, invoiceNumber,
      customerName, customerKey: customerName ? canonName(customerName) : null,
      saleStore: saleStore || null,
    });
  }

  // ── Resolve existing items (chunked select by sku_code) ──────────────────
  const skuToId = new Map();
  const allSkus = Array.from(missingSkus.keys());
  for (let i = 0; i < allSkus.length; i += CHUNK) {
    const chunk = allSkus.slice(i, i + CHUNK);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .in("sku_code", chunk);
    if (error) { counts.errors.push(`item lookup chunk ${i}: ${error.message}`); continue; }
    for (const row of data ?? []) skuToId.set(row.sku_code, row.id);
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
        for (const row of data ?? []) skuToId.set(row.sku_code, row.id);
        counts.new_items_created += chunk.length;
      }
    }
  }

  // ── Resolve customers (lookup by both customer_code and name) ────────────
  const customerCodeToId = new Map();
  const customerNameToId = new Map();
  if (missingCustomers.size > 0) {
    const codes = Array.from(missingCustomers.keys()).map((k) => `EXCEL:${k}`);
    const codesAuto = Array.from(missingCustomers.keys()).map((k) => `XORO:${k}`);
    const allCodes = [...codes, ...codesAuto];
    for (let i = 0; i < allCodes.length; i += CHUNK) {
      const chunk = allCodes.slice(i, i + CHUNK);
      const { data, error } = await admin
        .from("ip_customer_master")
        .select("id, customer_code, name")
        .in("customer_code", chunk);
      if (error) { counts.errors.push(`customer code lookup chunk ${i}: ${error.message}`); continue; }
      for (const row of data ?? []) {
        customerCodeToId.set(canonName(row.customer_code), row.id);
        if (row.name) customerNameToId.set(canonName(row.name), row.id);
      }
    }
    // Also fetch by name to catch customers added via other ingest paths
    const names = Array.from(missingCustomers.values());
    for (let i = 0; i < names.length; i += CHUNK) {
      const chunk = names.slice(i, i + CHUNK);
      const { data, error } = await admin
        .from("ip_customer_master")
        .select("id, customer_code, name")
        .in("name", chunk);
      if (error) { counts.errors.push(`customer name lookup chunk ${i}: ${error.message}`); continue; }
      for (const row of data ?? []) {
        if (row.name) customerNameToId.set(canonName(row.name), row.id);
        customerCodeToId.set(canonName(row.customer_code), row.id);
      }
    }
  }

  // Bulk-create customers we still haven't found
  const newCustomers = [];
  for (const [canonKey, displayName] of missingCustomers) {
    if (customerNameToId.has(canonKey) || customerCodeToId.has(canonKey)) continue;
    // Match the browser modal's customer_code prefix so manually-uploaded
    // and auto-synced customers don't fork into two rows.
    newCustomers.push({
      customer_code: `EXCEL:${canonKey}`,
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
        customerCodeToId.set(canonName(row.customer_code), row.id);
        if (row.name) customerNameToId.set(canonName(row.name), row.id);
      }
      counts.new_customers_created += chunk.length;
    }
  }

  // ── Pass 2: build sales rows ─────────────────────────────────────────────
  const out = [];
  for (const c of candidates) {
    const skuId = skuToId.get(c.sku);
    if (!skuId) { counts.skipped_no_sku++; continue; }
    const customerId = c.customerKey
      ? (customerNameToId.get(c.customerKey) ?? customerCodeToId.get(c.customerKey) ?? null)
      : null;

    // Match the line-key format the browser modal uses so the same invoice
    // line collides on the (source, source_line_key) unique constraint.
    const lineKey = c.invoiceNumber
      ? `excel:inv:${c.invoiceNumber}:${c.sku}:${c.txnDate}`
      : `excel:${c.sku}:${c.txnDate}:${c.qty}`;

    out.push({
      sku_id: skuId,
      customer_id: customerId,
      category_id: null,
      channel_id: null,
      order_number: null,
      invoice_number: c.invoiceNumber,
      txn_type: c.invoiceNumber ? "invoice" : "ship",
      txn_date: c.txnDate,
      qty: c.qty,
      unit_price: c.unitPrice,
      gross_amount: c.unitPrice != null ? c.unitPrice * c.qty : null,
      discount_amount: null,
      net_amount: c.unitPrice != null ? c.unitPrice * c.qty : null,
      currency: "USD",
      source: SOURCE,
      raw_payload_id: null,
      source_line_key: lineKey,
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
    existing.gross_amount = mergedUp != null ? mergedUp * totalQty : null;
    existing.net_amount = mergedUp != null ? mergedUp * totalQty : null;
  }
  const aggregated = Array.from(merged.values());

  // Bulk upsert sales rows
  for (let i = 0; i < aggregated.length; i += CHUNK) {
    const chunk = aggregated.slice(i, i + CHUNK);
    const { error } = await admin
      .from("ip_sales_history_wholesale")
      .upsert(chunk, { onConflict: "source,source_line_key", ignoreDuplicates: false });
    if (error) {
      counts.errors.push(`sales upsert chunk ${i}: ${error.message}`);
      continue;
    }
    counts.sales_upserted += chunk.length;
  }

  return res.status(200).json({ processed: true, ...counts });
}
