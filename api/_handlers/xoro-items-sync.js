// api/xoro-items-sync.js — Vercel Node.js Serverless Function
//
// Pulls the Xoro item catalog and upserts into ip_item_master so the
// planning grid (and the sales-history ingest) can resolve real SKUs.
//
// Query params:
//   path        Xoro endpoint override (default: item/getitem)
//   page_limit  max pages to fetch (default: 5, cap: 50)
//   active_only true|false (default: true)
//
// Uses the default Xoro creds (VITE_XORO_API_KEY/SECRET). Add a `module`
// override here if Xoro provisions a separate items API key later.

import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll } from "../_lib/xoro-client.js";

export const config = { maxDuration: 300 };

const ITEMS_PATH = "item/getitem";

function canonSku(s) {
  return (s ?? "").toString().trim().toUpperCase();
}

function toNum(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || ITEMS_PATH;
  const pageLimit = Math.min(parseInt(url.searchParams.get("page_limit") || "5", 10), 50);
  const pageStart = Math.max(parseInt(url.searchParams.get("page_start") || "1", 10), 1);
  const activeOnly = url.searchParams.get("active_only") !== "false";

  const xoroResult = await fetchXoroAll({
    path,
    params: { per_page: "500" },
    maxPages: pageLimit,
    pageStart,
  });
  if (!xoroResult.ok) {
    return res.status(200).json({
      error: "Xoro fetch failed — check path and credentials",
      path,
      debug: xoroResult.body,
    });
  }
  const items = Array.isArray(xoroResult.body?.Data) ? xoroResult.body.Data : [];

  const result = {
    xoro_items_fetched: items.length,
    inserted: 0,
    skipped_no_sku: 0,
    skipped_inactive: 0,
    errors: [],
    path,
  };

  const rows = [];
  const seenSkus = new Set();
  for (const it of items) {
    const sku = canonSku(it.ItemNumber ?? it.Sku ?? it.ItemCode ?? it.Item ?? it.Product);
    if (!sku) { result.skipped_no_sku++; continue; }
    if (seenSkus.has(sku)) continue;
    seenSkus.add(sku);

    const isActive = it.Active !== false && it.IsActive !== false && it.DeleteFlag !== true;
    if (activeOnly && !isActive) { result.skipped_inactive++; continue; }

    rows.push({
      sku_code: sku,
      style_code: it.StyleNumber ?? it.StyleCode ?? null,
      description: it.Description ?? it.ItemDescription ?? it.Title ?? null,
      color: it.Color ?? null,
      size: it.Size ?? null,
      uom: (it.BaseUomCode ?? it.UomCode ?? "each").toLowerCase(),
      unit_cost: toNum(it.AvgCost ?? it.StandardCost ?? it.LastCost ?? it.PurchaseCost),
      unit_price: toNum(it.UnitPrice ?? it.SellPrice ?? it.RetailPrice),
      active: isActive,
      external_refs: { xoro_item_id: it.Id ?? it.ItemId ?? null },
    });
  }

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_item_master")
      .upsert(chunk, { onConflict: "sku_code", ignoreDuplicates: false });
    if (error) result.errors.push(error.message);
    else result.inserted += chunk.length;
  }

  if (rows.length === 0 && items.length > 0) {
    result.diagnostic = {
      hint: "No items mapped — check the SKU field on the first item.",
      first_item_field_names: Object.keys(items[0]).slice(0, 40),
      first_item_preview: items[0],
    };
  }

  return res.status(200).json(result);
}
