// api/_lib/vendor-auth.js
//
// Unified vendor authentication.
//
//   authenticateVendor(admin, req, { requiredScope? })
//
// Accepts either:
//   - Authorization: Bearer <supabase_jwt>   (human user session)
//   - X-API-Key: <raw_key>                   (programmatic key)
//   - Authorization: Bearer vnd_...          (programmatic key via Bearer)
//
// Returns { ok: true, auth: { type, vendor_id, vendor_user_id?, scopes, api_key_id?, role? } }
// Or     { ok: false, status, error }
//
// If requiredScope is passed and the caller is an API key, the key's
// scopes must include that scope (or a matching wildcard like "catalog:*").
// If the caller is a JWT session, all scopes are allowed (human user).
//
// Side effects:
//   - On successful API-key auth, updates last_used_at on the key row
//     and writes a vendor_api_logs entry (fire-and-forget).

import { verifyApiKey, keyPrefixFromRaw } from "./api-key.js";

function extractKey(req) {
  const h = req.headers || {};
  const xApiKey = h["x-api-key"] || h["X-API-Key"];
  if (typeof xApiKey === "string" && xApiKey.startsWith("vnd_")) return { kind: "api_key", value: xApiKey };
  const authHeader = h.authorization || h.Authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.startsWith("vnd_")) return { kind: "api_key", value: token };
    return { kind: "jwt", value: token };
  }
  return null;
}

async function resolveJwt(admin, token) {
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return null;
    const { data: vu } = await admin
      .from("vendor_users")
      .select("id, vendor_id, display_name, role")
      .eq("auth_id", data.user.id)
      .maybeSingle();
    if (!vu) return null;
    return { ...vu, auth_id: data.user.id, email: data.user.email };
  } catch { return null; }
}

async function resolveApiKey(admin, raw) {
  const prefix = keyPrefixFromRaw(raw);
  if (!prefix) return null;
  const { data: row } = await admin
    .from("vendor_api_keys")
    .select("id, vendor_id, key_hash, scopes, expires_at, revoked_at")
    .eq("key_prefix", prefix)
    .maybeSingle();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (!verifyApiKey(raw, row.key_hash)) return null;
  return row;
}

function scopeMatches(granted, required) {
  if (!required) return true;
  if (!Array.isArray(granted) || granted.length === 0) return false;
  if (granted.includes(required) || granted.includes("*")) return true;
  const [resource] = required.split(":");
  return granted.includes(`${resource}:*`);
}

function logApiCall(admin, apiKeyRow, req, status, { durationMs, errorMessage } = {}) {
  try {
    const url = (req.url || "").split("?")[0];
    admin.from("vendor_api_logs").insert({
      api_key_id: apiKeyRow.id,
      vendor_id: apiKeyRow.vendor_id,
      endpoint: url,
      method: req.method || "UNKNOWN",
      status_code: status,
      ip_address: (req.headers?.["x-forwarded-for"] || "").toString().split(",")[0].trim() || null,
      request_id: req.headers?.["x-vercel-id"] || null,
      duration_ms: durationMs ?? null,
      error_message: errorMessage || null,
    }).then(() => {}, () => {});
  } catch { /* swallow */ }
  try {
    admin.from("vendor_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", apiKeyRow.id).then(() => {}, () => {});
  } catch { /* swallow */ }
}

export async function authenticateVendor(admin, req, { requiredScope } = {}) {
  const cred = extractKey(req);
  if (!cred) return { ok: false, status: 401, error: "Authentication required" };

  if (cred.kind === "jwt") {
    const user = await resolveJwt(admin, cred.value);
    if (!user) return { ok: false, status: 401, error: "Invalid or expired token" };
    return {
      ok: true,
      auth: {
        type: "jwt",
        vendor_id: user.vendor_id,
        vendor_user_id: user.id,
        auth_id: user.auth_id,
        display_name: user.display_name,
        email: user.email,
        role: user.role,
        scopes: ["*"],
      },
    };
  }

  const keyRow = await resolveApiKey(admin, cred.value);
  if (!keyRow) return { ok: false, status: 401, error: "Invalid, expired, or revoked API key" };

  if (!scopeMatches(keyRow.scopes, requiredScope)) {
    logApiCall(admin, keyRow, req, 403, { errorMessage: `Missing scope ${requiredScope}` });
    return { ok: false, status: 403, error: `API key missing required scope: ${requiredScope}` };
  }

  // Log the successful auth with status 200 on completion — but we don't
  // know the final status yet. Defer logging to the caller via finish().
  return {
    ok: true,
    auth: {
      type: "api_key",
      vendor_id: keyRow.vendor_id,
      api_key_id: keyRow.id,
      scopes: keyRow.scopes || [],
    },
    finish(status, extras) {
      logApiCall(admin, keyRow, req, status, extras);
    },
  };
}

export function requireAdmin(auth) {
  if (!auth) return false;
  if (auth.type !== "jwt") return false; // API keys can't manage keys
  return auth.role === "primary" || auth.role === "admin";
}
