// api/internal/sales-returns  (h612)
//
// P19 / M23 — Customer Returns / RMA list + create.
//
//   GET  /api/internal/sales-returns                  → list RMAs (+ lines, customer)
//   POST /api/internal/sales-returns                  → create an RMA (status='requested')
//        body { customer_id, original_sales_order_id?, original_ar_invoice_id?,
//               reason?, restocking_fee_cents?, notes?, lines: [
//                 { inventory_item_id?, sales_order_line_id?, description?,
//                   qty_returned, unit_price_cents?, reason? } ] }

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
    const { data: returns, error } = await admin
      .from("sales_returns")
      .select("*, customers(name, customer_code), sales_return_lines(*)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ returns: returns || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    if (!body.customer_id) return res.status(400).json({ error: "customer_id required" });
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length === 0) return res.status(400).json({ error: "at least one line required" });
    for (const l of lines) {
      if (!(Number(l.qty_returned) > 0)) return res.status(400).json({ error: "every line needs qty_returned > 0" });
    }

    const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

    // Resolve any line given as sku_code (no inventory_item_id) → ip_item_master.id.
    const skuCodes = [...new Set(lines.filter((l) => !l.inventory_item_id && l.sku_code).map((l) => String(l.sku_code).trim()))];
    const skuToId = new Map();
    if (skuCodes.length) {
      const { data: items } = await admin.from("ip_item_master").select("id, sku_code").in("sku_code", skuCodes);
      for (const it of items || []) skuToId.set(it.sku_code, it.id);
    }

    const { data: header, error: hErr } = await admin.from("sales_returns").insert({
      entity_id: entity.id,
      customer_id: body.customer_id,
      original_sales_order_id: body.original_sales_order_id || null,
      original_ar_invoice_id: body.original_ar_invoice_id || null,
      status: "requested",
      reason: body.reason || null,
      restocking_fee_cents: Math.max(0, Math.round(Number(body.restocking_fee_cents) || 0)),
      notes: body.notes || null,
      created_by_user_id: body.created_by_user_id || null,
    }).select("id").single();
    if (hErr) return res.status(500).json({ error: `RMA insert failed: ${hErr.message}` });

    const lineRows = lines.map((l, i) => ({
      sales_return_id: header.id,
      line_number: i + 1,
      inventory_item_id: l.inventory_item_id || (l.sku_code ? skuToId.get(String(l.sku_code).trim()) || null : null),
      sales_order_line_id: l.sales_order_line_id || null,
      description: l.description || null,
      qty_returned: Number(l.qty_returned),
      unit_price_cents: Math.round(Number(l.unit_price_cents) || 0),
      disposition: l.disposition && ["restock", "scrap"].includes(l.disposition) ? l.disposition : "pending",
      restock_location_id: l.restock_location_id || null,
      reason: l.reason || null,
    }));
    const { error: lErr } = await admin.from("sales_return_lines").insert(lineRows);
    if (lErr) { await admin.from("sales_returns").delete().eq("id", header.id); return res.status(500).json({ error: `RMA lines insert failed: ${lErr.message}` }); }

    return res.status(201).json({ id: header.id, message: "RMA created (requested)." });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
