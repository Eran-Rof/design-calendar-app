// api/tanda-pos-sync.js — Vercel Node.js Serverless Function
//
// Pulls open POs from the PO WIP (TandA) app's persisted Xoro data
// and upserts each line item into ip_open_purchase_orders so the
// planning grid can see "On PO" qty per SKU.
//
// Source: tanda_pos table in Supabase (rows = full Xoro PO payloads
// keyed by po_number). Each PO has a line array (PoLineArr or Items).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 300 };

function canonSku(s) {
  return (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, "");
}
function toNum(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}
function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

  // 1. Pull all PO rows from the TandA store. Page through to avoid the
  //    PostgREST default cap.
  const allPos = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from("tanda_pos")
      .select("po_number, data")
      .order("po_number", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return res.status(500).json({ error: "tanda_pos fetch failed", details: error.message });
    if (!data || data.length === 0) break;
    allPos.push(...data);
    if (data.length < PAGE) break;
  }

  // 2. Load item master so we can resolve sku_code → sku_id.
  const itemMap = new Map();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin
      .from("ip_item_master")
      .select("id, sku_code")
      .order("sku_code", { ascending: true })
      .range(offset, offset + 999);
    if (error) return res.status(500).json({ error: "item_master fetch failed", details: error.message });
    if (!data || data.length === 0) break;
    for (const r of data) itemMap.set(canonSku(r.sku_code), r.id);
    if (data.length < 1000) break;
  }

  const result = {
    pos_scanned: allPos.length,
    inserted: 0,
    auto_created_skus: 0,
    skipped_archived: 0,
    skipped_no_lines: 0,
    skipped_no_sku: 0,
    skipped_zero_open: 0,
    errors: [],
  };

  // 3. First pass: flatten PO → candidates and collect all unique
  //    SKUs that need to be auto-created. Bulk create in step 4 so we
  //    don't time out on per-SKU sequential upserts.
  const candidates = [];
  const missingSkus = new Map(); // canon sku → sample line for description
  for (const r of allPos) {
    const po = r.data;
    if (!po) { result.skipped_no_lines++; continue; }
    if (po._archived === true) { result.skipped_archived++; continue; }

    const poNumber = String(po.PoNumber ?? r.po_number ?? "").trim();
    if (!poNumber) { result.skipped_no_lines++; continue; }

    const lines = Array.isArray(po.PoLineArr) ? po.PoLineArr
                : Array.isArray(po.Items)     ? po.Items
                : Array.isArray(po.invoiceItemLineArr) ? po.invoiceItemLineArr
                : [];
    if (lines.length === 0) { result.skipped_no_lines++; continue; }

    const orderDate = toIsoDate(po.DateOrder);
    const expectedDate = toIsoDate(po.DateExpectedDelivery ?? po.VendorReqDate);
    const currency = po.CurrencyCode ?? null;
    const status = po.StatusName ?? null;

    for (const ln of lines) {
      const sku = canonSku(ln.ItemNumber ?? ln.Sku ?? ln.ItemCode);
      if (!sku) { result.skipped_no_sku++; continue; }

      const qtyOrdered = toNum(ln.QtyOrder ?? ln.QtyOrdered ?? ln.Qty);
      const qtyReceived = toNum(ln.QtyReceived);
      const qtyOpen = toNum(ln.QtyRemaining ?? (qtyOrdered - qtyReceived));
      if (qtyOpen <= 0) { result.skipped_zero_open++; continue; }

      if (!itemMap.has(sku) && !missingSkus.has(sku)) missingSkus.set(sku, ln);

      const lineNum = String(ln.LineNumber ?? ln.Id ?? "").trim() || sku;
      candidates.push({
        sku, poNumber, lineNum,
        order_date: orderDate, expected_date: expectedDate,
        qtyOrdered, qtyReceived, qtyOpen,
        unit_cost: toNum(ln.UnitPrice) || null,
        currency, status,
      });
    }
  }

  // 4. Bulk create missing items in 500-row chunks.
  if (missingSkus.size > 0) {
    const newItems = Array.from(missingSkus.entries()).map(([sku, ln]) => ({
      sku_code: sku,
      description: ln.Description ?? null,
      uom: "each",
      active: true,
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

  // 5. Build final upsert rows now that every candidate has a sku_id.
  const rows = [];
  for (const c of candidates) {
    const skuId = itemMap.get(c.sku);
    if (!skuId) { result.errors.push(`no id for ${c.sku} after bulk create`); continue; }
    rows.push({
      sku_id: skuId,
      po_number: c.poNumber,
      po_line_number: c.lineNum,
      order_date: c.order_date,
      expected_date: c.expected_date,
      qty_ordered: c.qtyOrdered,
      qty_received: c.qtyReceived,
      qty_open: c.qtyOpen,
      unit_cost: c.unit_cost,
      currency: c.currency,
      status: c.status,
      source: "xoro",
      source_line_key: `tanda:${c.poNumber}:${c.lineNum}`,
    });
  }

  // 4. Upsert new rows first, then trim stale ones. Doing it in this order
  //    avoids a window where the planning grid would see an empty PO table
  //    (delete-then-insert had that gap, and a mid-sync failure would have
  //    wiped the source-of-truth open-PO data).
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin
      .from("ip_open_purchase_orders")
      .upsert(chunk, { onConflict: "source,source_line_key", ignoreDuplicates: false });
    if (error) result.errors.push(error.message);
    else result.inserted += chunk.length;
  }

  // Delete rows whose source_line_key isn't in the freshly-synced set —
  // these are POs that closed since the last sync.
  const newKeys = new Set(rows.map((r) => r.source_line_key));
  result.cleaned = 0;
  let staleOffset = 0;
  while (true) {
    const { data: existing, error: fetchErr } = await admin
      .from("ip_open_purchase_orders")
      .select("source_line_key")
      .eq("source", "xoro")
      .range(staleOffset, staleOffset + 999);
    if (fetchErr) { result.errors.push(`stale lookup: ${fetchErr.message}`); break; }
    if (!existing || existing.length === 0) break;

    const staleKeys = existing
      .map((r) => r.source_line_key)
      .filter((k) => k && !newKeys.has(k));

    for (let i = 0; i < staleKeys.length; i += 100) {
      const chunk = staleKeys.slice(i, i + 100);
      const { error } = await admin
        .from("ip_open_purchase_orders")
        .delete()
        .eq("source", "xoro")
        .in("source_line_key", chunk);
      if (error) result.errors.push(`stale cleanup: ${error.message}`);
      else result.cleaned += chunk.length;
    }

    if (existing.length < 1000) break;
    staleOffset += 1000;
  }

  return res.status(200).json(result);
}
