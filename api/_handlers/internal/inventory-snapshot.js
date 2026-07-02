// api/internal/inventory-snapshot
//
// Aggregate "Inventory Snapshot" rows for the Inventory Matrix's default view.
// One row per (style, color) for the given style_ids (a page of styles), with
// the lifecycle quantities the snapshot table shows. Computed with SEPARATE
// set-based queries merged in JS (a single multi-join would fan out and
// double-count) — the same pattern as styleMatrix.js / ats-by-size.js.
//
// POST { style_ids: [uuid, …] }
//   → { rows: [{
//        style_id, style_code, description, color, category,
//        on_hand,            // Σ inventory_layers.remaining_qty  (matches the matrix)
//        allocated,          // Σ(qty_allocated − qty_shipped) on SO lines
//        on_so,              // Σ(qty_ordered − qty_shipped) on OPEN sales orders
//        on_po,              // Σ open inbound (native + Xoro mirror), not date-windowed
//        in_transit,         // subset of on_po flagged in-transit
//        ats,                // max(on_hand_ats − allocated, 0)   (ATS-app on-hand source)
//        ats_incl_po,        // max(on_hand_ats − allocated + on_po, 0)
//        sold,               // lifetime Σ wholesale qty + ecom net_qty
//        purchased,          // lifetime Σ receipts qty
//        avg_cost_cents,     // representative avg cost for the colour
//        sale_price_cents,   // qty-weighted avg SO sale price for the colour
//      }] }
//
// Entity scoped (ROF default). Read-only. No migration — reuses existing tables.

import { createClient } from "@supabase/supabase-js";
import { isPpkStyle, ppkUnitsPerPackByStyle, lotKeyOf, NO_LOT } from "../../_lib/styleMatrix.js";

export const config = { maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_SO_STATUSES = ["draft", "confirmed", "allocated", "fulfilling"];   // outstanding demand
const NATIVE_INBOUND_STATUSES = ["issued", "in_transit"];                     // native purchase_orders
const NATIVE_TRANSIT_STATUSES = ["in_transit"];                              // native, "in transit"
const TANDA_INBOUND_STATUSES = ["Open", "Released", "Partially Received"];    // Xoro tanda_pos
const TANDA_TRANSIT_STATUSES = ["Partially Received"];                       // Xoro, treated as in transit
const CHUNK = 100;       // PostgREST .in() URL-length guard
const STYLE_CHUNK = 50;
const PAGE = 1000;
const MAX_PO_ROWS = 50000;

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
function skuSafe(s) { return String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function looseKey(s) { return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function tupleKey(style, color, size) { return `${skuSafe(style)}|${skuSafe(color)}|${skuSafe(size)}`; }
function colorKey(styleId, color) { return `${styleId}|${color ?? ""}`; }
function parseItemNumber(itemNumber) {
  const parts = String(itemNumber ?? "").split("-");
  if (parts.length < 3) return null;
  return { style: parts[0], size: parts[parts.length - 1], color: parts.slice(1, -1).join("-") };
}
async function entityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}
async function fetchChunked(ids, chunkFn) {
  // Chunks are independent → fetch them in parallel (was sequential).
  const results = await Promise.all(chunks(ids, CHUNK).map((slice) => chunkFn(slice)));
  const rows = [];
  for (const { data, error } of results) {
    if (error) throw new Error(error.message);
    if (data) rows.push(...data);
  }
  return rows;
}
// Open Xoro-mirror PO lines for the given styles (coarse ILIKE prefilter; the
// authoritative match is the (style,color,size) tuple in JS). Returns lines with
// their parent status so we can split inbound vs in-transit.
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
        .select("item_number, qty_remaining, tanda_pos!inner(status, po_number)")
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
  const styleIds = Array.isArray(body?.style_ids) ? [...new Set(body.style_ids.filter((x) => UUID_RE.test(String(x))))] : [];
  if (styleIds.length === 0) return res.status(200).json({ rows: [] });
  // Optional date range for the historical Sold / Purchased columns (the header
  // date picker). Point-in-time columns (on-hand / allocated / ATS / SO / PO)
  // ignore it. Empty = lifetime.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const from = DATE_RE.test(String(body?.from || "")) ? String(body.from) : null;
  const to = DATE_RE.test(String(body?.to || "")) ? String(body.to) : null;
  // Explode PPK: when on, PPK styles' PACK quantities are converted to EACHES by
  // multiplying every lifecycle column by the style's units-per-pack (from the
  // Prepack Matrix master). The snapshot has no size axis, so this is the
  // size-less equivalent of the matrix's per-size explosion. PPK styles with no
  // active matrix are left un-exploded (pack counts shown as-is).
  const explodePpk = body?.explode_ppk === true || String(body?.explode_ppk || "") === "true";
  // Optional Warehouse filter (on-hand LOCATION, per the house "Warehouse vs
  // Store" rule). When set, the point-in-time on-hand columns (On Hand + the ATS
  // on-hand source, and therefore ATS / ATS-incl-PO) are narrowed to that single
  // warehouse; the other lifecycle columns (allocated / SO / PO / sold /
  // purchased) are not warehouse-grained so they're unaffected. Empty = sum all
  // warehouses (the prior behaviour). Match is case-insensitive on the name.
  const warehouse = String(body?.warehouse || "").trim() || null;
  const whKey = warehouse ? warehouse.toLowerCase() : null;
  // Optional Lot filter. When a non-empty list is supplied, the On Hand column is
  // summed only from inventory layers whose lot_number (or NO_LOT bucket) is in
  // the set — the same lot grain as the single-style matrix. The response's
  // `lots` list is ALWAYS the full set of lots present on these styles' on-hand
  // (filter-independent) so the UI dropdown stays populated. Only On Hand is
  // lot-scoped: allocated / SO / PO / ATS / sold / purchased are not lot-tracked
  // and remain whole-style. Empty = all lots (prior behaviour).
  const lotFilter = Array.isArray(body?.lots) && body.lots.length
    ? new Set(body.lots.map((s) => lotKeyOf(s)))
    : null;
  const lotsSeen = new Set();

  try {
    const eid = await entityId(admin);

    // ── Styles (header fields) + SKUs — fetched in parallel. ──────────────────
    const [styleRows, itemRows] = await Promise.all([
      fetchChunked(styleIds, (ids) =>
        admin.from("style_master").select("id, style_code, description, style_name, category_name, group_name").in("id", ids)),
      fetchChunked(styleIds, (ids) =>
        admin.from("ip_item_master").select("id, style_id, style_code, color, size, sku_code").in("style_id", ids)),
    ]);
    const styleById = new Map(styleRows.map((s) => [s.id, s]));
    const itemById = new Map(itemRows.map((r) => [r.id, r]));
    const itemIds = itemRows.map((r) => r.id);

    // Explode-PPK multiplier per item: PPK SKUs get their units-per-pack ratio
    // (so pack quantities read as eaches across every column); everything else
    // is ×1. Off → all ×1 (no-op). PPK styles with no matrix stay ×1.
    let packMult = null; // Map<item_id, ratio> | null when explode off
    if (explodePpk) {
      packMult = new Map();
      // Units-per-pack per PPK style. PRIMARY signal = the SKU size token
      // ("PPK24" → 24), which is reliable: the prepack_matrices master keys on
      // inseam-specific codes (e.g. RYB059430PPK) that do NOT match the
      // style-grain ip_item_master code (RYB0594PPK), and some PPK styles have
      // no matrix row at all (RYB0412PPK). Matrix master is only a fallback.
      const unitsByStyle = new Map(); // lower(style_code) → units
      for (const it of itemRows) {
        if (!it.style_code || !isPpkStyle(it.style_code)) continue;
        const key = String(it.style_code).toLowerCase();
        if (unitsByStyle.has(key)) continue;
        const m = /PPK\s*(\d+)/i.exec(String(it.size || "")) || /PPK\s*(\d+)/i.exec(String(it.sku_code || ""));
        const n = m ? parseInt(m[1], 10) : 0;
        if (n > 0) unitsByStyle.set(key, n);
      }
      const missing = [...new Set(itemRows
        .filter((it) => it.style_code && isPpkStyle(it.style_code) && !unitsByStyle.has(String(it.style_code).toLowerCase()))
        .map((it) => it.style_code))];
      if (missing.length) {
        const fromMatrix = await ppkUnitsPerPackByStyle(admin, eid, missing);
        for (const [k, u] of fromMatrix) if (!unitsByStyle.has(k)) unitsByStyle.set(k, u);
      }
      for (const it of itemRows) {
        const key = String(it.style_code || "").toLowerCase();
        if (it.style_code && isPpkStyle(it.style_code) && unitsByStyle.has(key)) packMult.set(it.id, unitsByStyle.get(key));
      }
    }
    const mult = (itemId) => (packMult ? (packMult.get(itemId) || 1) : 1);
    // Seed a row bucket for every (style, color) that has at least one SKU.
    const buckets = new Map(); // colorKey → aggregate row
    const bucketFor = (styleId, color) => {
      const k = colorKey(styleId, color);
      let b = buckets.get(k);
      if (!b) {
        const st = styleById.get(styleId);
        b = {
          style_id: styleId,
          style_code: st?.style_code || "",
          description: st?.description || st?.style_name || "",
          color: color ?? null,
          category: st?.category_name || st?.group_name || null,
          on_hand: 0, on_hand_ats: 0, allocated: 0, on_so: 0, on_po: 0, in_transit: 0,
          sold: 0, purchased: 0, _costCents: [], _salePx: [],
          // P27/#1541 per-column transaction pricing (all per-EACH, cents):
          //   open-SO value → On SO column price; sold value (sales history) →
          //   Sold column price; most-recent SO line → "current" price for the
          //   inventory/PO columns (On Hand/Allocated/ATS/On PO/Purchased/In Transit).
          _openSoValC: 0, _openSoEa: 0, _soldValC: 0, _soldEa: 0, _curDate: null, _curCents: null,
        };
        buckets.set(k, b);
      }
      return b;
    };
    for (const it of itemRows) bucketFor(it.style_id, it.color);
    const bucketOfItem = (itemId) => { const it = itemById.get(itemId); return it ? bucketFor(it.style_id, it.color) : null; };

    if (itemIds.length === 0) return res.status(200).json({ rows: [...buckets.values()].map(finalizeRow), lots: [] });

    // ── Tuple index (built up-front; needed to merge the Xoro PO lines). ──────
    const idByTuple = new Map();   // tupleKey → item_id
    const styleSet = new Set();
    for (const m of itemRows) {
      if (m.style_code && m.color != null && m.size != null) idByTuple.set(tupleKey(m.style_code, m.color, m.size), m.id);
      if (m.style_code) styleSet.add(String(m.style_code));
    }

    // ── Fetch EVERY aggregate IN PARALLEL — they're all independent once the
    //    SKU set is known. (Previously these ran sequentially → ~10+ serial
    //    round-trips → 8-10s load. Parallel ≈ the slowest single query.) ───────
    const fetchBills = async () => {
      const billLines = await fetchChunked(itemIds, (ids) =>
        admin.from("invoice_line_items").select("inventory_item_id, quantity, invoice_id").in("inventory_item_id", ids));
      const billInvIds = [...new Set(billLines.map((l) => l.invoice_id).filter(Boolean))];
      const billDateOk = new Map(); // invoice_id → included?
      if (billInvIds.length) {
        const invs = await fetchChunked(billInvIds, (ids) => {
          let q = admin.from("invoices").select("id").in("id", ids).in("invoice_kind", ["vendor_bill", "vendor_credit_memo"]);
          if (from) q = q.gte("invoice_date", from);
          if (to) q = q.lte("invoice_date", to);
          return q;
        });
        for (const v of invs) billDateOk.set(v.id, true);
      }
      return { billLines, billDateOk };
    };
    const fetchAvg = async () => {
      const stems = [...new Set(itemRows.map((r) => String(r.sku_code ?? "").split("-")[0].trim()).filter(Boolean))];
      const costBySku = new Map(), costByLoose = new Map();
      const results = await Promise.all([...chunks(stems, STYLE_CHUNK)].map((stemSlice) => {
        const orFilter = stemSlice.map((s) => `sku_code.like.${s}-%`).join(",");
        if (!orFilter) return Promise.resolve({ data: [] });
        return admin.from("ip_item_avg_cost").select("sku_code, avg_cost").or(orFilter);
      }));
      for (const { data: avgRows } of results) {
        for (const r of avgRows || []) {
          if (r.avg_cost == null) continue;
          const cents = Math.round(Number(r.avg_cost) * 100);
          costBySku.set(r.sku_code, cents);
          const lk = looseKey(r.sku_code); if (!costByLoose.has(lk)) costByLoose.set(lk, cents);
        }
      }
      return { costBySku, costByLoose };
    };

    // location_id → warehouse name (for the optional Warehouse filter). Layers
    // carry the authoritative location_id since the multi-warehouse cutover; we
    // fall back to the legacy `wh=<name>` notes tag when a layer has none.
    const locNameById = new Map();
    // Sales history has no warehouse column — but its CHANNEL corresponds to the
    // Xoro store = a Tangerine warehouse (operator-confirmed): ROF→Main Warehouse,
    // ROF ECOM→ROF Ecom, PT→Psycho Tuna, PT ECOM→Psycho Tuna Ecom. Map channel_id
    // → canonical warehouse (lowercased) so the Sold column filters by warehouse.
    const CHANNEL_TO_WH = { "rof": "main warehouse", "rof ecom": "rof ecom", "pt": "psycho tuna", "pt ecom": "psycho tuna ecom" };
    const channelIdToWh = new Map();
    if (whKey) {
      const { data: locRows } = await admin.from("inventory_locations").select("id, name").eq("entity_id", eid);
      for (const lr of locRows || []) locNameById.set(lr.id, lr.name);
      const { data: chRows } = await admin.from("ip_channel_master").select("id, channel_code");
      for (const cr of chRows || []) {
        const wh = CHANNEL_TO_WH[String(cr.channel_code || "").toLowerCase().trim()];
        if (wh) channelIdToWh.set(cr.id, wh);
      }
    }

    const [layerRows, ohRows, solRows, polRows, tandaLines, whRows, ecRows, rcRows, billBundle, avgBundle] = await Promise.all([
      fetchChunked(itemIds, (ids) => admin.from("inventory_layers").select("item_id, remaining_qty, location_id, notes, lot_number").in("item_id", ids)),
      fetchChunked(itemIds, (ids) => admin.from("tangerine_size_onhand").select("item_id, snapshot_date, qty_on_hand, warehouse_code").in("item_id", ids)),
      fetchChunked(itemIds, (ids) => admin.from("sales_order_lines").select("inventory_item_id, qty_ordered, qty_allocated, qty_shipped, unit_price_cents, sales_orders!inner(status, order_date)").in("inventory_item_id", ids)),
      fetchChunked(itemIds, (ids) => admin.from("purchase_order_lines").select("inventory_item_id, qty_ordered, qty_received, purchase_orders!inner(status, po_number)").in("inventory_item_id", ids).in("purchase_orders.status", NATIVE_INBOUND_STATUSES)),
      styleSet.size > 0 ? fetchTandaOpenLines(admin, [...styleSet]) : Promise.resolve([]),
      fetchChunked(itemIds, (ids) => { let q = admin.from("ip_sales_history_wholesale").select("sku_id, qty, net_amount, channel_id").in("sku_id", ids); if (from) q = q.gte("txn_date", from); if (to) q = q.lte("txn_date", to); return q; }),
      fetchChunked(itemIds, (ids) => { let q = admin.from("ip_sales_history_ecom").select("sku_id, net_qty, net_amount, channel_id").in("sku_id", ids); if (from) q = q.gte("order_date", from); if (to) q = q.lte("order_date", to); return q; }),
      fetchChunked(itemIds, (ids) => { let q = admin.from("ip_receipts_history").select("sku_id, qty").in("sku_id", ids); if (from) q = q.gte("received_date", from); if (to) q = q.lte("received_date", to); return q; }),
      fetchBills(),
      fetchAvg(),
    ]);

    // ── Merge (in-memory; order doesn't matter). ──────────────────────────────
    // On hand (inventory_layers — matches the matrix). When a Warehouse filter is
    // active, only layers in that warehouse contribute (location name, or the
    // legacy `wh=` notes tag as a fallback).
    const layerWh = (l) => {
      const name = l.location_id ? locNameById.get(l.location_id) : null;
      if (name) return name;
      const m = (l.notes || "").match(/wh=(.+)$/);
      return m ? m[1].trim() : null;
    };
    for (const r of layerRows) {
      const rawQ = Number(r.remaining_qty) || 0;
      const lot = lotKeyOf(r.lot_number);
      if (rawQ > 0) lotsSeen.add(lot);                          // full lot list (filter-independent)
      if (whKey && String(layerWh(r) || "").toLowerCase() !== whKey) continue;
      if (lotFilter && !lotFilter.has(lot)) continue;           // scope On Hand to the picked lots
      const q = rawQ * mult(r.item_id);
      if (q > 0) { const b = bucketOfItem(r.item_id); if (b) b.on_hand += q; }
    }
    // On hand (ATS source — latest snapshot per item). The ATS source carries a
    // warehouse_code that still uses the LEGACY Xoro names ("ROF Main", "ROF -
    // ECOM"), while the Warehouse filter comes from the canonical Warehouses
    // master ("Main Warehouse", "ROF Ecom"). Normalize the legacy code to its
    // canonical name (same mapping as mig 20260925) before comparing — otherwise
    // this column stayed 0 for every warehouse. Case-insensitive.
    const WH_ALIAS = { "rof main": "main warehouse", "rof - ecom": "rof ecom", "prebook - psycho tuna": "psycho tuna" };
    const canonWh = (name) => { const l = String(name || "").toLowerCase().trim(); return WH_ALIAS[l] || l; };
    const atsRows = whKey ? ohRows.filter((r) => canonWh(r.warehouse_code) === whKey) : ohRows;
    const latestByItem = new Map();
    for (const r of atsRows) { const c = latestByItem.get(r.item_id); if (!c || String(r.snapshot_date) > c) latestByItem.set(r.item_id, String(r.snapshot_date)); }
    for (const r of atsRows) {
      if (String(r.snapshot_date) !== latestByItem.get(r.item_id)) continue;
      const b = bucketOfItem(r.item_id); if (b) b.on_hand_ats += (Number(r.qty_on_hand) || 0) * mult(r.item_id);
    }
    // Allocated + On SO.
    for (const r of solRows) {
      const b = bucketOfItem(r.inventory_item_id); if (!b) continue;
      const m = mult(r.inventory_item_id);
      const alloc = Math.max((Number(r.qty_allocated) || 0) - (Number(r.qty_shipped) || 0), 0) * m;
      if (alloc > 0) b.allocated += alloc;
      // Avg sale price — qty-weighted across SO lines. When exploded, the pack
      // price spreads over m eaches (price/each = unit_price_cents / m, qty×m
      // eaches), so the line's total value is invariant to explode.
      const qOrd = Number(r.qty_ordered) || 0;
      const px = Number(r.unit_price_cents) || 0;
      if (qOrd > 0 && px > 0) b._salePx.push({ q: qOrd * m, c: px / m });
      // "Current" selling price = the most-recent SO line's per-each price
      // (px/m). Drives the inventory/PO columns, which have no sale of their own.
      if (px > 0) {
        const od = r.sales_orders?.order_date || null;
        if (b._curDate == null || (od && od > b._curDate)) { b._curDate = od; b._curCents = px / m; }
      }
      const status = r.sales_orders?.status;
      if (OPEN_SO_STATUSES.includes(status)) {
        const rawOpen = Math.max((Number(r.qty_ordered) || 0) - (Number(r.qty_shipped) || 0), 0); // packs (pre-explode)
        if (rawOpen > 0) {
          b.on_so += rawOpen * m;
          // On-SO column price: total open $ ÷ open eaches = per-each avg of the
          // OPEN orders (not the lifetime avg — which included old markdowns).
          if (px > 0) { b._openSoValC += rawOpen * px; b._openSoEa += rawOpen * m; }
        }
      }
    }
    // On PO + In transit (native purchase_order_lines).
    // The two PO models OVERLAP: the Xoro→Tangerine importer mirrors each Xoro
    // `tanda_pos` PO into native `purchase_orders` with the SAME po_number. So a
    // PO present in BOTH must be counted ONCE, or On PO doubles (155k vs ~88k).
    // Tangerine (native) is the source of truth: count native, then add Xoro
    // ONLY for POs not yet mirrored natively. Normalize po_number for matching.
    const normPo = (s) => String(s || "").trim().toUpperCase();
    const nativePoNums = new Set(polRows.map((r) => normPo(r.purchase_orders?.po_number)).filter(Boolean));
    for (const r of polRows) {
      const b = bucketOfItem(r.inventory_item_id); if (!b) continue;
      const open = Math.max((Number(r.qty_ordered) || 0) - (Number(r.qty_received) || 0), 0) * mult(r.inventory_item_id);
      if (open <= 0) continue;
      b.on_po += open;
      if (NATIVE_TRANSIT_STATUSES.includes(r.purchase_orders?.status)) b.in_transit += open;
    }
    // On PO + In transit (Xoro mirror tanda_pos / po_line_items) — skip POs
    // already counted from the native side (same po_number) to avoid double-count.
    for (const r of tandaLines) {
      if (nativePoNums.has(normPo(r.tanda_pos?.po_number))) continue;
      const p = parseItemNumber(r.item_number);
      if (!p) continue;
      const itemId = idByTuple.get(tupleKey(p.style, p.color, p.size));
      if (!itemId) continue;
      const b = bucketOfItem(itemId); if (!b) continue;
      const open = Math.max(Number(r.qty_remaining) || 0, 0) * mult(itemId);
      if (open <= 0) continue;
      b.on_po += open;
      if (TANDA_TRANSIT_STATUSES.includes(r.tanda_pos?.status)) b.in_transit += open;
    }
    // Sold — wholesale qty + ecom net_qty.
    // Sold — warehouse-filtered via the channel→warehouse map (a sale's channel
    // is its Xoro store = a Tangerine warehouse). A row whose channel doesn't map
    // to the selected warehouse is skipped.
    // Sold-column price = net sales revenue ÷ eaches sold (PPK-safe: net_amount
    // is the line total, eaches = qty × units-per-pack). This is the ACTUAL price
    // things sold at, per each — what the Sold column's Avg Sale should show.
    for (const r of whRows) { if (whKey && channelIdToWh.get(r.channel_id) !== whKey) continue; const b = bucketOfItem(r.sku_id); if (!b) continue; const ea = (Number(r.qty) || 0) * mult(r.sku_id); b.sold += ea; const nc = Math.round((Number(r.net_amount) || 0) * 100); if (ea > 0 && nc > 0) { b._soldValC += nc; b._soldEa += ea; } }
    for (const r of ecRows) { if (whKey && channelIdToWh.get(r.channel_id) !== whKey) continue; const b = bucketOfItem(r.sku_id); if (!b) continue; const ea = (Number(r.net_qty) || 0) * mult(r.sku_id); b.sold += ea; const nc = Math.round((Number(r.net_amount) || 0) * 100); if (ea > 0 && nc > 0) { b._soldValC += nc; b._soldEa += ea; } }
    // Purchased — Xoro receipts + Tangerine AP vendor-bill lines (date-ranged).
    for (const r of rcRows) { const b = bucketOfItem(r.sku_id); if (b) b.purchased += (Number(r.qty) || 0) * mult(r.sku_id); }
    for (const l of billBundle.billLines) {
      if (!billBundle.billDateOk.get(l.invoice_id)) continue;
      const b = bucketOfItem(l.inventory_item_id); if (b) b.purchased += (Number(l.quantity) || 0) * mult(l.inventory_item_id);
    }
    // Avg cost — ip_item_avg_cost by sku_code (exact + loose), per colour. When
    // exploded, a PPK SKU's avg cost is recorded at PACK grain (e.g. $136.80 for
    // a 24-pack), but every qty column is now in EACHES (×24). So divide the pack
    // cost by the same units-per-pack multiplier to get the per-each cost ($5.70)
    // — otherwise the Totals strip's $ Cost = eaches × pack-cost reads ~24×
    // inflated (the "millions" snapshot-totals bug). Mirrors the price/each split
    // done above for the SO sale price.
    for (const it of itemRows) {
      let cents = null;
      if (it.sku_code) {
        if (avgBundle.costBySku.has(it.sku_code)) cents = avgBundle.costBySku.get(it.sku_code);
        else { const lk = looseKey(it.sku_code); if (avgBundle.costByLoose.has(lk)) cents = avgBundle.costByLoose.get(lk); }
      }
      if (cents != null) {
        const m = mult(it.id);
        const perUnit = m > 1 ? cents / m : cents; // pack cost → per-each when exploded
        const b = bucketFor(it.style_id, it.color); b._costCents.push(perUnit);
      }
    }

    // Lots present on these styles' on-hand, sorted; the NO_LOT bucket last. Full
    // set (filter-independent) so the UI lot dropdown keeps every choice.
    const lots = [...lotsSeen].filter((l) => l !== NO_LOT).sort((a, b) => a.localeCompare(b));
    if (lotsSeen.has(NO_LOT)) lots.push(NO_LOT);
    return res.status(200).json({ rows: [...buckets.values()].map(finalizeRow), entity_id: eid, lots });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// Derive the display columns + drop scratch fields. ATS uses the ATS-app on-hand
// source and is clamped ≥ 0 (the ATS app clamps oversold to 0 by design).
function finalizeRow(b) {
  const ats = Math.max(b.on_hand_ats - b.allocated, 0);
  const ats_incl_po = Math.max(b.on_hand_ats - b.allocated + b.on_po, 0);
  const avg_cost_cents = b._costCents.length
    ? Math.round(b._costCents.reduce((s, c) => s + c, 0) / b._costCents.length)
    : null;
  // Qty-weighted average SO sale price for the colour (null if no priced SO lines).
  const spQty = b._salePx.reduce((s, x) => s + x.q, 0);
  const sale_price_cents = spQty > 0
    ? Math.round(b._salePx.reduce((s, x) => s + x.q * x.c, 0) / spQty)
    : null;
  // Per-column transaction prices (all per-each cents). Inventory/PO columns use
  // the "current" price (most-recent SO line); fall back to the lifetime avg when
  // a colour has never been on an SO with a date.
  const open_so_price_cents = b._openSoEa > 0 ? Math.round(b._openSoValC / b._openSoEa) : null;
  const sold_price_cents = b._soldEa > 0 ? Math.round(b._soldValC / b._soldEa) : null;
  const current_price_cents = b._curCents != null ? Math.round(b._curCents) : sale_price_cents;
  return {
    style_id: b.style_id, style_code: b.style_code, description: b.description,
    color: b.color, category: b.category,
    on_hand: b.on_hand, allocated: b.allocated, on_so: b.on_so,
    on_po: b.on_po, in_transit: b.in_transit, ats, ats_incl_po,
    sold: b.sold, purchased: b.purchased, avg_cost_cents, sale_price_cents,
    open_so_price_cents, sold_price_cents, current_price_cents,
  };
}
