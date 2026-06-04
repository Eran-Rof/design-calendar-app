// api/internal/users-access/me
//
// P14-4 — the CALLER's own effective permissions, for client-side menu hiding.
//
// GET → { mode, entity_id, permissions: ["module:action", …] }
//   mode        = RBAC_MODE on the server ("off" | "log" | "enforce").
//   permissions = the flattened v_effective_permissions for this user+entity.
//
// Identity: the internal apps don't (yet) hold a Supabase JWT in the browser —
// they cache the provisioned auth_user_id (see src/utils/tangerineAuthUser).
// So this endpoint reads that id from the `X-Auth-User-Id` header (or
// ?auth_user_id=). This is a UX-only surface: the SERVER still enforces every
// write/read via rbacEnforce, so a spoofed id at worst changes which menu items
// *you* see — it can never grant access. That's why this endpoint is NOT gated
// (a non-admin must be able to read their OWN permissions to hide their own
// menus; gating it on users_access would 403 exactly the users we filter for).
//
// The client treats menu-hiding as INERT unless `mode === "enforce"`, so this
// is a no-op today (RBAC_MODE defaults off) — zero behavior change.

import { createClient } from "@supabase/supabase-js";
import { rbacMode, loadEffectivePermissions } from "../../../_lib/rbac/index.js";

export const config = { maxDuration: 10 };

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

// The cached supabase auth_user_id, from header or query. Returns null if absent
// or malformed (client then fail-opens — shows all menus).
export function readAuthUserId(req) {
  const h = req?.headers || {};
  const raw = h["x-auth-user-id"] ?? h["X-Auth-User-Id"] ?? req?.query?.auth_user_id ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return UUID_RE.test(s) ? s : null;
}

async function resolveEntityId(admin, req) {
  const q = req.query?.entity_id;
  if (typeof q === "string" && UUID_RE.test(q)) return q;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const mode = rbacMode();
  const admin = client();
  // Always return mode so the client can decide whether to filter at all. If we
  // can't resolve anything, return empty perms — but only `enforce` mode makes
  // the client act on them, so this stays inert when off/log.
  if (!admin) return res.status(200).json({ mode, entity_id: null, permissions: [] });

  const authUserId = readAuthUserId(req);
  if (!authUserId) return res.status(200).json({ mode, entity_id: null, permissions: [] });

  const entityId = await resolveEntityId(admin, req);
  if (!entityId) return res.status(200).json({ mode, entity_id: null, permissions: [] });

  const perms = await loadEffectivePermissions(admin, authUserId, entityId);
  return res.status(200).json({
    mode,
    entity_id: entityId,
    permissions: Array.from(perms).sort(),
  });
}
