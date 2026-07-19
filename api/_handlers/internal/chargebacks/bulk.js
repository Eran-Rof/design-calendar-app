// api/internal/chargebacks/bulk
//
// Chargeback Management (#1744) — bulk reason-coding. PATCH a governed
// reason_code_id onto many factor_chargebacks rows at once from the worklist's
// multi-select, so the ~$740K un-coded backlog can be classified in batches
// instead of one PATCH per row.
//
// PATCH /api/internal/chargebacks/bulk
//   { ids: [uuid, …]  (1..500), reason_code_id: uuid | null }
//   reason_code_id must exist in chargeback_reason_codes, or null to un-code.
//   Response: { updated } — the number of rows actually re-coded.
//
// HOUSE RULES:
//   • Factor-churn rows (reason_code 610 / "Manual Charge Back") are NEVER
//     coded — they are intentionally excluded from dilution — so a non-null
//     coding update skips them server-side even if selected.
//   • reason_code_id is a management column the importer never writes, so
//     operator state survives re-imports; this writer only touches the selected
//     ids (parameterised .in()).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 30 };

export const BULK_MAX_IDS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Validate a bulk-coding request body. Returns { data: { ids, reason_code_id } }
 * or { error }. Pure — shared with the assistant bulk-coding action so the two
 * enforce the exact same rules.
 */
export function validateBulkCoding(body) {
  if (body == null || typeof body !== "object") return { error: "Request body must be an object" };
  const { ids, reason_code_id } = body;
  if (!Array.isArray(ids) || ids.length === 0) return { error: "ids must be a non-empty array" };
  if (ids.length > BULK_MAX_IDS) return { error: `ids may contain at most ${BULK_MAX_IDS} rows` };
  const clean = [];
  const seen = new Set();
  for (const id of ids) {
    const s = String(id || "").trim();
    if (!UUID_RE.test(s)) return { error: "every id must be a uuid" };
    if (!seen.has(s)) { seen.add(s); clean.push(s); }
  }
  if (!("reason_code_id" in body)) return { error: "reason_code_id is required (uuid to code, or null to un-code)" };
  let rc = reason_code_id;
  if (rc != null) {
    rc = String(rc).trim();
    if (!UUID_RE.test(rc)) return { error: "reason_code_id must be a uuid or null" };
  } else {
    rc = null;
  }
  return { data: { ids: clean, reason_code_id: rc } };
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

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBulkCoding(body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const { ids, reason_code_id } = v.data;

  try {
    // A non-null code must reference a real governed reason code.
    if (reason_code_id != null) {
      const { data: rc, error: rcErr } = await admin
        .from("chargeback_reason_codes")
        .select("id")
        .eq("id", reason_code_id)
        .maybeSingle();
      if (rcErr) return res.status(500).json({ error: rcErr.message });
      if (!rc) return res.status(400).json({ error: "reason_code_id does not exist" });
    }

    const by = (req.headers?.["x-auth-user-id"] || "").toString().trim() || "internal";
    const now = new Date().toISOString();

    let query = admin
      .from("factor_chargebacks")
      .update({ reason_code_id, updated_by: by, updated_at: now })
      .in("id", ids);
    // Never code factor churn (610 / "Manual Charge Back"). Un-coding (null) is
    // harmless on churn rows (already null), so the guard applies only when
    // setting a code.
    if (reason_code_id != null) {
      query = query.not("reason_code", "eq", "610").not("reason", "ilike", "%manual charge back%");
    }

    const { data, error } = await query.select("id");
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ updated: (data || []).length });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
