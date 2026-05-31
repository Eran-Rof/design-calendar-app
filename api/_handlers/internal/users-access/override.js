// api/internal/users-access/override
//
// P14 RBAC — Chunk 3b: per-cell permission override (grant or revoke a single
// module×action for one user, on top of their role).
//
// PUT    body { user_id, module_key, action, allowed, reason? }
//          → upsert entity_user_role_overrides. allowed=true grants the cell,
//            allowed=false revokes it (a revoke wins over a role grant in
//            v_effective_permissions).
//
// DELETE body|query { user_id, module_key, action }
//          → remove the override, reverting the cell to the role default.
//
// Service-role write; grant tables are anon-read-only (20260707010000). Gated
// on users_access:write by the dispatcher when RBAC_MODE=enforce.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const ACTIONS = ["read", "write", "post", "void", "export"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === "string" && UUID_RE.test(s); }

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveEntityId(admin, req) {
  const q = req.query?.entity_id;
  if (isUuid(q)) return q;
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveEntityId(admin, req);
  if (!entityId) return res.status(404).json({ error: "Entity not found" });

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = await validateOverride(admin, body || {}, { requireAllowed: true });
    if (v.error) return res.status(400).json({ error: v.error });

    const { data, error } = await admin
      .from("entity_user_role_overrides")
      .upsert(
        {
          entity_id: entityId,
          user_id: v.data.user_id,
          module_key: v.data.module_key,
          action: v.data.action,
          allowed: v.data.allowed,
          reason: v.data.reason,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "entity_id,user_id,module_key,action" }
      )
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    // DELETE may carry params in the body or the query string.
    const src = { ...(body || {}), ...stripUndefined(req.query || {}) };
    const v = await validateOverride(admin, src, { requireAllowed: false });
    if (v.error) return res.status(400).json({ error: v.error });

    const { error } = await admin
      .from("entity_user_role_overrides")
      .delete()
      .eq("entity_id", entityId)
      .eq("user_id", v.data.user_id)
      .eq("module_key", v.data.module_key)
      .eq("action", v.data.action);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

function stripUndefined(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// Validates the override identity (user/module/action) and, when grantng,
// the allowed flag. Confirms the action is one the module actually exposes
// (available_actions) so we never persist an impossible cell. Exported for
// unit tests; the admin client is only consulted for the module lookup.
export async function validateOverride(admin, body, { requireAllowed }) {
  if (!isUuid(body.user_id)) return { error: "user_id must be a uuid" };
  if (typeof body.module_key !== "string" || !body.module_key.trim()) {
    return { error: "module_key is required" };
  }
  if (!ACTIONS.includes(body.action)) {
    return { error: `action must be one of ${ACTIONS.join(", ")}` };
  }

  const { data: mod, error } = await admin
    .from("module_keys").select("available_actions").eq("key", body.module_key).maybeSingle();
  if (error) return { error: error.message };
  if (!mod) return { error: `Unknown module_key: ${body.module_key}` };
  if (!(mod.available_actions || []).includes(body.action)) {
    return { error: `Module ${body.module_key} does not expose action ${body.action}` };
  }

  const out = {
    user_id: body.user_id,
    module_key: body.module_key,
    action: body.action,
  };
  if (requireAllowed) {
    if (typeof body.allowed !== "boolean") return { error: "allowed must be a boolean" };
    out.allowed = body.allowed;
    out.reason = body.reason ? String(body.reason).trim() : null;
  }
  return { data: out };
}
