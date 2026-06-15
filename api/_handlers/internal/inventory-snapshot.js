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
//      }] }
//
// Entity scoped (ROF default). Read-only. No migration — reuses existing tables.

import { createClient } from "@supabase/supabase-js";

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
  const rows = [];
  for (const slice of chunks(ids, CHUNK)) {
    const { data, error } = await chunkFn(slice);
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
        .select("item_number, qty_remaining, tanda_pos!inner(status)")
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

  try {
    const eid = await entityId(admin);

    // ── Styles (header fields) ────────────────────────────────────────────────
    const styleRows = await fetchChunked(styleIds, (ids) =>
      admin.from("style_master").select("id, style_code, description, style_name, category_name, group_name").in("id", ids));
    const styleById = new Map(styleRows.map((s) => [s.id, s]));

    // ── SKUs for these styles → item_id → {style_id, color, sku_code, …} ───────
    const itemRows = await fetchChunked(styleIds, (ids) =>
      admin.from("ip_item_master").select("id, style_id, style_code, color, size, sku_code").in("style_id", ids));
    const itemById = new Map(itemRows.map((r) => [r.id, r]));
    const itemIds = itemRows.map((r) => r.id);
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
          sold: 0, purchased: 0, _costCents: [],
        };
        buckets.set(k, b);
      }
      return b;
    };
    for (const it of itemRows) bucketFor(it.style_id, it.color);
    const bucketOfItem = (itemId) => { const it = itemById.get(itemId); return it ? bucketFor(it.style_id, it.color) : null; };

    if (itemIds.length === 0) return res.status(200).json({ rows: [...buckets.values()].map(finalizeRow) });

    // ── On hand (inventory_layers — matches the matrix) ───────────────────────
    const layerRows = await fetchChunked(itemIds, (ids) =>
      admin.from("inventory_layers").select("item_id, remaining_qty").in("item_id", ids));
    for (const r of layerRows) {
      const q = Number(r.remaining_qty) || 0;
      if (q > 0) { const b = bucketOfItem(r.item_id); if (b) b.on_hand += q; }
    }

    // ── On hand (ATS source — tangerine_size_onhand latest snapshot) ──────────
    const ohRows = await fetchChunked(itemIds, (ids) =>
      admin.from("tangerine_size_onhand").select("item_id, snapshot_date, qty_on_hand").in("item_id", ids));
    const latestByItem = new Map();
    for (const r of ohRows) { const c = latestByItem.get(r.item_id); if (!c || String(r.snapshot_date) > c) latestByItem.set(r.item_id, String(r.snapshot_date)); }
    for (const r of ohRows) {
      if (String(r.snapshot_date) !== latestByItem.get(r.item_id)) continue;
      const b = bucketOfItem(r.item_id); if (b) b.on_hand_ats += Number(r.qty_on_hand) || 0;
    }

    // ── Allocated + On SO (sales_order_lines + open SO status) ─────────────────
    const solRows = await fetchChunked(itemIds, (ids) =>
      admin.from("sales_order_lines")
        .select("inventory_item_id, qty_ordered, qty_allocated, qty_shipped, sales_orders!inner(status)")
        .in("inventory_item_id", ids));
    for (const r of solRows) {
      const b = bucketOfItem(r.inventory_item_id); if (!b) continue;
      const alloc = Math.max((Number(r.qty_allocated) || 0) - (Number(r.qty_shipped) || 0), 0);
      if (alloc > 0) b.allocated += alloc;
      const status = r.sales_orders?.status;
      if (OPEN_SO_STATUSES.includes(status)) {
        const open = Math.max((Number(r.qty_ordered) || 0) - (Number(r.qty_shipped) || 0), 0);
        if (open > 0) b.on_so += open;
      }
    }

    // ── On PO + In transit (native purchase_order_lines) ──────────────────────
    const polRows = await fetchChunked(itemIds, (ids) =>
      admin.from("purchase_order_lines")
        .select("inventory_item_id, qty_ordered, qty_received, purchase_orders!inner(status)")
        .in("inventory_item_id", ids)
        .in("purchase_orders.status", NATIVE_INBOUND_STATUSES));
    for (const r of polRows) {
      const b = bucketOfItem(r.inventory_item_id); if (!b) continue;
      const open = Math.max((Number(r.qty_ordered) || 0) - (Number(r.qty_received) || 0), 0);
      if (open <= 0) continue;
      b.on_po += open;
      if (NATIVE_TRANSIT_STATUSES.includes(r.purchase_orders?.status)) b.in_transit += open;
    }

    // ── On PO + In transit (Xoro mirror tanda_pos / po_line_items) ────────────
    const idByTuple = new Map();   // tupleKey → item_id
    const styleSet = new Set();
    for (const m of itemRows) {
      if (m.style_code && m.color != null && m.size != null) idByTuple.set(tupleKey(m.style_code, m.color, m.size), m.id);
      if (m.style_code) styleSet.add(String(m.style_code));
    }
    if (styleSet.size > 0) {
      const tandaLines = await fetchTandaOpenLines(admin, [...styleSet]);
      for (const r of tandaLines) {
        const p = parseItemNumber(r.item_number);
        if (!p) continue;
        const itemId = idByTuple.get(tupleKey(p.style, p.color, p.size));
        if (!itemId) continue;
        const b = bucketOfItem(itemId); if (!b) continue;
        const open = Math.max(Number(r.qty_remaining) || 0, 0);
        if (open <= 0) continue;
        b.on_po += open;
        if (TANDA_TRANSIT_STATUSES.includes(r.tanda_pos?.status)) b.in_transit += open;
      }
    }

    // ── Sold — wholesale qty + ecom net_qty, keyed by sku_id (date-ranged) ────
    const whRows = await fetchChunked(itemIds, (ids) => {
      let q = admin.from("ip_sales_history_wholesale").select("sku_id, qty").in("sku_id", ids);
      if (from) q = q.gte("txn_date", from);
      if (to) q = q.lte("txn_date", to);
      return q;
    });
    for (const r of whRows) { const b = bucketOfItem(r.sku_id); if (b) b.sold += Number(r.qty) || 0; }
    const ecRows = await fetchChunked(itemIds, (ids) => {
      let q = admin.from("ip_sales_history_ecom").select("sku_id, net_qty").in("sku_id", ids);
      if (from) q = q.gte("order_date", from);
      if (to) q = q.lte("order_date", to);
      return q;
    });
    for (const r of ecRows) { const b = bucketOfItem(r.sku_id); if (b) b.sold += Number(r.net_qty) || 0; }

    // ── Purchased — Xoro receipts (date-ranged on received_date) + Tangerine AP
    //     vendor-bill line qty (date-ranged on invoice_date). Mirrors the
    //     purchased-detail drill so the column total matches the popup. ──────────
    const rcRows = await fetchChunked(itemIds, (ids) => {
      let q = admin.from("ip_receipts_history").select("sku_id, qty").in("sku_id", ids);
      if (from) q = q.gte("received_date", from);
      if (to) q = q.lte("received_date", to);
      return q;
    });
    for (const r of rcRows) { const b = bucketOfItem(r.sku_id); if (b) b.purchased += Number(r.qty) || 0; }
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
    for (const l of billLines) {
      if (!billDateOk.get(l.invoice_id)) continue;
      const b = bucketOfItem(l.inventory_item_id); if (b) b.purchased += Number(l.quantity) || 0;
    }

    // ── Avg cost — ip_item_avg_cost by sku_code (exact + loose), per colour ────
    const stems = [...new Set(itemRows.map((r) => String(r.sku_code ?? "").split("-")[0].trim()).filter(Boolean))];
    const costBySku = new Map(), costByLoose = new Map();
    for (const stemSlice of chunks(stems, STYLE_CHUNK)) {
      const orFilter = stemSlice.map((s) => `sku_code.like.${s}-%`).join(",");
      if (!orFilter) continue;
      const { data: avgRows } = await admin.from("ip_item_avg_cost").select("sku_code, avg_cost").or(orFilter);
      for (const r of avgRows || []) {
        if (r.avg_cost == null) continue;
        const cents = Math.round(Number(r.avg_cost) * 100);
        costBySku.set(r.sku_code, cents);
        const lk = looseKey(r.sku_code); if (!costByLoose.has(lk)) costByLoose.set(lk, cents);
      }
    }
    for (const it of itemRows) {
      let cents = null;
      if (it.sku_code) {
        if (costBySku.has(it.sku_code)) cents = costBySku.get(it.sku_code);
        else { const lk = looseKey(it.sku_code); if (costByLoose.has(lk)) cents = costByLoose.get(lk); }
      }
      if (cents != null) { const b = bucketFor(it.style_id, it.color); b._costCents.push(cents); }
    }

    return res.status(200).json({ rows: [...buckets.values()].map(finalizeRow), entity_id: eid });
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
  return {
    style_id: b.style_id, style_code: b.style_code, description: b.description,
    color: b.color, category: b.category,
    on_hand: b.on_hand, allocated: b.allocated, on_so: b.on_so,
    on_po: b.on_po, in_transit: b.in_transit, ats, ats_incl_po,
    sold: b.sold, purchased: b.purchased, avg_cost_cents,
  };
}
