// Internal-API auth header injector.
//
// Every server-side handler under /api/internal/** is gated by
// authenticateInternalCaller (api/_lib/auth.js). The gate is fail-open
// when INTERNAL_API_TOKEN is unset on the server, but enforced once
// the env var is configured. This module monkey-patches window.fetch
// at app boot so every browser-side request to /api/internal/**
// automatically picks up the Authorization: Bearer header without
// having to touch 33 individual call sites.
//
// The token is read from VITE_INTERNAL_API_TOKEN at build time. Yes,
// this means the token is shipped in the JS bundle and isn't truly a
// secret against a determined user — that's an accepted limitation
// of the stop-gap. Real per-user auth replaces this later.
//
// P10-5 — Same interceptor also injects the X-Entity-ID header on
// every /api/internal/** call when sessionStorage["x-tangerine-
// entity-id"] is set. <EntitySwitcher /> writes that key on switch.
// The server-side helper api/_lib/auth/resolve-entity.js (P10-4)
// validates the header against entity_users and rejects unknown
// memberships.
//
// Idempotent — installing twice is a no-op.

const TOKEN = (import.meta as ImportMeta & { env?: Record<string, string> })
  .env?.VITE_INTERNAL_API_TOKEN ?? "";

const INTERNAL_PATH_RE = /^\/api\/internal\//;

// MUST stay in lockstep with ENTITY_SESSION_KEY in src/hooks/useEntities.ts
// and with the alias accepted by api/_lib/auth/resolve-entity.js.
const ENTITY_SESSION_KEY = "x-tangerine-entity-id";

function readEntitySessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(ENTITY_SESSION_KEY);
    return v && v.trim().length > 0 ? v.trim() : null;
  } catch { return null; }
}

let installed = false;

export function installInternalApiAuth(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (!TOKEN) {
    // No token configured at build time. The server may still be
    // fail-open (matching) or strict; surface a console.warn once so
    // a frontend deploy without VITE_INTERNAL_API_TOKEN doesn't
    // silently 401. We still install the wrapper below so that
    // X-Entity-ID injection works even when the bearer token is
    // unconfigured (e.g. local dev).
    if (typeof console !== "undefined") {
      console.warn("[internal-api] VITE_INTERNAL_API_TOKEN not set at build — internal API calls will not include the bearer header");
    }
  }
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = function patchedFetch(input, init) {
    let url: string | null = null;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.pathname + input.search;
    else if (input && typeof input === "object" && "url" in input) {
      try { url = new URL((input as Request).url, window.location.origin).pathname; } catch { /* ignore */ }
    }
    if (url && INTERNAL_PATH_RE.test(url)) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (TOKEN && !headers.has("Authorization") && !headers.has("authorization")) {
        headers.set("Authorization", `Bearer ${TOKEN}`);
      }
      const entityId = readEntitySessionId();
      if (entityId && !headers.has("X-Entity-ID") && !headers.has("x-entity-id")) {
        headers.set("X-Entity-ID", entityId);
      }
      return original(input, { ...(init || {}), headers });
    }
    return original(input, init);
  };
}
