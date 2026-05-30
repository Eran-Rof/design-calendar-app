// Cross-cutter T4-3 — Personalization hook.
//
// Single hook backing every personalization UI surface (FavoritesDrawer,
// FavoriteStar, SetAsHomeButton, future "Most Used" tile). A
// module-level cache + pub/sub bus guarantees that:
//
//   • The first mounted consumer fetches /api/internal/users/me/preferences
//     exactly once. Subsequent mounts share the cached map.
//   • A toggle in one component (e.g. FavoriteStar) refreshes every other
//     consumer (e.g. the open FavoritesDrawer) on the same tick — without
//     React Context wiring around every shell.
//   • Click telemetry is fire-and-forget — never blocks navigation.
//
// Optimistic updates: toggleFavorite / setHomeRoute / setDrawerCollapsed
// mutate the local cache immediately, then PUT. On failure we roll back
// AND surface an Error reject to the caller so the UI can decide what to
// do (toast / silent / re-throw).
//
// T4-7 (favorites-drawer redesign — operator asks #2 + #3) added
// `drawerCollapsed` to the cache so the horizontal favorites strip can
// persist its open/closed state per-user. The previous version persisted
// to localStorage which doesn't survive a fresh laptop; we keep
// localStorage as the offline fallback before the cache hydrates.

import { useEffect, useState, useCallback } from "react";

// ── Shared module-level cache ─────────────────────────────────────────────

type FavoritesValue = { keys?: unknown };
type HomeRouteValue = { menu_key?: unknown };
type DrawerCollapsedValue = { collapsed?: unknown };

interface CacheShape {
  favorites: string[];
  homeRoute: string | null;
  drawerCollapsed: boolean;
  loading: boolean;
  /**
   * `unloaded` = no fetch attempted yet, `loading` = in-flight, `ready`
   * = at least one fetch has settled. Used so a second mount that races
   * the first fetch piggy-backs onto the same in-flight promise instead
   * of firing a duplicate.
   */
  status: "unloaded" | "loading" | "ready" | "error";
  error: string | null;
}

const DRAWER_COLLAPSED_LOCAL_KEY = "favorites_drawer_collapsed";

function readDrawerCollapsedFromLocalStorage(): boolean {
  // Default to COLLAPSED on first load so the strip does not overlay
  // panel content (e.g. the Style Master search bar). Operator clicks
  // the top-right pill to expand. Once they make any choice it persists.
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(DRAWER_COLLAPSED_LOCAL_KEY);
    if (v === null) return true;
    return v === "1" || v === "true";
  } catch {
    return true;
  }
}

function writeDrawerCollapsedToLocalStorage(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(DRAWER_COLLAPSED_LOCAL_KEY, collapsed ? "1" : "0"); }
  catch { /* ignore */ }
}

const cache: CacheShape = {
  favorites: [],
  homeRoute: null,
  drawerCollapsed: readDrawerCollapsedFromLocalStorage(),
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

let inFlight: Promise<void> | null = null;

async function fetchPreferences(): Promise<void> {
  if (inFlight) return inFlight;
  cache.status = "loading";
  cache.loading = true;
  cache.error = null;
  notify();
  inFlight = (async () => {
    try {
      const res = await fetch("/api/internal/users/me/preferences", { method: "GET" });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`GET /preferences failed (${res.status}): ${txt || res.statusText}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const favRow = (json.favorites ?? null) as FavoritesValue | null;
      const homeRow = (json.home_route ?? null) as HomeRouteValue | null;
      const drawerRow = (json.drawer_collapsed ?? null) as DrawerCollapsedValue | null;
      cache.favorites = Array.isArray(favRow?.keys)
        ? (favRow!.keys as unknown[]).filter((k): k is string => typeof k === "string")
        : [];
      cache.homeRoute = typeof homeRow?.menu_key === "string" ? homeRow.menu_key : null;
      if (typeof drawerRow?.collapsed === "boolean") {
        cache.drawerCollapsed = drawerRow.collapsed;
        writeDrawerCollapsedToLocalStorage(drawerRow.collapsed);
      }
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

async function putFavorites(keys: string[]): Promise<void> {
  const res = await fetch("/api/internal/users/me/preferences/favorites", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT favorites failed (${res.status}): ${txt || res.statusText}`);
  }
}

async function putHomeRoute(menuKey: string): Promise<void> {
  const res = await fetch("/api/internal/users/me/preferences/home-route", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ menu_key: menuKey }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT home-route failed (${res.status}): ${txt || res.statusText}`);
  }
}

async function putDrawerCollapsed(collapsed: boolean): Promise<void> {
  const res = await fetch("/api/internal/users/me/preferences/drawer-collapsed", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collapsed }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT drawer-collapsed failed (${res.status}): ${txt || res.statusText}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export interface UsePersonalization {
  favorites: string[];
  homeRoute: string | null;
  drawerCollapsed: boolean;
  loading: boolean;
  error: string | null;
  /**
   * Fetch lifecycle state. T4-4 auto-landing inspects this so it can
   * distinguish "preferences never fetched yet" (status === "unloaded")
   * from "fetched and home_route is genuinely null" (status === "ready").
   * Without this distinction, the auto-lander would prematurely conclude
   * that the operator has no home_route on the very first render before
   * the GET /preferences settles.
   */
  status: "unloaded" | "loading" | "ready" | "error";
  toggleFavorite: (menuKey: string) => Promise<void>;
  setHomeRoute: (menuKey: string) => Promise<void>;
  setDrawerCollapsed: (collapsed: boolean) => Promise<void>;
  logClick: (menuKey: string) => void;
  /** Force a re-fetch of /preferences. Mostly for tests + error recovery. */
  refresh: () => Promise<void>;
}

/**
 * React hook exposing the operator's personalization state plus mutators.
 *
 * On first mount in the app, kicks off a single GET /preferences. All
 * subsequent mounts share the cache and re-render when the cache changes.
 */
export function usePersonalization(): UsePersonalization {
  const [, force] = useState(0);

  useEffect(() => {
    const listener: Listener = () => force((n) => n + 1);
    listeners.add(listener);
    if (cache.status === "unloaded") {
      void fetchPreferences();
    }
    return () => { listeners.delete(listener); };
  }, []);

  const toggleFavorite = useCallback(async (menuKey: string): Promise<void> => {
    const prev = cache.favorites;
    const isFav = prev.includes(menuKey);
    const next = isFav ? prev.filter((k) => k !== menuKey) : [...prev, menuKey];
    // Optimistic update
    cache.favorites = next;
    notify();
    try {
      await putFavorites(next);
    } catch (e) {
      // Rollback on failure
      cache.favorites = prev;
      cache.error = e instanceof Error ? e.message : String(e);
      notify();
      throw e;
    }
  }, []);

  const setHomeRouteFn = useCallback(async (menuKey: string): Promise<void> => {
    const prev = cache.homeRoute;
    cache.homeRoute = menuKey;
    notify();
    try {
      await putHomeRoute(menuKey);
    } catch (e) {
      cache.homeRoute = prev;
      cache.error = e instanceof Error ? e.message : String(e);
      notify();
      throw e;
    }
  }, []);

  const setDrawerCollapsedFn = useCallback(async (collapsed: boolean): Promise<void> => {
    const prev = cache.drawerCollapsed;
    cache.drawerCollapsed = collapsed;
    // Mirror to localStorage so the next page load has the right initial
    // state even before /preferences hydrates.
    writeDrawerCollapsedToLocalStorage(collapsed);
    notify();
    try {
      await putDrawerCollapsed(collapsed);
    } catch (e) {
      cache.drawerCollapsed = prev;
      writeDrawerCollapsedToLocalStorage(prev);
      cache.error = e instanceof Error ? e.message : String(e);
      notify();
      throw e;
    }
  }, []);

  const logClick = useCallback((menuKey: string): void => {
    // Fire-and-forget. NEVER awaited. Swallow every error — telemetry
    // failures must not affect navigation.
    try {
      void fetch("/api/internal/users/me/menu-click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menu_key: menuKey }),
        // Use keepalive so a click that immediately navigates away
        // still flushes the request (browsers cancel in-flight fetches
        // when the page unloads otherwise).
        keepalive: true,
      }).catch(() => { /* swallow */ });
    } catch { /* swallow */ }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    cache.status = "unloaded";
    await fetchPreferences();
  }, []);

  return {
    favorites: cache.favorites,
    homeRoute: cache.homeRoute,
    drawerCollapsed: cache.drawerCollapsed,
    loading: cache.loading,
    error: cache.error,
    status: cache.status,
    toggleFavorite,
    setHomeRoute: setHomeRouteFn,
    setDrawerCollapsed: setDrawerCollapsedFn,
    logClick,
    refresh,
  };
}

// ── Test-only helpers ─────────────────────────────────────────────────────
// Exposed so unit tests can reset the module cache between runs without
// resorting to vi.resetModules() (which is brittle with React).

/** @internal */
export function __resetPersonalizationCacheForTests(): void {
  cache.favorites = [];
  cache.homeRoute = null;
  cache.drawerCollapsed = true;
  cache.loading = false;
  cache.status = "unloaded";
  cache.error = null;
  inFlight = null;
  listeners.clear();
}
