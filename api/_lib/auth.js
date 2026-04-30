// api/_lib/auth.js
//
// Tiny shared auth helper for Vercel serverless handlers. Validates a
// Supabase JWT from the Authorization header and (optionally) resolves
// the caller to a vendor_users / users row.
//
// The pattern was duplicated across searates-proxy and a couple of
// other handlers; this file consolidates it so new handlers (e.g.
// dropbox-proxy lockdown) can opt in with one line.
//
// Usage:
//   const auth = await authenticateCaller(req, admin);
//   if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
//   // auth.authId is now safe to use; never trust caller-supplied ids.
//
// Path prefixed with _ so Vercel does not treat it as a function.

import { timingSafeEqual } from "node:crypto";

export async function authenticateCaller(req, admin) {
  const header = req.headers?.authorization || "";
  const jwt = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!jwt) {
    return { ok: false, status: 401, error: "Missing bearer token", authId: null };
  }
  let authId = null;
  try {
    const { data } = await admin.auth.getUser(jwt);
    authId = data?.user?.id ?? null;
  } catch {
    authId = null;
  }
  if (!authId) {
    return { ok: false, status: 401, error: "Invalid or expired token", authId: null };
  }
  return { ok: true, status: 200, error: null, authId };
}

// Resolve auth_id → vendor_users.{id, vendor_id}. Returns 403 when the
// authenticated user isn't a vendor user (e.g. internal staff).
export async function resolveVendorUser(admin, authId) {
  const { data, error } = await admin
    .from("vendor_users")
    .select("id, vendor_id, status")
    .eq("auth_id", authId)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 500, error: `vendor_users lookup failed: ${error.message}`, vendorUser: null };
  }
  if (!data) {
    return { ok: false, status: 403, error: "Caller is not a vendor user", vendorUser: null };
  }
  if (data.status && data.status !== "active") {
    return { ok: false, status: 403, error: `Vendor user status is "${data.status}" — access denied`, vendorUser: null };
  }
  return { ok: true, status: 200, error: null, vendorUser: data };
}

// Reject path inputs that try to escape a vendor's allowed root or
// otherwise smuggle directives into Dropbox / S3 path parameters.
// Use for caller-supplied path strings that are forwarded to a
// 3rd-party storage API.
export function isSafeDropboxPath(p) {
  if (!p || typeof p !== "string") return false;
  if (p.length > 1024) return false;
  if (p.includes("..")) return false;
  if (!/^\//.test(p)) return false;
  if (/[\x00-\x1f]/.test(p)) return false; // control chars
  return true;
}

// Internal-API gate. Stop-gap until per-user Supabase Auth is rolled
// out for internal staff (today they live as a JSON blob in
// app_data["users"]). When INTERNAL_API_TOKEN is set, every request
// hitting an /api/internal/** handler MUST present the matching
// `Authorization: Bearer <token>` (or `X-Internal-Token: <token>`
// for legacy callers). When the env var is unset, requests pass
// through with a console.warn — same rollout pattern as the EDI
// shared secret. Once the token is set in Vercel, any caller that
// doesn't include it gets a 401.
//
// Returns the same { ok, status, error } shape as authenticateCaller.
export function authenticateInternalCaller(req) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    // Soft-warn on first hit so we know which routes need the token
    // wired into clients. Don't spam — once-per-process is enough.
    if (!authenticateInternalCaller._warned) {
      console.warn("[internal-auth] INTERNAL_API_TOKEN not set — internal handlers are open. Set the env var and re-deploy to enable token-gated access.");
      authenticateInternalCaller._warned = true;
    }
    return { ok: true, status: 200, error: null, mode: "open" };
  }
  const header = req.headers?.authorization || "";
  const xToken = req.headers?.["x-internal-token"];
  let presented = null;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    presented = header.slice(7).trim();
  } else if (typeof xToken === "string" && xToken.length > 0) {
    presented = xToken.trim();
  }
  if (!presented) {
    return { ok: false, status: 401, error: "Missing internal token", mode: "denied" };
  }
  // Constant-time-ish compare. Node has crypto.timingSafeEqual but
  // length-mismatched buffers throw; pad short presented to match.
  if (presented.length !== expected.length) {
    return { ok: false, status: 401, error: "Invalid internal token", mode: "denied" };
  }
  let ok = 0;
  for (let i = 0; i < expected.length; i++) {
    ok |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  if (ok !== 0) {
    return { ok: false, status: 401, error: "Invalid internal token", mode: "denied" };
  }
  return { ok: true, status: 200, error: null, mode: "token" };
}

// Constant-time bearer-token gate for the Design Calendar scriptable
// API surface (the three endpoints driven by the daily-design-calendar-sync
// skill). Distinct from authenticateInternalCaller because:
//   • the skill always presents `Authorization: Bearer <token>` — no
//     legacy X-Internal-Token alias
//   • the token is mandatory (no soft-warn fallback) once the env var
//     is set; if the env var is missing the endpoint returns 500 so
//     callers don't accidentally hit an open production endpoint
//   • compare uses crypto.timingSafeEqual on byte buffers, which is the
//     standard primitive Node provides for token compares
//
// Returns the same { ok, status, error } shape as the other helpers.
export function authenticateDesignCalendarCaller(req) {
  const expected = (process.env.DESIGN_CALENDAR_API_TOKEN || "").trim();
  if (!expected) {
    return { ok: false, status: 500, error: "DESIGN_CALENDAR_API_TOKEN not configured" };
  }
  const header = req.headers?.authorization || "";
  const presented = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : "";
  if (!presented) {
    return { ok: false, status: 401, error: "Missing bearer token" };
  }
  // crypto.timingSafeEqual throws on length mismatch, so we have to
  // length-check first. The length itself is not secret — leaking it
  // via an early return doesn't help an attacker any more than the
  // 32-byte-hex documented format already does.
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected,  "utf8");
  if (a.length !== b.length) {
    return { ok: false, status: 401, error: "Invalid bearer token" };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "Invalid bearer token" };
  }
  return { ok: true, status: 200, error: null };
}

// Tiny in-memory rate limiter, scoped to a single Vercel cold start.
// Vercel can spin up multiple instances so the budget is per-instance,
// not strictly global — fine for the daily-sync use case (60 req/hour
// is the documented ceiling and one cron tick uses ~3 calls). Keyed on
// caller identity (token tail or IP) so unauthenticated traffic can't
// burn the same budget as a legitimate caller.
//
// Returns { ok: true } or { ok: false, status: 429, error, retry_after_s }.
const _rateBuckets = new Map();
export function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const bucket = _rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    _rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, reset_at: now + windowMs };
  }
  if (bucket.count >= limit) {
    return {
      ok: false,
      status: 429,
      error: `Rate limit exceeded (${limit} req per ${Math.round(windowMs / 1000)}s)`,
      retry_after_s: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  bucket.count++;
  return { ok: true, remaining: limit - bucket.count, reset_at: bucket.resetAt };
}

// Test-only: clear the rate-limit state so unit tests can run
// independent buckets. Not exported via any handler path.
export function _resetRateLimitForTests() {
  _rateBuckets.clear();
}
