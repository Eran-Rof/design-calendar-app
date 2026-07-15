// api/internal/inventory-accuracy/perpetual-movements
//
// SHADOW perpetual ledger — per-SKU movement history drill. READ-ONLY.
// For one item_id returns the reconciliation row plus every event-ledger
// movement (the append-only inv_ledger_movements rows) so the panel can show
// the opening seed and each incremental movement that builds the perpetual
// on-hand. Locations resolved to code/name (no raw UUIDs surfaced).
//
//   GET ?item_id=<uuid>  ->  { row, movements }

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

  const itemId = (req.query?.item_id || "").toString().trim();
  if (!UUID_RE.test(itemId)) return res.status(400).json({ error: "item_id (uuid) required" });

  try {
    const { data: rowArr, error: rErr } = await admin
      .from("v_inv_perpetual_reconcile")
      .select("item_id, sku_code, style_code, color, size, description, perp_qty, layers_qty, rest_qty, rest_covered, opening_qty, incremental_moves, movement_count, size_grain_known, drift_vs_truth, drift_vs_layers, drift_value_cents, tracks_truth")
      .eq("item_id", itemId)
      .limit(1);
    if (rErr) throw new Error(rErr.message);
    const row = (rowArr || [])[0] || null;

    const { data: moves, error: mErr } = await admin
      .from("inv_ledger_movements")
      .select("movement_id, occurred_at, movement_type, qty_delta, size, size_grain_known, location_id, unit_cost_cents, source_table, notes")
      .eq("item_id", itemId)
      .order("occurred_at", { ascending: true });
    if (mErr) throw new Error(mErr.message);

    // Resolve location codes/names (no raw UUIDs surfaced to the UI).
    const locIds = [...new Set((moves || []).map((m) => m.location_id).filter(Boolean))];
    const locById = new Map();
    if (locIds.length) {
      const { data: locs } = await admin
        .from("inventory_locations")
        .select("id, code, name")
        .in("id", locIds);
      for (const l of locs || []) locById.set(l.id, l);
    }
    const movements = (moves || []).map((m) => {
      const loc = locById.get(m.location_id);
      const { location_id, ...rest } = m;
      return { ...rest, location_code: loc?.code || null, location_name: loc?.name || null };
    });

    return res.status(200).json({ row, movements });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
