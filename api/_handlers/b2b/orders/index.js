// api/b2b/orders  (GET list + POST create — /api/b2b/orders)
//
// P18-D — the B2B customer portal order endpoint.
//
// GET  → THIS customer's sales orders (scoped by the verified session
//        customer_id), newest first, with status + totals.
// POST → place a new wholesale order. Lands as a DRAFT sales_orders row with
//        origin='b2b_portal' so it appears in the internal Sales Orders queue
//        for staff review. Body:
//          { lines: [{ style_id, qty }], ship_to_location_id?, notes? }
//
// SECURITY (every rule enforced server-side; never trust the client):
//   • resolveB2BSession → customer_id; reject 401 when not a valid buyer session.
//   • POST requires account.can_place_orders, else 403.
//   • Each line's unit price is RESOLVED from b2b_price_list for the session
//     customer — client-supplied prices are ignored entirely. A line with no
//     resolvable price is rejected (cannot order a "call for price" item).
//   • ship_to_location_id, if supplied, MUST belong to the session customer.
//   • customer_id on the SO is the session customer_id — never from the body.

import { createClient } from "@supabase/supabase-js";
import { resolveB2BSession } from "../../../_lib/b2b/session.js";
import { resolvePricesForCustomer } from "../../../_lib/b2b/pricing.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function adminClient() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

const LIST_COLS =
  "id, so_number, status, origin, order_date, requested_ship_date, currency, " +
  "subtotal_cents, total_cents, notes, created_at, ship_to_location_id";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = adminClient();
  const sess = await resolveB2BSession(req, admin);
  if (!sess.ok) return res.status(sess.status).json({ error: sess.error });
  const { account, customer_id } = sess;

  // ── GET: this customer's orders ──────────────────────────────────────────────
  if (req.method === "GET") {
    const { data, error } = await admin
      .from("sales_orders")
      .select(LIST_COLS)
      .eq("customer_id", customer_id)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  // ── POST: place an order ─────────────────────────────────────────────────────
  if (req.method === "POST") {
    if (account.can_place_orders !== true) {
      return res.status(403).json({ error: "Your account is not permitted to place orders. Contact your rep." });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    if (!body || typeof body !== "object") return res.status(400).json({ error: "Request body must be an object" });

    // Normalise + validate lines (style_id + positive qty). Collapse duplicate
    // style_ids by summing qty so a style appears once.
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    const qtyByStyle = new Map();
    for (const l of rawLines) {
      const sid = l && l.style_id != null ? String(l.style_id).trim() : "";
      if (!UUID_RE.test(sid)) return res.status(400).json({ error: "each line requires a valid style_id" });
      const qty = Number(l.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue; // skip zero/empty lines
      qtyByStyle.set(sid, (qtyByStyle.get(sid) || 0) + qty);
    }
    if (qtyByStyle.size === 0) return res.status(400).json({ error: "at least one line with qty > 0 is required" });

    const styleIds = [...qtyByStyle.keys()];

    // Confirm each style is an ACTIVE, orderable catalog style.
    const { data: styleRows, error: stErr } = await admin
      .from("style_master")
      .select("id, style_code, style_name, description")
      .in("id", styleIds)
      .is("deleted_at", null)
      .eq("lifecycle_status", "active");
    if (stErr) return res.status(500).json({ error: stErr.message });
    const styleById = new Map((styleRows || []).map((s) => [s.id, s]));
    for (const sid of styleIds) {
      if (!styleById.has(sid)) return res.status(400).json({ error: "one or more styles are not available to order" });
    }

    // Validate ship_to_location_id belongs to the SESSION customer.
    let shipTo = null;
    if (body.ship_to_location_id != null && String(body.ship_to_location_id).trim() !== "") {
      const loc = String(body.ship_to_location_id).trim();
      if (!UUID_RE.test(loc)) return res.status(400).json({ error: "invalid ship_to_location_id" });
      const { data: locRow, error: locErr } = await admin
        .from("customer_locations")
        .select("id")
        .eq("id", loc)
        .eq("customer_id", customer_id)
        .maybeSingle();
      if (locErr) return res.status(500).json({ error: locErr.message });
      if (!locRow) return res.status(400).json({ error: "ship_to_location_id does not belong to your account" });
      shipTo = loc;
    }

    // Resolve unit prices server-side. The customer's tier governs tier pricing.
    let tier = null;
    try {
      const { data: cust } = await admin.from("customers").select("customer_tier").eq("id", customer_id).maybeSingle();
      tier = cust?.customer_tier || null;
    } catch { /* non-fatal */ }

    let priceMap;
    try {
      priceMap = await resolvePricesForCustomer(admin, customer_id, styleIds, tier);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // Every ordered line MUST have a resolvable price.
    for (const sid of styleIds) {
      if (!priceMap.has(sid)) {
        const s = styleById.get(sid);
        return res.status(400).json({ error: `No price available for ${s?.style_code || "a selected style"}. Contact your rep.` });
      }
    }

    // Build lines. (style_id is recorded in the line description for staff; the
    // native SO line links to inventory items at fulfillment, not styles.)
    let lineNo = 1;
    let subtotal = 0;
    const lineRows = [];
    for (const sid of styleIds) {
      const qty = qtyByStyle.get(sid);
      const price = priceMap.get(sid);
      const s = styleById.get(sid);
      const lineTotal = Math.round(qty * price.price_cents);
      subtotal += lineTotal;
      // Encode the catalog style_id in a leading tag so the portal can map a
      // placed line back to a style for reorder (the native SO line has no
      // style FK — it links to inventory items at fulfillment). Staff see the
      // human label after the tag.
      const label = s.style_code + (s.style_name ? ` — ${s.style_name}` : (s.description ? ` — ${s.description}` : ""));
      lineRows.push({
        line_number: lineNo++,
        inventory_item_id: null,
        description: `[sid:${sid}] ${label}`,
        qty_ordered: qty,
        unit_price_cents: price.price_cents,
        line_total_cents: lineTotal,
      });
    }

    const notes = body.notes != null && String(body.notes).trim() !== ""
      ? `[B2B portal order] ${String(body.notes).trim()}`
      : "[B2B portal order]";

    // Insert the DRAFT header (entity/brand defaulted by DB). customer_id is the
    // SESSION customer — never the client's.
    const { data: header, error: hErr } = await admin
      .from("sales_orders")
      .insert({
        customer_id,
        ship_to_location_id: shipTo,
        status: "draft",
        origin: "b2b_portal",
        placed_by_b2b_account_id: account.id,
        notes,
        subtotal_cents: subtotal,
        total_cents: subtotal,
      })
      .select("id, so_number, status, total_cents, currency, created_at")
      .single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    const withSo = lineRows.map((l) => ({ ...l, sales_order_id: header.id }));
    const { error: lErr } = await admin.from("sales_order_lines").insert(withSo);
    if (lErr) {
      return res.status(500).json({ error: `Order header created (${header.id}) but lines failed: ${lErr.message}` });
    }

    return res.status(201).json({
      id: header.id,
      so_number: header.so_number || null,
      status: header.status,
      total_cents: header.total_cents,
      currency: header.currency,
      created_at: header.created_at,
    });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
