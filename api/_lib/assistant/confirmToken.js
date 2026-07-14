// P28-4-1 — the assistant draft-action confirmation token.
//
// A compact, HMAC-SHA256-signed envelope that binds a previewed action to the
// EXACT write it will perform and to the operator who previewed it. It is the
// bridge between the two Phase-4 trust boundaries (arch doc §5, §6):
//   - model↔server produces a PREVIEW + this token (read-only, safe);
//   - client↔server /confirm consumes the token and performs the write.
//
// Reuses the appJwt.js HMAC primitive pattern verbatim (createHmac("sha256") +
// timingSafeEqual + base64url) — NO new crypto scheme, NO added dependency.
//
// GATING — fail-closed, exactly like appJwt.isAppJwtEnabled(): with no secret
// configured, signConfirmToken() returns null and verifyConfirmToken() rejects
// everything, so write actions are simply UNAVAILABLE (preview still works;
// /confirm 503s). Zero behavior change until the env var is set.
//
// Secret: TANGERINE_ACTION_CONFIRM_SECRET (dedicated), falling back to the
// appJwt secret (TANGERINE_JWT_SECRET / SUPABASE_JWT_SECRET) so an already-
// provisioned environment activates the moment either is present.
//
// Envelope (arch doc §6.1, with one documented refinement):
//   { iss:"tangerine-assistant-confirm", act, ph, pl, sub, ent, jti, iat, exp }
//   - act : action name (globally-unique registry key)
//   - ph  : sha256Hex(canonicalJSON(commit_payload)) — the doc's integrity
//           assertion; binds the EXACT write.
//   - pl  : the commit_payload itself, carried INSIDE the signed envelope.
//           Refinement over §6.1 (which lists only `ph`): without a server-side
//           confirmation store — deferred to P28-4-2 per §6.3 / D5 — the payload
//           must survive the round-trip through the client without being
//           trusted. Carrying it under the HMAC signature makes it tamper-proof
//           (strictly stronger than re-sending an unsigned payload + hashing),
//           and `ph` is retained and still re-checked when the client echoes a
//           payload (see validateConfirmedAction). Replace with the store in
//           P28-4-2 if payload size ever matters.
//   - sub : the auth_user_id who previewed = who must confirm.
//   - ent : entity id the preview ran under.
//   - jti : single-use replay id (replay STORE deferred to P28-4-2).
//
// Pure — fully unit-testable (nowSec is injectable for deterministic expiry).

import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";

const ALG = "HS256";
const ISS = "tangerine-assistant-confirm";
const DEFAULT_TTL_SEC = 5 * 60; // 5 min — short confirm window (arch doc §6.2 / D7).

/** The confirmation-signing secret. Dedicated var first, then the appJwt
 *  secret so an environment that already signs per-user JWTs activates. */
export function confirmSecret() {
  return process.env.TANGERINE_ACTION_CONFIRM_SECRET
    || process.env.TANGERINE_JWT_SECRET
    || process.env.SUPABASE_JWT_SECRET
    || "";
}

/** Is the confirm handshake configured? (Fail-closed gate.) */
export function isConfirmEnabled() {
  return confirmSecret().length > 0;
}

/** Stable-key-sorted JSON — the canonical form the hash is taken over, so
 *  semantically-equal payloads always hash identically regardless of key
 *  order. Arrays keep their order; `undefined` members are dropped. */
export function canonicalJSON(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = sortKeys(v[k]);
    }
    return out;
  }
  return v;
}

/** Hex SHA-256 of a string. */
export function sha256Hex(str) {
  return createHash("sha256").update(String(str)).digest("hex");
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/**
 * Mint a confirmation token binding `commit_payload` to the previewing
 * operator. Returns the token string, or null when no secret is configured
 * (fail-closed) or the payload is malformed.
 *
 * @param payload  { act, commit_payload, sub, ent, jti? }
 * @param opts     { ttlSec?, nowSec? } — nowSec injectable for tests
 */
export function signConfirmToken(payload, { ttlSec = DEFAULT_TTL_SEC, nowSec } = {}) {
  const sec = confirmSecret();
  if (!sec) return null;
  const { act, commit_payload, sub, ent, jti } = payload || {};
  if (!act || typeof act !== "string") return null;

  const iat = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const exp = iat + Math.max(1, Math.floor(ttlSec));
  const header = { alg: ALG, typ: "JWT" };
  const body = {
    iss: ISS,
    act,
    ph: sha256Hex(canonicalJSON(commit_payload ?? null)),
    pl: commit_payload ?? null,
    sub: sub || null,
    ent: ent || null,
    jti: jti || randomUUID(),
    iat,
    exp,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(body)}`;
  const sig = createHmac("sha256", sec).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

/**
 * Verify a confirmation token (local HMAC check, timing-safe). Returns the
 * claims { act, ph, pl, sub, ent, jti, iat, exp } on a valid, unexpired,
 * correctly-signed token with our own issuer; null otherwise. NEVER throws.
 */
export function verifyConfirmToken(token, { nowSec } = {}) {
  const sec = confirmSecret();
  if (!sec || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const expected = createHmac("sha256", sec).update(`${h}.${p}`).digest("base64url");
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const body = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    const now = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
    if (body.iss !== ISS) return null;
    if (typeof body.exp !== "number" || body.exp <= now) return null;
    if (typeof body.act !== "string" || !body.act) return null;
    if (typeof body.ph !== "string" || !body.ph) return null;
    return {
      act: body.act,
      ph: body.ph,
      pl: body.pl ?? null,
      sub: body.sub ?? null,
      ent: body.ent ?? null,
      jti: body.jti ?? null,
      iat: body.iat,
      exp: body.exp,
    };
  } catch {
    return null;
  }
}
