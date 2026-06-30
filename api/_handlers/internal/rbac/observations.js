// api/internal/rbac/observations
//
// P27 Phase 5 warm-up — the RBAC coverage report. Returns the aggregated
// would-deny observations recorded by rbacObserve() while RBAC_MODE='log', so
// the operator can see exactly which users would lose which module:action under
// 'enforce' and grant those permissions BEFORE flipping the gate. Read-only.
//
// GET /api/internal/rbac/observations
//   200 { mode, count, rows: [{ email, auth_id, module_key, action, method,
//          hits, first_seen, last_seen }] }  (sorted hits desc)
//
// Gated by the internal token (admin observability), same as other internal reads.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { rbacMode } from "../../../_lib/rbac/index.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
}

function client() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin
    .from("rbac_observations")
    .select("auth_id, module_key, action, method, sample_path, hits, first_seen, last_seen")
    .order("hits", { ascending: false })
    .limit(1000);
  if (error) return res.status(500).json({ error: error.message });

  // Resolve auth_id → email (one tiny listUsers page; staff list is small).
  const idToEmail = new Map();
  try {
    const { data: u } = await admin.auth.admin.listUsers({ perPage: 200, page: 1 });
    for (const usr of u?.users || []) idToEmail.set(usr.id, usr.email || null);
  } catch { /* email is best-effort enrichment */ }

  const rows = (data || []).map((r) => ({
    email: idToEmail.get(r.auth_id) || null,
    auth_id: r.auth_id,
    module_key: r.module_key,
    action: r.action,
    method: r.method,
    hits: Number(r.hits) || 0,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  }));

  return res.status(200).json({ mode: rbacMode(), count: rows.length, rows });
}
