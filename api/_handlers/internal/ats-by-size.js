// api/internal/ats-by-size  (h603)
//
// Available-to-ship BY SIZE for a set of size-level SKUs (ip_item_master.id).
// The ATS app itself is color-grain; this is the Tangerine-side size-grain
// source: on-hand-by-size (tangerine_size_onhand, Xoro REST nightly, summed
// across warehouses at each SKU's latest snapshot) MINUS open Tangerine
// reservations (sales_order_lines qty_allocated − qty_shipped). Consumed by the
// SO entry's ATS fulfillment mode to show real per-size availability.
//
// POST { item_ids: [uuid, …] }
//   → { as_of, availability: { <item_id>: { on_hand, allocated, available } } }

import { createClient } from "@supabase/supabase-js";

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
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const itemIds = Array.isArray(body?.item_ids) ? [...new Set(body.item_ids.filter((x) => UUID_RE.test(String(x))))] : [];
  if (itemIds.length === 0) return res.status(200).json({ as_of: null, availability: {} });

  // On-hand by size — sum across warehouses at each SKU's LATEST snapshot_date.
  const { data: ohRows, error: ohErr } = await admin
    .from("tangerine_size_onhand")
    .select("item_id, warehouse_code, snapshot_date, qty_on_hand")
    .in("item_id", itemIds);
  if (ohErr) return res.status(500).json({ error: ohErr.message });

  const latestByItem = new Map(); // item_id → latest snapshot_date string
  for (const r of ohRows || []) {
    const cur = latestByItem.get(r.item_id);
    if (!cur || String(r.snapshot_date) > cur) latestByItem.set(r.item_id, String(r.snapshot_date));
  }
  const onHand = {};
  let asOf = null;
  for (const r of ohRows || []) {
    if (String(r.snapshot_date) !== latestByItem.get(r.item_id)) continue; // only the SKU's latest snapshot
    onHand[r.item_id] = (onHand[r.item_id] || 0) + (Number(r.qty_on_hand) || 0);
    if (!asOf || String(r.snapshot_date) > asOf) asOf = String(r.snapshot_date);
  }

  // Open reservations by size — qty_allocated − qty_shipped (not yet out).
  const { data: solRows, error: solErr } = await admin
    .from("sales_order_lines")
    .select("inventory_item_id, qty_allocated, qty_shipped")
    .in("inventory_item_id", itemIds);
  if (solErr) return res.status(500).json({ error: solErr.message });
  const allocated = {};
  for (const r of solRows || []) {
    const open = Math.max((Number(r.qty_allocated) || 0) - (Number(r.qty_shipped) || 0), 0);
    if (open > 0) allocated[r.inventory_item_id] = (allocated[r.inventory_item_id] || 0) + open;
  }

  const availability = {};
  for (const id of itemIds) {
    const oh = onHand[id] || 0;
    const al = allocated[id] || 0;
    availability[id] = { on_hand: oh, allocated: al, available: Math.max(oh - al, 0) };
  }
  return res.status(200).json({ as_of: asOf, availability });
}
