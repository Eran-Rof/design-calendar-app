// api/internal/ats-by-size  (h603)
//
// Available-to-ship BY SIZE for a set of size-level SKUs (ip_item_master.id).
// The ATS app itself is color-grain; this is the Tangerine-side size-grain
// source. Consumed by the SO entry's ATS fulfillment mode to show real per-size
// availability above each cell.
//
// available = on_hand + incoming − allocated  (clamped ≥ 0)
//   on_hand   — tangerine_size_onhand (Xoro REST nightly), summed across
//               warehouses at each SKU's LATEST snapshot.
//   allocated — open Tangerine reservations: Σ(qty_allocated − qty_shipped)
//               from sales_order_lines (hard claims, NOT date-windowed).
//   incoming  — ONLY when `as_of_date` is supplied (the SO's requested ship
//               date): size-grain native PO inbound expected to ARRIVE by that
//               date — Σ(qty_ordered − qty_received) from purchase_order_lines
//               whose parent PO is issued/in_transit and expected_date ≤
//               as_of_date. Native purchase_orders only (size-grain). The
//               Xoro-mirror tanda_pos book is deliberately EXCLUDED — it is
//               color-grain and would contaminate the by-size number.
//
// Without as_of_date the result is the phase-1 snapshot (incoming = 0):
//   available = max(on_hand − allocated, 0).
//
// POST { item_ids: [uuid, …], as_of_date?: "YYYY-MM-DD" }
//   → { as_of, as_of_date, availability: {
//        <item_id>: { on_hand, allocated, incoming, available } } }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INBOUND_STATUSES = ["issued", "in_transit"]; // committed supply (not draft/received/cancelled)
const CHUNK = 100; // PostgREST .in() URL-length guard (see by-size cutover #763)

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function chunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// Run a builder once per id-chunk and concat the rows (chunkFn gets each slice).
async function fetchChunked(itemIds, chunkFn) {
  const rows = [];
  for (const slice of chunks(itemIds, CHUNK)) {
    const { data, error } = await chunkFn(slice);
    if (error) throw new Error(error.message);
    if (data) rows.push(...data);
  }
  return rows;
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
  const asOfDate = DATE_RE.test(String(body?.as_of_date || "")) ? String(body.as_of_date) : null;
  if (itemIds.length === 0) return res.status(200).json({ as_of: null, as_of_date: asOfDate, availability: {} });

  try {
    // On-hand by size — sum across warehouses at each SKU's LATEST snapshot_date.
    const ohRows = await fetchChunked(itemIds, (ids) =>
      admin.from("tangerine_size_onhand").select("item_id, warehouse_code, snapshot_date, qty_on_hand").in("item_id", ids));
    const latestByItem = new Map(); // item_id → latest snapshot_date string
    for (const r of ohRows) {
      const cur = latestByItem.get(r.item_id);
      if (!cur || String(r.snapshot_date) > cur) latestByItem.set(r.item_id, String(r.snapshot_date));
    }
    const onHand = {};
    let asOf = null;
    for (const r of ohRows) {
      if (String(r.snapshot_date) !== latestByItem.get(r.item_id)) continue; // only the SKU's latest snapshot
      onHand[r.item_id] = (onHand[r.item_id] || 0) + (Number(r.qty_on_hand) || 0);
      if (!asOf || String(r.snapshot_date) > asOf) asOf = String(r.snapshot_date);
    }

    // Open reservations by size — qty_allocated − qty_shipped (not yet out).
    const solRows = await fetchChunked(itemIds, (ids) =>
      admin.from("sales_order_lines").select("inventory_item_id, qty_allocated, qty_shipped").in("inventory_item_id", ids));
    const allocated = {};
    for (const r of solRows) {
      const open = Math.max((Number(r.qty_allocated) || 0) - (Number(r.qty_shipped) || 0), 0);
      if (open > 0) allocated[r.inventory_item_id] = (allocated[r.inventory_item_id] || 0) + open;
    }

    // Incoming native PO supply expected to ARRIVE by the ship date (windowed).
    // Only computed when a ship date is supplied; Xoro-mirror tanda_pos excluded.
    const incoming = {};
    if (asOfDate) {
      const polRows = await fetchChunked(itemIds, (ids) =>
        admin.from("purchase_order_lines")
          .select("inventory_item_id, qty_ordered, qty_received, purchase_orders!inner(status, expected_date)")
          .in("inventory_item_id", ids)
          .in("purchase_orders.status", INBOUND_STATUSES));
      for (const r of polRows) {
        const eta = r.purchase_orders?.expected_date;
        if (!eta || String(eta) > asOfDate) continue; // no ETA, or arrives after the ship date
        const open = Math.max((Number(r.qty_ordered) || 0) - (Number(r.qty_received) || 0), 0);
        if (open > 0) incoming[r.inventory_item_id] = (incoming[r.inventory_item_id] || 0) + open;
      }
    }

    const availability = {};
    for (const id of itemIds) {
      const oh = onHand[id] || 0, al = allocated[id] || 0, inc = incoming[id] || 0;
      availability[id] = { on_hand: oh, allocated: al, incoming: inc, available: Math.max(oh + inc - al, 0) };
    }
    return res.status(200).json({ as_of: asOf, as_of_date: asOfDate, availability });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
