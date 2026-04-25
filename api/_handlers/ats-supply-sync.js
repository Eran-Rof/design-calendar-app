// api/ats-supply-sync.js — Vercel Node.js Serverless Function
//
// Pulls supply state (on-hand, on-SO, on-PO from ATS upload) for the
// planning grid. Source: app_data['ats_excel_data'] which the ATS app
// already keeps fresh from manual uploads.
//
// Writes to ip_inventory_snapshot (one row per SKU per snapshot date).
// Uses today's date so successive runs roll forward.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 120 };

function canonSku(s) {
  return (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, "");
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

  const skus = Array.isArray(parsed?.skus) ? parsed.skus : [];
  if (skus.length === 0) return res.status(200).json({ error: "ATS snapshot has no SKU array", parsed_keys: Object.keys(parsed ?? {}) });

  // 2. Load item master so we can resolve sku_code → sku_id.
  const itemMap = new Map();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .order("sku_code", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return res.status(500).json({ error: "item_master fetch failed", details: error.message });
    if (!data || data.length === 0) break;
    for (const r of data) itemMap.set(canonSku(r.sku_code), r.id);
    if (data.length < PAGE) break;
  }

  // 3. Auto-create missing items (so we don't drop SKUs the planner has
  //    in inventory but hasn't sold yet).
  const today = new Date().toISOString().slice(0, 10);
  const result = {
    ats_skus: skus.length,
    inserted: 0,
    auto_created_skus: 0,
    skipped_no_sku: 0,
    skipped_zero_state: 0,
    snapshot_date: today,
    errors: [],
  };

  const rows = [];
  for (const s of skus) {
    const sku = canonSku(s.sku);
    if (!sku) { result.skipped_no_sku++; continue; }

    const onHand = toNum(s.onHand);
    const onPO = toNum(s.onPO);
    const onSo = toNum(s.onSO ?? s.onOrder);
    if (onHand === 0 && onPO === 0 && onSo === 0) { result.skipped_zero_state++; continue; }

    let skuId = itemMap.get(sku);
    if (!skuId) {
      const { data: created, error: createErr } = await admin
        .from("ip_item_master")
        .upsert({
          sku_code: sku,
          description: s.description ?? null,
          unit_cost: toNum(s.avgCost) || null,
          uom: "each",
          active: true,
          external_refs: { ats_category: s.category ?? null },
        }, { onConflict: "sku_code", ignoreDuplicates: false })
        .select("id")
        .single();
      if (createErr || !created) { result.errors.push(`item create ${sku}: ${createErr?.message ?? "no row"}`); continue; }
      skuId = created.id;
      itemMap.set(sku, skuId);
      result.auto_created_skus++;
    }

    rows.push({
      sku_id: skuId,
      warehouse_code: "DEFAULT",
      snapshot_date: today,
      qty_on_hand: onHand,
      qty_committed: onSo,
      qty_on_order: onPO,
      qty_available: Math.max(0, onHand - onSo),
      source: "manual",
    });
  }

  // 4. Upsert in 500-row chunks. Unique index is
  // (sku_id, warehouse_code, snapshot_date, source).
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_inventory_snapshot")
      .upsert(chunk, { onConflict: "sku_id,warehouse_code,snapshot_date,source", ignoreDuplicates: false });
    if (error) result.errors.push(error.message);
    else result.inserted += chunk.length;
  }

  return res.status(200).json(result);
}
