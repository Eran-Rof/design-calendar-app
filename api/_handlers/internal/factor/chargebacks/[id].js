// api/internal/factor/chargebacks/:id
//
// Factor Module Phase 2 — PATCH the dispute-workflow columns on one
// factor_chargebacks row: { status?, notes? }.
//
// Every status change is APPENDED to status_history ({at, by, from, to,
// note}) — an updated_by audit trail in the T11 spirit (factor_chargebacks
// is not in the T11-1 row_changes allowlist; the history column keeps the
// trail self-contained). updated_by resolves from the X-Auth-User-Id header
// the frontend interceptor injects (falls back to "internal").
//
// The importer NEVER writes these columns, so operator dispute state
// survives re-imports.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { CB_STATUSES } from "./index.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") return { error: "Request body must be an object" };
  const out = {};
  if ("status" in body) {
    if (!CB_STATUSES.includes(body.status)) {
      return { error: `status must be one of ${CB_STATUSES.join(", ")}` };
    }
    out.status = body.status;
  }
  if ("notes" in body) {
    const n = body.notes;
    out.notes = n == null || String(n).trim() === "" ? null : String(n).trim();
  }
  if (!Object.keys(out).length) return { error: "Nothing to update (status and/or notes)" };
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const id = (req.query?.id || "").toString().trim();
  if (!id) return res.status(400).json({ error: "id required" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validatePatch(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const { data: row, error: readErr } = await admin
    .from("factor_chargebacks")
    .select("id, status, notes, status_history")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!row) return res.status(404).json({ error: "Chargeback not found" });

  const by = (req.headers?.["x-auth-user-id"] || "").toString().trim() || "internal";
  const now = new Date().toISOString();
  const update = { ...v.data, updated_by: by, updated_at: now };

  if (v.data.status && v.data.status !== row.status) {
    const history = Array.isArray(row.status_history) ? row.status_history : [];
    update.status_history = [
      ...history,
      { at: now, by, from: row.status, to: v.data.status, note: v.data.notes ?? row.notes ?? null },
    ];
  }

  const { data: updated, error: updErr } = await admin
    .from("factor_chargebacks")
    .update(update)
    .eq("id", id)
    .select("id, status, notes, status_history, updated_by, updated_at")
    .single();
  if (updErr) return res.status(500).json({ error: updErr.message });

  return res.status(200).json(updated);
}
