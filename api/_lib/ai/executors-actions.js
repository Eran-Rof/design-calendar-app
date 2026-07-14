// P28-4-1 — run_action executor for the Ask AI loop.
//
// run_action is LOOPED, never a direct writer (arch doc §5.2). It resolves a
// pack action, RBAC-checks advisorily, and runs the action's read-only
// preview(). For draft / write_confirm modes it mints a confirmation token
// (confirmToken.js) and returns { status:"needs_confirmation", ..., token }
// so the model can emit the terminal present_confirmation card. The WRITE
// never happens here — commit() is reachable only from the authenticated
// confirm endpoint (api/_handlers/internal/assistant/actions-confirm.js).
//
// Authoritative RBAC is re-checked at commit (the confirm endpoint verifies a
// real identity); the check here is ADVISORY so the model can tell the
// operator instead of drafting a dead action. ask-grid is same-origin-only
// and does not verify a JWT, so this executor never performs a write.

import { actionByName } from "../assistant/registry.js";
import { resolveEntityId, isUuid } from "../assistant/context.js";
import { todayISO } from "../assistant/today.js";
import { rbacMode, loadEffectivePermissions, isAllowed } from "../rbac/index.js";
import { signConfirmToken } from "../assistant/confirmToken.js";

// Short confirm window — mirrors confirmToken's default (arch doc §6.2 / D7).
const CONFIRM_TTL_SEC = 5 * 60;

function requiredActionFor(action) {
  return action.required_action || (action.mode === "read" ? "read" : "write");
}

export async function tool_run_action(db, input, execCtx) {
  const name = typeof input?.action === "string" ? input.action : "";
  const packs = execCtx?.packs; // tests inject a fixture registry; prod omits it
  const action = actionByName(name, packs);
  if (!action) return { error: "unknown_action" };

  const userId = isUuid(execCtx?.user_id) ? execCtx.user_id.trim() : null;

  // Advisory RBAC pre-check (arch doc §5.2 step 2). Uses an injected
  // permission Set when provided (tests / already-resolved lens), else loads
  // it when enforcement is on and the operator is identified. Skipped
  // entirely when RBAC is off — authoritative re-check happens at commit.
  let permissions = execCtx?.permissions instanceof Set ? execCtx.permissions : null;
  if (!permissions && userId && rbacMode() === "enforce") {
    const entForPerms = await resolveEntityId(db, execCtx?.entity_id || null);
    if (entForPerms) permissions = await loadEffectivePermissions(db, userId, entForPerms);
  }
  if (permissions && !isAllowed(permissions, action.module_key, requiredActionFor(action))) {
    return { error: "not_permitted" };
  }

  // preview() is read-only and MUST NOT write (arch doc §4).
  let preview;
  try {
    preview = await action.preview(db, input?.input || {}, {
      userId,
      entityId: execCtx?.entity_id || null,
      permissions,
      todayISO: todayISO(),
    });
  } catch (e) {
    return { error: `preview_failed: ${e?.message || String(e)}` };
  }
  const summary = preview?.summary || null;
  const warnings = Array.isArray(preview?.warnings) ? preview.warnings : [];

  if (action.mode === "read") {
    // Read actions produce no write; the model summarises the data directly.
    return { mode: "read", summary, warnings, data: preview?.data ?? null };
  }

  // draft | write_confirm — mint the confirmation token binding the exact
  // commit_payload to the previewing operator, and hand it back for the
  // terminal present_confirmation card.
  const entityId = await resolveEntityId(db, execCtx?.entity_id || null);
  const token = signConfirmToken(
    { act: action.name, commit_payload: preview?.commit_payload, sub: userId, ent: entityId },
    { ttlSec: CONFIRM_TTL_SEC },
  );
  if (!token) {
    // Fail-closed: no confirm secret configured → write is unavailable, but
    // the operator still saw the (read-only) preview.
    return { status: "unavailable", error: "confirm_unavailable", summary, warnings };
  }
  return { status: "needs_confirmation", mode: action.mode, summary, warnings, token, action: action.name };
}
