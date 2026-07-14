// api/internal/assistant/today
//
// P28-1-2 — the Today page aggregate. Runs every registered capability
// pack (api/_lib/assistant/registry.js) and returns the caller's merged,
// RBAC-filtered, dismissal-filtered payload:
//   { greeting, mode, todos[], processes[], suggestions[], insights[], errors[] }
//
// RBAC: like users-access/me this route is deliberately UNMAPPED in
// routePermissions.js — the payload SELF-FILTERS by the caller's own
// v_effective_permissions (the shared lens in _lib/assistant/context.js),
// the same fail-open contract menu-hiding uses. A spoofed X-Auth-User-Id
// at worst changes which SUMMARY COUNTS you see; every drill target the
// page links to is enforced server-side by rbacEnforce on its own routes.
//
// P28-2 refactor: identity/permission/dismissal resolution moved to
// _lib/assistant/context.js so the brief handler + the ask-grid
// get_today executor share identical semantics.

import { createClient } from "@supabase/supabase-js";
import { rbacMode } from "../../../_lib/rbac/index.js";
import { buildTodayForUser, resolveDisplayName } from "../../../_lib/assistant/context.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function readAuthUserId(req) {
  const h = req?.headers || {};
  const raw = h["x-auth-user-id"] ?? h["X-Auth-User-Id"] ?? req?.query?.auth_user_id ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return UUID_RE.test(s) ? s : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const authUserId = readAuthUserId(req);
  const h = req.headers || {};
  const entityHint = String(h["x-entity-id"] ?? h["X-Entity-ID"] ?? "").trim() || null;

  const [{ day, payload }, name] = await Promise.all([
    buildTodayForUser(admin, { authUserId, entityHint }),
    resolveDisplayName(admin, authUserId),
  ]);

  return res.status(200).json({
    greeting: { name, date: day },
    mode: rbacMode(),
    can_dismiss: Boolean(authUserId),
    ...payload,
  });
}
