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
// Idempotent — installing twice is a no-op.

const TOKEN = (import.meta as ImportMeta & { env?: Record<string, string> })
  .env?.VITE_INTERNAL_API_TOKEN ?? "";

const INTERNAL_PATH_RE = /^\/api\/internal\//;

let installed = false;

export function installInternalApiAuth(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (!TOKEN) {
    // No token configured at build time. The server may still be
    // fail-open (matching) or strict; surface a console.warn once so
    // a frontend deploy without VITE_INTERNAL_API_TOKEN doesn't
    // silently 401.
    if (typeof console !== "undefined") {
      console.warn("[internal-api] VITE_INTERNAL_API_TOKEN not set at build — internal API calls will not include the bearer header");
    }
    return;
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
      if (!headers.has("Authorization") && !headers.has("authorization")) {
        headers.set("Authorization", `Bearer ${TOKEN}`);
      }
      return original(input, { ...(init || {}), headers });
    }
    return original(input, init);
  };
}
