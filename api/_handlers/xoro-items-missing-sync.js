// api/_handlers/xoro-items-missing-sync.js — Vercel Node.js Serverless Function
//
// "Add new items" button on the wholesale workbench. Pulls the Xoro item
// catalog and inserts ONLY the SKUs that are not already present in
// ip_item_master. Existing rows are never touched (Item Master Excel
// remains the source of truth). Fields populated for new rows mirror
// what the Excel ingest would set: sku_code, style_code, color,
// description, attributes.{group_name,category_name}, and unit_cost
// when Xoro returns one.
//
// Query params:
//   path        Xoro endpoint override (default: item/getitem)
//   page_start  starting page number (default: 1)
//   page_limit  max pages to walk (default: 50, capped at 200)

import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll } from "../_lib/xoro-client.js";
import { canonSku, canonStyleColor, parseStyleColor } from "../_lib/sku-canon.js";

export const config = { maxDuration: 300 };

const ITEMS_PATH = "item/getitem";

// First non-empty value across multiple Xoro field-name spellings —
// guards us from fragile mappings if Xoro renames a property.
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function stripHtml(s) {
  if (!s || typeof s !== "string") return s;
  if (!s.includes("<")) return s;
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured", supabase: !!SB_URL, serviceKey: !!SERVICE_KEY });
  }

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || ITEMS_PATH;
  const pageStart = Math.max(parseInt(url.searchParams.get("page_start") || "1", 10), 1);
  const pageLimit = Math.min(parseInt(url.searchParams.get("page_limit") || "50", 10), 200);

  const result = {
    xoro_path: path,
    pages_fetched: 0,
    xoro_items_fetched: 0,
    deduped_to_unique_skus: 0,
    already_in_master: 0,
    inserted: 0,
    new_skus: 0,
    skipped_no_sku: 0,
    errors: [],
  };

  // 1. Fetch Xoro item pages.
  const xoro = await fetchXoroAll({
    path,
    params: { per_page: "500" },
    pageStart,
    maxPages: pageLimit,
    module: "items",
  });
  if (!xoro.ok) {
    return res.status(200).json({ ...result, error: "XORO_FETCH_FAILED", xoro: xoro.body });
  }
  const data = Array.isArray(xoro.body?.Data) ? xoro.body.Data : [];
  result.xoro_items_fetched = data.length;
  result.pages_fetched = xoro.pageNotes?.length ?? 0;
  if (data.length === 0) {
    return res.status(200).json({ ...result, hint: "Xoro returned 0 items. Override path with ?path=…" });
  }

  // 2. Normalize each Xoro row into a candidate ip_item_master row.
  const candidates = new Map(); // canonical sku → row
  for (const x of data) {
    // SKU resolution: prefer ItemNumber / SKU columns; otherwise compose
    // from BasePartNumber + Option1Value (matches the Xoro item export).
    let raw = pick(x, ["ItemNumber", "SkuCode", "Sku", "ItemCode", "Item"]);
    let sku;
    if (raw) {
      sku = canonStyleColor(raw); // strip size suffix → style+color grain
    } else {
      const base = pick(x, ["BasePartNumber", "BasePart", "Style", "StyleCode"]);
      const opt1 = pick(x, ["Option1Value", "Color", "Colour"]);
      if (!base) { result.skipped_no_sku++; continue; }
      sku = canonSku([base, opt1].filter(Boolean).join("-"));
    }
    if (!sku) { result.skipped_no_sku++; continue; }
    if (candidates.has(sku)) continue;

    const { style: parsedStyle } = parseStyleColor(sku);
    const explicitStyle = pick(x, ["BasePartNumber", "Style", "StyleCode"]);
    const explicitColor = pick(x, ["Option1Value", "Color", "Colour"]);
    const description = stripHtml(
      pick(x, ["Title", "Description", "BodyHtml", "ItemName", "Name"]),
    );
    const groupName = pick(x, ["GroupName", "Group"]);
    const categoryName = pick(x, ["CategoryName", "Category"]);
    const cost = toNum(pick(x, ["StandardUnitCost", "UnitCost", "Cost", "AvgCost", "AverageCost"]));

    // Prefer parsedStyle over explicitStyle. The rest of the planner
    // groups variants by string-prefix of sku_code, so style_code MUST
    // match sku_code's prefix (parseStyleColor returns the substring
    // before the first dash). Xoro's BasePartNumber sometimes carries a
    // suffix that the canonical SKU doesn't (e.g. "RYO0659FP" vs
    // canonical "RYO0659-…"), which would split aggregate views.
    const row = {
      sku_code: sku,
      style_code: parsedStyle ?? (explicitStyle ? String(explicitStyle).trim() : sku),
      color: explicitColor ? String(explicitColor).trim() : null,
      uom: "each",
      active: true,
    };
    if (description) row.description = String(description).trim();
    if (cost != null && cost >= 0) row.unit_cost = cost;
    const attrs = {};
    if (groupName) attrs.group_name = String(groupName).trim();
    if (categoryName) attrs.category_name = String(categoryName).trim();
    if (Object.keys(attrs).length > 0) row.attributes = attrs;
    candidates.set(sku, row);
  }
  result.deduped_to_unique_skus = candidates.size;

  // 3. Diff against existing ip_item_master to keep only the missing ones.
  const allSkus = Array.from(candidates.keys());
  const existing = new Set();
  const CHUNK = 500;
  for (let i = 0; i < allSkus.length; i += CHUNK) {
    const chunk = allSkus.slice(i, i + CHUNK);
    const { data: rows, error } = await admin
      .from("ip_item_master")
      .select("sku_code")
      .in("sku_code", chunk);
    if (error) {
      result.errors.push(`existing-lookup chunk ${i}: ${error.message}`);
      continue;
    }
    for (const r of rows ?? []) existing.add(r.sku_code);
  }
  result.already_in_master = existing.size;

  const toInsert = [];
  for (const [sku, row] of candidates) {
    if (!existing.has(sku)) toInsert.push(row);
  }
  result.new_skus = toInsert.length;
  if (toInsert.length === 0) {
    return res.status(200).json({ ...result, message: "All Xoro items are already in master — nothing to insert." });
  }

  // 4. Insert with ignoreDuplicates so a concurrent Excel upload during
  // this run can't get clobbered. Existing rows from the Excel master
  // are protected by the ON CONFLICT DO NOTHING.
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { error } = await admin
      .from("ip_item_master")
      .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: true });
    if (error) {
      result.errors.push(`insert chunk ${i}: ${error.message}`);
      continue;
    }
    result.inserted += chunk.length;
  }

  return res.status(200).json(result);
}
