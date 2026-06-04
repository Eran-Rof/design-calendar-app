// api/internal/tpl-shipments  (h618)
//
// P21 / M13 — 3PL shipment list + create.
//
//   GET  /api/internal/tpl-shipments                 → list (+ provider, lines)
//   POST /api/internal/tpl-shipments                 → create (status='draft')
//        body { tpl_provider_id, direction?, reference?, carrier?, tracking_number?,
//               ship_date?, expected_date?, sales_order_id?, purchase_order_id?,
//               notes?, lines: [ { inventory_item_id?|sku_code?, description?, qty } ] }

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
      .from("tpl_shipments")
      .select("*, tpl_providers(name, code), tpl_shipment_lines(*)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ shipments: data || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    if (!body.tpl_provider_id) return res.status(400).json({ error: "tpl_provider_id required" });
    const dir = ["inbound", "outbound", "return"].includes(body.direction) ? body.direction : "inbound";
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length === 0) return res.status(400).json({ error: "at least one line required" });
    for (const l of lines) if (!(Number(l.qty) > 0)) return res.status(400).json({ error: "every line needs qty > 0" });

    const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

    // Resolve sku_code -> ip_item_master.id where given.
    const skuCodes = [...new Set(lines.filter((l) => !l.inventory_item_id && l.sku_code).map((l) => String(l.sku_code).trim()))];
    const skuToId = new Map();
    if (skuCodes.length) {
      const { data: items } = await admin.from("ip_item_master").select("id, sku_code").in("sku_code", skuCodes);
      for (const it of items || []) skuToId.set(it.sku_code, it.id);
    }

    const { data: header, error: hErr } = await admin.from("tpl_shipments").insert({
      entity_id: entity.id, tpl_provider_id: body.tpl_provider_id, direction: dir, status: "draft",
      reference: body.reference || null, carrier: body.carrier || null, tracking_number: body.tracking_number || null,
      ship_date: body.ship_date || null, expected_date: body.expected_date || null,
      sales_order_id: body.sales_order_id || null, purchase_order_id: body.purchase_order_id || null,
      notes: body.notes || null, created_by_user_id: body.created_by_user_id || null,
    }).select("id").single();
    if (hErr) return res.status(500).json({ error: `Shipment insert failed: ${hErr.message}` });

    const lineRows = lines.map((l, i) => ({
      tpl_shipment_id: header.id, line_number: i + 1,
      inventory_item_id: l.inventory_item_id || (l.sku_code ? skuToId.get(String(l.sku_code).trim()) || null : null),
      description: l.description || null, qty: Number(l.qty),
    }));
    const { error: lErr } = await admin.from("tpl_shipment_lines").insert(lineRows);
    if (lErr) { await admin.from("tpl_shipments").delete().eq("id", header.id); return res.status(500).json({ error: `Shipment lines insert failed: ${lErr.message}` }); }

    return res.status(201).json({ id: header.id, message: "3PL shipment created (draft)." });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
