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
import { canonColor } from "../../_lib/styleMatrix.js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";
import {
  normalizeRow,
  computeCompliance,
  DEFAULT_COMPLIANCE_THRESHOLD_PCT,
} from "../../_lib/master-sync-normalize.js";

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

// Build an upsert row for ip_item_master from one CurrentProducts CSV row.
// Returns null when the row has no usable identifier. Intentionally OMITS
// unit_cost from the payload — that column stays under the Excel uploader's
// control, and including it (even as null) would clobber hand-set values
// via the ON CONFLICT SET clause.
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

  const attributes = {};
  if (groupName) attributes.group_name = groupName;
  if (categoryName) attributes.category_name = categoryName;
  if (productCategory) attributes.product_category = productCategory;
  if (gender) attributes.gender = gender;

  return {
    sku_code: canonical,
    style_code: styleCode,
    // Canonicalize color on write so the nightly master sync never re-introduces
    // a spelling variant of a physical color (which would fragment matrices and
    // undo the color-canonicalization backfill). See canonColor.
    color: canonColor(opt1) || null,
    description: description || null,
    attributes: Object.keys(attributes).length > 0 ? attributes : null,
    uom: "each",
    active: true,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    return await _handleSync(req, res);
  } catch (e) {
    // Catch uncaught exceptions and return structured JSON so the nightly
    // log captures the real error message rather than Vercel's opaque 500 page.
    return res.status(500).json({ error: "handler_uncaught", details: e instanceof Error ? e.message : String(e) });
  }
}

async function _handleSync(req, res) {

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

  // Tier 2C: server-side port of daily_check.py's normalization + the
  // >=99% compliance gate from post_master_data.py. Both paths (Playwright
  // and REST) now run the same scrub. Idempotent: rows already cleaned
  // upstream pass through with changed=false, so the parallel-run window
  // does not double-mutate. See api/_lib/master-sync-normalize.js docstring.
  const normalizedResults = csvRows.map((r) => normalizeRow(r));
  const compliance = computeCompliance(csvRows, normalizedResults);

  // Threshold can be overridden per request via ?min_compliance_pct=...
  // (allows ops to dial it down for an emergency upload). Default mirrors
  // post_master_data.py's --min-compliance-pct default of 99.0.
  const overrideRaw = String(
    (req.query && req.query.min_compliance_pct) || ""
  ).trim();
  const overrideNum = overrideRaw === "" ? NaN : Number(overrideRaw);
  const threshold = Number.isFinite(overrideNum) && overrideNum >= 0 && overrideNum <= 100
    ? overrideNum
    : DEFAULT_COMPLIANCE_THRESHOLD_PCT;

  // Gate on gate_compliance_pct, which forgives ADVISORY_BUCKETS
  // (GENDER_MISMATCH). The prefix-rule-vs-Xoro gender disagreement is a
  // source-data review item, not a reason to reject the whole snapshot —
  // and the local daily_check.py path already treats it as compliant, so
  // gating on the strict pct here left the two metrics permanently at odds
  // (server saw 97.9% while the nightly email reported 99.95%). The strict
  // compliance_pct + bucket counts are still surfaced for telemetry.
  if (csvRows.length > 0 && compliance.gate_compliance_pct < threshold) {
    // Hard fail: do NOT upsert anything. Mirrors post_master_data.py's
    // exit 5 abort behavior — the DB never sees a sub-threshold snapshot.
    return res.status(422).json({
      error: "compliance_gate_failed",
      request_id: requestId,
      compliance_pct: compliance.compliance_pct,
      gate_compliance_pct: compliance.gate_compliance_pct,
      advisory_count: compliance.advisory_count,
      threshold_pct: threshold,
      scanned: compliance.scanned,
      compliant: compliance.compliant,
      auto_corrected: compliance.auto_corrected,
      buckets: compliance.buckets,
      message: `Gate compliance ${compliance.gate_compliance_pct}% < ${threshold}% threshold; refusing upsert. (strict ${compliance.compliance_pct}%, ${compliance.advisory_count} advisory rows forgiven)`,
    });
  }

  const counts = {
    request_id: requestId,
    csv_rows: csvRows.length,
    deduped_to_unique_skus: 0,
    skipped_no_sku: 0,
    upserted: 0,
    errors: [],
    // Surface normalization + compliance metrics so the nightly log + the
    // operator's daily email reflect server-side scrub status.
    compliance_pct: compliance.compliance_pct,
    gate_compliance_pct: compliance.gate_compliance_pct,
    advisory_count: compliance.advisory_count,
    compliance_threshold_pct: threshold,
    normalization: {
      scanned: compliance.scanned,
      auto_corrected: compliance.auto_corrected,
      unchanged_ok: compliance.unchanged_ok,
      buckets: compliance.buckets,
    },
  };

  // Build dedup'd candidate map, consuming normalized rows so buildCandidate
  // sees already-scrubbed values. Order of csvRows + normalizedResults is
  // preserved by Array.map above.
  const candidates = new Map();
  for (let i = 0; i < csvRows.length; i++) {
    const cand = buildCandidate(normalizedResults[i].row);
    if (!cand) { counts.skipped_no_sku++; continue; }
    if (candidates.has(cand.sku_code)) continue;
    candidates.set(cand.sku_code, cand);
  }
  counts.deduped_to_unique_skus = candidates.size;

  // Split candidates by existence so we can apply different policies:
  //   - INSERTs need is_apparel:false in the payload, otherwise the column
  //     DEFAULT true combined with our missing size/inseam/length/fit trips
  //     the apparel_dims_required CHECK. (Merchandiser flips is_apparel back
  //     to true via the admin UI once they finish backfilling dims — same
  //     flow Tangerine P1 Chunk 4.5 already established.)
  //   - UPDATEs must NOT include is_apparel, or every existing merchandiser-
  //     curated bottoms row would get demoted to is_apparel=false.
  // Same authority model as unit_cost / unit_price exclusion above.
  const allSkus = Array.from(candidates.keys());
  const existingSkus = new Set();
  for (let i = 0; i < allSkus.length; i += CHUNK) {
    const chunk = allSkus.slice(i, i + CHUNK);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("sku_code")
      .in("sku_code", chunk);
    if (error) {
      counts.errors.push(`pre-fetch chunk ${i}: ${error.message}`);
      continue;
    }
    for (const r of (data || [])) existingSkus.add(r.sku_code);
  }

  const newRows = [];
  const updateRows = [];
  for (const cand of candidates.values()) {
    if (existingSkus.has(cand.sku_code)) {
      // Update path: narrow to the two fields Xoro is the authoritative source
      // for (description + attributes). Color/style_code/etc. are excluded so
      // an empty REST Option1Value can't NULL-out an existing apparel row's
      // color and trip apparel_dims_required. Same authority model the
      // header docstring describes: "existing rows with populated values
      // are left alone."
      updateRows.push({
        sku_code: cand.sku_code,
        description: cand.description,
        attributes: cand.attributes,
      });
    } else {
      newRows.push({ ...cand, is_apparel: false });
    }
  }
  counts.new_rows = newRows.length;
  counts.updated_rows = updateRows.length;

  // NEW-row path: plain INSERT (via upsert with ignoreDuplicates so a race
  // doesn't error). is_apparel:false in the payload satisfies
  // apparel_dims_required on the proposed row.
  for (let i = 0; i < newRows.length; i += CHUNK) {
    const chunk = newRows.slice(i, i + CHUNK);
    const { error } = await admin
      .from("ip_item_master")
      .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: true });
    if (error) {
      counts.errors.push(`upsert new chunk ${i}: ${error.message}`);
      continue;
    }
    counts.upserted += chunk.length;
  }
  // UPDATE-row path: call the bulk_refresh RPC instead of upsert. PostgREST
  // upsert builds INSERT...ON CONFLICT, and PG evaluates CHECK on the
  // proposed INSERT row BEFORE the conflict resolves — apparel_dims_required
  // fails immediately because the payload's is_apparel defaults to true with
  // size/inseam/length/fit NULL. The RPC does a true UPDATE FROM jsonb input,
  // skipping the INSERT path entirely. Migration 20260713050000.
  for (let i = 0; i < updateRows.length; i += CHUNK) {
    const chunk = updateRows.slice(i, i + CHUNK);
    const { data, error } = await admin.rpc(
      "bulk_refresh_item_master_descriptions",
      { payload: chunk }
    );
    if (error) {
      counts.errors.push(`rpc update chunk ${i}: ${error.message}`);
      continue;
    }
    counts.upserted += (typeof data === "number") ? data : chunk.length;
  }

  return res.status(200).json({ processed: true, ...counts });
}
// (closing brace for _handleSync)
