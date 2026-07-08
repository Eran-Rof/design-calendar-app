// api/_lib/ip-permissions.js
//
// Server-side permission check for planning endpoints. Resolves the caller's
// identity, looks up the user's active roles + effective permissions from
// ip_user_roles / ip_roles, and returns a result object. Caller decides how
// to respond.
//
// Identity resolution (security sprint, re-rate 2026-07-08): the raw
// `x-user-email` header is client-supplied and trivially spoofable — any
// caller could inherit any user's permissions on privileged endpoints (e.g.
// buy-plan-to-po CREATES purchase orders). When the per-user JWT bridge is
// configured (TANGERINE_JWT_SECRET set — the production state), the email
// MUST come from a verified Authorization: Bearer app-JWT (the SPA's global
// fetch interceptor attaches it on every /api/internal/** call); the header
// is ignored. The header path survives only when the JWT bridge is not
// configured (local dev without the secret).
//
// Returns:
//   { ok: true, user: { email, permissions } }
//   { ok: false, status, error }

import { createClient } from "@supabase/supabase-js";
import { isAppJwtEnabled, verifyAppJwt } from "./auth/appJwt.js";

let _admin = null;
function supabaseAdmin() {
  if (_admin) return _admin;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return null;
  _admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });
  return _admin;
}

export async function checkPermission(req, requiredPermission) {
  const admin = supabaseAdmin();
  if (!admin) return { ok: false, status: 500, error: "Supabase admin not configured" };

  let email = "";
  if (isAppJwtEnabled()) {
    // Verified path: identity comes ONLY from the signed app JWT.
    const authz = (req.headers?.authorization || req.headers?.Authorization || "").toString();
    const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
    const claims = token ? verifyAppJwt(token) : null;
    email = (claims?.email || "").trim().toLowerCase();
    if (!email) {
      return { ok: false, status: 401, error: "Sign-in required (verified user token missing or has no email) — refresh the app to re-authenticate" };
    }
  } else {
    // Dev fallback only — no JWT secret configured on this deployment.
    email = (req.headers?.["x-user-email"] || req.headers?.["X-User-Email"] || "").toString().trim().toLowerCase();
    if (!email) {
      return { ok: false, status: 401, error: "x-user-email header missing" };
    }
  }

  // Pull user roles.
  const { data: urs, error: urErr } = await admin
    .from("ip_user_roles")
    .select("role_id, active")
    .eq("user_email", email)
    .eq("active", true);
  if (urErr) return { ok: false, status: 500, error: `user_roles lookup failed: ${urErr.message}` };
  if (!urs || urs.length === 0) {
    return { ok: false, status: 403, error: `User ${email} has no active roles` };
  }

  const roleIds = urs.map((r) => r.role_id);
  const { data: roles, error: rErr } = await admin
    .from("ip_roles")
    .select("permissions")
    .in("id", roleIds);
  if (rErr) return { ok: false, status: 500, error: `roles lookup failed: ${rErr.message}` };

  const perms = {};
  for (const r of roles ?? []) {
    for (const [k, v] of Object.entries(r.permissions ?? {})) {
      if (v) perms[k] = true;
    }
  }

  if (requiredPermission && !perms[requiredPermission]) {
    // Fire-and-forget audit of the denial.
    try {
      await admin.from("ip_change_audit_log").insert({
        entity_type: "other",
        changed_field: "permission_check",
        old_value: null,
        new_value: "denied",
        changed_by: email,
        change_reason: `category:permission_denied · key=${requiredPermission} · route=${req.url?.split("?")[0] ?? ""}`,
      });
    } catch { /* ignore */ }
    return { ok: false, status: 403, error: `Missing permission: ${requiredPermission}` };
  }

  return { ok: true, user: { email, permissions: perms } };
}

export async function requirePermission(req, res, requiredPermission) {
  const result = await checkPermission(req, requiredPermission);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return null;
  }
  return result.user;
}
