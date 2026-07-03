// api/internal/sales-orders/:id/ship
//
// P16 / M44 — ship an allocated sales order: record a carrier shipment +
// tracking, bump each line's qty_shipped, and advance line/header status
// (line → 'shipped' when fully shipped; header → 'shipped' when all lines
// shipped, else 'fulfilling'). Physical/logistics only — COGS/FIFO consumption
// happens later at AR-invoice post.
//
// Enforces the factored-customer ship-gate (Chunk K / item 17): a factored
// customer's SO cannot ship until factor_approval_status = 'approved'.
//
// Body: { carrier?, service_level?, tracking_number?, ship_date?,
//         lines?: [{ sales_order_line_id, qty }] }  // default = remaining allocated per line

import { createClient } from "@supabase/supabase-js";
import { evaluateSoCreditGate } from "../../../_lib/customers/soShipGate.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const actor = (body?.created_by_user_id && UUID_RE.test(String(body.created_by_user_id))) ? String(body.created_by_user_id) : null;
  const shipDate = (typeof body?.ship_date === "string" && ISO_DATE_RE.test(body.ship_date)) ? body.ship_date : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Load SO.
  const { data: so, error: soErr } = await admin
    .from("sales_orders").select("id, status, entity_id, customer_id, factor_approval_status, credit_approval_status, payment_terms_id, total_cents, amount_paid_cents").eq("id", id).maybeSingle();
  if (soErr) return res.status(500).json({ error: soErr.message });
  if (!so) return res.status(404).json({ error: "Sales order not found" });
  if (!["allocated", "fulfilling", "confirmed"].includes(so.status)) {
    return res.status(409).json({ error: `Cannot ship a ${so.status} sales order (allocate/confirm it first).` });
  }

  // 2. Ship-gates. Factored customers are gated by factor approval (Chunk K /
  //    item 17). NON-factored customers are gated by the credit gate
  //    (house-account overdue AR / credit-card paid-in-full). An operator
  //    override (credit_approval_status='approved') always releases the credit
  //    gate. Mirrors the 409-block in sales-orders/[id].js.
  if (so.customer_id) {
    const { data: cust } = await admin.from("customers").select("is_factored").eq("id", so.customer_id).maybeSingle();
    if (cust?.is_factored === true) {
      if (so.factor_approval_status !== "approved") {
        return res.status(409).json({ error: "Factored customer — factor approval required before shipping. Set Factor/Ins Approval = approved on the sales order first." });
      }
    } else if (so.credit_approval_status !== "approved") {
      try {
        const decision = await evaluateSoCreditGate(admin, {
          customer_id: so.customer_id, entity_id: so.entity_id,
          payment_terms_id: so.payment_terms_id, total_cents: so.total_cents,
          amount_paid_cents: so.amount_paid_cents,
        });
        if (decision.blocked) {
          // Persist the latest hold reason so the UI badge stays accurate.
          await admin.from("sales_orders").update({
            credit_approval_status: decision.target_status,
            credit_hold_reason: decision.reason,
            credit_checked_at: new Date().toISOString(),
          }).eq("id", so.id);
          return res.status(409).json({ error: decision.reason, credit_gate: decision.gate });
        }
      } catch (e) {
        // High-stakes: a failed overdue-AR lookup must not silently allow a ship.
        return res.status(500).json({ error: `Credit gate check failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  // 3. Lines: default = remaining allocated (qty_allocated − qty_shipped) per line.
  const { data: lines, error: lErr } = await admin
    .from("sales_order_lines").select("*").eq("sales_order_id", id).order("line_number", { ascending: true });
  if (lErr) return res.status(500).json({ error: lErr.message });

  const reqByLine = new Map();
  if (Array.isArray(body?.lines)) {
    for (const l of body.lines) {
      if (l && UUID_RE.test(String(l.sales_order_line_id)) && Number(l.qty) > 0) reqByLine.set(String(l.sales_order_line_id), Number(l.qty));
    }
  }

  const toShip = [];
  for (const ln of lines || []) {
    if (ln.status === "cancelled") continue;
    const remaining = Number(ln.qty_allocated) - Number(ln.qty_shipped);
    const want = reqByLine.has(ln.id) ? reqByLine.get(ln.id) : remaining;
    const qty = Math.min(want, remaining);
    if (qty > 0) toShip.push({ line: ln, qty });
  }
  if (toShip.length === 0) {
    return res.status(400).json({ error: "Nothing to ship — allocate stock first (or all allocated qty already shipped)." });
  }

  // 4. Create the shipment header + lines.
  const { data: shipment, error: shErr } = await admin
    .from("sales_order_shipments")
    .insert({
      entity_id: so.entity_id,
      sales_order_id: so.id,
      carrier: body?.carrier ? String(body.carrier).trim() || null : null,
      service_level: body?.service_level ? String(body.service_level).trim() || null : null,
      tracking_number: body?.tracking_number ? String(body.tracking_number).trim() || null : null,
      ship_date: shipDate || new Date().toISOString().slice(0, 10),
      status: "shipped",
      notes: body?.notes ? String(body.notes).trim() || null : null,
      created_by_user_id: actor,
    })
    .select("id, ship_date, tracking_number")
    .single();
  if (shErr) return res.status(500).json({ error: shErr.message });

  const shipLineRows = toShip.map((t) => ({ shipment_id: shipment.id, sales_order_line_id: t.line.id, qty: t.qty }));
  const { error: slErr } = await admin.from("sales_order_shipment_lines").insert(shipLineRows);
  if (slErr) {
    await admin.from("sales_order_shipments").delete().eq("id", shipment.id);
    return res.status(500).json({ error: `Shipment created but lines failed: ${slErr.message}` });
  }

  // 5. Bump qty_shipped + line status.
  for (const t of toShip) {
    const newShipped = Number(t.line.qty_shipped) + t.qty;
    await admin.from("sales_order_lines")
      .update({ qty_shipped: newShipped, status: newShipped >= Number(t.line.qty_ordered) ? "shipped" : t.line.status, updated_at: new Date().toISOString() })
      .eq("id", t.line.id);
  }

  // 6. Header status: 'shipped' when every non-cancelled line is fully shipped, else 'fulfilling'.
  const shippedById = new Map(toShip.map((t) => [t.line.id, Number(t.line.qty_shipped) + t.qty]));
  const allShipped = (lines || [])
    .filter((ln) => ln.status !== "cancelled")
    .every((ln) => (shippedById.get(ln.id) ?? Number(ln.qty_shipped)) >= Number(ln.qty_ordered));
  await admin.from("sales_orders")
    .update({ status: allShipped ? "shipped" : "fulfilling", updated_at: new Date().toISOString() })
    .eq("id", so.id);

  return res.status(201).json({
    shipment_id: shipment.id,
    tracking_number: shipment.tracking_number,
    ship_date: shipment.ship_date,
    lines_shipped: toShip.length,
    sales_order_status: allShipped ? "shipped" : "fulfilling",
    message: allShipped
      ? "Shipped in full — sales order moved to shipped. Invoice it from the SO."
      : "Partial shipment recorded — sales order is fulfilling.",
  });
}
