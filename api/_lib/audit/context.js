// api/_lib/audit/context.js
//
// Tangerine T11-2 audit-context bridge.
//
// Wraps a mutating handler so the T11-1 audit_row_changes_trigger sees the
// correct actor + source + reason. Stamps six session vars via the
// set_audit_context RPC (shipped in P13-4 migration), runs the wrapped
// function, then clears the session vars in a finally{} block.
//
// Usage:
//   await withAuditContext(supabase, {
//     userId: auth.authId,
//     employeeId: employee.id,           // optional, T11-1 resolves on its own
//     displayName: employee.display_name, // optional
//     source: 'manual',                  // T10 source enum; default 'manual'
//     reason: body.reason,               // D3 REQUIRED on VOID/POST/REVERSE
//     correlationId: req.headers['x-correlation-id'] || null,
//   }, async () => {
//     // ... mutating SQL via supabase.from(...).update/insert/delete
//   });
//
// Both lands together in the same migration as the bookkeeper_approval_log
// table to keep P13-4 self-contained while T11-2's broader handler-sweep
// still ships separately.

const VALID_SOURCES = new Set([
  "manual",
  "xoro_mirror",
  "shopify",
  "fba",
  "walmart",
  "faire",
  "edi_3pl",
  "plaid_sync",
  "api",
  "system",
]);

/**
 * Wrap a mutating handler so the trigger sees the right actor + source + reason.
 *
 * @param {object} supabase    The Supabase JS client (service-role admin).
 * @param {object} ctx         Audit context.
 * @param {string|null} ctx.userId          auth.users.id of the actor.
 * @param {string|null} [ctx.employeeId]    employees.id of the actor (T11-1 resolves on its own if null).
 * @param {string|null} [ctx.displayName]   Cached display name.
 * @param {string} [ctx.source]             T10 source enum value (default 'manual').
 * @param {string|null} [ctx.reason]        Operator-typed reason (D3 required on void/post/reverse).
 * @param {string|null} [ctx.correlationId] Request_id / batch_id for tracing.
 * @param {function(): Promise<*>} fn       The wrapped handler.
 * @returns {Promise<*>} Whatever fn returns.
 */
export async function withAuditContext(supabase, ctx, fn) {
  if (!supabase) throw new TypeError("withAuditContext requires a supabase client");
  if (typeof fn !== "function") throw new TypeError("withAuditContext requires a function to wrap");

  const source = ctx.source && VALID_SOURCES.has(ctx.source) ? ctx.source : "manual";
  const setArgs = {
    p_actor_auth_id: ctx.userId || null,
    p_actor_employee_id: ctx.employeeId || null,
    p_actor_display_name: ctx.displayName || null,
    p_audit_source: source,
    p_audit_reason: ctx.reason || null,
    p_audit_correlation_id: ctx.correlationId || null,
  };

  // SET — non-fatal if the RPC isn't present (e.g. unit tests with a mock
  // client). In production the RPC is shipped by the P13-4 migration.
  try {
    await supabase.rpc("set_audit_context", setArgs);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.warn("[audit-context] set_audit_context failed:", err?.message || err);
    }
  }

  try {
    return await fn();
  } finally {
    // CLEAR — always run, even on throw. Same non-fatal guard.
    try {
      await supabase.rpc("clear_audit_context");
    } catch (err) {
      if (process.env.NODE_ENV !== "test") {
        // eslint-disable-next-line no-console
        console.warn("[audit-context] clear_audit_context failed:", err?.message || err);
      }
    }
  }
}

/**
 * Extract the audit-context actor from an incoming request.
 *
 * Returns { authId, source, correlationId } from the Authorization header
 * + standard infrastructure headers. The handler still calls
 * authenticateCaller() (Bearer JWT validation) separately — this helper
 * only pulls the IDs out for use in withAuditContext.
 *
 * @param {object} req  The Vercel handler request.
 * @param {string|null} authId  The validated auth.users.id from authenticateCaller.
 * @returns {{ authId: string|null, source: string, correlationId: string|null }}
 */
export function extractActorFromRequest(req, authId) {
  const correlationId =
    req?.headers?.["x-correlation-id"] ||
    req?.headers?.["x-request-id"] ||
    null;
  return {
    authId: authId || null,
    source: "manual",
    correlationId: correlationId || null,
  };
}
