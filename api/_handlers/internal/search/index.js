// api/internal/search
//
// Tangerine T6-2 — Global full-text search across all 11 v1 entities.
//
// GET /api/internal/search?q=<query>&limit=<N>
//
// Backed by the `global_search(q, max_results)` RPC defined in
// supabase/migrations/20260624000000_t6_chunk2_global_search_view.sql.
//
// Auth: Bearer JWT required (401 otherwise). The Supabase client is
// constructed with the user's JWT so the RPC runs with SECURITY INVOKER
// against the caller's RLS — they only see results from rows they would
// already be allowed to SELECT.
//
// Validation:
//   - q is required; must be ≥ 2 and ≤ 200 chars after trim.
//   - limit defaults to 30; clamped to [1, 100].
//
// Response:
//   { results: [ { entity_type, entity_id, title, subtitle, rank, route_hint }, ... ] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const Q_MIN = 2;
const Q_MAX = 200;
const LIMIT_DEFAULT = 30;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function extractJwt(authHeader) {
  if (!authHeader || typeof authHeader !== "string") return null;
  if (!authHeader.startsWith("Bearer ")) return null;
  const jwt = authHeader.slice(7).trim();
  return jwt || null;
}

/**
 * Validate + normalize the search query string and limit.
 *
 * @param {URLSearchParams} params
 * @returns {{ error: string } | { data: { q: string, limit: number } }}
 */
export function validateQuery(params) {
  const qRaw = params.get("q");
  if (qRaw == null) return { error: "q is required" };
  const q = String(qRaw).trim();
  if (q.length < Q_MIN) {
    return { error: `q must be at least ${Q_MIN} characters` };
  }
  if (q.length > Q_MAX) {
    return { error: `q must be at most ${Q_MAX} characters` };
  }

  const limitRaw = params.get("limit");
  let limit = LIMIT_DEFAULT;
  if (limitRaw != null && limitRaw !== "") {
    const parsed = parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed)) {
      return { error: "limit must be an integer" };
    }
    limit = parsed;
  }
  limit = Math.min(Math.max(limit, LIMIT_MIN), LIMIT_MAX);

  return { data: { q, limit } };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const jwt = extractJwt(req.headers && req.headers.authorization);
  if (!jwt) return res.status(401).json({ error: "Authentication required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!SB_URL || !ANON_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }

  // User-scoped client so SECURITY INVOKER RLS applies inside the RPC.
  const userClient = createClient(SB_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = validateQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  const { data, error } = await userClient.rpc("global_search", {
    q: v.data.q,
    max_results: v.data.limit,
  });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ results: data || [] });
}
