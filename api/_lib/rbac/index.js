// api/_lib/rbac/index.js
//
// P14 RBAC — enforcement core. CHUNK 2 = LOG-ONLY.
//
// `rbacObserve()` is called by the dispatcher after a route matches. It
// resolves the caller's effective permission set (from the P14-1
// v_effective_permissions view) and the permission the matched route requires
// (from routePermissions.js), then console.warns a structured line if the
// caller WOULD be denied. It NEVER throws, NEVER mutates the response, and
// NEVER blocks — chunk 3 adds the actual reject path behind RBAC_MODE=enforce.
//
// Gated by RBAC_MODE (default "off" → total no-op, zero added latency). Set
// RBAC_MODE=log on the deployment to start collecting would-deny telemetry.
//
// NOTE: distinct from api/_lib/ip-permissions.js (the legacy PLM permission
// check) — different module path, different names, no overlap.

import { createClient } from "@supabase/supabase-js";
import { authenticateCaller } from "../auth.js";
import { resolveCallerEntity } from "../auth/resolve-entity.js";
import { routePermissionFor } from "./routePermissions.js";

/** "off" | "log" | "enforce". Default off. ("enforce" still only logs in chunk 2.) */
export function rbacMode() {
  const m = String(process.env.RBAC_MODE || "off").toLowerCase();
  return (m === "log" || m === "enforce") ? m : "off";
}

let _admin = null;
function getAdmin() {
  if (_admin) return _admin;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}

/**
 * Load the caller's effective permissions as a Set of "module_key:action".
 * Reads the P14-1 v_effective_permissions view (role grants ∪ allow-overrides
 * − deny-overrides). Never throws — returns an empty Set on any failure.
 */
export async function loadEffectivePermissions(sb, authId, entityId) {
  if (!sb || !authId || !entityId) return new Set();
  try {
    const { data, error } = await sb
      .from("v_effective_permissions")
      .select("module_key, action")
      .eq("user_id", authId)
      .eq("entity_id", entityId);
    if (error || !Array.isArray(data)) return new Set();
    return new Set(data.map((r) => `${r.module_key}:${r.action}`));
  } catch {
    return new Set();
  }
}

/** Pure membership check. */
export function isAllowed(perms, moduleKey, action) {
  return perms instanceof Set && perms.has(`${moduleKey}:${action}`);
}

/**
 * Dispatcher hook — LOG-ONLY observability. No-op unless RBAC_MODE is set and
 * the request carries a Supabase bearer (internal apps that have adopted the
 * MS-auth bridge). Resolves (authId, entityId, perms) and logs a would-deny.
 * Wrapped so it can NEVER affect the request lifecycle.
 *
 * @returns {Promise<void>}
 */
export async function rbacObserve(req, pathname, method) {
  try {
    if (rbacMode() === "off") return;
    const required = routePermissionFor(pathname, method);
    if (!required) return; // unmapped (vendor/cron/public or uncatalogued) — skip
    const sb = getAdmin();
    if (!sb) return;
    const auth = await authenticateCaller(req, sb);
    if (!auth || !auth.ok || !auth.authId) return; // no JWT yet → nothing to observe
    const ent = await resolveCallerEntity(req, sb, auth.authId);
    if (!ent || !ent.entity_id) return;
    const perms = await loadEffectivePermissions(sb, auth.authId, ent.entity_id);
    if (!isAllowed(perms, required.module, required.action)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[RBAC log-only] would-deny ${method} ${pathname} — user=${auth.authId} ` +
        `entity=${ent.entity_id} needs ${required.module}:${required.action}`,
      );
    }
  } catch {
    // Observability must never affect a real request. Swallow everything.
  }
}
