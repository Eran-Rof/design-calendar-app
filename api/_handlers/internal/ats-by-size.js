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
//               date): size-grain PO inbound expected to ARRIVE by that date,
//               from TWO sources, summed:
//                 (a) native purchase_order_lines (M11) — issued/in_transit POs,
//                     expected_date ≤ as_of_date, Σ(qty_ordered − qty_received).
//                 (b) Xoro-mirror tanda_pos / po_line_items — the real 233-PO
//                     book. po_line_items.item_number is the Xoro ItemNumber
//                     (STYLE-COLOR-SIZE = already size-grain); it maps to a size
//                     SKU by (style,color,size) tuple against ip_item_master's
//                     own style_code/color/size columns (NOT the sku_code string,
//                     which stores small sizes inconsistently). Same item_id the
//                     on-hand is keyed on, so the two reconcile.
//                     Counted when the parent PO status ∈ {Open, Released,
//                     Partially Received} (NOT Received/Closed — those carry
//                     stale qty_remaining), the line date_expected_delivery
//                     (MM/DD/YYYY) ≤ as_of_date, and qty_remaining > 0.
//               Native and tanda_pos are summed (native is empty today, so no
//               overlap; if native POs ever mirror the same physical POs, dedup
//               will be needed).
//
// Without as_of_date the result is the phase-1 snapshot (incoming = 0):
//   available = max(on_hand − allocated, 0).
//
// POST { item_ids: [uuid, …], as_of_date?: "YYYY-MM-DD" }
//   → { as_of, as_of_date, availability: {
//        <item_id>: { on_hand, allocated, incoming, available } } }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NATIVE_INBOUND_STATUSES = ["issued", "in_transit"];        // native purchase_orders
const TANDA_INBOUND_STATUSES = ["Open", "Released", "Partially Received"]; // Xoro tanda_pos
const CHUNK = 100;       // PostgREST .in() URL-length guard (see by-size cutover #763)
const STYLE_CHUNK = 50;  // styles per OR-ilike prefilter
const PAGE = 1000;       // PostgREST max rows per request
const MAX_PO_ROWS = 50000; // runaway guard for the open-line scan

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

// Normalize one identity token (style / color / size) to a match key: UPPER,
// every non-alphanumeric run → "-", trimmed. "Light Olive" → "LIGHT-OLIVE".
function skuSafe(s) {
  return String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// Match key from a (style, color, size) triple. We key on the MASTER's own
// color/size columns (not the concatenated sku_code) because small sizes are
// stored inconsistently in sku_code — some colors carry an explicit "-SML"
// suffix, others fold SML into the bare "{STYLE}-{COLOR}" row — which would
// undercount those sizes if matched by sku_code string.
function tupleKey(style, color, size) {
  return `${skuSafe(style)}|${skuSafe(color)}|${skuSafe(size)}`;
}
// Parse a Xoro ItemNumber "STYLE-COLOR-SIZE" (color may contain spaces, never
// dashes; "-" is only the field separator). Needs ≥3 parts to be size-grain;
// returns null for color-grain (sizeless) lines, which can't map to a size cell.
function parseItemNumber(itemNumber) {
  const parts = String(itemNumber ?? "").split("-");
  if (parts.length < 3) return null;
  return { style: parts[0], size: parts[parts.length - 1], color: parts.slice(1, -1).join("-") };
}
// "MM/DD/YYYY" (Xoro line ETA) → "YYYY-MM-DD"; null if unparseable.
function isoFromMDY(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

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

// Open Xoro-mirror PO lines for the given styles (coarse ILIKE-by-style
// prefilter; the authoritative match is skuSafe(item_number) in JS). Paginated.
async function fetchTandaOpenLines(admin, styleCodes) {
  const out = [];
  for (const styleSlice of chunks(styleCodes, STYLE_CHUNK)) {
    const orExpr = styleSlice
      .map((s) => String(s).replace(/[^A-Za-z0-9]/g, ""))
      .filter(Boolean)
      .map((s) => `item_number.ilike.${s}-*`)
      .join(",");
    if (!orExpr) continue;
    for (let from = 0; from <= MAX_PO_ROWS; from += PAGE) {
      const { data, error } = await admin
        .from("po_line_items")
        .select("item_number, qty_remaining, date_expected_delivery, tanda_pos!inner(status)")
        .gt("qty_remaining", 0)
        .or(orExpr)
        .in("tanda_pos.status", TANDA_INBOUND_STATUSES)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = data || [];
      out.push(...batch);
      if (batch.length < PAGE) break;
    }
  }
  return out;
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

    // Incoming PO supply expected to ARRIVE by the ship date (windowed). Only
    // when a ship date is supplied. Two size-grain sources, summed.
    const incoming = {};
    if (asOfDate) {
      // (a) native purchase_order_lines — direct item_id, header expected_date.
      const polRows = await fetchChunked(itemIds, (ids) =>
        admin.from("purchase_order_lines")
          .select("inventory_item_id, qty_ordered, qty_received, purchase_orders!inner(status, expected_date)")
          .in("inventory_item_id", ids)
          .in("purchase_orders.status", NATIVE_INBOUND_STATUSES));
      for (const r of polRows) {
        const eta = r.purchase_orders?.expected_date;
        if (!eta || String(eta) > asOfDate) continue;
        const open = Math.max((Number(r.qty_ordered) || 0) - (Number(r.qty_received) || 0), 0);
        if (open > 0) incoming[r.inventory_item_id] = (incoming[r.inventory_item_id] || 0) + open;
      }

      // (b) Xoro-mirror tanda_pos / po_line_items — map item_number → item_id by
      //     (style,color,size) tuple, line ETA windowed. Build the tuple→id map +
      //     style set from the REQUESTED items only, so only their inbound counts.
      const masters = await fetchChunked(itemIds, (ids) =>
        admin.from("ip_item_master").select("id, style_code, color, size").in("id", ids));
      const idByTuple = new Map();    // tupleKey(style,color,size) → item_id
      const styleSet = new Set();
      for (const m of masters) {
        if (m.style_code && m.color != null && m.size != null) idByTuple.set(tupleKey(m.style_code, m.color, m.size), m.id);
        if (m.style_code) styleSet.add(String(m.style_code));
      }
      if (idByTuple.size > 0 && styleSet.size > 0) {
        const tandaLines = await fetchTandaOpenLines(admin, [...styleSet]);
        for (const r of tandaLines) {
          const p = parseItemNumber(r.item_number);
          if (!p) continue;                                   // color-grain line, no size
          const itemId = idByTuple.get(tupleKey(p.style, p.color, p.size));
          if (!itemId) continue;                              // not one of the requested SKUs
          const eta = isoFromMDY(r.date_expected_delivery);
          if (!eta || eta > asOfDate) continue;               // no ETA, or arrives after the ship date
          const open = Math.max(Number(r.qty_remaining) || 0, 0);
          if (open > 0) incoming[itemId] = (incoming[itemId] || 0) + open;
        }
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
