// api/internal/users-access
//
// P14 RBAC — Chunk 3b admin surface (matrix + role assignment).
//
// GET  /api/internal/users-access[?entity_id=…]
//        → the full access matrix for one entity:
//          { entity_id, modules[], roles[], users[] }
//        where each user carries their assigned role, per-cell overrides, and
//        flattened effective permissions ("module:action" strings).
//
// PUT  /api/internal/users-access
//        body { user_id, role_id } → assign / change a user's role in the
//        entity (upsert entity_user_roles). The single place a role is set.
//
// Writes go through the service-role key (bypasses RLS); the grant tables are
// anon-READ-ONLY as of 20260707010000, so the browser cannot rewrite roles
// directly — only this handler can, and the dispatcher gates it on
// users_access:write when RBAC_MODE=enforce.
//
// Per-cell override grant/revoke lives in the sibling ./override.js handler.

import { createClient } from "@supabase/supabase-js";
import { TANGERINE_MODULES } from "../../../_lib/tangerineModules.js";
import { CAPABILITY_MODULES } from "../../../_lib/capabilityModules.js";

export const config = { maxDuration: 15 };

// The User Access grid shows exactly the CURRENT Tangerine menu items (the
// generated nav mirror) PLUS the hand-curated cross-cutting capabilities
// (api/_lib/capabilityModules.js — e.g. `margins`) that are grantable but are
// not nav destinations. The DB module_keys table may carry stale legacy keys
// (e.g. product_master, coa) that are no longer in the nav — those are dropped
// from the grid. For keys that ARE current, any curated DB values
// (display_name / available_actions / sort_order) override the mirror default.
function mergeModules(dbRows) {
  const dbByKey = new Map((dbRows || []).map((r) => [r.key, r]));
  return [...TANGERINE_MODULES, ...CAPABILITY_MODULES]
    .map((m) => {
      const r = dbByKey.get(m.key);
      return {
        key: m.key,
        display_name: r?.display_name || m.display_name,
        group_name: r?.group_name || m.group_name,
        sort_order: m.sort_order,
        available_actions: r?.available_actions || m.available_actions,
      };
    })
    .sort((a, b) => (a.sort_order - b.sort_order) || a.key.localeCompare(b.key));
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === "string" && UUID_RE.test(s); }

// Resolve which entity the matrix is for. Explicit ?entity_id (uuid) wins;
// otherwise fall back to the single-tenant ROF entity (same pattern as the
// other internal handlers — single-tenant first, P10 multi-tenant later).
async function resolveEntityId(admin, req) {
  const q = req.query?.entity_id;
  if (isUuid(q)) return q;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

// Map auth.users id → email via the service-role admin API. Internal apps have
// a handful of users; one page (perPage 200) covers them. Never throws.
async function loadEmailMap(admin) {
  const map = {};
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of data?.users || []) map[u.id] = u.email || null;
  } catch { /* email is a nicety; matrix still works without it */ }
  return map;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveEntityId(admin, req);
  if (!entityId) return res.status(404).json({ error: "Entity not found" });

  if (req.method === "GET") {
    const [mods, roles, rolePerms, eur, eusers, overrides, eff, emails] = await Promise.all([
      admin.from("module_keys").select("key,display_name,group_name,sort_order,available_actions").order("sort_order"),
      admin.from("roles").select("id,name,description,is_seed").order("name"),
      admin.from("role_permissions").select("role_id,module_key,action").eq("allowed", true),
      admin.from("entity_user_roles").select("user_id,role_id").eq("entity_id", entityId),
      admin.from("entity_users").select("auth_id,role").eq("entity_id", entityId),
      admin.from("entity_user_role_overrides").select("user_id,module_key,action,allowed,reason").eq("entity_id", entityId),
      admin.from("v_effective_permissions").select("user_id,module_key,action").eq("entity_id", entityId),
      loadEmailMap(admin),
    ]);

    const firstErr = [mods, roles, rolePerms, eur, eusers, overrides, eff].find((r) => r.error);
    if (firstErr) return res.status(500).json({ error: firstErr.error.message });

    const roleById = new Map((roles.data || []).map((r) => [r.id, r]));
    const roleByUser = new Map((eur.data || []).map((r) => [r.user_id, r.role_id]));

    const overridesByUser = new Map();
    for (const o of overrides.data || []) {
      if (!overridesByUser.has(o.user_id)) overridesByUser.set(o.user_id, []);
      overridesByUser.get(o.user_id).push({
        module_key: o.module_key, action: o.action, allowed: o.allowed, reason: o.reason || null,
      });
    }

    const effByUser = new Map();
    for (const e of eff.data || []) {
      if (!effByUser.has(e.user_id)) effByUser.set(e.user_id, []);
      effByUser.get(e.user_id).push(`${e.module_key}:${e.action}`);
    }

    // Membership = entity_users rows (canonical). A member may have no
    // entity_user_roles row yet (e.g. provisioned after the backfill).
    const users = (eusers.data || []).map((m) => {
      const roleId = roleByUser.get(m.auth_id) || null;
      const role = roleId ? roleById.get(roleId) : null;
      return {
        user_id: m.auth_id,
        email: emails[m.auth_id] || null,
        legacy_role: m.role || null,
        role_id: roleId,
        role_name: role?.name || null,
        overrides: overridesByUser.get(m.auth_id) || [],
        effective: (effByUser.get(m.auth_id) || []).sort(),
      };
    }).sort((a, b) => (a.email || "").localeCompare(b.email || ""));

    // role_permissions grouped by role → lets the UI distinguish a role-default
    // cell from an explicit per-user override (and clear an override by toggling
    // a cell back to its role default).
    const roleGrants = {};
    for (const rp of rolePerms.data || []) {
      (roleGrants[rp.role_id] ||= []).push(`${rp.module_key}:${rp.action}`);
    }

    return res.status(200).json({
      entity_id: entityId,
      modules: mergeModules(mods.data),
      roles: roles.data || [],
      role_grants: roleGrants,
      users,
    });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateRoleAssignment(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Reject unknown role / non-member up front for a clean 400 (FK would 500).
    const [{ data: role }, { data: member }] = await Promise.all([
      admin.from("roles").select("id").eq("id", v.data.role_id).maybeSingle(),
      admin.from("entity_users").select("auth_id").eq("entity_id", entityId).eq("auth_id", v.data.user_id).maybeSingle(),
    ]);
    if (!role) return res.status(400).json({ error: "Unknown role_id" });
    if (!member) return res.status(400).json({ error: "User is not a member of this entity" });

    const { data, error } = await admin
      .from("entity_user_roles")
      .upsert(
        { entity_id: entityId, user_id: v.data.user_id, role_id: v.data.role_id, updated_at: new Date().toISOString() },
        { onConflict: "entity_id,user_id" }
      )
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PUT");
  return res.status(405).json({ error: "Method not allowed" });
}

// Exported for unit tests.
export function validateRoleAssignment(body) {
  if (!isUuid(body.user_id)) return { error: "user_id must be a uuid" };
  if (!isUuid(body.role_id)) return { error: "role_id must be a uuid" };
  return { data: { user_id: body.user_id, role_id: body.role_id } };
}
