// api/internal/drop-ship  (h615)
//
// P20 / M49 — Drop-ship order list + create. A drop-ship order is shipped by
// the vendor directly to the customer (no warehouse, no inventory movement).
//
//   GET  /api/internal/drop-ship                → list (+ lines, customer, vendor)
//   POST /api/internal/drop-ship                → create (status='requested')
//        body { customer_id, vendor_id, sales_order_id?, ship_to?, notes?,
//               lines: [ { inventory_item_id?|sku_code?, description?, qty,
//                          customer_unit_price_cents?, vendor_unit_cost_cents? } ] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("drop_ship_orders")
      .select("*, customers(name, customer_code), vendors(name, code), drop_ship_lines(*)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ orders: data || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    if (!body.customer_id) return res.status(400).json({ error: "customer_id required" });
    if (!body.vendor_id) return res.status(400).json({ error: "vendor_id required" });
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length === 0) return res.status(400).json({ error: "at least one line required" });
    for (const l of lines) if (!(Number(l.qty) > 0)) return res.status(400).json({ error: "every line needs qty > 0" });

    const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

    // Ship-to: explicit, else snapshot the customer's shipping address.
    let shipTo = body.ship_to;
    if (!shipTo || typeof shipTo !== "object") {
      const { data: cust } = await admin.from("customers").select("shipping_address").eq("id", body.customer_id).maybeSingle();
      shipTo = (cust && cust.shipping_address) || {};
    }

    // Resolve any sku_code → ip_item_master.id.
    const skuCodes = [...new Set(lines.filter((l) => !l.inventory_item_id && l.sku_code).map((l) => String(l.sku_code).trim()))];
    const skuToId = new Map();
    if (skuCodes.length) {
      const { data: items } = await admin.from("ip_item_master").select("id, sku_code").in("sku_code", skuCodes);
      for (const it of items || []) skuToId.set(it.sku_code, it.id);
    }

    const { data: header, error: hErr } = await admin.from("drop_ship_orders").insert({
      entity_id: entity.id, customer_id: body.customer_id, vendor_id: body.vendor_id,
      sales_order_id: body.sales_order_id || null, status: "requested",
      ship_to: shipTo, notes: body.notes || null,
      expected_ship_date: body.expected_ship_date || null,
      created_by_user_id: body.created_by_user_id || null,
    }).select("id").single();
    if (hErr) return res.status(500).json({ error: `Drop-ship insert failed: ${hErr.message}` });

    const lineRows = lines.map((l, i) => ({
      drop_ship_order_id: header.id, line_number: i + 1,
      inventory_item_id: l.inventory_item_id || (l.sku_code ? skuToId.get(String(l.sku_code).trim()) || null : null),
      sales_order_line_id: l.sales_order_line_id || null,
      description: l.description || null,
      qty: Number(l.qty),
      customer_unit_price_cents: Math.round(Number(l.customer_unit_price_cents) || 0),
      vendor_unit_cost_cents: Math.round(Number(l.vendor_unit_cost_cents) || 0),
    }));
    const { error: lErr } = await admin.from("drop_ship_lines").insert(lineRows);
    if (lErr) { await admin.from("drop_ship_orders").delete().eq("id", header.id); return res.status(500).json({ error: `Drop-ship lines insert failed: ${lErr.message}` }); }

    return res.status(201).json({ id: header.id, message: "Drop-ship order created (requested)." });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
