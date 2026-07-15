// api/internal/inventory-accuracy/perpetual
//
// SHADOW perpetual inventory ledger (Cutover Phase 2) — READ-ONLY. Returns:
//   { summary, rows }
//     summary — inv_perpetual_readiness_summary() rollup jsonb
//               (readiness_pct, perp/rest/layers totals, Σ|drift|, coverage)
//     rows    — v_inv_perpetual_reconcile: per-SKU perpetual vs live layers vs
//               xoro_rest truth, with signed drift + tracks_truth
//
// Query params (all optional):
//   drift_only=1   only rows that do NOT track truth (|perp-truth| >= 0.5)
//   limit=<n>      cap rows (default 3000)
//
// This is a PARALLEL / pre-cutover measurement surface. It mutates nothing —
// the perpetual is Σ of an append-only event ledger, not the live on-hand.
// Paged past the PostgREST 1000-row cap.

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
  const driftOnly = ["1", "true", "yes"].includes((q.drift_only || "").toString().toLowerCase());
  const cap = Math.min(Math.max(parseInt((q.limit || "3000").toString(), 10) || 3000, 1), 20000);

  try {
    const { data: summary, error: sErr } = await admin.rpc("inv_perpetual_readiness_summary");
    if (sErr) throw new Error(`readiness rpc failed: ${sErr.message}`);

    const rows = await pageAll((from, to) => {
      let query = admin
        .from("v_inv_perpetual_reconcile")
        .select("item_id, sku_code, style_code, color, size, description, perp_qty, layers_qty, rest_qty, rest_covered, opening_qty, incremental_moves, movement_count, size_grain_known, last_movement_at, drift_vs_truth, abs_drift_vs_truth, drift_vs_layers, abs_drift_vs_layers, unit_cost_cents, drift_value_cents, tracks_truth")
        .order("abs_drift_vs_truth", { ascending: false })
        .range(from, to);
      if (driftOnly) query = query.eq("tracks_truth", false);
      return query;
    }, cap);

    return res.status(200).json({ summary, rows });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
