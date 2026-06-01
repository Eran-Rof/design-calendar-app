// api/b2b/orders/[id]  (GET /api/b2b/orders/:id)
//
// P18-D — B2B customer portal single-order detail (header + lines). Used by the
// portal Orders page to show a placed order and to power "Reorder" (load its
// lines back into the cart).
//
// SECURITY: resolveB2BSession → customer_id; the order is fetched with BOTH
// id = :id AND customer_id = session customer_id, so a buyer can never read
// another customer's order even with a guessed id. :id arrives via req.query.id
// (dispatcher merges path params into req.query).

import { createClient } from "@supabase/supabase-js";
import { resolveB2BSession } from "../../../_lib/b2b/session.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function adminClient() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

const HEADER_COLS =
  "id, so_number, status, origin, order_date, requested_ship_date, currency, " +
  "subtotal_cents, total_cents, notes, created_at, ship_to_location_id";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });

  const admin = adminClient();
  const sess = await resolveB2BSession(req, admin);
  if (!sess.ok) return res.status(sess.status).json({ error: sess.error });
  const { customer_id } = sess;

  // Scope by BOTH id AND the session customer_id — an order for another customer
  // simply returns 404, never its data.
  const { data: header, error: hErr } = await admin
    .from("sales_orders")
    .select(HEADER_COLS)
    .eq("id", id)
    .eq("customer_id", customer_id)
    .maybeSingle();
  if (hErr) return res.status(500).json({ error: hErr.message });
  if (!header) return res.status(404).json({ error: "Order not found" });

  const { data: lines, error: lErr } = await admin
    .from("sales_order_lines")
    .select("id, line_number, description, qty_ordered, unit_price_cents, line_total_cents, status")
    .eq("sales_order_id", id)
    .order("line_number", { ascending: true });
  if (lErr) return res.status(500).json({ error: lErr.message });

  // Portal-placed lines encode the source style_id as a leading "[sid:<uuid>] "
  // tag (see the create endpoint). Surface it as style_id + a clean description
  // so the portal can reorder a line straight back into the cart.
  const SID_RE = /^\[sid:([0-9a-f-]{36})\]\s*/i;
  const outLines = (lines || []).map((l) => {
    const desc = l.description || "";
    const m = SID_RE.exec(desc);
    return {
      ...l,
      style_id: m ? m[1] : null,
      description: m ? desc.slice(m[0].length) : desc,
    };
  });

  return res.status(200).json({ ...header, lines: outLines });
}
