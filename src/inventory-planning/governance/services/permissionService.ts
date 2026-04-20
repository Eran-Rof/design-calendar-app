// Phase 7 permission service.
//
// Client-side shape:
//   • currentUserEmail() reads localStorage.planning_user_email (default "admin@local")
//   • loadPermissionsFor(email) resolves all active roles + flattens permissions (OR across roles)
//   • can(user, permission) returns boolean
//   • requirePermission(user, permission) throws if denied (used by mutation callers)
//
// Server-side hook: `/api/xoro/writeback/*` calls readPermissionsForEmail via
// the Supabase service role key. Client callers must send `x-user-email`
// on those requests — the writeback service does that.
//
// Philosophy: read-only utilities are permissive (UI controls visibility);
// sensitive actions use requirePermission or an explicit guard before the
// mutation.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type {
  IpPermissionKey,
  IpRole,
  IpUserRole,
  IpUserWithPermissions,
} from "../types/governance";

// ── Current user ──────────────────────────────────────────────────────────
const STORAGE_KEY = "planning_user_email";

export function currentUserEmail(): string {
  if (typeof window === "undefined") return "admin@local";
  return (window.localStorage.getItem(STORAGE_KEY) ?? "admin@local").toLowerCase();
}

export function setCurrentUserEmail(email: string): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, email.trim().toLowerCase());
  }
}

// ── Data loading ──────────────────────────────────────────────────────────
export async function loadPermissionsFor(email: string): Promise<IpUserWithPermissions> {
  const lower = email.trim().toLowerCase();
  if (!SB_URL) {
    return { user_email: lower, roles: [], permissions: {} };
  }
  // Pull roles + user_roles + join in code (simpler than nested PostgREST).
  const [rolesRes, userRolesRes] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/ip_roles?select=*&limit=200`, { headers: SB_HEADERS }),
    fetch(`${SB_URL}/rest/v1/ip_user_roles?select=*&active=eq.true&user_email=eq.${encodeURIComponent(lower)}`, { headers: SB_HEADERS }),
  ]);
  if (!rolesRes.ok || !userRolesRes.ok) {
    return { user_email: lower, roles: [], permissions: {} };
  }
  const roles = (await rolesRes.json()) as IpRole[];
  const userRoles = (await userRolesRes.json()) as IpUserRole[];
  const rolesById = new Map(roles.map((r) => [r.id, r]));
  const activeRoles = userRoles.map((ur) => rolesById.get(ur.role_id)).filter((r): r is IpRole => !!r);

  const flattened: Partial<Record<IpPermissionKey, boolean>> = {};
  for (const r of activeRoles) {
    for (const [k, v] of Object.entries(r.permissions ?? {})) {
      if (v) (flattened as Record<string, boolean>)[k] = true;
    }
  }
  return {
    user_email: lower,
    roles: activeRoles.map((r) => ({ role_name: r.role_name, description: r.description })),
    permissions: flattened,
  };
}

// ── Pure guards ───────────────────────────────────────────────────────────
export function can(user: IpUserWithPermissions, key: IpPermissionKey): boolean {
  return !!user.permissions[key];
}

export function canAny(user: IpUserWithPermissions, ...keys: IpPermissionKey[]): boolean {
  return keys.some((k) => can(user, k));
}

export function canAll(user: IpUserWithPermissions, ...keys: IpPermissionKey[]): boolean {
  return keys.every((k) => can(user, k));
}

export class PermissionDeniedError extends Error {
  readonly key: IpPermissionKey;
  readonly user_email: string;
  constructor(user: IpUserWithPermissions, key: IpPermissionKey) {
    super(`Permission denied: ${user.user_email} lacks "${key}"`);
    this.key = key;
    this.user_email = user.user_email;
  }
}

export function requirePermission(user: IpUserWithPermissions, key: IpPermissionKey): void {
  if (!can(user, key)) throw new PermissionDeniedError(user, key);
}

// ── Management ops (admin-only; caller enforces) ──────────────────────────
export async function listRoles(): Promise<IpRole[]> {
  if (!SB_URL) return [];
  const r = await fetch(`${SB_URL}/rest/v1/ip_roles?select=*&order=role_name.asc&limit=200`, { headers: SB_HEADERS });
  if (!r.ok) return [];
  return r.json();
}
export async function listUserRoles(): Promise<IpUserRole[]> {
  if (!SB_URL) return [];
  const r = await fetch(`${SB_URL}/rest/v1/ip_user_roles?select=*&order=user_email.asc&limit=5000`, { headers: SB_HEADERS });
  if (!r.ok) return [];
  return r.json();
}
export async function assignUserRole(user_email: string, role_id: string, granted_by: string | null): Promise<void> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const r = await fetch(`${SB_URL}/rest/v1/ip_user_roles`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify([{ user_email: user_email.toLowerCase(), role_id, granted_by, active: true }]),
  });
  if (!r.ok) throw new Error(`Assign failed: ${r.status} ${await r.text()}`);
}
export async function revokeUserRole(id: string): Promise<void> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const r = await fetch(`${SB_URL}/rest/v1/ip_user_roles?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({ active: false }),
  });
  if (!r.ok) throw new Error(`Revoke failed: ${r.status} ${await r.text()}`);
}

// ── Audit helper: log a permission_denied event ──────────────────────────
export async function logPermissionDenied(args: {
  user_email: string; key: IpPermissionKey;
  entity_type?: string; entity_id?: string | null;
  context?: string | null;
}): Promise<void> {
  if (!SB_URL) return;
  try {
    await fetch(`${SB_URL}/rest/v1/ip_change_audit_log`, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify([{
        entity_type: args.entity_type ?? "other",
        entity_id: args.entity_id ?? null,
        changed_field: "permission_check",
        old_value: null,
        new_value: "denied",
        changed_by: args.user_email,
        change_reason: `category:permission_denied · key=${args.key}${args.context ? ` · ${args.context}` : ""}`,
        planning_run_id: null,
        scenario_id: null,
      }]),
    });
  } catch {
    // swallow — audit is advisory
  }
}
