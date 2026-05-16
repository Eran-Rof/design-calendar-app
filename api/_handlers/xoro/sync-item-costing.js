// POST /api/xoro/sync-item-costing — nightly Xoro Item Costing ingest.
//
// Receives the gzipped CSV of Xoro's "Item Costing Report (Average Cost) 5"
// from post_item_costing.py and upserts each row into ip_item_avg_cost
// (source='xoro'). The same row also populates the brand_name column so
// downstream consumers can pick brand off the same table without an extra
// ip_item_master fetch.
//
// CSV shape:
//   Description, Standard Unit Price, Average Cost, Brand Name, Item Number
// Average Cost is frequently empty (Xoro emits blank for items that haven't
// moved). We still upsert those rows so brand + standard_unit_price land —
// the cost-resolution helper handles the null-cost cascade downstream.
//
//   curl -F "costing=@ItemCostingReport<ts>.csv.gz" \
//        -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/xoro/sync-item-costing

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import formidable from "formidable";
import { createClient } from "@supabase/supabase-js";
import { canonSku } from "../../_lib/sku-canon.js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

// NOTE: We intentionally do NOT use the `xlsx` package here. The Vercel
// dispatcher static-imports every handler under api/_handlers/ at cold
// start, and `xlsx` (CJS) triggers a Node ESM/CJS interop assertion
// failure ("ERR_INTERNAL_ASSERTION: module imported again after being
// required") when this handler's import path is added to the graph.
// The input is CSV, so the small RFC-4180 parser below avoids the dep.

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };
const CHUNK = 500;
const SOURCE = "xoro";
const SOURCE_REF = "item_costing_report";

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

// Minimal RFC-4180 CSV parser. Returns Array<Record<headerName,string>>.
// Handles: leading UTF-8 BOM, CRLF / LF / CR line endings, quoted fields,
// embedded commas inside quoted fields, escaped quotes (""), trailing
// blank rows (Xoro pads ItemCostingReport with hundreds of empty rows).
function parseCsv(text) {
  if (!text) return [];
  // Strip UTF-8 BOM if present (Xoro CSVs start with ﻿).
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
    if (ch === "\r") {
      // CRLF or lone CR — end of line either way.
      row.push(field); field = "";
      rows.push(row); row = [];
      if (i + 1 < len && text[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush final field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];

  // First non-empty row is the header.
  let headerIdx = 0;
  while (headerIdx < rows.length && rows[headerIdx].every((c) => c.trim() === "")) {
    headerIdx += 1;
  }
  if (headerIdx >= rows.length) return [];
  const header = rows[headerIdx].map((h) => h.trim());

  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip completely blank rows (Xoro's CSV has hundreds of these at the end).
    if (cells.every((c) => c.trim() === "")) continue;
    const rec = {};
    for (let c = 0; c < header.length; c++) {
      rec[header[c]] = cells[c] ?? "";
    }
    out.push(rec);
  }
  return out;
}

function readCsvRows(filepath) {
  const buffer = readFileSync(filepath);
  return parseCsv(buffer.toString("utf8"));
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

// Xoro CSV numbers come quoted with thousands separators ("6,000.00")
// when they exceed 999. Strip commas before parsing.
function toNum(v) {
  if (v == null || v === "") return null;
  const cleaned = String(v).replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

// Xoro emits the literal string "null" for missing brand on miscellaneous
// charge SKUs ("Miscellaneous Charge", "Refunds", etc.). Treat that as
// missing so brand=null in the table rather than the string "null".
function brandOrNull(v) {
  const s = str(v);
  if (!s) return null;
  if (s.toLowerCase() === "null") return null;
  return s;
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
  const rl = rateLimit(`item-costing:${tok}`, RATE_LIMIT);
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

  const file = pickFile(files, "costing", "item_costing", "csv");
  if (!file) {
    return res.status(400).json({
      error: "Missing 'costing' field",
      details: "Expected the ItemCostingReport*.csv (gzip OK; also accepts: item_costing, csv)",
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
    skipped_no_sku: 0,
    skipped_blank_row: 0,
    rows_with_avg_cost: 0,
    rows_with_brand: 0,
    upserted: 0,
    errors: [],
  };

  // ── Pass 1: parse + dedupe by canonical SKU ────────────────────────────
  const bySku = new Map(); // canonicalSku → row to upsert
  for (const r of csvRows) {
    const itemNumber = str(r["Item Number"]);
    if (!itemNumber) {
      // Trailing blank rows in the Xoro CSV are common.
      counts.skipped_blank_row++;
      continue;
    }
    const sku = canonSku(itemNumber);
    if (!sku) { counts.skipped_no_sku++; continue; }

    const avgCost = toNum(r["Average Cost"]);
    const standardPrice = toNum(r["Standard Unit Price"]);
    const brand = brandOrNull(r["Brand Name"]);

    // Skip rows where everything we care about is blank. (Some Xoro
    // service-line SKUs are price=0/cost=null/brand=null — keeping
    // them would just bloat the table with nulls.)
    if (avgCost == null && standardPrice == null && !brand) {
      counts.skipped_blank_row++;
      continue;
    }

    if (avgCost != null) counts.rows_with_avg_cost++;
    if (brand) counts.rows_with_brand++;

    // Last-write-wins within a single CSV — but with this report each
    // Item Number is unique already, so the Map is just deduping.
    bySku.set(sku, {
      sku_code: sku,
      avg_cost: avgCost != null && avgCost >= 0 ? avgCost : null,
      standard_unit_price: standardPrice != null && standardPrice >= 0 ? standardPrice : null,
      brand_name: brand,
      source: SOURCE,
      source_ref: SOURCE_REF,
      updated_at: new Date().toISOString(),
    });
  }

  const rows = Array.from(bySku.values());

  // ── Pass 2: upsert in chunks ────────────────────────────────────────────
  // PostgREST refuses heterogeneous payloads on a single upsert call when
  // some rows have keys others don't. We always include all four optional
  // columns (avg_cost / standard_unit_price / brand_name / source_ref)
  // — null where absent — so every row in the chunk has the same shape.
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await admin
      .from("ip_item_avg_cost")
      .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: false });
    if (error) {
      counts.errors.push(`upsert chunk ${i}: ${error.message}`);
      continue;
    }
    counts.upserted += chunk.length;
  }

  return res.status(200).json({ processed: true, ...counts });
}
