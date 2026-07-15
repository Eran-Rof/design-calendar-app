// api/internal/inventory-aging/layers
//
// Inventory Aging — per-grain FIFO layer drill. READ-ONLY.
// Given a grain row (group_by + grain_key) and the as-of date, returns the
// individual inventory_layers that make up that row via the inventory_aging_
// layers() RPC — which applies the SAME effective received-date (ATS last-
// receipt / receipts-history for mirrored xoro_rest_size layers) and effective
// cost (layer → avg_cost → item unit_cost) as the report, so the drill
// reconciles to the aggregate. Each layer carries its own age, on-hand, cost
// and value, plus an uncosted flag.
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
const GROUPS = new Set(["style", "style_color", "sku", "category", "warehouse", "vendor"]);

async function resolveEntityId(admin, req) {
  const hdr = (req.headers?.["x-entity-id"] || "").toString().trim();
  if (UUID_RE.test(hdr)) return hdr;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
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
  const groupBy = GROUPS.has((q.group_by || "").toString()) ? q.group_by.toString() : "style";
  const grainKey = (q.grain_key || "").toString();
  const asOf = DATE_RE.test((q.as_of || "").toString()) ? q.as_of.toString() : null;
  const includeZero = ["1", "true", "yes"].includes((q.include_zero || "").toString().toLowerCase());
  if (!grainKey) return res.status(400).json({ error: "grain_key required" });

  try {
    const entityId = await resolveEntityId(admin, req);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const { data, error } = await admin.rpc("inventory_aging_layers", {
      p_entity_id: entityId,
      p_group_by: groupBy,
      p_grain_key: grainKey,
      p_as_of: asOf,
      p_include_zero: includeZero,
    });
    if (error) throw new Error(error.message);

    const layers = (data || []).map((l) => ({
      id: l.layer_id,
      sku_code: l.sku_code,
      style_code: l.style_code,
      color: l.color,
      size: l.size,
      description: l.description,
      source_kind: l.source_kind,
      lot_number: l.lot_number,
      location_name: l.location_name,
      received_at: l.received_at,
      eff_received: l.eff_received,
      age_days: Number(l.age_days) || 0,
      remaining_qty: Number(l.remaining_qty) || 0,
      original_qty: Number(l.original_qty) || 0,
      unit_cost_cents: Number(l.unit_cost_cents) || 0,
      eff_unit_cost_cents: Number(l.eff_unit_cost_cents) || 0,
      is_uncosted: !!l.is_uncosted,
      value_cents: Number(l.value_cents) || 0,
    }));

    const items = new Set(layers.map((l) => l.sku_code || l.id));
    return res.status(200).json({ layers, item_count: items.size });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
