// api/internal/date-presets/[id]
//
// PATCH  — update a date_preset_master row (label, kind, n, sort_order, is_active).
// DELETE — hard-delete the preset.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const VALID_KINDS = new Set([
  "last_n_days", "last_n_months", "mtd", "ytd", "this_year", "last_year",
  "this_month", "last_month", "this_quarter", "last_quarter", "ty_to_last_month",
  "today", "yesterday",
]);
const N_KINDS = new Set(["last_n_days", "last_n_months"]);
const MUTABLE = new Set(["label", "kind", "n", "sort_order", "is_active"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const out = {};
    for (const [k, val] of Object.entries(body || {})) if (MUTABLE.has(k)) out[k] = val;
    if (out.label != null) { out.label = String(out.label).trim(); if (!out.label) return res.status(400).json({ error: "label cannot be empty" }); }
    if (out.kind != null && !VALID_KINDS.has(out.kind)) return res.status(400).json({ error: "invalid kind" });
    if ("n" in out) {
      if (out.n === "" || out.n == null) out.n = null;
      else { const n = parseInt(out.n, 10); out.n = Number.isInteger(n) && n > 0 ? n : null; }
    }
    // If the (resulting) kind needs n, enforce it.
    const effKind = out.kind ?? null;
    if (effKind && N_KINDS.has(effKind) && (out.n == null)) return res.status(400).json({ error: `n is required for ${effKind}` });
    if ("sort_order" in out) { const n = parseInt(out.sort_order, 10); out.sort_order = Number.isInteger(n) && n >= 0 ? n : 0; }
    if ("is_active" in out) out.is_active = out.is_active === true || out.is_active === "true" || out.is_active === 1;
    if (Object.keys(out).length === 0) return res.status(400).json({ error: "No mutable fields supplied" });

    const { data, error } = await admin.from("date_preset_master")
      .update({ ...out, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (error) { if (error.code === "PGRST116") return res.status(404).json({ error: "Preset not found" }); return res.status(500).json({ error: error.message }); }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("date_preset_master").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
