// P28-2 — shared per-user Today context.
//
// One place that answers "what does THIS caller's Today aggregate look
// like right now", used by three consumers with identical semantics:
//   - GET /api/internal/assistant/today   (the page)
//   - GET /api/internal/assistant/brief   (morning-brief generation)
//   - the ask-grid `get_today` tool executor (assistant conversations)
//
// Permission lens contract (mirrors useEffectivePermissions, inert unless
// enforce): RBAC_MODE !== "enforce" OR no resolvable user → permissions
// null (no filtering); enforce + identified → the caller's effective set.

import { rbacMode, loadEffectivePermissions } from "../rbac/index.js";
import { buildToday, todayISO } from "./today.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v.trim());
}

export async function resolveEntityId(admin, entityHint) {
  if (isUuid(entityHint)) return entityHint.trim();
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

/** Greeting/brief display name. Never throws — names are decoration. */
export async function resolveDisplayName(admin, authUserId) {
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

/**
 * Build the caller's Today aggregate with the standard lens.
 * @param admin       service-role supabase client
 * @param authUserId  resolved auth.users.id or null (legacy pass-through)
 * @param entityHint  optional entity uuid (X-Entity-ID header value)
 * @returns { day, entityId, permissions, dismissedKeys, payload }
 */
export async function buildTodayForUser(admin, { authUserId = null, entityHint = null } = {}) {
  const day = todayISO();
  const userId = isUuid(authUserId) ? authUserId.trim() : null;
  const entityId = await resolveEntityId(admin, entityHint);

  let permissions = null;
  if (rbacMode() === "enforce" && userId && entityId) {
    permissions = await loadEffectivePermissions(admin, userId, entityId);
  }

  const dismissedKeys = new Set();
  if (userId) {
    try {
      const { data } = await admin
        .from("assistant_dismissals")
        .select("item_key")
        .eq("user_id", userId)
        .eq("dismissed_on", day)
        .limit(500);
      for (const r of data || []) dismissedKeys.add(r.item_key);
    } catch { /* dismissals are best-effort */ }
  }

  const payload = await buildToday(admin, {
    userId, entityId, permissions, dismissedKeys, todayISO: day,
  });
  return { day, entityId, permissions, dismissedKeys, payload };
}

/**
 * Compact, model-facing rendering of the aggregate — the ONLY facts the
 * brief/assistant may cite. Pure; unit-tested.
 */
export function aggregateForModel(payload) {
  return {
    todos: (payload.todos || []).map((t) => ({
      key: t.key, title: t.title, count: t.count, severity: t.severity, detail: t.detail || null, panel: t.panel || null,
    })),
    processes: (payload.processes || []).map((p) => ({
      key: p.key, label: p.label, state: p.state, detail: p.detail || null,
    })),
    suggestions: (payload.suggestions || []).map((s) => ({ key: s.key, text: s.text })),
    partial: (payload.errors || []).length > 0,
  };
}
