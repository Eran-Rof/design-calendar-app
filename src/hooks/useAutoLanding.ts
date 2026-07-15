// Cross-cutter T4-4 — Personalization: auto-landing redirect on app boot.
//
// When the operator opens the app at the root URL (e.g. "/", "/tanda" with
// no `view=` param) AND they have previously persisted a `home_route`
// preference (via SetAsHomeButton), this hook fires a one-shot redirect to
// their preferred view.
//
// Design constraints (operator-driven):
//   • One-shot per tab session — uses sessionStorage 'auto_landing_fired'.
//     A re-mount, navigation back to root, or React StrictMode double-render
//     must NOT re-trigger. The sentinel is written BEFORE navigation so a
//     React fast-refresh can't double-fire either.
//   • Never override an explicit URL — if the operator typed/bookmarked a
//     deep link (e.g. `/tanda?view=ar_invoices`), don't yank them away.
//     Detection: pathname must be "/" OR the pathname starts with one of
//     the app shell roots ("/tanda", "/design", "/ats", "/gs1", "/tangerine")
//     AND there is no `view=` query param.
//   • Escape hatch: `?nolanding=1` skips the redirect AND sets the sentinel
//     so the operator can land at the bare app shell without re-triggering.
//   • Waits for usePersonalization().loading to settle. If homeRoute is null
//     after load, sets the sentinel + bails (avoids re-checking next mount).
//   • If the persisted menu_key is not in MENU_KEY_BY_KEY (registry drift /
//     stale preference), set sentinel + bail silently — don't navigate to
//     an unknown route.
//
// Tests dependency-inject the navigator and sessionStorage so we don't have
// to fight jsdom's read-only `window.location` setter.

import { useEffect, useRef, useState } from "react";

import { usePersonalization } from "./usePersonalization";
import { MENU_KEY_BY_KEY } from "../lib/menuKeys";

// ── Public types ───────────────────────────────────────────────────────────

export interface UseAutoLandingOptions {
  /** Query param that, when present + truthy, suppresses the redirect.
   *  Defaults to "nolanding". */
  skipParam?: string;
  /** Injected so tests can avoid touching window.location (which jsdom
   *  treats as read-only). Defaults to `(href) => { window.location.href = href; }`. */
  navigate?: (href: string) => void;
  /** Injected so tests can drive the sentinel without touching sessionStorage.
   *  Defaults to the real `window.sessionStorage`. */
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** Injected so tests can simulate URLs. Defaults to `window.location`. */
  location?: { pathname: string; search: string };
}

export interface UseAutoLandingResult {
  /** True for one render tick after the hook decides to redirect, so the
   *  caller can render the "Welcome back …" toast before the page unloads. */
  redirecting: boolean;
  /** Resolved route the hook navigated to, or null. */
  redirectTarget: string | null;
  /** menu_key label, for the toast. null when not redirecting. */
  redirectLabel: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SENTINEL_KEY = "auto_landing_fired";

/**
 * App-shell pathname prefixes. If the user is at one of these *bare*
 * (no `view=` query param), we may still redirect. Anything else is
 * treated as an explicit deep-link and we don't touch it.
 *
 * Note: "/" is also a valid landing root (the launcher card grid).
 */
const ROOT_SHELL_PREFIXES = [
  "/",
  "/design",
  "/tanda",
  "/ats",
  "/gs1",
  "/tangerine",
];

// ── Helpers ────────────────────────────────────────────────────────────────

function isRootLikePath(pathname: string, search: string): boolean {
  // Exact root.
  if (pathname === "/" || pathname === "") return true;

  // Normalize trailing slash for prefix match.
  const normalized = pathname.endsWith("/") && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;

  const isShellRoot = ROOT_SHELL_PREFIXES.includes(normalized);
  if (!isShellRoot) return false;

  // If the operator is at /tanda?view=… OR /tangerine?m=… they're deep-linked
  // into a panel; do NOT redirect on top of that. The Tangerine shell drives
  // its active module from `?m=` (not `?view=`), so an `m=` param is just as
  // much an explicit deep link as `view=` is on the legacy shells.
  try {
    const params = new URLSearchParams(search);
    if (params.has("view") && (params.get("view") ?? "") !== "") return false;
    if (params.has("m") && (params.get("m") ?? "") !== "") return false;
  } catch {
    // Malformed query — treat as bare shell.
  }
  return true;
}

function isSkipRequested(search: string, skipParam: string): boolean {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get(skipParam);
    if (raw === null) return false;
    // Accept "1", "true", "yes" — anything explicitly falsy ("0", "false") is NOT a skip.
    const v = raw.toLowerCase();
    if (v === "0" || v === "false" || v === "no") return false;
    return true;
  } catch {
    return false;
  }
}

function defaultNavigate(href: string): void {
  // Match the existing nav pattern in TandA.tsx + FavoritesDrawer.tsx —
  // most routes are query-string variants on a handful of pathnames so a
  // hard navigation is the simplest correct behaviour.
  if (typeof window !== "undefined") {
    window.location.href = href;
  }
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function defaultLocation(): { pathname: string; search: string } {
  if (typeof window === "undefined") return { pathname: "/", search: "" };
  return { pathname: window.location.pathname, search: window.location.search };
}

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Reads `homeRoute` from `usePersonalization()` and, if the conditions are
 * right (root URL, no skip param, sentinel not yet set, registry resolves
 * the menu_key), navigates the browser to the persisted home route exactly
 * once per tab session.
 *
 * Caller renders <AutoLandingToast /> alongside this hook so the operator
 * sees a "Welcome back — landing on X" message before the page unloads.
 */
export function useAutoLanding(opts: UseAutoLandingOptions = {}): UseAutoLandingResult {
  const skipParam = opts.skipParam ?? "nolanding";
  const navigate = opts.navigate ?? defaultNavigate;
  const storage = opts.storage ?? defaultStorage();
  const location = opts.location ?? defaultLocation();

  const { homeRoute, loading, status } = usePersonalization();

  const [redirecting, setRedirecting] = useState(false);
  const [redirectTarget, setRedirectTarget] = useState<string | null>(null);
  const [redirectLabel, setRedirectLabel] = useState<string | null>(null);

  // Guard against repeated invocations within the same component lifetime
  // (React StrictMode invokes effects twice in dev). The sessionStorage
  // sentinel guards across mounts; this ref guards within a mount.
  const decidedRef = useRef(false);

  useEffect(() => {
    if (decidedRef.current) return;

    // 1) Sentinel already set this tab session → bail.
    if (storage) {
      try {
        if (storage.getItem(SENTINEL_KEY) === "1") {
          decidedRef.current = true;
          return;
        }
      } catch {
        // Ignore storage errors and continue — better to attempt the
        // redirect than to never fire because of a quota / privacy mode.
      }
    }

    // 2) Skip param present → set sentinel + bail.
    if (isSkipRequested(location.search, skipParam)) {
      decidedRef.current = true;
      try { storage?.setItem(SENTINEL_KEY, "1"); } catch { /* swallow */ }
      return;
    }

    // 3) Not at a root URL → don't override explicit deep link. Don't set
    //    sentinel — if the operator navigates back to root in this tab we
    //    do want to redirect them then.
    if (!isRootLikePath(location.pathname, location.search)) {
      decidedRef.current = true;
      return;
    }

    // 4) Wait for preferences to load. We must wait until the
    //    preferences fetch has actually SETTLED — not just "not loading".
    //    On the very first render `loading` is false because the GET
    //    hasn't been kicked off yet (status: "unloaded"). Bailing here
    //    would prematurely conclude homeRoute is null. We accept "ready"
    //    or "error" as terminal states.
    if (loading) return;
    if (status === "unloaded" || status === "loading") return;

    // 5) No home_route set → set sentinel + bail (don't re-check).
    if (!homeRoute) {
      decidedRef.current = true;
      try { storage?.setItem(SENTINEL_KEY, "1"); } catch { /* swallow */ }
      return;
    }

    // 6) Resolve menu_key → route. Unknown key (stale pref, registry drift)
    //    → set sentinel + bail silently.
    const entry = MENU_KEY_BY_KEY[homeRoute];
    if (!entry) {
      decidedRef.current = true;
      try { storage?.setItem(SENTINEL_KEY, "1"); } catch { /* swallow */ }
      return;
    }

    // 7) Don't redirect to the same route we're already on. Compare pathname
    //    AND both route params — `view=` (legacy TandA shell) and `m=` (the
    //    Tangerine shell's module param). Comparing only `view=` treated a
    //    bare `/tangerine` as identical to `/tangerine?m=today`, so a Today
    //    (or any `m=`) home_route never fired from the bare shell.
    try {
      const target = new URL(entry.route, "http://x.local");
      const locParams = new URLSearchParams(location.search);
      const same = target.pathname === location.pathname
        && (target.searchParams.get("view") ?? "") === (locParams.get("view") ?? "")
        && (target.searchParams.get("m") ?? "") === (locParams.get("m") ?? "");
      if (same) {
        decidedRef.current = true;
        try { storage?.setItem(SENTINEL_KEY, "1"); } catch { /* swallow */ }
        return;
      }
    } catch {
      // URL parse failed — fall through and attempt the redirect anyway.
    }

    // 8) All checks passed — fire the redirect. Set sentinel FIRST so a
    //    fast re-render can't double-fire before the page unloads.
    decidedRef.current = true;
    try { storage?.setItem(SENTINEL_KEY, "1"); } catch { /* swallow */ }
    setRedirectTarget(entry.route);
    setRedirectLabel(entry.label);
    setRedirecting(true);
    // Defer the actual navigation by a tick so the toast has a chance to
    // mount + paint before the page unloads. 0ms is enough for React to
    // flush the state update; we don't need a longer delay.
    const id = setTimeout(() => {
      navigate(entry.route);
    }, 0);
    return () => clearTimeout(id);
  }, [homeRoute, loading, status, location.pathname, location.search, skipParam, storage, navigate]);

  return { redirecting, redirectTarget, redirectLabel };
}

// ── Test-only helpers ──────────────────────────────────────────────────────

/** @internal — clears the sessionStorage sentinel so tests can re-run. */
export function __resetAutoLandingSentinelForTests(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(SENTINEL_KEY); } catch { /* swallow */ }
}

/** @internal — exported for tests so they can assert on the key. */
export const __AUTO_LANDING_SENTINEL_KEY = SENTINEL_KEY;
