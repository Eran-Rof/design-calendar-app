// api/internal/three-way-match/tolerances
//
// 3-Way Match module — GET the tolerance config row / PATCH to change it.
// Defaults: qty +/-2%, price +/-1% or $50, amount $100, fuzzy window
// -180/+30 days. A PATCH does NOT re-run the engine; the panel offers the
// explicit "Re-run engine" action (and the nightly cron picks it up anyway).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const NUMERIC_FIELDS = [
  "qty_tol_pct", "price_tol_pct", "price_tol_abs_cents", "amount_tol_abs_cents",
  "fuzzy_amount_tol_pct", "fuzzy_amount_tol_abs_cents",
  "fuzzy_date_back_days", "fuzzy_date_fwd_days",
];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") return { error: "Request body must be an object" };
  const out = {};
  for (const f of NUMERIC_FIELDS) {
    if (!(f in body)) continue;
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n < 0) return { error: `${f} must be a non-negative number` };
    out[f] = f.endsWith("_cents") || f.endsWith("_days") ? Math.round(n) : n;
  }
  if (!Object.keys(out).length) return { error: "Nothing to update" };
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("ap_match_tolerances").select("*")
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || null);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const { data: row, error: readErr } = await admin
      .from("ap_match_tolerances").select("id")
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!row) return res.status(404).json({ error: "Tolerance config row not found" });

    const by = (req.headers?.["x-auth-user-id"] || "").toString().trim() || "internal";
    const { data, error } = await admin
      .from("ap_match_tolerances")
      .update({ ...v.data, updated_by: by, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
