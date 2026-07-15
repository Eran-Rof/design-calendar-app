// api/_lib/rbac/marginAccess.js
//
// Server-side companion to the frontend useCanSeeMargins() hook. Lets a report
// handler decide whether to include margin fields in its response for THIS
// caller, using the same P14 `margins` capability the UI checks.
//
//   const { canView } = await resolveMarginAccess(req);
//   if (!canView) rows = rows.map(stripMarginKeys);
//
// IDENTITY: same source as api/internal/users-access/me — the cached
// auth_user_id from the `X-Auth-User-Id` header (the SPA's internal-API auth
// interceptor attaches it on every /api/internal/** call). This is a
// defence-in-depth strip, not the security boundary (the browser can spoof the
// header); its job is to keep margin numbers out of a non-granted user's normal
// responses + exports, mirroring the column hiding the UI already does.
//
// FAIL-OPEN — identical contract to the client hook: returns canView:true
// whenever RBAC_MODE !== "enforce", the admin client is unconfigured, the
// caller is unidentified, or anything errors. So this is a NO-OP until
// enforcement is live and can never blank out margins for a legitimate caller
// on an infra hiccup.

import { createClient } from "@supabase/supabase-js";
import { rbacMode, loadEffectivePermissions, isAllowed } from "./index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _admin = null;
function getAdmin() {
  if (_admin) return _admin;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}

function readAuthUserId(req) {
  const h = req?.headers || {};
  const raw = h["x-auth-user-id"] ?? h["X-Auth-User-Id"] ?? req?.query?.auth_user_id ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return UUID_RE.test(s) ? s : null;
}

async function resolveEntityId(admin, req) {
  const q = req?.query?.entity_id;
  if (typeof q === "string" && UUID_RE.test(q)) return q;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

/**
 * @returns {Promise<{ canView: boolean, canExport: boolean, enforcing: boolean }>}
 * Fail-open: canView/canExport are true unless enforcement is ON and the caller
 * genuinely lacks the grant.
 */
export async function resolveMarginAccess(req) {
  const OPEN = { canView: true, canExport: true, enforcing: false };
  try {
    if (rbacMode() !== "enforce") return OPEN;
    const admin = getAdmin();
    if (!admin) return OPEN;
    const authId = readAuthUserId(req);
    if (!authId) return OPEN;
    const entityId = await resolveEntityId(admin, req);
    if (!entityId) return OPEN;
    const perms = await loadEffectivePermissions(admin, authId, entityId);
    return {
      canView: isAllowed(perms, "margins", "read"),
      canExport: isAllowed(perms, "margins", "export"),
      enforcing: true,
    };
  } catch {
    return OPEN;
  }
}

/**
 * Remove margin-ish keys from a plain object (non-destructive; returns a copy).
 * Pass the exact key names a given endpoint uses.
 */
export function stripMarginKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
