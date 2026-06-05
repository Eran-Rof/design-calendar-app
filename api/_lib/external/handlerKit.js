// api/_lib/external/handlerKit.js
//
// Shared plumbing for the READ-ONLY external/partner API (/api/external/v1/*):
//   • service-role Supabase client
//   • CORS headers
//   • API-key gate (401 without a valid active key)
//   • limit/offset pagination (cap 200)
//
// Each external endpoint is GET-only, entity-scoped (to the key's entity_id),
// JSON, and returns HUMAN labels (codes/names) — never raw uuids where a code
// or name exists.

import { createClient } from "@supabase/supabase-js";
import { authenticateApiKey } from "./apiKeyAuth.js";

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

export function externalClient() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export function externalCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

/** Parse limit/offset from the request query, clamped to [1, MAX_LIMIT] / >=0. */
export function parsePaging(req) {
  const q = req.query || {};
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let offset = parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

/**
 * Wrap an external endpoint: enforce GET, CORS, configured server, and a valid
 * API key. Calls `run({ req, res, admin, auth, limit, offset })` on success.
 * `auth` = { entity_id, scopes, key_id }.
 */
export function withApiKey(run) {
  return async function handler(req, res) {
    externalCors(res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "method_not_allowed" });
    }
    const admin = externalClient();
    if (!admin) return res.status(500).json({ error: "server_not_configured" });

    const auth = await authenticateApiKey(admin, req);
    if (!auth) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "unauthorized", message: "Missing or invalid API key." });
    }
    const { limit, offset } = parsePaging(req);
    try {
      return await run({ req, res, admin, auth, limit, offset });
    } catch (e) {
      return res.status(500).json({ error: "internal_error", message: String(e?.message || e) });
    }
  };
}

/** Standard paginated JSON envelope. */
export function pageEnvelope(res, { data, limit, offset }) {
  return res.status(200).json({
    data,
    paging: { limit, offset, count: Array.isArray(data) ? data.length : 0 },
  });
}
