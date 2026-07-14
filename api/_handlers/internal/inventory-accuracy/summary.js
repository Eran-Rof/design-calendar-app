// api/internal/inventory-accuracy/summary
//
// Inventory On-Hand Accuracy panel — READ-ONLY. Returns:
//   { summary, rows, trend }
//     summary — inventory_onhand_accuracy_summary() rollup jsonb
//     rows    — v_inventory_onhand_reconcile, divergent SKUs only by default
//     trend   — inventory_onhand_accuracy_snapshot, last ~90 days
//
// Query params (all optional):
//   severity=minor|material|phantom_suspect   (default: all divergent, i.e. severity<>tie)
//   include_ties=1                             (also return the tied SKUs)
//   limit=<n>                                  (cap rows; default 2000)
//
// Nothing here mutates inventory. Paged past the PostgREST 1000-row cap.

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

async function pageAll(build, cap) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; from < cap; from += PAGE) {
    const to = Math.min(from + PAGE - 1, cap - 1);
    const { data, error } = await build(from, to);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
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
  const severity = (q.severity || "").toString().trim();
  const includeTies = ["1", "true", "yes"].includes((q.include_ties || "").toString().toLowerCase());
  const cap = Math.min(Math.max(parseInt((q.limit || "2000").toString(), 10) || 2000, 1), 20000);

  try {
    const { data: summary, error: sErr } = await admin.rpc("inventory_onhand_accuracy_summary");
    if (sErr) throw new Error(`summary rpc failed: ${sErr.message}`);

    const rows = await pageAll((from, to) => {
      let query = admin
        .from("v_inventory_onhand_reconcile")
        .select("item_id, sku_code, style_code, color, size, description, category_id, layers_qty, rest_qty, rest_covered, ats_qty, phantom_qty, divergence, abs_divergence, unit_cost_cents, divergence_value_cents, is_negative, is_zero_cost, is_phantom_suspect, severity")
        .order("abs_divergence", { ascending: false })
        .range(from, to);
      if (severity) query = query.eq("severity", severity);
      else if (!includeTies) query = query.neq("severity", "tie");
      return query;
    }, cap);

    const { data: trend, error: tErr } = await admin
      .from("inventory_onhand_accuracy_snapshot")
      .select("snapshot_date, skus_total, skus_divergent, skus_minor, skus_material, skus_phantom, sum_abs_units, exposure_cents, zero_cost_skus, negative_skus, layers_total_units, rest_total_units")
      .order("snapshot_date", { ascending: true })
      .limit(90);
    if (tErr) throw new Error(`trend read failed: ${tErr.message}`);

    return res.status(200).json({ summary, rows, trend: trend || [] });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
