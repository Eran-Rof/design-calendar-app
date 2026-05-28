// api/internal/crm/activities/:id
//
// PATCH — soft-hide / un-hide an activity row. Body: { is_hidden: boolean }.
//          ONLY is_hidden may be patched here (defense-in-depth — the DB
//          trigger crm_activities_immutability_trg from P8-1 also rejects
//          changes to any other column).
//
// No GET (use list endpoint).
// No DELETE (activity log is append-only; no role can delete activity rows).
//
// Tangerine P8-2 (arch §4).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({
      error: "Method not allowed. crm_activities is append-only — only PATCH is_hidden is permitted; no DELETE.",
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validatePatch(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: existing, error: fErr } = await admin
    .from("crm_activities")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (fErr) return res.status(500).json({ error: fErr.message });
  if (!existing) return res.status(404).json({ error: "Activity not found" });

  const { data: updated, error: upErr } = await admin
    .from("crm_activities")
    .update({ is_hidden: v.data.is_hidden })
    .eq("id", id)
    .select()
    .single();
  if (upErr) {
    // DB-trigger immutability rejection → 409
    if (/append-only|is_hidden may be toggled/i.test(upErr.message || "")) {
      return res.status(409).json({ error: upErr.message });
    }
    return res.status(500).json({ error: upErr.message });
  }
  return res.status(200).json(updated);
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function validatePatch(body) {
  // Reject any key other than is_hidden — defense in depth alongside the
  // P8-1 DB trigger.
  const keys = Object.keys(body);
  for (const k of keys) {
    if (k !== "is_hidden") {
      return { error: `${k} is not patchable on crm_activities; only is_hidden may be toggled` };
    }
  }
  if (!("is_hidden" in body)) {
    return { error: "is_hidden is required" };
  }
  if (typeof body.is_hidden !== "boolean") {
    return { error: "is_hidden must be a boolean" };
  }
  return { data: { is_hidden: body.is_hidden } };
}
