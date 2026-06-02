// api/internal/allocations
//
// P16 / M18 — Allocations Workbench data + write.
//
// GET  ?q=&customer_id=&brand_id=&channel_id=&only_short=  →
//        { demand: [v_allocation_demand rows], availability: [{item_id,on_hand_qty,
//          reserved_qty,available_qty}] } for the default (ROF) entity. The client
//        joins demand→availability by item_id and groups by style/color → SKU.
// POST { allocations: [{ line_id, qty }] }  →  apply_allocations RPC.
//        Absolute SET of qty_allocated per line (0 releases). Returns
//        { applied, skipped:[{line_id,reason}], message }. Used by both manual
//        cell edits and the Auto-allocate run (which previews via ./preview).
//
// anon-read RLS; writes via service-role. q matches sku_code / style description
// / SO number (case-insensitive).

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

const DEMAND_COLS =
  "line_id, so_id, so_number, entity_id, order_date, requested_ship_date, so_status, " +
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

    let query = admin.from("v_allocation_demand").select(DEMAND_COLS)
      .eq("entity_id", entityId)
      .order("sku_code", { ascending: true })
      .order("requested_ship_date", { ascending: true, nullsFirst: false })
      .order("order_date", { ascending: true });
    query = applyBrandScope(query, req);
    query = applyChannelScope(query, req);
    if (customerId && UUID_RE.test(customerId)) query = query.eq("customer_id", customerId);
    if (onlyShort) query = query.gt("open_qty", 0);
    if (q) query = query.or(`sku_code.ilike.%${q}%,description.ilike.%${q}%,so_number.ilike.%${q}%,color.ilike.%${q}%`);

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
