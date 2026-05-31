// src/hooks/useEffectivePermissions.ts
//
// P14-4 — client-side menu hiding driven by the caller's effective RBAC
// permissions. Singleton module-level cache + pub/sub (same shape as
// useEntities / usePersonalization): the first consumer fetches
// /api/internal/users-access/me once; all mounts share the result.
//
// CRITICAL SAFETY CONTRACT — fail-open + inert-unless-enforce:
//   `can(moduleKey, action)` returns TRUE (show the item) whenever:
//     • the server's RBAC_MODE is not "enforce" (off / log → menus unchanged), OR
//     • the permission set hasn't loaded / the fetch errored, OR
//     • we couldn't identify the caller (no cached auth_user_id).
//   It only returns false when enforcement is ON, perms loaded, and the
//   caller genuinely lacks `module:action`. So this is a NO-OP today
//   (RBAC_MODE defaults off) — zero behavior change — and an operator can
//   never be locked out of their own menu by a fetch hiccup.
//
// Menu hiding is pure UX. The server independently enforces every request via
// rbacEnforce; hiding a menu item is a convenience, not the security boundary.

import { useEffect, useState, useCallback } from "react";

type RbacMode = "off" | "log" | "enforce";

interface MePayload {
  mode: RbacMode;
  entity_id: string | null;
  permissions: string[]; // "module_key:action"
}

interface CacheShape {
  mode: RbacMode;
  perms: Set<string>;
  status: "unloaded" | "loading" | "ready" | "error";
  error: string | null;
}

const cache: CacheShape = {
  mode: "off",
  perms: new Set(),
  status: "unloaded",
  error: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();
function notify(): void {
  for (const l of listeners) { try { l(); } catch { /* keep notifying */ } }
}

let inFlight: Promise<void> | null = null;

async function fetchMe(): Promise<void> {
  if (inFlight) return inFlight;
  cache.status = "loading";
  cache.error = null;
  notify();
  inFlight = (async () => {
    try {
      // X-Auth-User-Id + X-Entity-ID are injected by installInternalApiAuth.
      const res = await fetch("/api/internal/users-access/me", { method: "GET" });
      if (!res.ok) throw new Error(`GET users-access/me failed (${res.status})`);
      const json = (await res.json()) as MePayload;
      cache.mode = json.mode === "enforce" || json.mode === "log" ? json.mode : "off";
      cache.perms = new Set(Array.isArray(json.permissions) ? json.permissions : []);
      cache.status = "ready";
      cache.error = null;
    } catch (e) {
      // Fail-open: leave perms empty + mode untouched; `can()` returns true
      // because we never reach the enforce branch without a ready load.
      cache.status = "error";
      cache.error = e instanceof Error ? e.message : String(e);
    } finally {
      inFlight = null;
      notify();
    }
  })();
  return inFlight;
}

export interface UseEffectivePermissions {
  loading: boolean;
  /** True only when RBAC_MODE === "enforce" AND perms loaded — i.e. when menu hiding is live. */
  enforcing: boolean;
  mode: RbacMode;
  error: string | null;
  /**
   * Should a UI element guarded by (moduleKey, action) be shown?
   * Fail-open: true unless enforcing AND the caller lacks the permission.
   * `moduleKey` of null/undefined (an unmapped menu item) is always shown.
   */
  can: (moduleKey: string | null | undefined, action?: string) => boolean;
}

export function useEffectivePermissions(): UseEffectivePermissions {
  const [, force] = useState(0);

  useEffect(() => {
    const listener: Listener = () => force((n) => n + 1);
    listeners.add(listener);
    if (cache.status === "unloaded") void fetchMe();
    return () => { listeners.delete(listener); };
  }, []);

  const enforcing = cache.status === "ready" && cache.mode === "enforce";

  const can = useCallback(
    (moduleKey: string | null | undefined, action: string = "read"): boolean => {
      // Not enforcing (off/log/loading/error) → show everything.
      if (!enforcing) return true;
      // Unmapped item → always visible (we only hide what we can confidently map).
      if (!moduleKey) return true;
      return cache.perms.has(`${moduleKey}:${action}`);
    },
    [enforcing],
  );

  return {
    loading: cache.status === "loading" || cache.status === "unloaded",
    enforcing,
    mode: cache.mode,
    error: cache.error,
    can,
  };
}

// ── Test-only helpers ─────────────────────────────────────────────────────
/** @internal */
export function __setPermsForTests(mode: RbacMode, permissions: string[]): void {
  cache.mode = mode;
  cache.perms = new Set(permissions);
  cache.status = "ready";
  cache.error = null;
  inFlight = null;
}
/** @internal */
export function __resetPermsCacheForTests(): void {
  cache.mode = "off";
  cache.perms = new Set();
  cache.status = "unloaded";
  cache.error = null;
  inFlight = null;
  listeners.clear();
}
