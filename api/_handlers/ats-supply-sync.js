// api/ats-supply-sync.js — Vercel Node.js Serverless Function
//
// Pulls supply state (on-hand, on-SO, on-PO from ATS upload) for the
// planning grid. Source: app_data['ats_excel_data'] which the ATS app
// already keeps fresh from manual uploads.
//
// Writes to ip_inventory_snapshot (one row per SKU per snapshot date).
// Uses today's date so successive runs roll forward.
//
// Performance: the auto-create-missing-items path used to run one
// upsert per SKU which timed out on multi-thousand catalogs. Now we
// bulk-upsert all missing items in 500-row chunks, then bulk-upsert
// all snapshot rows.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 300 };

function canonSku(s) {
  return (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, "");
}
// Drop trailing size suffix so ATS items match the Excel-grain SKUs
// (style+color). Mirrors tanda-pos-sync's canonStyleColor — keep the
// regex in sync.
function canonStyleColor(rawSku) {
  let s = canonSku(rawSku);
  if (!s) return s;
  s = s.replace(
    /-(XS|S|M|L|XL|XXL|XXXL|SM|MD|LG|SML|MED|LRG|OS|OSFA|O\/S|[0-9]+|[A-Z]+\([0-9X\-]+\))$/,
    "",
  );
  return s;
}
function toNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1. Pull the persisted ATS Excel snapshot.
  const { data: appRow, error: appErr } = await admin
    .from("app_data")
    .select("value")
    .eq("key", "ats_excel_data")
    .maybeSingle();
  if (appErr) return res.status(500).json({ error: "ats_excel_data fetch failed", details: appErr.message });
  if (!appRow?.value) return res.status(200).json({ error: "No ATS Excel snapshot uploaded yet — open ATS app and upload an inventory file first." });

  let parsed;
  try { parsed = typeof appRow.value === "string" ? JSON.parse(appRow.value) : appRow.value; }
  catch (e) { return res.status(500).json({ error: "ATS snapshot is not valid JSON", details: String(e) }); }

  const allSkus = Array.isArray(parsed?.skus) ? parsed.skus : [];
  if (allSkus.length === 0) return res.status(200).json({ error: "ATS snapshot has no SKU array", parsed_keys: Object.keys(parsed ?? {}) });

  // Chunked processing — large catalogs (10k+ SKUs) blow the Vercel
  // gateway timeout in a single call. Caller passes ?start=0 and the
  // handler returns next_start so the UI can keep clicking.
  const url = new URL(req.url, `https://${req.headers.host}`);
  const start = Math.max(parseInt(url.searchParams.get("start") || "0", 10), 0);
  const batchSize = Math.min(parseInt(url.searchParams.get("limit") || "2000", 10), 10000);
  const skus = allSkus.slice(start, start + batchSize);
  const nextStart = start + batchSize >= allSkus.length ? null : start + batchSize;

  const today = new Date().toISOString().slice(0, 10);
  const result = {
    ats_skus_total: allSkus.length,
    ats_skus_in_batch: skus.length,
    start, batch_size: batchSize,
    next_start: nextStart,
    done: nextStart === null,
    inserted: 0,
    auto_created_skus: 0,
    skipped_no_sku: 0,
    skipped_zero_state: 0,
    snapshot_date: today,
    errors: [],
  };

  // 2. Pre-canonicalize at style+color grain (drop size) and aggregate
  //    so multiple ATS rows for the same style+color (different sizes)
  //    sum into one snapshot row. Matches Excel-sourced grid SKUs.
  const aggMap = new Map();
  for (const s of skus) {
    const sku = canonStyleColor(s.sku);
    if (!sku) { result.skipped_no_sku++; continue; }
    const onHand = toNum(s.onHand);
    const onPO = toNum(s.onPO);
    const onSo = toNum(s.onSO ?? s.onOrder);
    if (onHand === 0 && onPO === 0 && onSo === 0) { result.skipped_zero_state++; continue; }
    const prev = aggMap.get(sku);
    if (!prev) {
      aggMap.set(sku, { sku, src: s, onHand, onPO, onSo });
    } else {
      prev.onHand += onHand;
      prev.onPO += onPO;
      prev.onSo += onSo;
      // Keep first src for description/cost — they should match across sizes anyway.
    }
  }
  const candidates = Array.from(aggMap.values());

  // 3. Resolve only the SKUs in this batch (instead of pulling the full
  //    20k-row item master). Postgres `in.` accepts long lists; chunk to
  //    stay under URL length limits.
  const itemMap = new Map();
  const candidateSkus = candidates.map((c) => c.sku);
  for (let i = 0; i < candidateSkus.length; i += 200) {
    const chunk = candidateSkus.slice(i, i + 200);
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .in("sku_code", chunk);
    if (error) return res.status(500).json({ error: "item_master fetch failed", details: error.message });
    for (const r of data ?? []) itemMap.set(canonSku(r.sku_code), r.id);
  }

  // 4. Bulk-create missing items in 500-row chunks (was per-SKU before;
  //    that hit the 60s timeout on large catalogs).
  const missing = candidates.filter((c) => !itemMap.has(c.sku));
  if (missing.length > 0) {
    const newItems = missing.map((c) => ({
      sku_code: c.sku,
      description: c.src.description ?? null,
      unit_cost: toNum(c.src.avgCost) || null,
      uom: "each",
      active: true,
      external_refs: { ats_category: c.src.category ?? null },
    }));
    for (let i = 0; i < newItems.length; i += 500) {
      const chunk = newItems.slice(i, i + 500);
      const { data: created, error } = await admin
        .from("ip_item_master")
        .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: false })
        .select("id, sku_code");
      if (error) {
        result.errors.push(`item bulk create chunk ${i}: ${error.message}`);
        continue;
      }
      for (const row of created ?? []) itemMap.set(canonSku(row.sku_code), row.id);
      result.auto_created_skus += chunk.length;
    }
  }

  // 5. Build snapshot rows now that every candidate has a sku_id.
  const rows = [];
  for (const c of candidates) {
    const skuId = itemMap.get(c.sku);
    if (!skuId) { result.errors.push(`no id for ${c.sku} after bulk create`); continue; }
    rows.push({
      sku_id: skuId,
      warehouse_code: "DEFAULT",
      snapshot_date: today,
      qty_on_hand: c.onHand,
      qty_committed: c.onSo,
      qty_on_order: c.onPO,
      qty_available: Math.max(0, c.onHand - c.onSo),
      source: "manual",
    });
  }

  // 5b. Also write avg cost to ip_item_avg_cost so the static "Avg Cost"
  //     column on the planning grid populates from ATS in addition to
  //     the inventory snapshot. Unit Cost editor uses this as its
  //     fallback default before the planner overrides.
  const avgCostRows = [];
  for (const c of candidates) {
    const cost = toNum(c.src.avgCost);
    if (cost > 0) {
      avgCostRows.push({
        sku_code: c.sku,
        avg_cost: cost,
        source: "manual",
        source_ref: "ats_excel_data",
      });
    }
  }
  if (avgCostRows.length > 0) {
    for (let i = 0; i < avgCostRows.length; i += 500) {
      const chunk = avgCostRows.slice(i, i + 500);
      const { error } = await admin
        .from("ip_item_avg_cost")
        .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: false });
      if (error) result.errors.push(`avg_cost chunk ${i}: ${error.message}`);
    }
    result.avg_costs_upserted = avgCostRows.length;
  }

  // 6. Bulk-upsert snapshot rows. Unique index =
  //    (sku_id, warehouse_code, snapshot_date, source).
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_inventory_snapshot")
      .upsert(chunk, { onConflict: "sku_id,warehouse_code,snapshot_date,source", ignoreDuplicates: false });
    if (error) result.errors.push(`snapshot chunk ${i}: ${error.message}`);
    else result.inserted += chunk.length;
  }

  return res.status(200).json(result);
}
