// api/internal/purchase-orders
//
// P16 / M11 — native Purchase Order list + create (origination).
//
// GET  ?status=&vendor_id=&q=&limit=   → PO headers for the default entity.
// POST { vendor_id, brand_id?, order_date?, expected_date?, payment_terms_id?,
//        notes?, lines: [{ inventory_item_id?, description?, qty_ordered,
//        unit_cost_cents? }] }
//        → creates a DRAFT PO (po_number is assigned later, on issue).
//
// Brand + entity scoped. Writes via service-role (anon-read RLS).

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope, activeBrandId } from "../../../_lib/brandContext.js";
import { resolvePricesForCustomer } from "../../../_lib/pricing/engine.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "issued", "partially_received", "in_transit", "received", "cancelled"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Brand-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntity(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data || null;
}

const PO_HEADER_COLS =
  "po_type, customer_id, po_prefix, vendor_contact, vendor_email, vendor_ref, factory_location, coo, " +
  "requested_delivery_date, ship_window_start, ship_window_end, port_date, acknowledged_date, cancel_date, " +
  "ship_to_location_id, bill_to_entity_id, ship_method, freight_forwarder, season, channel_id, department_category_id, sales_order_id";
const SELECT_COLS =
  "id, entity_id, brand_id, vendor_id, po_number, order_date, expected_date, status, " +
  "currency, payment_terms_id, notes, subtotal_cents, total_cents, created_at, updated_at, " + PO_HEADER_COLS;

// Enum guards mirror the CHECK constraints in 20260863000000 / 20260954000000.
const PO_TYPES = ["stock", "replenishment", "made_to_order", "sample", "drop_ship", "manufacturing_part"];
const SHIP_METHODS = ["sea", "air", "ground"];

// Normalize the rich-header fields off a body into a column patch (shared by
// POST insert + PATCH). Only well-formed values survive; everything else → null.
export function normalizeHeader(body) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuid = (k) => (body[k] && UUID.test(String(body[k])) ? body[k] : null);
  const date = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(body[k] || "") ? body[k] : null);
  const text = (k) => (body[k] != null && String(body[k]).trim() !== "" ? String(body[k]).trim() : null);
  return {
    po_type: PO_TYPES.includes(body.po_type) ? body.po_type : null,
    customer_id: uuid("customer_id"),
    po_prefix: text("po_prefix"),
    vendor_contact: text("vendor_contact"),
    vendor_email: text("vendor_email"),
    vendor_ref: text("vendor_ref"),
    factory_location: text("factory_location"),
    coo: text("coo"),
    requested_delivery_date: date("requested_delivery_date"),
    ship_window_start: date("ship_window_start"),
    ship_window_end: date("ship_window_end"),
    port_date: date("port_date"),
    acknowledged_date: date("acknowledged_date"),
    cancel_date: date("cancel_date"),
    ship_to_location_id: uuid("ship_to_location_id"),
    bill_to_entity_id: uuid("bill_to_entity_id"),
    ship_method: SHIP_METHODS.includes(body.ship_method) ? body.ship_method : null,
    freight_forwarder: text("freight_forwarder"),
    season: text("season"),
    channel_id: uuid("channel_id"),
    department_category_id: uuid("department_category_id"),
    sales_order_id: uuid("sales_order_id"),
  };
}

export function validateInsert(body) {
  if (!body || typeof body !== "object") return { error: "body required" };
  if (!body.vendor_id || !UUID_RE.test(String(body.vendor_id))) {
    return { error: "vendor_id (uuid) required" };
  }
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const normLines = [];
  let ln = 1;
  for (const l of lines) {
    const qty = Number(l.qty_ordered);
    if (!Number.isFinite(qty) || qty <= 0) continue; // skip empty/zero lines
    const unit = l.unit_cost_cents == null || l.unit_cost_cents === "" ? 0 : Math.round(Number(l.unit_cost_cents));
    if (!Number.isFinite(unit) || unit < 0) return { error: `line ${ln}: unit_cost_cents must be >= 0` };
    const dre = /^\d{4}-\d{2}-\d{2}$/;
    normLines.push({
      line_number: ln++,
      inventory_item_id: l.inventory_item_id && UUID_RE.test(String(l.inventory_item_id)) ? l.inventory_item_id : null,
      // Manufacturing-part line: stocks a part_master part into part inventory
      // (1360) on receipt instead of a style SKU. Mutually exclusive with
      // inventory_item_id (a line is a style SKU OR a part).
      part_id: l.part_id && UUID_RE.test(String(l.part_id)) ? l.part_id : null,
      description: l.description ? String(l.description).trim() : null,
      qty_ordered: qty,
      unit_cost_cents: unit,
      line_total_cents: Math.round(qty * unit),
      requested_ship_date: dre.test(l.requested_ship_date || "") ? l.requested_ship_date : null,
      vendor_confirmed_ship_date: dre.test(l.vendor_confirmed_ship_date || "") ? l.vendor_confirmed_ship_date : null,
      // Lot (Scenario 1): operator may set it now; otherwise auto-stamped to the
      // PO number at issue (drafts have no PO number yet). Grain = style+color.
      lot_number: l.lot_number != null && String(l.lot_number).trim() !== "" ? String(l.lot_number).trim() : null,
    });
  }
  if (normLines.length === 0) return { error: "at least one line with qty_ordered > 0 is required" };

  const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
  return {
    data: {
      vendor_id: body.vendor_id,
      brand_id: nz("brand_id"),
      order_date: /^\d{4}-\d{2}-\d{2}$/.test(body.order_date || "") ? body.order_date : null,
      expected_date: /^\d{4}-\d{2}-\d{2}$/.test(body.expected_date || "") ? body.expected_date : null,
      payment_terms_id: nz("payment_terms_id"),
      notes: body.notes ? String(body.notes).trim() : null,
      ...normalizeHeader(body),
      lines: normLines,
    },
  };
}

// Split an id array into pages so a `.in(...)` filter's URL stays under
// PostgREST's ~16KB header limit (uuids ≈ 39 chars each → 200 ≈ 8KB).
function chunkIds(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// In-transit OVERLAY: a PO is "in transit" while it has ≥1 shipment still in
// status 'in_transit' (a separate dimension from its lifecycle status — see
// po_shipments). Decorate each row with in_transit (bool), transit_eta (the
// earliest active-shipment ETA) and transit_shipments (count). Best-effort:
// swallow errors (e.g. table not yet migrated) so the grid never 500s on it.
async function enrichInTransit(admin, rows) {
  if (!rows.length) return rows;
  for (const r of rows) { r.in_transit = false; r.transit_eta = null; r.transit_shipments = 0; }
  try {
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const slice of chunkIds([...byId.keys()], 200)) {
      const { data } = await admin
        .from("po_shipments")
        .select("purchase_order_id, eta")
        .eq("status", "in_transit")
        .in("purchase_order_id", slice);
      for (const s of data || []) {
        const r = byId.get(s.purchase_order_id);
        if (!r) continue;
        r.in_transit = true;
        r.transit_shipments += 1;
        if (s.eta && (r.transit_eta == null || s.eta < r.transit_eta)) r.transit_eta = s.eta;
      }
    }
  } catch { /* table missing / transient — leave overlay defaults */ }
  return rows;
}

// ── List enrichment: per-PO Avg cost, Avg PO Price, Sell, Margin ─────────────
// Decorates each PO header row with qty-weighted, per-line aggregates so the
// grid can show them without N round-trips:
//   avg_cost_cents     — Σ(std_cost·qty) / Σ(qty). STANDARD/catalog cost from
//                        ip_item_avg_cost (keyed by sku_code, exact then loose)
//                        — the same source the Inventory Snapshot + SO grid use.
//                        Lets the operator compare standard cost vs the actual
//                        negotiated PO price (PO variance).
//   avg_po_price_cents — Σ(unit_cost_cents·qty) / Σ(qty) across the PO's OWN
//                        lines. The actual price this PO pays the vendor.
//   sell_cents         — Σ(resolved_sell·qty) / Σ(qty). Sell is resolved per style:
//                        • if the PO is tied to a customer (sales_order_id →
//                          sales_orders.customer_id) the M43 pricing engine resolves
//                          the customer's price (own → assigned → tier → default);
//                        • any style the customer path doesn't price (and every line
//                          when there's no customer) falls back to that style's
//                          BRAND DEFAULT list price (price_lists.brand_id = style's
//                          brand, mirroring price-lists/style-cost.js).
//   margin_cents/_pct  — Sell − Avg PO Price (the gross margin if sold at list,
//                        priced against what this PO actually costs). Mirrors the
//                        SO grid's Sell − Cost convention. null when sell is absent.
// styleFilter (style_code, case-insensitive) scopes ALL aggregates to just that
// style's lines — mirrors the grid's style search so the numbers match the view.
// Prepack (PPK) pack size from a size/style/sku token, e.g. "PPK18" → 18. A PPK
// line's qty is PACKS and its unit_cost is per-PACK; exploding by the pack size
// puts cost/qty on the same per-UNIT grain as the sell + standard cost, so the
// Avg PO Price + margin don't blow up (a $214/pack line vs a $16/unit sell →
// −1248% before, sane after). Non-PPK tokens → 1 (no change).
function extractPpk(v) {
  if (!v) return null;
  const m = String(v).match(/PPK[\s_-]*(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function enrichPricing(admin, rows, styleFilter) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const poIds = rows.map((r) => r.id);
  // NB: chunk every `.in(<id array>)` — a full 500-PO / thousands-of-SKU array
  // makes the request URL exceed PostgREST's 16KB header limit (the fetch fails
  // with HeadersOverflowError, the query silently returns no rows, and EVERY
  // money column goes blank). 200 uuids ≈ 8KB, safely under. (Same pattern the
  // SO grid's computeSoMetrics already uses.)
  // PostgREST caps a response at 1000 rows. A 200-PO chunk can hold FAR more than
  // 1000 lines (denim size-matrix POs run dozens of lines each — ~68/PO seen in
  // prod), so a single `.in()` fetch silently dropped every line past row 1000 →
  // those POs got NO lines → Avg PO Price / Sell / Margin blank on most rows.
  // Page through each chunk with .range() (stable order) until it's exhausted.
  const allLines = [];
  const LINE_PAGE = 1000;
  for (const slice of chunkIds(poIds, 200)) {
    for (let from = 0; ; from += LINE_PAGE) {
      const { data } = await admin
        .from("purchase_order_lines")
        .select("purchase_order_id, inventory_item_id, qty_ordered, qty_received, unit_cost_cents")
        .in("purchase_order_id", slice)
        .order("purchase_order_id", { ascending: true })
        .order("line_number", { ascending: true })
        .range(from, from + LINE_PAGE - 1);
      const batch = data || [];
      for (const l of batch) allLines.push(l);
      if (batch.length < LINE_PAGE) break;
    }
  }

  // SKU → { style_id, style_code, sku_code } for every line item.
  const itemIds = [...new Set(allLines.map((l) => l.inventory_item_id).filter(Boolean))];
  const skuById = new Map();
  for (const slice of chunkIds(itemIds, 200)) {
    const { data: skus } = await admin
      .from("ip_item_master").select("id, style_id, style_code, sku_code, size").in("id", slice);
    for (const s of skus || []) skuById.set(s.id, s);
  }
  const styleNeedle = styleFilter ? String(styleFilter).trim().toLowerCase() : null;

  // Group the (optionally style-filtered) lines under each PO, carrying style_id
  // + sku_code (sku_code drives the standard-cost lookup below).
  const linesByPo = new Map();
  const allStyleIds = new Set();
  const allSkuCodes = new Set();
  for (const l of allLines) {
    const sku = l.inventory_item_id ? skuById.get(l.inventory_item_id) : null;
    if (styleNeedle && !(sku?.style_code && String(sku.style_code).toLowerCase() === styleNeedle)) continue;
    const arr = linesByPo.get(l.purchase_order_id) || [];
    arr.push({ ...l, style_id: sku?.style_id || null, sku_code: sku?.sku_code || null, style_code: sku?.style_code || null, size: sku?.size || null });
    linesByPo.set(l.purchase_order_id, arr);
    if (sku?.style_id) allStyleIds.add(sku.style_id);
    if (sku?.sku_code) allSkuCodes.add(sku.sku_code);
  }

  // Standard (catalog) cost + standard unit selling price per sku_code, resolved
  // via the normalized-SKU RPC. ip_item_avg_cost stores a punctuation-collapsed
  // sku_code, so an exact .in() match missed ~60% of lines; the RPC normalizes
  // both sides (upper + alphanumeric-only) → ~89% coverage. stdSell feeds the
  // sell fallback below (many PO styles have no customer/brand-list price).
  const stdCostBySku = new Map(); // sku_code → cents (standard cost)
  const stdSellBySku = new Map(); // sku_code → cents (standard unit selling price)
  if (allSkuCodes.size) {
    const skuList = [...allSkuCodes];
    for (let i = 0; i < skuList.length; i += 500) {
      const slice = skuList.slice(i, i + 500);
      const { data: resolved } = await admin.rpc("resolve_avg_cost_by_norm", { p_skus: slice });
      for (const c of resolved || []) {
        if (c.avg_cost != null && !stdCostBySku.has(c.input_sku)) stdCostBySku.set(c.input_sku, Math.round(Number(c.avg_cost) * 100));
        if (c.standard_unit_price != null && !stdSellBySku.has(c.input_sku)) stdSellBySku.set(c.input_sku, Math.round(Number(c.standard_unit_price) * 100));
      }
    }
  }
  const stdCostForSku = (sku) => (sku && stdCostBySku.has(sku) ? stdCostBySku.get(sku) : null);
  const stdSellForSku = (sku) => (sku && stdSellBySku.has(sku) ? stdSellBySku.get(sku) : null);

  // Resolve the customer for any PO carrying a sales_order_id (sell pricing).
  const soIds = [...new Set(rows.map((r) => r.sales_order_id).filter(Boolean))];
  const customerByPo = new Map();
  if (soIds.length) {
    const { data: sos } = await admin.from("sales_orders").select("id, customer_id").in("id", soIds);
    const custBySo = new Map((sos || []).map((s) => [s.id, s.customer_id]));
    for (const r of rows) if (r.sales_order_id && custBySo.get(r.sales_order_id)) customerByPo.set(r.id, custBySo.get(r.sales_order_id));
  }

  // Brand-default sell price per style (fallback when there's no customer price).
  // Resolve each style's brand, then that brand's default list's price (min_qty=0).
  const brandDefaultByStyle = new Map();
  if (allStyleIds.size) {
    const brandByStyle = new Map();
    for (const slice of chunkIds([...allStyleIds], 200)) {
      const { data: styles } = await admin.from("style_master").select("id, brand_id").in("id", slice);
      for (const s of styles || []) brandByStyle.set(s.id, s.brand_id);
    }
    const brandIds = [...new Set([...brandByStyle.values()].filter(Boolean))];
    if (brandIds.length) {
      const { data: brandLists } = await admin.from("price_lists")
        .select("id, brand_id").in("brand_id", brandIds).eq("is_active", true).order("created_at");
      const listByBrand = new Map();
      for (const bl of brandLists || []) if (!listByBrand.has(bl.brand_id)) listByBrand.set(bl.brand_id, bl.id);
      const listIds = [...new Set([...listByBrand.values()])];
      if (listIds.length) {
        const { data: pli } = await admin.from("price_list_items")
          .select("price_list_id, style_id, price_cents").in("price_list_id", listIds).eq("min_qty", 0).eq("is_active", true);
        const priceByListStyle = new Map((pli || []).map((p) => [`${p.price_list_id}|${p.style_id}`, Number(p.price_cents)]));
        for (const sid of allStyleIds) {
          const listId = listByBrand.get(brandByStyle.get(sid));
          const px = listId ? priceByListStyle.get(`${listId}|${sid}`) : undefined;
          if (px != null) brandDefaultByStyle.set(sid, px);
        }
      }
    }
  }

  // Per-customer style price cache (one engine call per distinct customer).
  const customerPriceCache = new Map(); // customerId → Map<styleId, cents>
  for (const cust of new Set([...customerByPo.values()])) {
    const priced = await resolvePricesForCustomer(admin, cust, [...allStyleIds]);
    const m = new Map();
    for (const [sid, e] of priced) m.set(sid, e.price_cents);
    customerPriceCache.set(cust, m);
  }

  // Most-recent ACTUAL sell per style (wholesale history + native SOs). Ranked
  // above the standard/provisional fallbacks so a style's real price shows the
  // moment it has an SO / invoice / Xoro sale (which also supersedes any
  // provisional placeholder for that style).
  const recentSellByStyle = new Map();
  if (allStyleIds.size) {
    const { data: recent } = await admin.rpc("recent_sell_by_style", { p_style_ids: [...allStyleIds] });
    for (const rr of recent || []) if (rr.unit_price_cents != null) recentSellByStyle.set(rr.style_id, Number(rr.unit_price_cents));
  }
  // Provisional placeholder sell (21% margin off PO cost) for never-sold styles —
  // the last-resort fallback. Read from the dedicated table only (the M43 quote
  // engine never sees it, so a placeholder can't leak into a customer quote).
  const provisionalByStyle = new Map();
  if (allStyleIds.size) {
    for (const slice of chunkIds([...allStyleIds], 200)) {
      const { data: prov } = await admin.from("provisional_style_prices")
        .select("style_id, price_cents").in("style_id", slice).eq("is_active", true);
      for (const p of prov || []) if (p.price_cents != null) provisionalByStyle.set(p.style_id, Number(p.price_cents));
    }
  }

  for (const r of rows) {
    const myLines = linesByPo.get(r.id) || [];
    // priceNum/Den → Avg PO Price (PO's own line cost); stdNum/Den → Avg cost
    // (standard/catalog cost, only over lines that actually have one).
    let priceNum = 0, priceDen = 0, stdNum = 0, stdDen = 0, sellNum = 0, sellDen = 0;
    let unlinkedCostLines = 0;
    // Remaining-to-ship $ = Σ max(0, qty_ordered − qty_received) × this PO's unit
    // cost. Ties to Xoro's "$ Remaining to Ship" (open commitment), unlike Total
    // which is the full ordered value. Uses every line (SKU-linked or not) since
    // it's the PO's own cost × its own open qty.
    let remainingCents = 0;
    const custPrices = customerByPo.has(r.id) ? customerPriceCache.get(customerByPo.get(r.id)) : null;
    for (const l of myLines) {
      const qty = Number(l.qty_ordered) || 0;
      const poPrice = Number(l.unit_cost_cents) || 0;
      // Remaining-to-ship $ uses the PO's own pack-grain qty × cost (a real $
      // total, grain-agnostic like Total) — do NOT explode it.
      const openQty = Math.max(0, qty - (Number(l.qty_received) || 0));
      remainingCents += openQty * poPrice;
      if (qty <= 0) continue;
      // PPK prepack lines carry qty = PACKS and unit_cost = per-PACK. Explode by
      // the pack size so cost/qty land on the same per-UNIT grain as the sell +
      // standard cost (whose SKU size is "PPKnn"). effQty = total UNITS; the total
      // $ (poPrice × packs) is unchanged, so Avg PO Price = total$ ÷ units = the
      // real per-unit price (a $214/pack line reads $11.90/unit, not $214).
      const ppk = extractPpk(l.size) || extractPpk(l.style_code) || extractPpk(l.sku_code) || 1;
      const effQty = qty * ppk;
      // Exclude UNLINKED (no resolved SKU) lines from Avg PO Price. Some Xoro POs
      // carry pack-priced aggregate lines with no SKU (unit_cost = the ~24× pack
      // price against a unit-level qty), which otherwise blow up the per-unit
      // average and produce nonsense margins (e.g. −1,762%). Orphan lines can't be
      // per-unit-validated anyway (std-cost + sell below also require a SKU).
      if (l.sku_code || l.style_id) { priceNum += poPrice * qty; priceDen += effQty; }
      else { unlinkedCostLines += 1; }
      const std = stdCostForSku(l.sku_code);
      if (std != null) { stdNum += std * effQty; stdDen += effQty; }
      // Sell resolution order: customer price → brand-default list → recent
      // ACTUAL sell (SO/invoice/Xoro) → standard unit price → provisional (21%
      // placeholder). Each layer covers a wider set of styles; the provisional
      // is only used for never-sold styles with no price on file.
      let sell = null;
      if (l.style_id) {
        if (custPrices && custPrices.get(l.style_id) != null) sell = custPrices.get(l.style_id);
        else if (brandDefaultByStyle.get(l.style_id) != null) sell = brandDefaultByStyle.get(l.style_id);
        else if (recentSellByStyle.get(l.style_id) != null) sell = recentSellByStyle.get(l.style_id);
      }
      if (sell == null) sell = stdSellForSku(l.sku_code);
      if (sell == null && l.style_id) { const pv = provisionalByStyle.get(l.style_id); if (pv != null) sell = pv; }
      if (sell != null) { sellNum += sell * effQty; sellDen += effQty; }
    }
    r.avg_po_price_cents = priceDen > 0 ? Math.round(priceNum / priceDen) : null;
    r.avg_cost_cents = stdDen > 0 ? Math.round(stdNum / stdDen) : null;
    r.remaining_to_ship_cents = Math.round(remainingCents);
    // Flag POs that carry unlinked (SKU-less) cost lines — typically the Xoro
    // pack-priced aggregate lines excluded above; their qty/value are real but
    // their per-unit price is unreliable, so the Total may still be inflated.
    r.cost_anomaly = unlinkedCostLines > 0;
    r.sell_cents = sellDen > 0 ? Math.round(sellNum / sellDen) : null;
    // Margin = Sell − Avg PO Price (gross margin at list, against actual PO cost).
    if (r.sell_cents != null && r.avg_po_price_cents != null) {
      r.margin_cents = r.sell_cents - r.avg_po_price_cents;
      r.margin_pct = r.sell_cents !== 0 ? Math.round((r.margin_cents / r.sell_cents) * 1000) / 10 : null;
    } else {
      r.margin_cents = null;
      r.margin_pct = null;
    }
  }
  return rows;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    // Multi-status filter: `status` may be a comma-separated set (mirrors the SO
    // grid's multi-select). Empty = all statuses.
    const statusRaw = (url.searchParams.get("status") || "").trim();
    const statuses = statusRaw ? statusRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const vendorId = (url.searchParams.get("vendor_id") || "").trim();
    const q = (url.searchParams.get("q") || "").trim();
    // Optional style scope for the Avg cost / Avg PO Price / Sell / Margin columns
    // — when set, all aggregates count only that style's lines (matches the grid's
    // style search).
    const styleScope = (url.searchParams.get("style") || "").trim() || null;
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 500);
    for (const s of statuses) {
      if (!STATUSES.includes(s)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    }

    const venId = vendorId && UUID_RE.test(vendorId) ? vendorId : null;
    let data, error;
    if (q) {
      // All-field search (PO #, notes, vendor name/code, and any line's
      // description / SKU sku_code / style_code / description) runs in the
      // search_purchase_orders RPC so the line-level match never has to ship a
      // large id.in.(…) URL. NULL brand = "all" unless enforcing. The RPC takes a
      // single status, so a multi-status set is filtered client-side below.
      ({ data, error } = await admin.rpc("search_purchase_orders", {
        p_entity_id: entity.id,
        p_q: q,
        p_status: statuses.length === 1 ? statuses[0] : null,
        p_vendor_id: venId,
        p_brand_id: activeBrandId(req),
        p_limit: limit,
      }));
    } else {
      let query = admin.from("purchase_orders").select(SELECT_COLS)
        .eq("entity_id", entity.id)
        .order("order_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      query = applyBrandScope(query, req);
      if (statuses.length === 1) query = query.eq("status", statuses[0]);
      else if (statuses.length > 1) query = query.in("status", statuses);
      if (venId) query = query.eq("vendor_id", venId);
      ({ data, error } = await query);
    }
    if (error) return res.status(500).json({ error: error.message });
    let headers = data || [];
    // The search RPC can't express a multi-status set, so narrow it client-side.
    if (q && statuses.length > 1) { const set = new Set(statuses); headers = headers.filter((h) => set.has(h.status)); }
    const enriched = await enrichPricing(admin, headers, styleScope);
    await enrichInTransit(admin, enriched);
    return res.status(200).json(enriched);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const subtotal = v.data.lines.reduce((s, l) => s + l.line_total_cents, 0);
    const header_cols = normalizeHeader(v.data); // v.data already carries the normalized header values
    const { data: header, error: hErr } = await admin.from("purchase_orders").insert({
      entity_id: entity.id,
      vendor_id: v.data.vendor_id,
      brand_id: v.data.brand_id || undefined, // undefined → DB default rof_default_brand_id()
      order_date: v.data.order_date || undefined,
      expected_date: v.data.expected_date,
      status: "draft",
      payment_terms_id: v.data.payment_terms_id,
      notes: v.data.notes,
      ...header_cols,
      subtotal_cents: subtotal,
      total_cents: subtotal,
    }).select(SELECT_COLS).single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    // Scenario 3 — a PO created from an SO inherits the SO's customer PO as the
    // lot on every line the caller didn't already lot. The UI pre-fills this, but
    // doing it server-side guarantees it for any programmatic PO-from-SO path and
    // means the at-issue PO#-stamp won't later fill these (they're no longer null).
    let soLot = null;
    if (v.data.sales_order_id) {
      const { data: so } = await admin.from("sales_orders").select("customer_po").eq("id", v.data.sales_order_id).maybeSingle();
      soLot = (so?.customer_po && String(so.customer_po).trim()) || null;
    }
    const lineRows = v.data.lines.map((l) => ({ ...l, lot_number: l.lot_number || soLot, purchase_order_id: header.id }));
    const { error: lErr } = await admin.from("purchase_order_lines").insert(lineRows);
    if (lErr) return res.status(500).json({ error: `Header saved (${header.id}) but lines failed: ${lErr.message}` });

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
