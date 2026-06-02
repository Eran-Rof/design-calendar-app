// Tangerine P10-5 — Entity-switcher hook.
//
// Single hook backing the top-bar <EntitySwitcher /> across every app
// shell. A module-level cache + pub/sub bus (same pattern as
// usePersonalization, T4-3) guarantees that:
//
//   • The first mounted consumer fetches /api/internal/users/me/entities
//     exactly once. Subsequent mounts share the cached payload.
//   • Calling switchEntity in one panel re-renders every other
//     EntitySwitcher mount on the same tick (each shell renders its own).
//   • switchEntity writes sessionStorage["x-tangerine-entity-id"] and
//     reloads the window, so every panel re-fetches under the new
//     entity context. This is the simplest correct behaviour for v1 —
//     all in-memory caches and open panels are tied to the previous
//     entity, and propagating a context flip cleanly through every
//     subscriber would require touching dozens of files. Reload-on-
//     switch matches what enterprise multi-tenant SaaS does.
//   • setDefault calls PUT /entity-default and re-fetches the list so
//     the star icon updates without a reload.
//
// Why session-storage instead of localStorage?
//   • Per-tab isolation: an operator can open two browser tabs side-by-
//     side, each scoped to a different entity (RingOfFire + Xoro
//     mirror). localStorage would force them to share a single value.
//   • Per-session clear: the header reverts to "no header → server uses
//     is_default" when the browser closes. The default flag persists in
//     the DB; the in-session override does not.
//
// Wiring with the API:
//   • src/utils/internalApiAuth.ts is extended (P10-5) to read
//     sessionStorage["x-tangerine-entity-id"] and inject
//     X-Entity-ID on every /api/internal/** request.
//   • api/_lib/auth/resolve-entity.js (P10-4) validates the header
//     against entity_users and rejects if the caller isn't a member.

import { useEffect, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────

export interface Entity {
  id: string;
  code: string | null;
  name: string;
  role: string;
  is_default: boolean;
}

interface EntitiesPayload {
  entities: Entity[];
  current_entity_id: string | null;
}

// ── Shared module-level cache ─────────────────────────────────────────────

interface CacheShape {
  entities: Entity[];
  currentEntityId: string | null;
  loading: boolean;
  status: "unloaded" | "loading" | "ready" | "error";
  error: string | null;
}

const cache: CacheShape = {
  entities: [],
  currentEntityId: null,
  loading: false,
  status: "unloaded",
  error: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* keep notifying others */ }
  }
}

// Storage key for the per-tab entity override. Mirrors the alias accepted
// by api/_lib/auth/resolve-entity.js (readEntityHeader). Keep these two
// constants in lockstep; if you rename one, rename the other.
export const ENTITY_SESSION_KEY = "x-tangerine-entity-id";

let inFlight: Promise<void> | null = null;

async function fetchEntities(): Promise<void> {
  if (inFlight) return inFlight;
  cache.status = "loading";
  cache.loading = true;
  cache.error = null;
  notify();
  inFlight = (async () => {
    try {
      const res = await fetch("/api/internal/users/me/entities", { method: "GET" });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`GET /entities failed (${res.status}): ${txt || res.statusText}`);
      }
      const json = (await res.json()) as EntitiesPayload;
      cache.entities = Array.isArray(json.entities) ? json.entities : [];
      // Prefer the session override (set by switchEntity in a prior
      // tick) over the server's current_entity_id, but only if the
      // override matches an entity the caller actually belongs to.
      const sessionOverride = readSessionEntity();
      const overrideValid = sessionOverride
        && cache.entities.some((e) => e.id === sessionOverride);
      cache.currentEntityId = overrideValid
        ? sessionOverride
        : (json.current_entity_id ?? null);
      cache.status = "ready";
      cache.error = null;
    } catch (e) {
      cache.status = "error";
      cache.error = e instanceof Error ? e.message : String(e);
    } finally {
      cache.loading = false;
      inFlight = null;
      notify();
    }
  })();
  return inFlight;
}

async function putEntitySwitch(entityId: string): Promise<void> {
  const res = await fetch("/api/internal/users/me/entity-switch", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT entity-switch failed (${res.status}): ${txt || res.statusText}`);
  }
}

async function putEntityDefault(entityId: string): Promise<void> {
  const res = await fetch("/api/internal/users/me/entity-default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT entity-default failed (${res.status}): ${txt || res.statusText}`);
  }
}

function readSessionEntity(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(ENTITY_SESSION_KEY);
    return v && v.trim().length > 0 ? v.trim() : null;
  } catch { return null; }
}

function writeSessionEntity(entityId: string): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(ENTITY_SESSION_KEY, entityId); } catch { /* ignore */ }
}

// Test-only seam: switchEntity calls window.location.reload(), which jsdom
// doesn't really implement and which would defeat assertions about the
// post-switch cache state. Tests can override this hook to observe the
// reload call without actually navigating.
let reloadFn: () => void = () => {
  if (typeof window !== "undefined") {
    try { window.location.reload(); } catch { /* ignore */ }
  }
};

/** @internal — for tests only. */
export function __setReloadFnForTests(fn: () => void): void {
  reloadFn = fn;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface UseEntities {
  entities: Entity[];
  currentEntityId: string | null;
  loading: boolean;
  error: string | null;
  status: "unloaded" | "loading" | "ready" | "error";
  /**
   * Switch the active entity for the current tab. Validates membership
   * server-side, writes sessionStorage, then triggers a full page
   * reload so every panel re-fetches under the new entity. Throws on
   * failure (membership rejected, network down) so the UI can surface
   * a toast.
   */
  switchEntity: (entityId: string) => Promise<void>;
  /**
   * Toggle the persisted default for this caller. Re-fetches the
   * /entities list on success so the star icon and current_entity_id
   * update. Does NOT switch the in-tab session override — operators
   * can be parked on a non-default entity for the current tab while
   * the persistent default points elsewhere.
   */
  setDefault: (entityId: string) => Promise<void>;
  /** Force a re-fetch. Mostly for error recovery + tests. */
  refresh: () => Promise<void>;
}

export function useEntities(): UseEntities {
  const [, force] = useState(0);

  useEffect(() => {
    const listener: Listener = () => force((n) => n + 1);
    listeners.add(listener);
    if (cache.status === "unloaded") {
      void fetchEntities();
    }
    return () => { listeners.delete(listener); };
  }, []);

  const switchEntity = useCallback(async (entityId: string): Promise<void> => {
    // Validate server-side first — if the caller isn't a member, we
    // do NOT want to write the session key and reload into a 403
    // storm. The PUT is the authoritative membership check.
    await putEntitySwitch(entityId);
    writeSessionEntity(entityId);
    cache.currentEntityId = entityId;
    notify();
    // Reload so every panel re-fetches under the new entity. Defer to
    // a microtask so subscribers that just received notify() can
    // observe the new currentEntityId before the page unloads — that
    // makes the cache.currentEntityId === entityId assertion in tests
    // observable without racing the reload.
    reloadFn();
  }, []);

  const setDefault = useCallback(async (entityId: string): Promise<void> => {
    const prev = cache.entities;
    // Optimistic flag update — flip is_default locally so the star
    // icon swaps immediately. We re-fetch on success to grab the
    // authoritative shape, and roll back on failure.
    cache.entities = prev.map((e) => ({ ...e, is_default: e.id === entityId }));
    notify();
    try {
      await putEntityDefault(entityId);
      // Re-fetch to pick up authoritative current_entity_id (it might
      // have shifted if the session override wasn't set).
      cache.status = "unloaded";
      await fetchEntities();
    } catch (e) {
      cache.entities = prev;
      cache.error = e instanceof Error ? e.message : String(e);
      notify();
      throw e;
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    cache.status = "unloaded";
    await fetchEntities();
  }, []);

  return {
    entities: cache.entities,
    currentEntityId: cache.currentEntityId,
    loading: cache.loading,
    error: cache.error,
    status: cache.status,
    switchEntity,
    setDefault,
    refresh,
  };
}

// ── Test-only helpers ─────────────────────────────────────────────────────

/** @internal */
export function __resetEntitiesCacheForTests(): void {
  cache.entities = [];
  cache.currentEntityId = null;
  cache.loading = false;
  cache.status = "unloaded";
  cache.error = null;
  inFlight = null;
  listeners.clear();
  reloadFn = () => { /* no-op default for tests */ };
  if (typeof window !== "undefined") {
    try { window.sessionStorage.removeItem(ENTITY_SESSION_KEY); } catch { /* ignore */ }
  }
}
