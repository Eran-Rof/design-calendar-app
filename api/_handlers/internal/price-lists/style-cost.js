// api/internal/price-lists/style-cost?style_id=<uuid>
//
// Cost-aware helper for the add-a-style flow. For one style returns:
//   cost_cents       — on-hand weighted-avg unit cost (sum(cost*remaining)/sum(remaining)
//                       over the style's inventory_layers with remaining_qty>0 &
//                       unit_cost_cents>0); ELSE open-PO weighted-avg unit cost from
//                       unreceived purchase_order_lines; ELSE null.
//   cost_source      — 'onhand' | 'open_po' | null
//   suggested_cents  — formula price: ceil((cost/0.77)/5)*5  (23% margin, round up 5c); null if no cost
//   brand            — { id, name, code } | null  (style_master.brand_id)
//   brand_default    — { list_id, price_cents } | null — this style's price in the
//                       matching brand DEFAULT list (for "Copy from Default").
//
// Pricing formula kept in sync with the seed + UI: price = ceil((cost/0.77)/5)*5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

// price = ceil((cost/0.77)/5)*5  (23% margin on sell, round UP to nearest 5 cents)
export function suggestPrice(costCents) {
  if (!Number.isFinite(costCents) || costCents <= 0) return null;
  return Math.ceil((costCents / 0.77) / 5) * 5;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const styleId = req.query?.style_id;
  if (!styleId || !UUID_RE.test(String(styleId))) return res.status(400).json({ error: "style_id (uuid) required" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // style + brand
  const { data: style } = await admin.from("style_master")
    .select("id, brand_id, brand:brand_master!style_master_brand_id_fkey(id, name, code)")
    .eq("id", styleId).maybeSingle();
  const brand = style?.brand || null;

  // items (sku ids) for this style
  const { data: items } = await admin.from("ip_item_master").select("id").eq("style_id", styleId);
  const itemIds = (items || []).map((i) => i.id);

  let costCents = null;
  let costSource = null;

  if (itemIds.length) {
    // (1) on-hand weighted average
    const { data: layers } = await admin.from("inventory_layers")
      .select("unit_cost_cents, remaining_qty").in("item_id", itemIds).gt("remaining_qty", 0).gt("unit_cost_cents", 0);
    let num = 0, den = 0;
    for (const l of layers || []) { const q = Number(l.remaining_qty), c = Number(l.unit_cost_cents); num += c * q; den += q; }
    if (den > 0 && num > 0) { costCents = Math.round(num / den); costSource = "onhand"; }

    // (2) ELSE open-PO weighted average (unreceived lines)
    if (costCents == null) {
      const { data: pol } = await admin.from("purchase_order_lines")
        .select("unit_cost_cents, qty_ordered, qty_received").in("inventory_item_id", itemIds).gt("unit_cost_cents", 0);
      let pn = 0, pd = 0;
      for (const l of pol || []) {
        const open = Number(l.qty_ordered) - Number(l.qty_received || 0);
        if (open > 0) { pn += Number(l.unit_cost_cents) * open; pd += open; }
      }
      if (pd > 0 && pn > 0) { costCents = Math.round(pn / pd); costSource = "open_po"; }
    }
  }

  // matching brand DEFAULT list price for this style (Copy from Default)
  let brandDefault = null;
  if (brand?.id) {
    const { data: bl } = await admin.from("price_lists")
      .select("id").eq("brand_id", brand.id).eq("is_default", false).eq("is_active", true).order("created_at").limit(1);
    const listId = bl?.[0]?.id || null;
    if (listId) {
      const { data: pli } = await admin.from("price_list_items")
        .select("price_cents").eq("price_list_id", listId).eq("style_id", styleId).eq("min_qty", 0).eq("is_active", true).limit(1);
      if (pli?.[0]) brandDefault = { list_id: listId, price_cents: Number(pli[0].price_cents) };
    }
  }

  return res.status(200).json({
    style_id: styleId,
    brand,
    cost_cents: costCents,
    cost_source: costSource,
    suggested_cents: suggestPrice(costCents),
    brand_default: brandDefault,
  });
}
