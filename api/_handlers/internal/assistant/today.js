// api/internal/assistant/today
//
// P28-1-2 — the Today page aggregate. Runs every registered capability
// pack (api/_lib/assistant/registry.js) and returns the caller's merged,
// RBAC-filtered, dismissal-filtered payload:
//   { greeting, mode, todos[], processes[], suggestions[], insights[], errors[] }
//
// RBAC: like users-access/me this route is deliberately UNMAPPED in
// routePermissions.js — the payload SELF-FILTERS by the caller's own
// v_effective_permissions (aggregator lens), which is the same fail-open
// contract menu-hiding uses:
//   - RBAC_MODE !== "enforce"  → no filtering (permissions = null)
//   - no resolvable user id    → no filtering (legacy PLM-session path)
//   - enforce + identified     → items gated on <module_key>:read
// A spoofed X-Auth-User-Id at worst changes which SUMMARY COUNTS you see;
// every drill target the page links to is enforced server-side by
// rbacEnforce on its own routes.

import { createClient } from "@supabase/supabase-js";
import { rbacMode, loadEffectivePermissions } from "../../../_lib/rbac/index.js";
import { buildToday, todayISO } from "../../../_lib/assistant/today.js";

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

async function resolveEntityId(admin, req) {
  const h = req?.headers || {};
  const fromHeader = String(h["x-entity-id"] ?? h["X-Entity-ID"] ?? "").trim();
  if (UUID_RE.test(fromHeader)) return fromHeader;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

/** Greeting display name: employees link first, cached-provision name is the
 *  client's own fallback. Never throws — greeting is decoration.           */
async function resolveDisplayName(admin, authUserId) {
  if (!authUserId) return null;
  try {
    const { data } = await admin
      .from("employees")
      .select("display_name, first_name")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    return data?.first_name || data?.display_name || null;
  } catch {
    return null;
  }
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

  const mode = rbacMode();
  const authUserId = readAuthUserId(req);
  const entityId = await resolveEntityId(admin, req);
  const day = todayISO();

  // Permission lens: only enforce-mode + identified callers get filtered
  // (mirrors useEffectivePermissions' inert-unless-enforce contract).
  let permissions = null;
  if (mode === "enforce" && authUserId && entityId) {
    permissions = await loadEffectivePermissions(admin, authUserId, entityId);
  }

  // Today's dismissals for this user (item keys hidden until tomorrow).
  const dismissedKeys = new Set();
  if (authUserId) {
    try {
      const { data } = await admin
        .from("assistant_dismissals")
        .select("item_key")
        .eq("user_id", authUserId)
        .eq("dismissed_on", day)
        .limit(500);
      for (const r of data || []) dismissedKeys.add(r.item_key);
    } catch { /* dismissals are best-effort */ }
  }

  const [payload, name] = await Promise.all([
    buildToday(admin, { userId: authUserId, entityId, permissions, dismissedKeys, todayISO: day }),
    resolveDisplayName(admin, authUserId),
  ]);

  return res.status(200).json({
    greeting: { name, date: day },
    mode,
    can_dismiss: Boolean(authUserId),
    ...payload,
  });
}
