// api/internal/recon/variances/:id/clear
//
// Tangerine P9-7 — manually clear a recon variance.
//
//   POST /api/internal/recon/variances/:id/clear
//     body: { reason: <required, non-empty string> }
//
// Side effects:
//   1. INSERT into recon_cleared_log (recon_variance_id, reason,
//      cleared_at = now(), cleared_by_auth_id) — audit trail. The
//      audit reason is REQUIRED per the P9-1 schema (NOT NULL).
//   2. UPDATE recon_variances SET status='cleared' WHERE id = :id.
//
// Returns 200 with the cleared variance + the new cleared_log row.
//
// Validation:
//   - :id must be a uuid
//   - reason must be a non-empty string (trim != "")
//   - reason caps at 2000 chars (defensive against accidental paste)
//
// 401 / 400 / 404 / 409 / 500.
//   - 404 if the variance id doesn't exist
//   - 409 if the variance is already 'cleared' (idempotent guard)

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_REASON_LEN = 2000;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Internal-Token, X-Entity-ID",
  );
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Pure body validator. Exported for unit tests.
 */
export function validateClearBody(body) {
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.reason !== "string") {
    return { error: "reason is required (non-empty string)" };
  }
  const reason = b.reason.trim();
  if (reason.length === 0) {
    return { error: "reason cannot be empty" };
  }
  if (reason.length > MAX_REASON_LEN) {
    return {
      error: `reason cannot exceed ${MAX_REASON_LEN} characters (got ${reason.length})`,
    };
  }
  return { data: { reason } };
}

/**
 * Pure id validator. Exported for unit tests.
 */
export function validateVarianceId(id) {
  if (!id || typeof id !== "string" || !UUID_RE.test(id.trim())) {
    return { error: "variance id must be a uuid" };
  }
  return { data: id.trim() };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Auth gate.
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // 2. Path param — dispatcher injects via req.query.id (see api/dispatch.js).
  const idv = validateVarianceId(req.query?.id);
  if (idv.error) return res.status(400).json({ error: idv.error });
  const variance_id = idv.data;

  // 3. Body parse + validate. Audit reason MUST be present (D3 audit trail).
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  }
  const bv = validateClearBody(body || {});
  if (bv.error) return res.status(400).json({ error: bv.error });
  const { reason } = bv.data;

  // 4. Build admin client.
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 5. Lookup the variance to verify existence + current status.
  const { data: variance, error: vErr } = await admin
    .from("recon_variances")
    .select(
      "id, recon_run_id, source_table, source_id, source_tag, " +
        "tangerine_amount_cents, xoro_amount_cents, variance_amount_cents, " +
        "status, notes",
    )
    .eq("id", variance_id)
    .maybeSingle();
  if (vErr) return res.status(500).json({ error: vErr.message });
  if (!variance) {
    return res.status(404).json({ error: `Variance ${variance_id} not found` });
  }
  if (variance.status === "cleared") {
    return res.status(409).json({ error: "Variance is already cleared" });
  }

  // 6. INSERT into recon_cleared_log. Per the P9-1 schema, reason is
  // NOT NULL — we already validated above. cleared_at defaults to now().
  // We omit cleared_by_auth_id / cleared_by_employee_id for v1 — the
  // internal-token gate doesn't carry an auth identity. T11 audit
  // trail captures the route + correlation_id separately.
  const { data: log, error: lErr } = await admin
    .from("recon_cleared_log")
    .insert({
      recon_variance_id: variance_id,
      reason,
    })
    .select("id, recon_variance_id, reason, cleared_at")
    .maybeSingle();
  if (lErr) return res.status(500).json({ error: lErr.message });

  // 7. Flip status='cleared' on the variance. Idempotent — the 409
  // guard above prevents a double-clear race for the same variance.
  const { data: updated, error: uErr } = await admin
    .from("recon_variances")
    .update({ status: "cleared" })
    .eq("id", variance_id)
    .select(
      "id, recon_run_id, source_table, source_id, source_tag, " +
        "tangerine_amount_cents, xoro_amount_cents, variance_amount_cents, " +
        "status, notes",
    )
    .maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });

  return res.status(200).json({
    ok: true,
    variance: updated || { ...variance, status: "cleared" },
    cleared_log: log,
  });
}
