// api/_lib/auth/appJwt.js
//
// P14 JWT phase — mint + verify a Supabase-compatible per-user access token
// for internal staff, bridging the MS-OAuth login into a real per-user
// identity the server can verify.
//
// WHY a self-signed token instead of a GoTrue session:
//   The internal apps sign in via MS OAuth (PKCE) and provision an auth.users
//   row server-side (api/internal/auth/provision). supabase-js has no admin
//   "issue a session for user X" call, so we mint an HS256 JWT with the SAME
//   claims GoTrue uses (sub / role / aud / exp), signed with the project's
//   SUPABASE_JWT_SECRET. We then VERIFY it locally with the same secret — no
//   GoTrue round-trip — so the token is fully self-consistent and immune to the
//   legacy-vs-asymmetric-signing-key question. Because it carries standard
//   Supabase claims it ALSO works as a PostgREST/RLS bearer later if we adopt
//   per-user RLS.
//
// GATING: everything here is a NO-OP unless SUPABASE_JWT_SECRET is set on the
// server. provision then omits the token, the client has none, and the whole
// stack behaves exactly as before (cached auth_user_id stopgap). Set the env
// var to activate — zero behavior change until then.
//
// Pure Node crypto (HMAC-SHA256) — no dependency added.

import { createHmac, timingSafeEqual } from "node:crypto";

const ALG = "HS256";
const DEFAULT_TTL_SEC = 12 * 60 * 60; // 12h — re-minted on every MS sign-in.

function secret() {
  // The project JWT secret. Server-only (never VITE_-prefixed).
  return process.env.SUPABASE_JWT_SECRET || "";
}

/** Is per-user JWT minting/verification configured? */
export function isAppJwtEnabled() {
  return secret().length > 0;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64urlJson(obj) {
  return b64urlEncode(JSON.stringify(obj));
}

/**
 * Mint a Supabase-compatible HS256 access token for `authId`.
 * Returns { access_token, expires_in } or null when no secret is configured.
 */
export function signAppJwt(authId, { email = null, ttlSec = DEFAULT_TTL_SEC, nowSec } = {}) {
  const sec = secret();
  if (!sec || !authId) return null;
  // nowSec is injectable for deterministic tests; defaults to wall clock.
  const iat = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const exp = iat + ttlSec;
  const header = { alg: ALG, typ: "JWT" };
  const payload = {
    sub: authId,
    role: "authenticated",
    aud: "authenticated",
    email: email || undefined,
    iss: "tangerine-ms-bridge",
    iat,
    exp,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = createHmac("sha256", sec).update(signingInput).digest("base64url");
  return { access_token: `${signingInput}.${sig}`, expires_in: ttlSec };
}

/**
 * Verify a token we minted (local HMAC check). Returns { sub, email } on a
 * valid, unexpired, correctly-signed token; null otherwise. NEVER throws.
 *
 * Only accepts our own claim shape (role/aud = "authenticated", iss bridge) so
 * a foreign HS256 token signed with the same secret but a different purpose
 * isn't silently honoured as an internal session.
 */
export function verifyAppJwt(token, { nowSec } = {}) {
  const sec = secret();
  if (!sec || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const expected = createHmac("sha256", sec).update(`${h}.${p}`).digest("base64url");
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    const now = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= now) return null;
    if (payload.aud !== "authenticated" || payload.role !== "authenticated") return null;
    if (payload.iss !== "tangerine-ms-bridge") return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return { sub: payload.sub, email: payload.email || null };
  } catch {
    return null;
  }
}
