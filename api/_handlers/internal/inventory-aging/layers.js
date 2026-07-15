// api/internal/inventory-aging/layers
//
// Inventory Aging — per-grain FIFO layer drill. READ-ONLY.
// Given a grain row (group_by + grain_key) and the as-of date, returns the
// individual inventory_layers that make up that row, each with its own age,
// on-hand qty, unit cost and value — the "why is this aged" evidence behind an
// aggregate. Same as-of semantics as the report (received_at ≤ as_of).
//
//   GET ?group_by=style&grain_key=STYLE123&as_of=YYYY-MM-DD
//        [&include_zero=1]  ->  { layers, item_count }

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 60 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function resolveEntityId(admin, req) {
  const hdr = (req.headers?.["x-entity-id"] || "").toString().trim();
  if (UUID_RE.test(hdr)) return hdr;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

function ageDays(receivedISO, asOfISO) {
  const r = Date.parse((receivedISO || "").slice(0, 10) + "T00:00:00Z");
  const a = Date.parse(asOfISO + "T00:00:00Z");
  if (!Number.isFinite(r) || !Number.isFinite(a)) return 0;
  const d = Math.floor((a - r) / 86400000);
  return d < 0 ? 0 : d;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const q = req.query || {};
  const groupBy = (q.group_by || "style").toString();
  const grainKey = (q.grain_key || "").toString();
  const asOf = DATE_RE.test((q.as_of || "").toString()) ? q.as_of.toString() : new Date(Date.now()).toISOString().slice(0, 10);
  const includeZero = ["1", "true", "yes"].includes((q.include_zero || "").toString().toLowerCase());
  if (!grainKey) return res.status(400).json({ error: "grain_key required" });

  try {
    const entityId = await resolveEntityId(admin, req);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    // Which items belong to this grain
    let itemQuery = admin.from("ip_item_master").select("id, sku_code, style_code, color, size, gender_code, description, category_id, vendor_id, brand_id");
    let locationFilter = null;
    switch (groupBy) {
      case "style":
        itemQuery = itemQuery.eq("style_code", grainKey);
        break;
      case "style_color": {
        const [style, color] = grainKey.split("|");
        itemQuery = itemQuery.eq("style_code", style || "");
        itemQuery = color ? itemQuery.eq("color", color) : itemQuery.is("color", null);
        break;
      }
      case "sku":
        if (!UUID_RE.test(grainKey)) return res.status(400).json({ error: "sku grain_key must be item uuid" });
        itemQuery = itemQuery.eq("id", grainKey);
        break;
      case "category":
        if (UUID_RE.test(grainKey)) itemQuery = itemQuery.eq("category_id", grainKey);
        else itemQuery = itemQuery.is("category_id", null);
        break;
      case "vendor":
        if (UUID_RE.test(grainKey)) itemQuery = itemQuery.eq("vendor_id", grainKey);
        else itemQuery = itemQuery.is("vendor_id", null);
        break;
      case "warehouse":
        locationFilter = UUID_RE.test(grainKey) ? grainKey : "__none__";
        break;
      default:
        itemQuery = itemQuery.eq("style_code", grainKey);
    }

    let itemMap = new Map();
    let itemIds = [];
    if (groupBy !== "warehouse") {
      const { data: items, error: iErr } = await itemQuery.limit(5000);
      if (iErr) throw new Error(iErr.message);
      itemMap = new Map((items || []).map((r) => [r.id, r]));
      itemIds = (items || []).map((r) => r.id);
      if (!itemIds.length) return res.status(200).json({ layers: [], item_count: 0 });
    }

    let layerQuery = admin
      .from("inventory_layers")
      .select("id, item_id, location_id, source_kind, remaining_qty, original_qty, unit_cost_cents, received_at, lot_number")
      .eq("entity_id", entityId)
      .lte("received_at", asOf + "T23:59:59Z")
      .order("received_at", { ascending: true })
      .limit(5000);
    if (!includeZero) layerQuery = layerQuery.gt("remaining_qty", 0);
    if (groupBy === "warehouse") {
      if (locationFilter === "__none__") layerQuery = layerQuery.is("location_id", null);
      else layerQuery = layerQuery.eq("location_id", locationFilter);
    } else {
      layerQuery = layerQuery.in("item_id", itemIds);
    }

    const { data: layers, error: lErr } = await layerQuery;
    if (lErr) throw new Error(lErr.message);

    // hydrate item info for warehouse grain (items not pre-loaded)
    if (groupBy === "warehouse") {
      const ids = Array.from(new Set((layers || []).map((l) => l.item_id)));
      if (ids.length) {
        const { data: items } = await admin
          .from("ip_item_master")
          .select("id, sku_code, style_code, color, size, gender_code, description")
          .in("id", ids);
        itemMap = new Map((items || []).map((r) => [r.id, r]));
      }
    }

    // resolve location names
    const locIds = Array.from(new Set((layers || []).map((l) => l.location_id).filter(Boolean)));
    let locMap = new Map();
    if (locIds.length) {
      const { data: locs } = await admin.from("inventory_locations").select("id, name, code").in("id", locIds);
      locMap = new Map((locs || []).map((r) => [r.id, r]));
    }

    const out = (layers || []).map((l) => {
      const im = itemMap.get(l.item_id) || {};
      const loc = locMap.get(l.location_id) || {};
      const age = ageDays(l.received_at, asOf);
      const qty = Number(l.remaining_qty) || 0;
      const unit = Number(l.unit_cost_cents) || 0;
      return {
        id: l.id,
        sku_code: im.sku_code || null,
        style_code: im.style_code || null,
        color: im.color || null,
        size: im.size || null,
        description: im.description || null,
        source_kind: l.source_kind || null,
        lot_number: l.lot_number || null,
        location_name: loc.name || null,
        received_at: l.received_at || null,
        age_days: age,
        remaining_qty: qty,
        original_qty: Number(l.original_qty) || 0,
        unit_cost_cents: unit,
        value_cents: qty * unit,
      };
    }).sort((a, b) => b.age_days - a.age_days);

    return res.status(200).json({ layers: out, item_count: groupBy === "warehouse" ? itemMap.size : itemIds.length });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
