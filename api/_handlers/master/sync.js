// POST /api/master/sync — scriptable item-master refresh from Xoro CSV.
//
// Accepts the nightly CurrentProducts*.csv from Xoro (gzipped) and folds
// new style+color combos into ip_item_master, plus fills in NULL fields
// on existing rows. Existing rows with populated values are left alone —
// the Item Master Excel uploader remains the authoritative source for
// hand-tuned data.
//
// Why this exists: the ATS UI looks up styles via ip_item_master. The
// modal Excel uploader only seeds rows with sku_code; style_code, color,
// description and attributes were often left NULL, so the ATS grid showed
// "—" for the STYLE column on those rows. Xoro's nightly CurrentProducts
// CSV is the canonical source for the missing fields.
//
//   curl -F "master_data=@CurrentProducts<ts>.csv.gz" \
//        -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/master/sync
//
// CSV grain: one row per (BasePartNumber, Option1Value, Option2Value).
// We dedupe to (style, color) grain via canonStyleColor before upserting,
// matching how the ATS lookup keys rows (size lives separately).

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import formidable from "formidable";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { canonStyleColor, parseStyleColor } from "../../_lib/sku-canon.js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

export const config = { api: { bodyParser: false }, maxDuration: 300 };

const RATE_LIMIT = { limit: 12, windowMs: 60 * 60 * 1000 };
const CHUNK = 500;

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

function stripHtml(s) {
  if (!s || typeof s !== "string") return s;
  if (!s.includes("<")) return s;
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// Build a candidate ip_item_master row from one CurrentProducts CSV row.
// Returns null when the row has no usable identifier.
function buildCandidate(r) {
  const itemNumber = str(r.ItemNumber);
  const basePart = str(r.BasePartNumber);
  const opt1 = str(r.Option1Value);

  let canonical = itemNumber ? canonStyleColor(itemNumber) : "";
  if (!canonical && basePart) {
    canonical = canonStyleColor([basePart, opt1].filter(Boolean).join("-"));
  }
  if (!canonical) return null;

  const { style: parsedStyle } = parseStyleColor(canonical);
  const explicitStyle = basePart;
  const styleCode = explicitStyle && explicitStyle.length > 0
    ? explicitStyle
    : (parsedStyle ?? canonical);

  const description = stripHtml(str(r.Description) || str(r.Title));
  const groupName = str(r.GroupName);
  const categoryName = str(r.CategoryName);
  const productCategory = str(r.ProductCategoryName);
  const gender = str(r.GenderCode);
  const cost = toNum(r.StandardUnitCost);

  const attributes = {};
  if (groupName) attributes.group_name = groupName;
  if (categoryName) attributes.category_name = categoryName;
  if (productCategory) attributes.product_category = productCategory;
  if (gender) attributes.gender = gender;

  return {
    sku_code: canonical,
    style_code: styleCode,
    color: opt1 || null,
    description: description || null,
    unit_cost: cost,
    attributes: Object.keys(attributes).length > 0 ? attributes : null,
  };
}

// Decide whether `existing` row needs an update from `cand`. Only fills
// NULL/empty scalar fields. Attributes JSONB is merged: keys present on
// existing win; new keys from cand are added.
function buildUpdateForExisting(existing, cand) {
  const updates = {};
  if ((existing.style_code == null || existing.style_code === "") && cand.style_code) {
    updates.style_code = cand.style_code;
  }
  if ((existing.color == null || existing.color === "") && cand.color) {
    updates.color = cand.color;
  }
  if ((existing.description == null || existing.description === "") && cand.description) {
    updates.description = cand.description;
  }
  if (cand.attributes) {
    const ex = existing.attributes && typeof existing.attributes === "object"
      ? existing.attributes
      : {};
    const merged = { ...cand.attributes, ...ex }; // existing wins
    const exKeys = Object.keys(ex);
    const mergedKeys = Object.keys(merged);
    // Only emit an update if merging adds at least one new key.
    if (mergedKeys.length > exKeys.length) {
      updates.attributes = merged;
    }
  }
  return updates;
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
  const rl = rateLimit(`master-sync:${tok}`, RATE_LIMIT);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retry_after_s));
    return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });
  }

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Supabase not configured (VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required)" });
  }
  const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  const requestId = randomUUID();
  const form = formidable({ maxFileSize: 50 * 1024 * 1024, multiples: false });
  let files;
  try {
    [, files] = await form.parse(req);
  } catch (e) {
    return res.status(400).json({ error: "Multipart parse error", details: e.message });
  }

  const file = pickFile(files, "master_data", "current_products", "items");
  if (!file) {
    return res.status(400).json({
      error: "Missing 'master_data' field",
      details: "Expected the CurrentProducts*.csv (gzip OK; also accepts: current_products, items)",
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
    deduped_to_unique_skus: 0,
    skipped_no_sku: 0,
    already_complete: 0,
    inserted: 0,
    updated: 0,
    errors: [],
  };

  // Build dedup'd candidate map.
  const candidates = new Map();
  for (const r of csvRows) {
    const cand = buildCandidate(r);
    if (!cand) { counts.skipped_no_sku++; continue; }
    if (candidates.has(cand.sku_code)) continue;
    candidates.set(cand.sku_code, cand);
  }
  counts.deduped_to_unique_skus = candidates.size;

  // Diff against existing ip_item_master.
  const allSkus = Array.from(candidates.keys());
  const existingMap = new Map();
  for (let i = 0; i < allSkus.length; i += CHUNK) {
    const chunk = allSkus.slice(i, i + CHUNK);
    const { data: rows, error } = await admin
      .from("ip_item_master")
      .select("sku_code, style_code, color, description, attributes")
      .in("sku_code", chunk);
    if (error) {
      counts.errors.push(`existing-lookup chunk ${i}: ${error.message}`);
      continue;
    }
    for (const r of rows ?? []) existingMap.set(r.sku_code, r);
  }

  const toInsert = [];
  const toUpdate = [];
  for (const [sku, cand] of candidates) {
    const existing = existingMap.get(sku);
    if (!existing) {
      toInsert.push({
        sku_code: cand.sku_code,
        style_code: cand.style_code,
        color: cand.color,
        description: cand.description,
        attributes: cand.attributes,
        unit_cost: cand.unit_cost,
        uom: "each",
        active: true,
      });
      continue;
    }
    const updates = buildUpdateForExisting(existing, cand);
    if (Object.keys(updates).length > 0) {
      toUpdate.push({ sku_code: sku, ...updates });
    } else {
      counts.already_complete++;
    }
  }

  // Insert new rows (ignoreDuplicates protects against races with the
  // Excel uploader). We don't pre-check via the existence Set because
  // a manual upload between our select and our insert would still be
  // protected by the ON CONFLICT DO NOTHING.
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { error } = await admin
      .from("ip_item_master")
      .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: true });
    if (error) {
      counts.errors.push(`insert chunk ${i}: ${error.message}`);
      continue;
    }
    counts.inserted += chunk.length;
  }

  // Update fills (per-row UPDATE; Supabase's batch upsert with
  // ignoreDuplicates: false would overwrite columns we don't want to
  // touch, so per-row is the safest path).
  for (const u of toUpdate) {
    const { sku_code, ...patch } = u;
    const { error } = await admin
      .from("ip_item_master")
      .update(patch)
      .eq("sku_code", sku_code);
    if (error) {
      counts.errors.push(`update ${sku_code}: ${error.message}`);
      continue;
    }
    counts.updated++;
  }

  return res.status(200).json({ processed: true, ...counts });
}
