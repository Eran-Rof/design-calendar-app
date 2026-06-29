// api/internal/allocations
//
// P16 / M18 — Allocations Workbench data + write.
//
// GET  ?q=&customer_id=&brand_id=&channel_id=&only_short=  →
//        { demand: [v_allocation_demand rows], availability: [{item_id,on_hand_qty,
//          reserved_qty,available_qty}] } for the default (ROF) entity. The client
//        joins demand→availability by item_id and groups by style/color → SKU.
//
// GET  ?so=<SO number or uuid>&include_all=1  →  show-all-rows mode. When the
//        workbench is focused on ONE sales order (the SO→Allocations deep link),
//        v_allocation_demand hides terminal lines (the view excludes shipped /
//        invoiced lines and shipped/invoiced/closed/cancelled SOs). That made a
//        focused SO look "open-only" even with the filter off. With include_all=1
//        and a single SO in focus, we read that SO's FULL line set straight from
//        sales_order_lines (+ customer + item master), bypassing the view's
//        terminal exclusions, and shape each row exactly like a v_allocation_demand
//        row so the client renders them identically.
// POST { allocations: [{ line_id, qty }] }  →  apply_allocations RPC.
//        Absolute SET of qty_allocated per line (0 releases). Returns
//        { applied, skipped:[{line_id,reason}], message }. Used by both manual
//        cell edits and the Auto-allocate run (which previews via ./preview).
//
// anon-read RLS; writes via service-role. q is an all-field search — matches
// sku_code / style description / SO number / color / size / customer name
// (case-insensitive).

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope, applyChannelScope } from "../../../_lib/brandContext.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Brand-ID, X-Channel-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

// Show-all-rows: read EVERY line of one focused SO straight from the base tables
// (not v_allocation_demand, which hides shipped/invoiced lines + terminal SOs),
// then shape each row exactly like a v_allocation_demand row so the client treats
// them the same. Returns { demand, availability } or null to fall through.
async function fetchFocusedSoLines(admin, entityId, soParam, onlyShort) {
  // Resolve the SO by uuid or SO number.
  let soQ = admin.from("sales_orders")
    .select("id, so_number, order_date, requested_ship_date, cancel_date, status, customer_id, factor_approval_status, factor_reference, factor_approved_cents, brand_id, channel_id")
    .eq("entity_id", entityId);
  soQ = UUID_RE.test(soParam) ? soQ.eq("id", soParam) : soQ.eq("so_number", soParam);
  const { data: so, error: soErr } = await soQ.maybeSingle();
  if (soErr || !so) return null; // fall through to the view path

  // Customer (factor / card signal).
  let customer = null;
  if (so.customer_id) {
    const { data: c } = await admin.from("customers")
      .select("name, is_factored, payment_processor, processor_payment_method_id, processor_card_last4")
      .eq("id", so.customer_id).maybeSingle();
    customer = c || null;
  }
  const hasCard = !!(customer && (customer.payment_processor || customer.processor_payment_method_id || customer.processor_card_last4));

  // Every line of this SO (no terminal-state exclusion).
  const { data: lines, error: lErr } = await admin.from("sales_order_lines")
    .select("id, inventory_item_id, qty_ordered, qty_allocated, qty_shipped, unit_price_cents, description, status")
    .eq("sales_order_id", so.id).order("line_number", { ascending: true });
  if (lErr) return null;

  const itemIds = [...new Set((lines || []).map((l) => l.inventory_item_id).filter(Boolean))];
  let skuById = new Map();
  if (itemIds.length) {
    const { data: skus } = await admin.from("ip_item_master").select("id, sku_code, color, size, description").in("id", itemIds);
    skuById = new Map((skus || []).map((s) => [s.id, s]));
  }

  const demand = (lines || [])
    .filter((l) => l.inventory_item_id)
    .map((l) => {
      const s = skuById.get(l.inventory_item_id) || {};
      return {
        line_id: l.id, so_id: so.id, so_number: so.so_number, entity_id: entityId,
        order_date: so.order_date, requested_ship_date: so.requested_ship_date, cancel_date: so.cancel_date,
        so_status: so.status, customer_id: so.customer_id, customer_name: customer?.name ?? null,
        is_factored: !!customer?.is_factored, factor_approval_status: so.factor_approval_status,
        factor_reference: so.factor_reference, factor_approved_cents: so.factor_approved_cents,
        has_card: hasCard, item_id: l.inventory_item_id, sku_code: s.sku_code ?? null,
        color: s.color ?? null, size: s.size ?? null, description: s.description ?? l.description ?? null,
        qty_ordered: l.qty_ordered, qty_allocated: l.qty_allocated, qty_shipped: l.qty_shipped,
        open_qty: Number(l.qty_ordered) - Number(l.qty_allocated), unit_price_cents: l.unit_price_cents,
        brand_id: so.brand_id, channel_id: so.channel_id,
      };
    })
    .filter((d) => !onlyShort || Number(d.open_qty) > 0);

  // Availability for the items present.
  let availability = [];
  if (itemIds.length) {
    const { data: av } = await admin.from("v_inventory_available")
      .select("item_id, on_hand_qty, reserved_qty, available_qty")
      .eq("entity_id", entityId).in("item_id", itemIds);
    availability = av || [];
  }
  return { demand, availability, focused_so: so.so_number || null, focused_all: true };
}

const DEMAND_COLS =
  "line_id, so_id, so_number, entity_id, order_date, requested_ship_date, cancel_date, so_status, " +
  "customer_id, customer_name, is_factored, factor_approval_status, factor_reference, " +
  "factor_approved_cents, has_card, item_id, sku_code, color, size, description, " +
  "qty_ordered, qty_allocated, qty_shipped, open_qty, unit_price_cents, brand_id, channel_id";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const q = (url.searchParams.get("q") || "").trim();
    const customerId = (url.searchParams.get("customer_id") || "").trim();
    const onlyShort = url.searchParams.get("only_short") === "1" || url.searchParams.get("only_short") === "true";
    const includeAll = url.searchParams.get("include_all") === "1" || url.searchParams.get("include_all") === "true";
    const soParam = (url.searchParams.get("so") || url.searchParams.get("so_id") || "").trim();

    // Show-all-rows mode — focus on ONE sales order and return ALL its lines
    // (including terminal ones the demand view hides). Resolve the SO by number
    // or uuid, then read its full line set directly. Falls through to the normal
    // view path if the SO can't be uniquely resolved.
    if (includeAll && soParam) {
      const focusOut = await fetchFocusedSoLines(admin, entityId, soParam, onlyShort);
      if (focusOut) return res.status(200).json(focusOut);
    }

    let query = admin.from("v_allocation_demand").select(DEMAND_COLS)
      .eq("entity_id", entityId)
      .order("sku_code", { ascending: true })
      .order("requested_ship_date", { ascending: true, nullsFirst: false })
      .order("order_date", { ascending: true });
    query = applyBrandScope(query, req);
    query = applyChannelScope(query, req);
    if (customerId && UUID_RE.test(customerId)) query = query.eq("customer_id", customerId);
    if (onlyShort) query = query.gt("open_qty", 0);
    if (q) query = query.or(`sku_code.ilike.%${q}%,description.ilike.%${q}%,so_number.ilike.%${q}%,color.ilike.%${q}%,size.ilike.%${q}%,customer_name.ilike.%${q}%`);

    const { data: demand, error } = await query.limit(2000);
    if (error) return res.status(500).json({ error: error.message });

    // Availability for just the items present in the demand set.
    const itemIds = [...new Set((demand || []).map((d) => d.item_id).filter(Boolean))];
    let availability = [];
    if (itemIds.length) {
      const { data: av, error: avErr } = await admin
        .from("v_inventory_available")
        .select("item_id, on_hand_qty, reserved_qty, available_qty")
        .eq("entity_id", entityId)
        .in("item_id", itemIds);
      if (avErr) return res.status(500).json({ error: avErr.message });
      availability = av || [];
    }
    return res.status(200).json({ demand: demand || [], availability });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const raw = Array.isArray(body?.allocations) ? body.allocations : null;
    if (!raw || raw.length === 0) return res.status(400).json({ error: "allocations [{line_id, qty}] required" });

    const allocations = [];
    for (const a of raw) {
      if (!a || !UUID_RE.test(String(a.line_id || ""))) return res.status(400).json({ error: "each allocation needs a valid line_id (uuid)" });
      const qty = Number(a.qty);
      if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: `qty for line ${a.line_id} must be >= 0` });
      allocations.push({ line_id: String(a.line_id), qty });
    }
    const actor = body?.created_by_user_id && UUID_RE.test(String(body.created_by_user_id)) ? String(body.created_by_user_id) : null;

    const { data, error } = await admin.rpc("apply_allocations", { p_allocations: allocations, p_user_id: actor });
    if (error) return res.status(500).json({ error: error.message });

    const applied = Array.isArray(data?.applied) ? data.applied : [];
    const skipped = Array.isArray(data?.skipped) ? data.skipped : [];
    const message = skipped.length
      ? `Allocated ${applied.length} line(s); ${skipped.length} skipped.`
      : `Allocated ${applied.length} line(s).`;
    return res.status(200).json({ ...data, message });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
