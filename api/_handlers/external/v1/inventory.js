// GET /api/external/v1/inventory
//
// READ-ONLY on-hand inventory by SKU, scoped to the API key's entity. Reuses
// the existing tangerine_size_onhand snapshot table (per-size ip_item_master
// SKU). Returns the LATEST snapshot row per (sku, warehouse) with human labels
// (sku_code, style_code, color, size) — no raw uuids.
//
// Query: ?limit=&offset=&warehouse=

import { withApiKey, pageEnvelope } from "../../../_lib/external/handlerKit.js";

export const config = { maxDuration: 20 };

export default withApiKey(async ({ req, res, admin, auth, limit, offset }) => {
  const warehouse = typeof req.query?.warehouse === "string" ? req.query.warehouse.trim() : "";

  let q = admin
    .from("tangerine_size_onhand")
    .select("item_id, warehouse_code, snapshot_date, qty_on_hand, ip_item_master!inner(sku_code, style_code, color, size)")
    .eq("entity_id", auth.entity_id)
    .order("snapshot_date", { ascending: false })
    .range(offset, offset + limit - 1);
  if (warehouse) q = q.eq("warehouse_code", warehouse);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "query_failed", message: error.message });

  const rows = (data || []).map((r) => {
    const m = r.ip_item_master || {};
    return {
      sku_code: m.sku_code || null,
      style_code: m.style_code || null,
      color: m.color || null,
      size: m.size || null,
      warehouse: r.warehouse_code,
      qty_on_hand: Number(r.qty_on_hand) || 0,
      as_of: r.snapshot_date,
    };
  });
  return pageEnvelope(res, { data: rows, limit, offset });
});
