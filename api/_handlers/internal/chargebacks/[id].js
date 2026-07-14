// api/internal/chargebacks/:id
//
// Chargeback Management (#1744) — PATCH the management columns on one
// factor_chargebacks row:
//   { disposition?, disposition_reason?, owner?, reason_code_id?, matched_ar_invoice_id? }
//
// A disposition CHANGE REQUIRES a disposition_reason note (house rule) and is
// appended to status_history in the T11 spirit ({at, by, field:'disposition',
// from, to, note}). factor_chargebacks is not in the T11-1 row_changes
// allowlist, so the self-contained history column carries the audit trail —
// the same pattern as the Factor-Recon chargeback PATCH. The importer never
// writes these columns, so operator state survives re-imports.
//
// A manual invoice link sets match_method='manual', which the auto-match
// migration never clobbers. Passing matched_ar_invoice_id:null clears the link.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { DISPOSITIONS } from "./index.js";

export const config = { maxDuration: 15 };

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

export function validatePatch(body) {
  if (body == null || typeof body !== "object") return { error: "Request body must be an object" };
  const out = {};
  if ("disposition" in body) {
    if (!DISPOSITIONS.includes(body.disposition)) {
      return { error: `disposition must be one of ${DISPOSITIONS.join(", ")}` };
    }
    out.disposition = body.disposition;
  }
  if ("disposition_reason" in body) {
    const n = body.disposition_reason;
    out.disposition_reason = n == null || String(n).trim() === "" ? null : String(n).trim();
  }
  if ("owner" in body) {
    const n = body.owner;
    out.owner = n == null || String(n).trim() === "" ? null : String(n).trim();
  }
  if ("reason_code_id" in body) {
    const v = body.reason_code_id;
    if (v != null && !UUID_RE.test(String(v))) return { error: "reason_code_id must be a uuid or null" };
    out.reason_code_id = v == null ? null : String(v);
  }
  if ("matched_ar_invoice_id" in body) {
    const v = body.matched_ar_invoice_id;
    if (v != null && !UUID_RE.test(String(v))) return { error: "matched_ar_invoice_id must be a uuid or null" };
    out.matched_ar_invoice_id = v == null ? null : String(v);
  }
  if (!Object.keys(out).length) return { error: "Nothing to update" };
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
    .select("id, disposition, disposition_reason, owner, reason_code_id, matched_ar_invoice_id, match_method, status_history")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!row) return res.status(404).json({ error: "Chargeback not found" });

  const changingDisposition = "disposition" in v.data && v.data.disposition !== row.disposition;
  // House rule: a disposition change requires a reason note.
  if (changingDisposition) {
    const note = "disposition_reason" in v.data ? v.data.disposition_reason : row.disposition_reason;
    if (!note) return res.status(400).json({ error: "A disposition_reason note is required to change disposition" });
  }

  const by = (req.headers?.["x-auth-user-id"] || "").toString().trim() || "internal";
  const now = new Date().toISOString();
  const update = { ...v.data, updated_by: by, updated_at: now };

  if (changingDisposition) {
    update.disposition_at = now;
    const history = Array.isArray(row.status_history) ? row.status_history : [];
    update.status_history = [
      ...history,
      {
        at: now, by, field: "disposition",
        from: row.disposition, to: v.data.disposition,
        note: ("disposition_reason" in v.data ? v.data.disposition_reason : row.disposition_reason) ?? null,
      },
    ];
  }
  // A hand-set invoice link is 'manual' (auto-match never clobbers it);
  // clearing the link resets match_method to null.
  if ("matched_ar_invoice_id" in v.data) {
    update.match_method = v.data.matched_ar_invoice_id == null ? null : "manual";
  }

  const { data: updated, error: updErr } = await admin
    .from("factor_chargebacks")
    .update(update)
    .eq("id", id)
    .select("id, disposition, disposition_reason, owner, reason_code_id, matched_ar_invoice_id, match_method, disposition_at, status_history, updated_by, updated_at")
    .single();
  if (updErr) return res.status(500).json({ error: updErr.message });

  return res.status(200).json(updated);
}
