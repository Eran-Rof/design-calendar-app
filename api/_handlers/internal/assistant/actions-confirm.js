// api/internal/assistant/actions/confirm
//
// P28-4-1 — the WRITE boundary of the assistant draft-action handshake
// (arch doc §5.3). This is the ONLY place a drafted action commits, and it
// re-establishes every trust guarantee the same-origin ask-grid loop cannot:
//
//   1. Authenticate a REAL identity (per-user JWT, else the SPA-injected
//      X-Auth-User-Id header — exactly what the JE handler trusts as the maker
//      id). It NEVER trusts body.user_id.
//   2. Verify the confirmation token (timing-safe HMAC, not expired, issuer),
//      and require token.sub === the authenticated caller.
//   3. Re-check RBAC AUTHORITATIVELY (loadEffectivePermissions + the action's
//      module_key:required_action) — advisory at preview, authoritative here.
//   4. Enforce preview == commit: the token carries the signed commit_payload
//      (ph binds its canonical hash); if the caller re-sends a payload it must
//      hash to ph (409 on drift).
//   5. action.commit(admin, commit_payload, ctx) — the ONLY write point. For
//      money-moving actions (later chunks) commit wraps requestIfRequired and
//      the response relays the underlying result, incl the HTTP 202 held state.
//
// Fail-closed: with no confirm secret configured the endpoint 503s (writes
// unavailable) while preview keeps working.
//
// This segment ("assistant") is deliberately UNMAPPED in routePermissions.js
// (like today/dismiss), so the dispatcher does NOT gate it — the authoritative
// RBAC check lives INSIDE this handler against the action's own module_key.
//
// In P28-4-1 no pack ships an action, so there is nothing real to commit yet;
// the endpoint is wired fully and exercised by tests via a fixture action.

import { createClient } from "@supabase/supabase-js";
import { resolveUserId } from "../../../_lib/auth.js";
import { resolveEntityId } from "../../../_lib/assistant/context.js";
import { todayISO } from "../../../_lib/assistant/today.js";
import { rbacMode, loadEffectivePermissions, isAllowed } from "../../../_lib/rbac/index.js";
import { actionByName } from "../../../_lib/assistant/registry.js";
import {
  verifyConfirmToken, isConfirmEnabled, sha256Hex, canonicalJSON,
} from "../../../_lib/assistant/confirmToken.js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Pure token + payload validation (exported for tests). Does NOT touch the DB
 * or RBAC — the handler layers the authoritative RBAC check + commit on top.
 *
 * @param token          the confirmation token string
 * @param commit_payload optional re-sent payload (drift-checked when present)
 * @param callerId       the AUTHENTICATED caller's auth_user_id
 * @param packs          optional fixture registry (tests); prod omits
 * @param nowSec         injectable clock for deterministic expiry tests
 * @returns { ok, status, error?, action?, claims?, commit_payload? }
 */
export function validateConfirmedAction({ token, commit_payload, callerId, packs, nowSec } = {}) {
  if (!isConfirmEnabled()) return { ok: false, status: 503, error: "confirm_unavailable" };
  const claims = verifyConfirmToken(token, { nowSec });
  if (!claims) return { ok: false, status: 401, error: "invalid_or_expired_token" };
  if (!callerId || claims.sub !== callerId) return { ok: false, status: 403, error: "identity_mismatch" };
  const action = actionByName(claims.act, packs);
  if (!action) return { ok: false, status: 404, error: "unknown_action" };
  if (typeof action.commit !== "function") return { ok: false, status: 400, error: "action_not_committable" };

  // preview == commit. The token carries the signed payload (pl); if the
  // caller ALSO re-sends one it must hash to the signed ph (defense-in-depth).
  let payload = claims.pl;
  if (commit_payload !== undefined && commit_payload !== null) {
    const ph = sha256Hex(canonicalJSON(commit_payload));
    if (ph !== claims.ph) return { ok: false, status: 409, error: "payload_drift" };
    payload = commit_payload;
  }
  return { ok: true, status: 200, action, claims, commit_payload: payload };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Authenticate a REAL identity — never body.user_id.
  const who = await resolveUserId(req, admin);
  if (!who.ok || !who.authId) {
    return res.status(401).json({ error: "authentication_required" });
  }

  const body = req.body || {};
  // 2 + 4. Verify the token, bind it to the caller, enforce preview==commit.
  const v = validateConfirmedAction({
    token: body.token,
    commit_payload: body.commit_payload,
    callerId: who.authId,
  });
  if (!v.ok) return res.status(v.status).json({ error: v.error });

  const action = v.action;
  const h = req.headers || {};
  const headerEntity = String(h["x-entity-id"] ?? h["X-Entity-ID"] ?? "").trim() || null;
  const entityId = v.claims.ent || await resolveEntityId(admin, headerEntity);

  // 3. Authoritative RBAC re-check against the action's own module.
  if (rbacMode() === "enforce") {
    const need = action.required_action || "write";
    const perms = await loadEffectivePermissions(admin, who.authId, entityId);
    if (!isAllowed(perms, action.module_key, need)) {
      return res.status(403).json({ error: "permission_denied", module: action.module_key, action: need });
    }
  }

  // TODO(P28-4-2): replay store — record v.claims.jti as single-use (a small
  // assistant_action_confirmations table per arch doc §6.3 / open decision D5)
  // and reject a second presentation of the same jti. Short TTL is the interim
  // guard. Migration is intentionally NOT added in this chunk.

  // 5. commit() — the ONLY write point. Money actions (later chunks) route
  // through requestIfRequired inside commit and may return an HTTP 202 held
  // state, which we relay verbatim.
  try {
    const result = await action.commit(admin, v.commit_payload, {
      userId: who.authId,
      entityId,
      todayISO: todayISO(),
    });
    const status = Number.isInteger(result?.status) ? result.status : 200;
    const payload = (result && typeof result === "object" && "body" in result) ? result.body : result;
    return res.status(status).json(payload ?? { ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
