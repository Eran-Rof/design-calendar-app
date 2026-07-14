// api/internal/inventory-accuracy/detail
//
// Inventory On-Hand Accuracy — per-SKU drill. READ-ONLY. For one item_id
// returns the reconciliation row plus the underlying FIFO layers (inventory_
// layers, by source_kind + warehouse) and the by-size REST snapshot rows, so
// the panel can show every feed side-by-side against the live layer stack.
//
//   GET ?item_id=<uuid>  ->  { row, layers, rest_rows }

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
      .from("v_inventory_onhand_reconcile")
      .select("item_id, sku_code, style_code, color, size, description, layers_qty, rest_qty, rest_covered, ats_qty, phantom_qty, divergence, abs_divergence, unit_cost_cents, divergence_value_cents, is_negative, is_zero_cost, is_phantom_suspect, severity")
      .eq("item_id", itemId)
      .limit(1);
    if (rErr) throw new Error(rErr.message);
    const row = (rowArr || [])[0] || null;

    const { data: layers, error: lErr } = await admin
      .from("inventory_layers")
      .select("id, source_kind, location_id, remaining_qty, original_qty, unit_cost_cents, received_at, notes")
      .eq("item_id", itemId)
      .order("received_at", { ascending: true });
    if (lErr) throw new Error(lErr.message);

    // Resolve location codes/names (no raw UUIDs surfaced to the UI).
    const locIds = [...new Set((layers || []).map((l) => l.location_id).filter(Boolean))];
    const locById = new Map();
    if (locIds.length) {
      const { data: locs } = await admin
        .from("inventory_locations")
        .select("id, code, name")
        .in("id", locIds);
      for (const l of locs || []) locById.set(l.id, l);
    }
    const layersOut = (layers || []).map((l) => {
      const loc = locById.get(l.location_id);
      const { location_id, ...rest } = l;
      return { ...rest, location_code: loc?.code || null, location_name: loc?.name || null };
    });

    const { data: restRows, error: sErr } = await admin
      .from("tangerine_size_onhand")
      .select("warehouse_code, snapshot_date, qty_on_hand, source")
      .eq("item_id", itemId)
      .order("snapshot_date", { ascending: false })
      .limit(50);
    if (sErr) throw new Error(sErr.message);

    return res.status(200).json({ row, layers: layersOut, rest_rows: restRows || [] });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
