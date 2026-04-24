// api/_lib/xoro-writeback.js
//
// Shared helper for the Xoro writeback endpoints. Encapsulates:
//   • feature gate (XORO_WRITEBACK_ENABLED must be "1" for live calls)
//   • dry-run parsing (defaults to TRUE)
//   • structured response shape
//   • payload validation bail-out
//   • request logging (non-fatal)
//
// Live Xoro call is intentionally NOT implemented in Phase 6 — we
// return a placeholder response so the end-to-end flow works (dry run
// from UI → endpoint → structured reply → status update in DB). Flip
// the envelope to a real POST once the Xoro endpoint/contract is
// confirmed with their support team.

import { createClient } from "@supabase/supabase-js";

// Writeback requires explicit opt-in (XORO_WRITEBACK_ENABLED=1) AND the app
// must not be running in staging. Staging always stays in dry-run mode even
// if the flag is accidentally set.
export const WRITEBACK_ENABLED_ENV =
  process.env.XORO_WRITEBACK_ENABLED === "1" &&
  process.env.VITE_APP_ENV !== "staging";

export function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Hard guard for writeback handlers. Returns true (and writes a 503) if
// writeback is blocked — callers should return immediately when true.
// Staging is permanently blocked regardless of XORO_WRITEBACK_ENABLED.
export function assertWritebackDisabled(res) {
  if (WRITEBACK_ENABLED_ENV) return false;
  const env = process.env.VITE_APP_ENV ?? "unset";
  const hint = env === "staging"
    ? "Writeback is permanently disabled in staging. Use production credentials to enable."
    : "Set XORO_WRITEBACK_ENABLED=1 in production environment variables to enable.";
  console.warn(`[xoro-writeback] blocked in env=${env}: ${hint}`);
  res.status(503).json({ ok: false, error: "Writeback disabled in this environment", env, hint });
  return true;
}

export function isDryRun(req) {
  try {
    const url = new URL(req.url, `https://${req.headers.host ?? "localhost"}`);
    const v = url.searchParams.get("dry_run");
    if (v === "0" || v === "false") return false;
    return true; // default to dry-run
  } catch {
    return true;
  }
}

export function supabaseAdmin() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return null;
  return createClient(SB_URL, KEY, { auth: { persistSession: false } });
}

// Write a Phase 6 audit row without bringing down the response on failure.
export async function auditWriteback(batchIdOrAction, event_type, data) {
  try {
    const admin = supabaseAdmin();
    if (!admin) return;
    await admin.from("ip_execution_audit_log").insert({
      execution_batch_id: batchIdOrAction.batchId ?? null,
      execution_action_id: batchIdOrAction.actionId ?? null,
      event_type,
      event_message: typeof data === "string" ? data : JSON.stringify(data).slice(0, 2000),
      actor: batchIdOrAction.actor ?? null,
    });
  } catch { /* ignore audit failures */ }
}

export function okResult({ action_id, dry_run, message, response }) {
  return {
    ok: true,
    dry_run,
    action_id,
    status: dry_run ? "submitted" : "succeeded",
    message,
    response: response ?? null,
  };
}

export function failResult({ action_id, dry_run, message, status = 400 }) {
  return {
    status,
    body: {
      ok: false,
      dry_run,
      action_id,
      status: "failed",
      message,
    },
  };
}

// Minimum payload validators — keep small and obvious.
export function requireFields(payload, fields) {
  const missing = fields.filter((f) => payload[f] == null || payload[f] === "");
  if (missing.length > 0) return `Missing fields: ${missing.join(", ")}`;
  return null;
}

// Dry-run / disabled-path placeholder.
export function placeholderResponse(type, payload) {
  return {
    would_call: `xoro.${type}`,
    preview: payload,
    note: WRITEBACK_ENABLED_ENV
      ? "Live mode enabled by env, but the real Xoro endpoint is not wired in Phase 6. Treat as dry-run."
      : "Writeback globally disabled (XORO_WRITEBACK_ENABLED != '1'). Dry-run only.",
  };
}
