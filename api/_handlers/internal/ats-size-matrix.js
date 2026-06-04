// api/internal/ats-size-matrix  (h611)
//
// By-size ATS-available matrix for a set of STYLES — the data behind the ATS
// Excel "By Size Matrix" export option. The ATS app grid is color-grain; this
// returns the size-grain breakdown per style for the export to render as a
// color × size matrix + a separate PPK pack column.
//
// For each requested style_code:
//   - size columns  = the style's size_scale (ordered); falls back to the
//                     distinct sizes present on its loose SKUs.
//   - loose (each-grain) SKUs → per (color,size) ATS-available eaches.
//   - PPK sibling style ("{style}PPK" / "{style}-PPK") → per-color PACK count,
//     kept SEPARATE (NOT exploded into the size cells, by operator's layout).
//
// ATS-available per SKU = max(on_hand − reservations + incoming, 0):
//   on_hand     — tangerine_size_onhand, summed across warehouses at the SKU's
//                 LATEST snapshot_date (same rule as h603 ats-by-size).
//   reservations— open Tangerine claims Σ(qty_allocated − qty_shipped) from
//                 sales_order_lines (hard, not date-windowed).
//   incoming    — 0 for the snapshot; when as_of_date is supplied (a report
//                 period's end date), adds size-grain PO inbound expected to
//                 ARRIVE by that date — native purchase_order_lines +
//                 Xoro-mirror tanda_pos/po_line_items mapped by
//                 (style,color,size) tuple — exactly as h603 ats-by-size. This
//                 is what makes the export's per-period tabs differ.
//
// POST { style_codes: [string], as_of_date?: "YYYY-MM-DD" }
//   → { as_of, as_of_date, styles: [...] }
//
// POST { style_codes: [string, …], as_of_date?: "YYYY-MM-DD" }
//   → { as_of, styles: [{
//        style_code, style_name, sizes: [string], pack_size,
//        colors: [{ color, by_size: { <size>: qty }, total_eachs, ppk_packs }],
//     }] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const CHUNK = 100;     // PostgREST .in() URL-length guard (#763)
const STYLE_CHUNK = 80;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NATIVE_INBOUND_STATUSES = ["issued", "in_transit"];               // native purchase_orders
const TANDA_INBOUND_STATUSES = ["Open", "Released", "Partially Received"]; // Xoro tanda_pos
const PAGE = 1000;        // PostgREST max rows per request
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

// PPK gate — canonical: style_code contains "PPK" (see ppk-grain-rule). The
// loose/pack split keys off this, NOT pack_size or size.
const isPpkStyle = (s) => /PPK/i.test(String(s ?? ""));
// Bare stem of a style_code with any trailing PPK token stripped:
// "RYB0412PPK" / "RYB0412-PPK" → "RYB0412". Used to pair a pack style to its
// loose base.
const ppkStem = (s) => String(s ?? "").trim().replace(/-?PPK\d*$/i, "").toUpperCase();
const norm = (s) => String(s ?? "").trim().toUpperCase();

async function fetchChunked(ids, chunkFn) {
  const rows = [];
  for (const slice of chunks(ids, CHUNK)) {
    const { data, error } = await chunkFn(slice);
    if (error) throw new Error(error.message);
    if (data) rows.push(...data);
  }
  return rows;
}

// ── Ship-window inbound helpers (mirror h603 ats-by-size) ──────────────────
// Normalize one identity token to a match key: UPPER, non-alphanumeric runs → "-".
const skuSafe = (s) => String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const tupleKey = (style, color, size) => `${skuSafe(style)}|${skuSafe(color)}|${skuSafe(size)}`;
// Parse a Xoro ItemNumber "STYLE-COLOR-SIZE" (color may contain spaces, never
// dashes). Needs ≥3 parts to be size-grain; null for color-grain lines.
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
// Open Xoro-mirror PO lines for the given styles (coarse ILIKE-by-style
// prefilter; authoritative match is skuSafe(item_number) in JS). Paginated.
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
  const styleCodes = Array.isArray(body?.style_codes)
    ? [...new Set(body.style_codes.map((s) => String(s ?? "").trim()).filter(Boolean))]
    : [];
  // Optional ship-window date: when supplied, available adds size-grain PO
  // inbound expected to ARRIVE by that date (per-period projection). Without
  // it the result is the current snapshot (incoming = 0).
  const asOfDate = DATE_RE.test(String(body?.as_of_date || "")) ? String(body.as_of_date) : null;
  if (styleCodes.length === 0) return res.status(200).json({ as_of: null, as_of_date: asOfDate, styles: [] });

  try {
    // Base (loose) styles requested + their PPK siblings — pull both in one
    // master scan so pack columns resolve even if the caller only named the
    // loose style. Key everything by the bare stem so loose↔pack pair up.
    const stems = [...new Set(styleCodes.map(ppkStem))];

    // 1. Size scales for the loose styles (ordered size columns).
    const styleRows = await fetchChunked(stems, (slice) =>
      admin.from("style_master").select("id, style_code, style_name, size_scale_id").in("style_code", slice));
    const scaleIds = [...new Set(styleRows.map((s) => s.size_scale_id).filter(Boolean))];
    const scaleById = new Map();
    if (scaleIds.length) {
      const scales = await fetchChunked(scaleIds, (slice) =>
        admin.from("size_scales").select("id, sizes").in("id", slice));
      for (const sc of scales) scaleById.set(sc.id, Array.isArray(sc.sizes) ? sc.sizes.filter(Boolean).map(String) : []);
    }
    const styleMetaByStem = new Map(); // stem → { style_name, sizes[] }
    for (const s of styleRows) {
      const stem = norm(s.style_code);
      if (!styleMetaByStem.has(stem)) {
        styleMetaByStem.set(stem, {
          style_name: s.style_name || s.style_code,
          sizes: s.size_scale_id ? (scaleById.get(s.size_scale_id) || []) : [],
        });
      }
    }

    // 2. All SKUs (loose + PPK) under each requested stem. Match on the
    // style_code's stem so "RYB0412" pulls RYB0412 (loose) AND RYB0412PPK.
    // ILIKE prefix per stem, then filter by exact stem in JS.
    const stemSet = new Set(stems.map(norm));
    const skuRows = [];
    for (const slice of chunks(stems, STYLE_CHUNK)) {
      const orExpr = slice
        .map((s) => String(s).replace(/[^A-Za-z0-9]/g, ""))
        .filter(Boolean)
        .map((s) => `style_code.ilike.${s}*`)
        .join(",");
      if (!orExpr) continue;
      const { data, error } = await admin
        .from("ip_item_master")
        .select("id, style_code, color, size, pack_size")
        .or(orExpr);
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        if (stemSet.has(ppkStem(r.style_code))) skuRows.push(r);
      }
    }
    if (skuRows.length === 0) return res.status(200).json({ as_of: null, styles: [] });

    const allItemIds = [...new Set(skuRows.map((r) => r.id))];

    // 3. On-hand by size — latest snapshot per item, summed across warehouses.
    const ohRows = await fetchChunked(allItemIds, (ids) =>
      admin.from("tangerine_size_onhand").select("item_id, snapshot_date, qty_on_hand").in("item_id", ids));
    const latestByItem = new Map();
    for (const r of ohRows) {
      const cur = latestByItem.get(r.item_id);
      if (!cur || String(r.snapshot_date) > cur) latestByItem.set(r.item_id, String(r.snapshot_date));
    }
    const onHand = {};
    let asOf = null;
    for (const r of ohRows) {
      if (String(r.snapshot_date) !== latestByItem.get(r.item_id)) continue;
      onHand[r.item_id] = (onHand[r.item_id] || 0) + (Number(r.qty_on_hand) || 0);
      if (!asOf || String(r.snapshot_date) > asOf) asOf = String(r.snapshot_date);
    }

    // 4. Open reservations by size (hard claims).
    const solRows = await fetchChunked(allItemIds, (ids) =>
      admin.from("sales_order_lines").select("inventory_item_id, qty_allocated, qty_shipped").in("inventory_item_id", ids));
    const allocated = {};
    for (const r of solRows) {
      const open = Math.max((Number(r.qty_allocated) || 0) - (Number(r.qty_shipped) || 0), 0);
      if (open > 0) allocated[r.inventory_item_id] = (allocated[r.inventory_item_id] || 0) + open;
    }

    // Incoming PO supply expected to ARRIVE by the ship date (windowed). Only
    // when a ship date is supplied. Two size-grain sources, summed (mirror h603).
    const incoming = {};
    if (asOfDate) {
      // (a) native purchase_order_lines — direct item_id, header expected_date.
      const polRows = await fetchChunked(allItemIds, (ids) =>
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
      //     (style,color,size) tuple, line ETA windowed.
      const masters = await fetchChunked(allItemIds, (ids) =>
        admin.from("ip_item_master").select("id, style_code, color, size").in("id", ids));
      const idByTuple = new Map();
      const styleSet = new Set();
      for (const m of masters) {
        if (m.style_code && m.color != null && m.size != null) idByTuple.set(tupleKey(m.style_code, m.color, m.size), m.id);
        if (m.style_code) styleSet.add(String(m.style_code));
      }
      if (idByTuple.size > 0 && styleSet.size > 0) {
        const tandaLines = await fetchTandaOpenLines(admin, [...styleSet]);
        for (const r of tandaLines) {
          const p = parseItemNumber(r.item_number);
          if (!p) continue;
          const itemId = idByTuple.get(tupleKey(p.style, p.color, p.size));
          if (!itemId) continue;
          const eta = isoFromMDY(r.date_expected_delivery);
          if (!eta || eta > asOfDate) continue;
          const open = Math.max(Number(r.qty_remaining) || 0, 0);
          if (open > 0) incoming[itemId] = (incoming[itemId] || 0) + open;
        }
      }
    }

    const avail = (id) => Math.max((onHand[id] || 0) + (incoming[id] || 0) - (allocated[id] || 0), 0);

    // 5. Assemble per stem: loose cells (color×size) + PPK pack count per color.
    //    Group sku rows by stem, split loose vs pack.
    const byStem = new Map(); // stem → { loose: rows[], pack: rows[] }
    for (const r of skuRows) {
      const stem = ppkStem(r.style_code);
      if (!byStem.has(stem)) byStem.set(stem, { loose: [], pack: [] });
      (isPpkStyle(r.style_code) ? byStem.get(stem).pack : byStem.get(stem).loose).push(r);
    }

    const styles = [];
    for (const stem of stems) {
      const key = norm(stem);
      const meta = styleMetaByStem.get(key) || { style_name: stem, sizes: [] };
      const group = byStem.get(stem) || byStem.get(key) || { loose: [], pack: [] };

      // Size columns: scale first; fall back to distinct loose sizes (ordered
      // by first appearance) when the style has no scale.
      let sizes = meta.sizes.slice();
      if (sizes.length === 0) {
        const seen = new Set();
        for (const r of group.loose) { const sz = String(r.size ?? "").trim(); if (sz && !seen.has(sz)) { seen.add(sz); sizes.push(sz); } }
      }
      const sizeSet = new Set(sizes.map(norm));

      // PPK pack size (for the "Total PPK<n>" header) — the dominant pack_size
      // across this stem's pack SKUs.
      let packSize = 0;
      const packCount = {};
      for (const r of group.pack) {
        const ps = Number(r.pack_size) || 0;
        if (ps > 1) packCount[ps] = (packCount[ps] || 0) + 1;
      }
      packSize = Object.entries(packCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
      packSize = Number(packSize) || 0;

      // Loose cells per color.
      const colorMap = new Map(); // color → { by_size:{}, total_eachs, ppk_packs }
      const ensure = (color) => {
        const c = String(color ?? "").trim();
        if (!colorMap.has(c)) colorMap.set(c, { color: c, by_size: {}, total_eachs: 0, ppk_packs: 0 });
        return colorMap.get(c);
      };
      for (const r of group.loose) {
        const sz = String(r.size ?? "").trim();
        if (!sz || !sizeSet.has(norm(sz))) continue; // off-scale size → skip cell (still counts? keep strict to scale)
        const q = avail(r.id);
        if (q === 0) continue;
        const c = ensure(r.color);
        c.by_size[sz] = (c.by_size[sz] || 0) + q;
        c.total_eachs += q;
      }
      // PPK pack counts per color (separate column).
      for (const r of group.pack) {
        const q = avail(r.id);
        if (q === 0) continue;
        ensure(r.color).ppk_packs += q;
      }

      const colors = [...colorMap.values()]
        .filter((c) => c.total_eachs > 0 || c.ppk_packs > 0)
        .sort((a, b) => a.color.localeCompare(b.color));

      styles.push({
        style_code: stem,
        style_name: meta.style_name,
        sizes,
        pack_size: packSize,
        colors,
      });
    }

    return res.status(200).json({ as_of: asOf, as_of_date: asOfDate, styles });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
