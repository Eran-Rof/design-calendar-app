// api/_lib/ip-permissions.js
//
// Server-side permission check for planning endpoints. Reads the
// `x-user-email` request header, looks up the user's active roles +
// effective permissions from ip_user_roles / ip_roles, and returns a
// result object. Caller decides how to respond.
//
// Returns:
//   { ok: true, user: { email, permissions } }
//   { ok: false, status, error }

import { createClient } from "@supabase/supabase-js";

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

  const email = (req.headers?.["x-user-email"] || req.headers?.["X-User-Email"] || "").toString().trim().toLowerCase();
  if (!email) {
    return { ok: false, status: 401, error: "x-user-email header missing" };
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
