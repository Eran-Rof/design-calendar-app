// api/internal/purchase-orders/:id/shipments            (GET list, POST create)
// api/internal/purchase-orders/:id/shipments/:sid        (PATCH, DELETE)
//
// The in-transit OVERLAY for a PO. 'in transit' is not an order-lifecycle
// status — it's a separate dimension (goods on the water/air). A PO carries
// zero-or-more shipment records; it reads as "in transit" while any is still
// status 'in_transit'. Buyer-entered here in Tangerine; a vendor ASN feed sets
// source='vendor_asn' in a later PR.
//
// POST/PATCH body: { ship_method?, carrier?, tracking_number?, asn_ref?,
//   shipped_date?, eta?, notes?, status?('in_transit'|'arrived'|'cancelled'),
//   lines?: [{ purchase_order_line_id, qty_in_transit }] }
// When `lines` is present on PATCH it REPLACES the shipment's line set.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHIP_METHODS = ["sea", "air", "ground"];
const SHIP_STATUSES = ["in_transit", "arrived", "cancelled"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Auth-User-Id");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

// Normalize the editable header fields off a body → column patch (well-formed
// values only; everything else omitted so PATCH leaves it untouched / POST
// nulls it).
function headerPatch(body, { forInsert } = {}) {
  const text = (k) => (body[k] != null && String(body[k]).trim() !== "" ? String(body[k]).trim() : (forInsert ? null : undefined));
  const date = (k) => (DATE_RE.test(body[k] || "") ? body[k] : (forInsert ? null : undefined));
  const patch = {
    ship_method: SHIP_METHODS.includes(body.ship_method) ? body.ship_method : (forInsert ? null : undefined),
    carrier: text("carrier"),
    tracking_number: text("tracking_number"),
    asn_ref: text("asn_ref"),
    shipped_date: date("shipped_date"),
    eta: date("eta"),
    notes: text("notes"),
  };
  if (SHIP_STATUSES.includes(body.status)) patch.status = body.status;
  // drop undefined keys (PATCH: only set provided fields)
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  return patch;
}

// Validate + build the shipment_lines rows for a shipment. Each line must point
// at a real PO line of THIS PO, qty_in_transit ≥ 0.
async function buildLines(admin, poId, shipmentId, rawLines) {
  if (!Array.isArray(rawLines)) return { rows: [] };
  const { data: poLines } = await admin
    .from("purchase_order_lines").select("id").eq("purchase_order_id", poId);
  const valid = new Set((poLines || []).map((l) => l.id));
  const rows = [];
  for (const l of rawLines) {
    const lid = l?.purchase_order_line_id;
    if (!lid || !UUID_RE.test(String(lid)) || !valid.has(lid)) continue;
    const qty = Number(l.qty_in_transit);
    if (!Number.isFinite(qty) || qty < 0) continue;
    if (qty === 0) continue; // a 0-qty line carries no shipment
    rows.push({ shipment_id: shipmentId, purchase_order_line_id: lid, qty_in_transit: qty });
  }
  return { rows };
}

async function loadShipments(admin, poId) {
  const { data: ships } = await admin
    .from("po_shipments").select("*").eq("purchase_order_id", poId).order("created_at", { ascending: false });
  const list = ships || [];
  if (!list.length) return [];
  const { data: lines } = await admin
    .from("po_shipment_lines").select("*").in("shipment_id", list.map((s) => s.id));
  const byShip = new Map();
  for (const l of lines || []) { const a = byShip.get(l.shipment_id) || []; a.push(l); byShip.set(l.shipment_id, a); }
  return list.map((s) => ({ ...s, lines: byShip.get(s.id) || [] }));
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const poId = params?.id || req.query?.id;
  const sid = params?.sid || req.query?.sid;
  if (!poId || !UUID_RE.test(String(poId))) return res.status(400).json({ error: "Invalid PO id" });

  // PO must exist (and give a clean 404).
  const { data: po } = await admin.from("purchase_orders").select("id").eq("id", poId).maybeSingle();
  if (!po) return res.status(404).json({ error: "Purchase order not found" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const userId = req.headers["x-auth-user-id"] && UUID_RE.test(String(req.headers["x-auth-user-id"])) ? req.headers["x-auth-user-id"] : null;

  try {
    if (req.method === "GET") {
      return res.status(200).json(await loadShipments(admin, poId));
    }

    if (req.method === "POST") {
      const patch = headerPatch(body, { forInsert: true });
      const { data: created, error } = await admin
        .from("po_shipments")
        .insert({ purchase_order_id: poId, source: "buyer", created_by_user_id: userId, ...patch })
        .select("id").single();
      if (error) return res.status(500).json({ error: error.message });
      const { rows } = await buildLines(admin, poId, created.id, body.lines);
      if (rows.length) { const { error: le } = await admin.from("po_shipment_lines").insert(rows); if (le) return res.status(500).json({ error: le.message }); }
      const [full] = await loadShipments(admin, poId).then((all) => all.filter((s) => s.id === created.id));
      return res.status(201).json(full || { id: created.id });
    }

    if (req.method === "PATCH") {
      if (!sid || !UUID_RE.test(String(sid))) return res.status(400).json({ error: "Invalid shipment id" });
      const patch = headerPatch(body, { forInsert: false });
      patch.updated_at = new Date().toISOString();
      const { error } = await admin.from("po_shipments").update(patch).eq("id", sid).eq("purchase_order_id", poId);
      if (error) return res.status(500).json({ error: error.message });
      if (Array.isArray(body.lines)) {
        await admin.from("po_shipment_lines").delete().eq("shipment_id", sid);
        const { rows } = await buildLines(admin, poId, sid, body.lines);
        if (rows.length) { const { error: le } = await admin.from("po_shipment_lines").insert(rows); if (le) return res.status(500).json({ error: le.message }); }
      }
      const [full] = await loadShipments(admin, poId).then((all) => all.filter((s) => s.id === sid));
      return res.status(200).json(full || { id: sid });
    }

    if (req.method === "DELETE") {
      if (!sid || !UUID_RE.test(String(sid))) return res.status(400).json({ error: "Invalid shipment id" });
      const { error } = await admin.from("po_shipments").delete().eq("id", sid).eq("purchase_order_id", poId);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
