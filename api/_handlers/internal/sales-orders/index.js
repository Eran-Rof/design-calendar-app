// api/internal/sales-orders
//
// P16 / M10-B — native Sales Order list + create.
//
// GET  ?status=&customer_id=&q=&limit=   → SO headers for the default entity.
// POST { customer_id, ship_to_location_id?, brand_id?, channel_id?, order_date?,
//        requested_ship_date?, cancel_date?, payment_terms_id?, ar_account_id?,
//        revenue_account_id?, notes?, lines: [{ inventory_item_id?, description?,
//        qty_ordered, unit_price_cents?, revenue_account_id? }] }
//        → creates a DRAFT SO (so_number is assigned later, on confirm).
//
// Brand/channel + entity scoped. Writes via service-role (anon-read RLS).

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope, applyChannelScope, activeBrandId, activeChannelId } from "../../../_lib/brandContext.js";
import { resolveMarginAccess } from "../../../_lib/rbac/marginAccess.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "confirmed", "allocated", "fulfilling", "shipped", "invoiced", "closed", "cancelled"];
const FACTOR_STATUSES = ["not_submitted", "pending", "approved", "partial", "declined", "not_required"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Brand-ID, X-Channel-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntity(admin) {
  const { data } = await admin.from("entities").select("id, default_revenue_account_id").eq("code", "ROF").maybeSingle();
  return data || null;
}

// chunk a list into pages (Supabase .in() URL-length guard).
function chunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// Per-SO cost / sell / margin aggregates (operator ask: Avg cost, Avg sell,
// Margin %, Margin $ columns). Cost source = ip_item_avg_cost (same source the
// Inventory Snapshot uses), keyed by sku_code (exact, then loose). All values
// qty-weighted across the SO's lines. When `styleFilter` is set, the aggregates
// are scoped to ONLY the lines whose style_code / sku_code matches it (so the
// grid metrics reflect the searched style, not the whole order) — but only when
// at least one line matches; otherwise the whole-SO aggregate is returned.
async function computeSoMetrics(admin, soIds, styleFilter) {
  const out = new Map(); // so_id -> { avg_cost_cents, avg_sell_cents, margin_cents, margin_pct }
  if (!soIds.length) return out;

  // 1. Lines for these SOs.
  const lines = [];
  for (const slice of chunks(soIds, 100)) {
    const { data } = await admin.from("sales_order_lines")
      .select("sales_order_id, inventory_item_id, qty_ordered, unit_price_cents")
      .in("sales_order_id", slice);
    for (const l of data || []) lines.push(l);
  }
  if (!lines.length) return out;

  // 2. Resolve inventory_item_id -> { sku_code, style_code }.
  const itemIds = [...new Set(lines.map((l) => l.inventory_item_id).filter(Boolean))];
  const itemById = new Map();
  for (const slice of chunks(itemIds, 200)) {
    if (!slice.length) continue;
    const { data } = await admin.from("ip_item_master")
      .select("id, sku_code, style_code, size").in("id", slice);
    for (const it of data || []) itemById.set(it.id, it);
  }

  // 3. Avg cost per sku_code from ip_item_avg_cost, via the normalized-SKU RPC.
  // ip_item_avg_cost stores a punctuation-collapsed sku_code, so an exact .in()
  // match missed ~60% of lines; the RPC normalizes both sides (upper +
  // alphanumeric-only) so the cost resolves for ~89% of SKUs.
  const skus = [...new Set([...itemById.values()].map((it) => it.sku_code).filter(Boolean))];
  const costBySku = new Map();
  for (const slice of chunks(skus, 500)) {
    if (!slice.length) continue;
    const { data } = await admin.rpc("resolve_avg_cost_by_norm", { p_skus: slice });
    for (const r of data || []) {
      if (r.avg_cost != null && !costBySku.has(r.input_sku)) costBySku.set(r.input_sku, Math.round(Number(r.avg_cost) * 100));
    }
  }
  const costForSku = (sku) => (sku && costBySku.has(sku) ? costBySku.get(sku) : null);

  // 4. Qty-weighted aggregation per SO. styleFilter = case-insensitive substring
  // on style_code or sku_code; only narrows when it actually matches a line.
  const sf = (styleFilter || "").trim().toLowerCase();
  const matchesStyle = (it) => {
    if (!sf) return true;
    const sc = String(it?.style_code ?? "").toLowerCase();
    const sk = String(it?.sku_code ?? "").toLowerCase();
    return sc.includes(sf) || sk.includes(sf);
  };
  // Per-SO bucket: full + style-scoped accumulators.
  const buckets = new Map(); // so_id -> { qFull,sellFull,costFull,costQFull, qScoped,sellScoped,costScoped,costQScoped, anyScoped }
  const bucketFor = (id) => {
    let b = buckets.get(id);
    if (!b) { b = { qFull: 0, sellFull: 0, costFull: 0, costQFull: 0, qScoped: 0, sellScoped: 0, costScoped: 0, costQScoped: 0, anyScoped: false, explFull: 0, explScoped: 0 }; buckets.set(id, b); }
    return b;
  };
  for (const l of lines) {
    const qty = Number(l.qty_ordered) || 0;
    if (qty <= 0) continue;
    const unit = Number(l.unit_price_cents) || 0;
    const it = l.inventory_item_id ? itemById.get(l.inventory_item_id) : null;
    const cost = costForSku(it?.sku_code);
    const b = bucketFor(l.sales_order_id);
    // Exploded units: a PPK line stores PACKS at size = the pack token (PPK24);
    // exploded qty = packs × pack size. Non-PPK lines are already in eaches.
    const packSize = /PPK/i.test(String(it?.style_code ?? "")) ? (parseInt(String(it?.size ?? "").match(/(\d+)/)?.[1] ?? "1", 10) || 1) : 1;
    b.qFull += qty; b.sellFull += unit * qty; b.explFull += qty * packSize;
    if (cost != null) { b.costFull += cost * qty; b.costQFull += qty; }
    if (sf && matchesStyle(it)) {
      b.anyScoped = true;
      b.qScoped += qty; b.sellScoped += unit * qty; b.explScoped += qty * packSize;
      if (cost != null) { b.costScoped += cost * qty; b.costQScoped += qty; }
    }
  }
  for (const [id, b] of buckets) {
    const useScoped = sf && b.anyScoped;
    const q = useScoped ? b.qScoped : b.qFull;
    const sellSum = useScoped ? b.sellScoped : b.sellFull;
    const costSum = useScoped ? b.costScoped : b.costFull;
    const costQ = useScoped ? b.costQScoped : b.costQFull;
    const avg_sell_cents = q > 0 ? Math.round(sellSum / q) : null;
    const avg_cost_cents = costQ > 0 ? Math.round(costSum / costQ) : null;
    let margin_cents = null, margin_pct = null;
    if (avg_sell_cents != null && avg_cost_cents != null) {
      margin_cents = avg_sell_cents - avg_cost_cents;
      margin_pct = avg_sell_cents !== 0 ? Math.round((margin_cents / avg_sell_cents) * 1000) / 10 : null;
    }
    out.set(id, { avg_cost_cents, avg_sell_cents, margin_cents, margin_pct, total_qty: q, total_qty_exploded: useScoped ? b.explScoped : b.explFull });
  }
  return out;
}

const SELECT_COLS =
  "id, entity_id, brand_id, channel_id, customer_id, ship_to_location_id, so_number, " +
  "order_date, requested_ship_date, cancel_date, status, currency, payment_terms_id, " +
  "ar_account_id, revenue_account_id, notes, customer_po, customer_po_is_placeholder, is_bulk_order, subtotal_cents, total_cents, fulfillment_source, is_closeout, sale_store, " +
  "factor_approval_status, factor_reference, factor_approved_cents, buyer_id, " +
  "credit_approval_status, credit_hold_reason, amount_paid_cents, paid_in_full_at, " +
  "parent_sales_order_id, is_split_parent, created_at, updated_at";

export function validateInsert(body) {
  if (!body || typeof body !== "object") return { error: "body required" };
  if (!body.customer_id || !UUID_RE.test(String(body.customer_id))) {
    return { error: "customer_id (uuid) required" };
  }
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const normLines = [];
  let ln = 1;
  for (const l of lines) {
    const qty = Number(l.qty_ordered);
    if (!Number.isFinite(qty) || qty <= 0) continue; // skip empty/zero lines
    const unit = l.unit_price_cents == null || l.unit_price_cents === "" ? 0 : Math.round(Number(l.unit_price_cents));
    if (!Number.isFinite(unit) || unit < 0) return { error: `line ${ln}: unit_price_cents must be >= 0` };
    normLines.push({
      line_number: ln++,
      inventory_item_id: l.inventory_item_id && UUID_RE.test(String(l.inventory_item_id)) ? l.inventory_item_id : null,
      description: l.description ? String(l.description).trim() : null,
      qty_ordered: qty,
      unit_price_cents: unit,
      line_total_cents: Math.round(qty * unit),
      // Lot (grain: style+color). Set by customer PO (Scenario 3) or lot-aware
      // ATS allocation (Scenario 5); accepted here so callers can seed it.
      lot_number: l.lot_number != null && String(l.lot_number).trim() !== "" ? String(l.lot_number).trim() : null,
      // Item 9 — revenue_account_id is resolved server-side from the customer
      // (default_revenue_account_id) → entity default; NOT taken from the payload.
    });
  }
  if (normLines.length === 0) return { error: "at least one line with qty_ordered > 0 is required" };

  // Item 3 — factor / credit-insurance approval (manual).
  let factorStatus = "not_submitted";
  if (body.factor_approval_status != null && body.factor_approval_status !== "") {
    if (!FACTOR_STATUSES.includes(body.factor_approval_status)) {
      return { error: `factor_approval_status must be one of ${FACTOR_STATUSES.join(", ")}` };
    }
    factorStatus = body.factor_approval_status;
  }
  let factorApprovedCents = null;
  if (body.factor_approved_cents != null && body.factor_approved_cents !== "") {
    const n = typeof body.factor_approved_cents === "number" ? body.factor_approved_cents : parseInt(body.factor_approved_cents, 10);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { error: "factor_approved_cents must be a non-negative integer" };
    factorApprovedCents = n;
  }

  const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
  return {
    data: {
      customer_id: body.customer_id,
      buyer_id: nz("buyer_id"),
      ship_to_location_id: nz("ship_to_location_id"),
      brand_id: nz("brand_id"),
      channel_id: nz("channel_id"),
      order_date: /^\d{4}-\d{2}-\d{2}$/.test(body.order_date || "") ? body.order_date : null,
      requested_ship_date: /^\d{4}-\d{2}-\d{2}$/.test(body.requested_ship_date || "") ? body.requested_ship_date : null,
      cancel_date: /^\d{4}-\d{2}-\d{2}$/.test(body.cancel_date || "") ? body.cancel_date : null,
      payment_terms_id: nz("payment_terms_id"),
      ar_account_id: nz("ar_account_id"),
      revenue_account_id: nz("revenue_account_id"),
      notes: body.notes ? String(body.notes).trim() : null,
      customer_po: body.customer_po ? String(body.customer_po).trim() : null,
      sale_store: body.sale_store && String(body.sale_store).trim() ? String(body.sale_store).trim() : null,
      customer_po_is_placeholder: body.customer_po_is_placeholder === true,
      is_bulk_order: body.is_bulk_order === true,
      fulfillment_source: ["production", "ats"].includes(body.fulfillment_source) ? body.fulfillment_source : null,
      is_closeout: body.is_closeout === true || body.is_closeout === "true",
      factor_approval_status: factorStatus,
      factor_reference: body.factor_reference ? String(body.factor_reference).trim() : null,
      factor_approved_cents: factorApprovedCents,
      lines: normLines,
    },
  };
}

// Item 9 — resolve the revenue account to stamp on each SO line: the customer's
// default_revenue_account_id, else the entity default. Returns a uuid or null.
async function resolveLineRevenueAccount(admin, customerId, entity) {
  let acct = null;
  if (customerId) {
    const { data: cust } = await admin.from("customers").select("default_revenue_account_id").eq("id", customerId).maybeSingle();
    if (cust?.default_revenue_account_id) acct = cust.default_revenue_account_id;
  }
  if (!acct && entity?.default_revenue_account_id) acct = entity.default_revenue_account_id;
  return acct || null;
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

    // Facet: distinct selling-store list for the grid's Store filter dropdown.
    if (url.searchParams.get("facet") === "stores") {
      const { data: stores, error: stErr } = await admin.rpc("distinct_so_sale_stores", { p_entity_id: entity.id });
      if (stErr) return res.status(500).json({ error: stErr.message });
      return res.status(200).json((stores || []).map((r) => r.sale_store).filter(Boolean));
    }

    // Status may be a comma-separated list (multi-select grid filter); store is a
    // single selling-store value (Item 5).
    const statusRaw = (url.searchParams.get("status") || "").trim();
    const statuses = statusRaw ? statusRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const store = (url.searchParams.get("store") || "").trim();
    const customerId = (url.searchParams.get("customer_id") || "").trim();
    const q = (url.searchParams.get("q") || "").trim();
    const customerPo = (url.searchParams.get("customer_po") || "").trim();
    // Optional style scope for the per-SO cost/sell/margin aggregates. Accepts
    // either an explicit `style` param or `style_id` (resolved to a style_code);
    // when absent, the aggregates cover the whole SO.
    let styleFilter = (url.searchParams.get("style") || "").trim();

    // Duplicate-PO guard for the AI upload flow: return any non-cancelled SO that
    // already carries this exact customer PO # (case-insensitive), so the SO modal
    // can warn before creating a duplicate. Entity-scoped (a duplicate PO is a
    // duplicate regardless of the active brand/channel). Takes precedence over the
    // generic q/list path.
    if (customerPo) {
      // ilike for a loose, index-friendly fetch (and so case/whitespace differ),
      // then filter to an EXACT case-insensitive match in JS — ilike treats _ and
      // % as wildcards, so a PO like "PO_123" must not match "POX123".
      const esc = customerPo.replace(/[%_,()]/g, " ");
      const { data: dups, error: dupErr } = await admin
        .from("sales_orders")
        .select(SELECT_COLS)
        .eq("entity_id", entity.id)
        .neq("status", "cancelled")
        .ilike("customer_po", `%${esc}%`)
        .order("created_at", { ascending: false })
        .limit(50);
      if (dupErr) return res.status(500).json({ error: dupErr.message });
      const want = customerPo.toLowerCase().trim();
      const exact = (dups || []).filter((s) => String(s.customer_po || "").toLowerCase().trim() === want);
      return res.status(200).json(exact);
    }
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 500);
    // Pagination offset — the UI's "Export all" walks pages of `limit` rows
    // (offset 0, 500, 1000, …) so a download covers the whole filtered set, not
    // just the first page (operator item 17). The page size stays capped at 500.
    let offset = parseInt(url.searchParams.get("offset") || "0", 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    for (const s of statuses) {
      if (!STATUSES.includes(s)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    }

    const custId = customerId && UUID_RE.test(customerId) ? customerId : null;
    let data, error;
    if (q) {
      // All-field search (SO #, notes, customer name/code, and any line's
      // description / SKU sku_code / style_code / description) runs in the
      // search_sales_orders RPC so the line-level match never has to ship a
      // large id.in.(…) URL. NULL brand/channel = "all" unless enforcing.
      // p_offset is only sent when paging past the first page (Export all). It
      // defaults to 0 in the function, so omitting it keeps working in the brief
      // window between a deploy and the migration that adds the parameter.
      const rpcArgs = {
        p_entity_id: entity.id,
        p_q: q,
        p_status: statuses.length === 1 ? statuses[0] : null,
        p_customer_id: custId,
        p_brand_id: activeBrandId(req),
        p_channel_id: activeChannelId(req),
        p_limit: limit,
      };
      if (offset > 0) rpcArgs.p_offset = offset;
      ({ data, error } = await admin.rpc("search_sales_orders", rpcArgs));
    } else {
      let query = admin.from("sales_orders").select(SELECT_COLS)
        .eq("entity_id", entity.id)
        .order("order_date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      query = applyBrandScope(query, req);
      query = applyChannelScope(query, req);
      if (statuses.length === 1) query = query.eq("status", statuses[0]);
      else if (statuses.length > 1) query = query.in("status", statuses);
      if (store) query = query.eq("sale_store", store);
      if (custId) query = query.eq("customer_id", custId);
      ({ data, error } = await query);
    }
    if (error) return res.status(500).json({ error: error.message });

    let headers = data || [];
    // The search RPC can't express a multi-status set or the store filter, so
    // apply those client-side to the RPC result (Item 5 / Item 6).
    if (q) {
      if (statuses.length > 1) { const set = new Set(statuses); headers = headers.filter((h) => set.has(h.status)); }
      if (store) headers = headers.filter((h) => (h.sale_store || "") === store);
    }
    // Resolve a style_id → style_code so the style scope works from a drill too.
    if (!styleFilter) {
      const styleIdParam = (url.searchParams.get("style_id") || "").trim();
      if (styleIdParam && UUID_RE.test(styleIdParam)) {
        const { data: st } = await admin.from("style_master").select("style_code").eq("id", styleIdParam).maybeSingle();
        if (st?.style_code) styleFilter = st.style_code;
      }
    }
    // Attach per-SO Avg cost / Avg sell / Margin aggregates (style-scoped when a
    // style filter is active). Best-effort: never fail the list on metric errors.
    try {
      const metrics = await computeSoMetrics(admin, headers.map((h) => h.id), styleFilter);
      for (const h of headers) {
        const m = metrics.get(h.id) || { avg_cost_cents: null, avg_sell_cents: null, margin_cents: null, margin_pct: null, total_qty: null, total_qty_exploded: null };
        h.avg_cost_cents = m.avg_cost_cents;
        h.avg_sell_cents = m.avg_sell_cents;
        h.margin_cents = m.margin_cents;
        h.margin_pct = m.margin_pct;
        h.total_qty = m.total_qty;  // item 18 — total units across the SO's lines
        h.total_qty_exploded = m.total_qty_exploded;  // item 30 — PPK packs → units
      }
    } catch { /* leave metrics absent on failure */ }

    // Margin visibility gate (P14 `margins` capability). Defence-in-depth for
    // the UI column hiding: a non-granted caller never receives margin numbers.
    // Fail-open until RBAC_MODE=enforce, so a no-op today.
    const { canView: canViewMargins } = await resolveMarginAccess(req);
    if (!canViewMargins) {
      for (const h of headers) {
        delete h.margin_cents;
        delete h.margin_pct;
        delete h.total_margin_cents;
      }
    }

    return res.status(200).json(headers);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Optional buyer must belong to this SO's customer.
    if (v.data.buyer_id) {
      const { data: b } = await admin.from("customer_buyers").select("id, customer_id").eq("id", v.data.buyer_id).maybeSingle();
      if (!b) return res.status(400).json({ error: "buyer_id not found" });
      if (b.customer_id !== v.data.customer_id) return res.status(400).json({ error: "buyer_id must belong to the order's customer" });
    }

    const subtotal = v.data.lines.reduce((s, l) => s + l.line_total_cents, 0);
    const { data: header, error: hErr } = await admin.from("sales_orders").insert({
      entity_id: entity.id,
      customer_id: v.data.customer_id,
      buyer_id: v.data.buyer_id,
      ship_to_location_id: v.data.ship_to_location_id,
      brand_id: v.data.brand_id || undefined, // undefined → DB default rof_default_brand_id()
      channel_id: v.data.channel_id,
      order_date: v.data.order_date || undefined,
      requested_ship_date: v.data.requested_ship_date,
      cancel_date: v.data.cancel_date,
      status: "draft",
      payment_terms_id: v.data.payment_terms_id,
      ar_account_id: v.data.ar_account_id,
      revenue_account_id: v.data.revenue_account_id,
      notes: v.data.notes,
      customer_po: v.data.customer_po,
      sale_store: v.data.sale_store,
      customer_po_is_placeholder: v.data.customer_po_is_placeholder,
      is_bulk_order: v.data.is_bulk_order,
      fulfillment_source: v.data.fulfillment_source,
      is_closeout: v.data.is_closeout,
      factor_approval_status: v.data.factor_approval_status,
      factor_reference: v.data.factor_reference,
      factor_approved_cents: v.data.factor_approved_cents,
      subtotal_cents: subtotal,
      total_cents: subtotal,
    }).select(SELECT_COLS).single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    // Item 9 — auto-route revenue per customer master (entity default fallback).
    const lineRevenueAccountId = await resolveLineRevenueAccount(admin, v.data.customer_id, entity);
    const lineRows = v.data.lines.map((l) => ({ ...l, revenue_account_id: lineRevenueAccountId, sales_order_id: header.id }));
    const { error: lErr } = await admin.from("sales_order_lines").insert(lineRows);
    if (lErr) return res.status(500).json({ error: `Header saved (${header.id}) but lines failed: ${lErr.message}` });

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
