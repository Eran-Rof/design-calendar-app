// POST /api/ap/sync-bills — scriptable Xoro AP bill-history ingest.
//
// Consumer side of the new Xoro AP read path. The producer
// (rest_ap_sync.py, in the sibling rof_xoro_project repo) walks Xoro's
// bill/getbill REST endpoint, builds a CSV, gzips it, and POSTs here.
//
// Mirrors api/_handlers/sales/sync-invoices.js for the multipart + gzip
// plumbing, but the row shape is simpler: every CSV row maps 1:1 to an
// ap_bills row keyed off (source="xoro", source_line_key) so re-runs
// upsert cleanly. No item/customer auto-create — this table is a mirror,
// not the system of record.
//
// This is SEPARATE from /api/internal/ap-invoices (the manual-entry
// Tangerine AP UI which writes to `invoices`). That path is internal AP;
// this one is read-only Xoro mirror data for reporting / planning.
//
// Pre-agreed CSV columns (DO NOT change without coordinating with producer):
//   Bill Number, Bill Date, Due Date, Vendor Code, Vendor Name, Currency,
//   Item Number, Description, Qty, Unit Price, Amount,
//   Bill Status, Payment Status
//
//   curl -F "bills=@bills<ts>.csv.gz" \
//        -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/ap/sync-bills

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import formidable from "formidable";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };
const CHUNK = 500;
const SOURCE = "xoro";

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
  // Xoro typically emits MM/DD/YYYY in CSV exports.
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

// Build candidate rows from the raw CSV. Exported so tests can hit the
// parsing logic without re-routing through formidable + supabase.
//
// Per-bill_number line_index counter ensures expense lines (no Item Number)
// AND multiple identical SKU lines on the same bill both get a distinct
// source_line_key. This is the spot where the AP shape diverges from the
// sales-invoices precedent — sales-invoices used invoice + sku + txn_date
// as the dedupe key because Xoro never emits expense lines there. AP
// bills routinely have line items without a SKU (freight, tariff,
// adjustments), so we have to use an in-CSV line_index instead.
export function buildCandidates(csvRows) {
  const counts = {
    csv_rows: csvRows.length,
    skipped_no_bill_number: 0,
    skipped_no_date: 0,
    skipped_zero_qty: 0,
  };

  const lineIndexByBill = new Map();
  const out = [];

  for (const r of csvRows) {
    const billNumber = str(r["Bill Number"]);
    if (!billNumber) { counts.skipped_no_bill_number++; continue; }

    const billDate = toIsoDate(r["Bill Date"]);
    if (!billDate) { counts.skipped_no_date++; continue; }

    const qty = toNum(r["Qty"]);
    // Zero-qty rows are usually heading/separator rows in Xoro's export.
    // They're tracked but skipped so they don't pollute the table.
    if (qty != null && qty === 0) { counts.skipped_zero_qty++; continue; }

    const itemNumber = str(r["Item Number"]) || null;
    const description = str(r["Description"]) || null;
    const vendorCode = str(r["Vendor Code"]) || null;
    const vendorName = str(r["Vendor Name"]) || null;
    const currency = str(r["Currency"]) || "USD";
    const dueDate = toIsoDate(r["Due Date"]);
    const unitPrice = toNum(r["Unit Price"]);
    const amount = toNum(r["Amount"]);
    const billStatus = str(r["Bill Status"]) || null;
    const paymentStatus = str(r["Payment Status"]) || null;

    const idx = (lineIndexByBill.get(billNumber) ?? -1) + 1;
    lineIndexByBill.set(billNumber, idx);
    // Compact, deterministic. Item Number can be blank for expense lines
    // (freight, broker fees, tariffs) — we include the literal empty
    // segment so the line_index keeps the key unique on a bill with
    // multiple expense rows.
    const sourceLineKey = `${billNumber}::${itemNumber ?? ""}::${idx}`;

    out.push({
      source: SOURCE,
      bill_number: billNumber,
      bill_date: billDate,
      due_date: dueDate,
      vendor_code: vendorCode,
      vendor_name: vendorName,
      currency,
      item_number: itemNumber,
      description,
      qty,
      unit_price: unitPrice,
      amount,
      bill_status: billStatus,
      payment_status: paymentStatus,
      source_line_key: sourceLineKey,
    });
  }

  return { rows: out, counts };
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
  const rl = rateLimit(`ap-sync:${tok}`, RATE_LIMIT);
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

  const file = pickFile(files, "bills", "ap_bills", "ap");
  if (!file) {
    return res.status(400).json({
      error: "Missing 'bills' field",
      details: "Expected the bills*.csv (gzip OK; also accepts: ap_bills, ap)",
    });
  }

  let csvRows;
  try {
    const path = decompressIfGzipped(file);
    csvRows = readCsvRows(path);
  } catch (e) {
    return res.status(400).json({ error: "CSV decode failed", details: e.message });
  }

  const { rows: candidates, counts: parseCounts } = buildCandidates(csvRows);

  // Dedupe within the same payload — a single CSV can re-state the same
  // (bill, item, idx) triple if the producer streamed pages with overlap.
  // Last write wins (matches the upsert contract for re-runs).
  const byKey = new Map();
  for (const r of candidates) byKey.set(r.source_line_key, r);
  const aggregated = Array.from(byKey.values());

  const counts = {
    processed: true,
    request_id: requestId,
    csv_rows: parseCounts.csv_rows,
    deduped: candidates.length - aggregated.length,
    skipped_no_bill_number: parseCounts.skipped_no_bill_number,
    skipped_no_date: parseCounts.skipped_no_date,
    skipped_zero_qty: parseCounts.skipped_zero_qty,
    upserted: 0,
    errors: [],
    mode: "incremental",
  };

  for (let i = 0; i < aggregated.length; i += CHUNK) {
    const chunk = aggregated.slice(i, i + CHUNK);
    const { error } = await admin
      .from("ap_bills")
      .upsert(chunk, { onConflict: "source,source_line_key", ignoreDuplicates: false });
    if (error) {
      counts.errors.push(`ap_bills write chunk ${i}: ${error.message}`);
      continue;
    }
    counts.upserted += chunk.length;
  }

  return res.status(200).json(counts);
}
