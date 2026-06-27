// api/internal/purchase-orders/:id/split-by-lot
//
// Lot numbers — Scenario 4 (4.1 + 4.3 + 4.4). Split a ROF PO's lines across the
// customer POs it covers, stamping each split with that customer PO as its lot
// and dividing each line's quantity EVENLY on a full-carton basis.
//
// Body (one of):
//   { lots: ["PO-123","PO-124"] }            explicit customer PO numbers (lots)
//   { sales_order_ids: [uuid, ...] }         resolve each SO's customer_po as a lot
//   { carton_size?: number }                 units per carton (default 24)
//
// Replaces the PO's lines with the per-lot split set and recomputes the header
// totals. Pre-receiving only (draft / issued / in_transit). Received or
// cancelled POs are rejected — their stock is already lot-stamped on layers.

import { createClient } from "@supabase/supabase-js";
import { splitLinesByLot } from "../../../_lib/inventory/poLotSplit.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const cartonSize = Number(body.carton_size) > 0 ? Math.floor(body.carton_size) : 24;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: po, error: poErr } = await admin.from("purchase_orders").select("id, status").eq("id", id).maybeSingle();
  if (poErr) return res.status(500).json({ error: poErr.message });
  if (!po) return res.status(404).json({ error: "Purchase order not found" });
  if (["received", "cancelled"].includes(po.status)) {
    return res.status(409).json({ error: `Cannot split lines on a ${po.status} PO — splitting is a pre-receiving operation.` });
  }

  // Resolve the lots: explicit list, or the customer_po of each given SO (in
  // order, de-duped, blanks skipped).
  let lots = [];
  if (Array.isArray(body.sales_order_ids) && body.sales_order_ids.length) {
    const soIds = body.sales_order_ids.filter((s) => UUID_RE.test(String(s)));
    if (soIds.length) {
      const { data: sos } = await admin.from("sales_orders").select("id, customer_po").in("id", soIds);
      const byId = new Map((sos || []).map((s) => [s.id, (s.customer_po || "").trim()]));
      // Preserve the caller's order.
      lots = soIds.map((sid) => byId.get(sid)).filter(Boolean);
    }
  } else if (Array.isArray(body.lots)) {
    lots = body.lots.map((l) => String(l ?? "").trim()).filter(Boolean);
  }
  lots = [...new Set(lots)]; // de-dupe, keep first occurrence order
  if (lots.length === 0) return res.status(400).json({ error: "Provide lots[] (customer PO numbers) or sales_order_ids[] with a customer PO." });

  const { data: lines, error: lErr } = await admin.from("purchase_order_lines")
    .select("inventory_item_id, description, qty_ordered, unit_cost_cents, requested_ship_date, vendor_confirmed_ship_date")
    .eq("purchase_order_id", id).order("line_number", { ascending: true });
  if (lErr) return res.status(500).json({ error: lErr.message });
  if (!lines || lines.length === 0) return res.status(400).json({ error: "This PO has no lines to split." });

  const split = splitLinesByLot(lines, lots, cartonSize);
  if (split.length === 0) return res.status(400).json({ error: "Nothing to split (lines have no quantity)." });

  // Replace the PO's lines with the split set, then recompute header totals.
  await admin.from("purchase_order_lines").delete().eq("purchase_order_id", id);
  const rows = split.map((l) => ({ ...l, purchase_order_id: id }));
  const { error: insErr } = await admin.from("purchase_order_lines").insert(rows);
  if (insErr) return res.status(500).json({ error: `Split failed (lines not re-inserted): ${insErr.message}` });
  const subtotal = split.reduce((s, l) => s + (l.line_total_cents || 0), 0);
  await admin.from("purchase_orders").update({ subtotal_cents: subtotal, total_cents: subtotal }).eq("id", id);

  return res.status(200).json({
    lots,
    lines_before: lines.length,
    lines_after: split.length,
    carton_size: cartonSize,
    message: `Split ${lines.length} line(s) across ${lots.length} lot(s) → ${split.length} line(s).`,
  });
}
