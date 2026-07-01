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
const STATUSES = ["draft", "issued", "in_transit", "received", "cancelled"];

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

// Enum guards mirror the CHECK constraints in 20260863000000.
const PO_TYPES = ["stock", "replenishment", "made_to_order", "sample", "drop_ship"];
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

// loose SKU key — strip non-alphanumerics + uppercase, for fuzzy std-cost match
// (mirrors sales-orders/index.js so the two grids read costs the same way).
function looseKey(s) { return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

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
async function enrichPricing(admin, rows, styleFilter) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const poIds = rows.map((r) => r.id);
  const { data: lines } = await admin
    .from("purchase_order_lines")
    .select("purchase_order_id, inventory_item_id, qty_ordered, unit_cost_cents")
    .in("purchase_order_id", poIds);
  const allLines = lines || [];

  // SKU → { style_id, style_code, sku_code } for every line item.
  const itemIds = [...new Set(allLines.map((l) => l.inventory_item_id).filter(Boolean))];
  let skuById = new Map();
  if (itemIds.length) {
    const { data: skus } = await admin
      .from("ip_item_master").select("id, style_id, style_code, sku_code").in("id", itemIds);
    skuById = new Map((skus || []).map((s) => [s.id, s]));
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
    arr.push({ ...l, style_id: sku?.style_id || null, sku_code: sku?.sku_code || null });
    linesByPo.set(l.purchase_order_id, arr);
    if (sku?.style_id) allStyleIds.add(sku.style_id);
    if (sku?.sku_code) allSkuCodes.add(sku.sku_code);
  }

  // Standard (catalog) cost per sku_code from ip_item_avg_cost — exact + loose.
  const stdCostBySku = new Map(), stdCostByLoose = new Map();
  if (allSkuCodes.size) {
    const skuList = [...allSkuCodes];
    for (let i = 0; i < skuList.length; i += 100) {
      const slice = skuList.slice(i, i + 100);
      const { data: costs } = await admin.from("ip_item_avg_cost").select("sku_code, avg_cost").in("sku_code", slice);
      for (const c of costs || []) {
        if (c.avg_cost == null) continue;
        const cents = Math.round(Number(c.avg_cost) * 100);
        stdCostBySku.set(c.sku_code, cents);
        const lk = looseKey(c.sku_code); if (!stdCostByLoose.has(lk)) stdCostByLoose.set(lk, cents);
      }
    }
  }
  const stdCostForSku = (sku) => {
    if (!sku) return null;
    if (stdCostBySku.has(sku)) return stdCostBySku.get(sku);
    const lk = looseKey(sku); return stdCostByLoose.has(lk) ? stdCostByLoose.get(lk) : null;
  };

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
    const { data: styles } = await admin.from("style_master").select("id, brand_id").in("id", [...allStyleIds]);
    const brandByStyle = new Map((styles || []).map((s) => [s.id, s.brand_id]));
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

  for (const r of rows) {
    const myLines = linesByPo.get(r.id) || [];
    // priceNum/Den → Avg PO Price (PO's own line cost); stdNum/Den → Avg cost
    // (standard/catalog cost, only over lines that actually have one).
    let priceNum = 0, priceDen = 0, stdNum = 0, stdDen = 0, sellNum = 0, sellDen = 0;
    const custPrices = customerByPo.has(r.id) ? customerPriceCache.get(customerByPo.get(r.id)) : null;
    for (const l of myLines) {
      const qty = Number(l.qty_ordered) || 0;
      if (qty <= 0) continue;
      const poPrice = Number(l.unit_cost_cents) || 0;
      priceNum += poPrice * qty; priceDen += qty;
      const std = stdCostForSku(l.sku_code);
      if (std != null) { stdNum += std * qty; stdDen += qty; }
      // Sell: customer price → brand-default → skip (can't fabricate a sell).
      let sell = null;
      if (l.style_id) {
        if (custPrices && custPrices.get(l.style_id) != null) sell = custPrices.get(l.style_id);
        else if (brandDefaultByStyle.get(l.style_id) != null) sell = brandDefaultByStyle.get(l.style_id);
      }
      if (sell != null) { sellNum += sell * qty; sellDen += qty; }
    }
    r.avg_po_price_cents = priceDen > 0 ? Math.round(priceNum / priceDen) : null;
    r.avg_cost_cents = stdDen > 0 ? Math.round(stdNum / stdDen) : null;
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
