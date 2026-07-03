// api/internal/sales-orders/placeholder-po
//
// Lot numbers — Scenario 2. Mint a unique placeholder customer PO for an SO
// opened from a buy sheet before the real customer PO exists. Format:
// "PH-YYYY-NNNNN" (per entity, per year). The operator sees it, it rides onto
// the SO (customer_po + customer_po_is_placeholder=true), and a PO created from
// the SO inherits it as the lot (Scenario 3). It's replaced — and the lot
// propagated — when the real customer PO arrives (SO PATCH).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntity(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const year = new Date().toISOString().slice(0, 4);
  const prefix = `PH-${year}-`;
  // Count existing placeholder customer_pos this year to get the next sequence.
  // The flag-or-prefix combo keeps this independent of real buyer PO numbers.
  const { count } = await admin.from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entity.id)
    .ilike("customer_po", `${prefix}%`);
  const customer_po = `${prefix}${String((count || 0) + 1).padStart(5, "0")}`;
  return res.status(200).json({ customer_po });
}
