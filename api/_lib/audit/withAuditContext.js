// api/_lib/audit/withAuditContext.js
//
// Tangerine T11-2 — JS-side audit context helper.
//
// The T11-1 trigger (`audit_row_changes_trigger`) reads six PostgreSQL
// session vars (set via `set_config(..., true)`) to stamp every row in
// the universal `row_changes` ledger:
//
//   app.actor_auth_id          uuid    auth.users.id of the actor
//   app.actor_employee_id      uuid    employees.id (resolved server-side)
//   app.actor_display_name     text    cached display name
//   app.audit_source           text    T10 source enum value
//   app.audit_reason           text    operator-typed reason (D3 required)
//   app.audit_correlation_id   text    request_id / batch_id for tracing
//
// IMPORTANT CONNECTION-POOL CAVEAT
// ────────────────────────────────
// `supabase-js` (and PostgREST behind it) pools connections — a
// `SET LOCAL ...` issued inside one round-trip does NOT survive into a
// separate `.from('x').update()` call. PG associates the session var
// with the connection, not the request; PostgREST hands the next request
// a different connection from the pool. That means:
//
//   ❌ admin.rpc('set_audit_context', {...});  // sets vars on conn-A
//   ❌ await admin.from('ar_invoices').update({...});  // runs on conn-B
//
// The trigger sees no audit context, and D3 raises on VOID/POST/REVERSE.
//
// THE FIX (v1 pattern)
// ────────────────────
// Ship a small family of SECURITY DEFINER PL/pgSQL wrapper RPCs that
// combine `set_config(...)` + the actual write in a single statement.
// Same statement = same connection = trigger sees the vars.
//
//   await admin.rpc('void_ar_invoice_with_audit', {
//     invoice_id: '...',
//     audit_actor_auth_id: '...',
//     audit_employee_id: '...',
//     audit_reason: 'Customer cancelled order',
//     audit_source: 'manual',
//     audit_correlation_id: '<request-id>',
//   });
//
// For T11-2 we ship four of these (void_ar_invoice_with_audit,
// void_ap_invoice_with_audit, post_journal_entry_with_audit,
// reverse_journal_entry_with_audit) plus the bare `set_audit_context`
// helper for callers that already do their write in one SECURITY DEFINER
// of their own.
//
// USAGE FROM A HANDLER
// ────────────────────
//   import { extractActorFromRequest, callWithAudit } from
//     '../../../_lib/audit/withAuditContext.js';
//
//   const actor = await extractActorFromRequest(req, admin);
//   const result = await callWithAudit(admin, 'void_ar_invoice_with_audit', {
//     invoice_id: id,
//     actor,
//     reason,
//     source: 'manual',
//     correlation_id: req.headers['x-request-id'],
//   });
//
// The handler doesn't have to know about set_config / connection pooling
// — `callWithAudit` builds the `audit_*` parameter prefix from the actor
// + ctx, the RPC sets the session vars in PL/pgSQL, and the trigger
// fires with the right context.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const T10_SOURCES = new Set([
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
 * Extract the calling actor from a Vercel-style request.
 *
 * Steps:
 *   1. Read the bearer JWT from `Authorization: Bearer ...` and call
 *      `admin.auth.getUser(jwt)` to resolve auth.users.id.
 *   2. Look up `employees` where `auth_user_id = authId` to resolve
 *      employee_id + display_name.
 *   3. Fall through to `{ auth_id, employee_id: null, display_name: null }`
 *      when the auth user is not an employee (e.g. service-account calls
 *      from the nightly pipeline). Those rows still get an `actor_auth_id`
 *      so the ledger isn't fully anonymous.
 *
 * Returns:
 *   {
 *     auth_id:      string | null,
 *     employee_id:  string | null,
 *     display_name: string | null,
 *   }
 *
 * NEVER throws — handlers shouldn't 500 because we couldn't resolve the
 * actor. If everything is null the trigger will still fire (and the row
 * will have null actor columns), so the audit trail records "unknown
 * actor at <timestamp>" rather than dropping the write.
 */
export async function extractActorFromRequest(req, admin) {
  const empty = { auth_id: null, employee_id: null, display_name: null };
  if (!req || !req.headers) return empty;

  const header = req.headers.authorization || req.headers.Authorization || "";
  const jwt =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : "";
  if (!jwt) return empty;

  let authId = null;
  try {
    const { data } = await admin.auth.getUser(jwt);
    authId = data?.user?.id ?? null;
  } catch {
    authId = null;
  }
  if (!authId) return empty;

  // Look up employees row. Use auth_user_id (the documented FK column on
  // employees per T11-1 architecture §6). Fall through cleanly when the
  // auth user isn't an internal employee.
  let employee = null;
  try {
    const { data } = await admin
      .from("employees")
      .select("id, full_name, first_name, last_name, email")
      .eq("auth_user_id", authId)
      .maybeSingle();
    employee = data || null;
  } catch {
    employee = null;
  }

  const display_name = employee
    ? employee.full_name ||
      [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
      employee.email ||
      null
    : null;

  return {
    auth_id: authId,
    employee_id: employee?.id || null,
    display_name,
  };
}

/**
 * Validate + normalize an audit context. Throws TypeError on invalid
 * shape — handlers should let that bubble up to a 400 since these are
 * server-controlled inputs (the actor comes from extractActorFromRequest
 * and the source/reason come from the handler body which the handler
 * has already validated).
 */
export function normalizeAuditContext(ctx) {
  if (!ctx || typeof ctx !== "object") {
    throw new TypeError("audit context must be an object");
  }
  const actor = ctx.actor || {
    auth_id: null,
    employee_id: null,
    display_name: null,
  };
  const auth_id = actor.auth_id || null;
  const employee_id = actor.employee_id || null;
  const display_name = actor.display_name || null;

  if (auth_id != null && !UUID_RE.test(String(auth_id))) {
    throw new TypeError(`audit.actor.auth_id must be a uuid, got "${auth_id}"`);
  }
  if (employee_id != null && !UUID_RE.test(String(employee_id))) {
    throw new TypeError(
      `audit.actor.employee_id must be a uuid, got "${employee_id}"`,
    );
  }

  const source = ctx.source || null;
  if (source != null && !T10_SOURCES.has(String(source))) {
    throw new TypeError(
      `audit.source must be a T10 enum value (got "${source}"). ` +
        `Valid: ${Array.from(T10_SOURCES).join(", ")}.`,
    );
  }

  const reason = ctx.reason ? String(ctx.reason).trim() : null;
  const correlation_id = ctx.correlation_id
    ? String(ctx.correlation_id).trim()
    : null;

  return {
    auth_id,
    employee_id,
    display_name,
    source,
    reason: reason || null,
    correlation_id: correlation_id || null,
  };
}

/**
 * Pure helper: invoke the `set_audit_context` RPC to push the session
 * vars onto the current PostgREST connection. Returns the RPC error if
 * any (caller decides whether to bail).
 *
 * NOTE: this is exposed mostly for completeness + testability. Because
 * of the connection-pool caveat above, calling this alone before a
 * separate write WILL NOT plumb the context to the trigger. Use
 * `callWithAudit` for the combined-statement pattern.
 */
export async function setAuditSessionVars(admin, ctx) {
  const norm = normalizeAuditContext(ctx);
  return admin.rpc("set_audit_context", {
    p_actor_auth_id: norm.auth_id,
    p_actor_employee_id: norm.employee_id,
    p_actor_display_name: norm.display_name,
    p_audit_source: norm.source,
    p_audit_reason: norm.reason,
    p_audit_correlation_id: norm.correlation_id,
  });
}

/**
 * Build the `audit_*` parameter prefix that every `_with_audit` RPC
 * expects. Keeping this in one place means we never have to remember
 * the exact key names at call sites.
 *
 *   {
 *     audit_actor_auth_id,
 *     audit_actor_employee_id,
 *     audit_actor_display_name,
 *     audit_source,
 *     audit_reason,
 *     audit_correlation_id,
 *   }
 */
export function buildAuditRpcParams(ctx) {
  const norm = normalizeAuditContext(ctx);
  return {
    audit_actor_auth_id: norm.auth_id,
    audit_actor_employee_id: norm.employee_id,
    audit_actor_display_name: norm.display_name,
    audit_source: norm.source,
    audit_reason: norm.reason,
    audit_correlation_id: norm.correlation_id,
  };
}

/**
 * Call an `_with_audit` RPC with the operation-specific params merged
 * onto the `audit_*` prefix.
 *
 *   await callWithAudit(admin, 'void_ar_invoice_with_audit', {
 *     invoice_id,
 *     actor,
 *     reason,
 *     source: 'manual',
 *     correlation_id,
 *   });
 *
 * `ctx` may include any number of non-audit keys (e.g. `invoice_id`,
 * `je_id`); they are forwarded verbatim. Reserved keys
 * (`actor`/`reason`/`source`/`correlation_id`) are normalized into the
 * `audit_*` parameter prefix.
 */
export async function callWithAudit(admin, rpcName, ctx) {
  if (typeof rpcName !== "string" || rpcName.length === 0) {
    throw new TypeError("rpcName is required");
  }
  if (!ctx || typeof ctx !== "object") {
    throw new TypeError("ctx must be an object");
  }
  const { actor, reason, source, correlation_id, ...rest } = ctx;
  const auditParams = buildAuditRpcParams({
    actor,
    reason,
    source,
    correlation_id,
  });
  const params = { ...rest, ...auditParams };
  return admin.rpc(rpcName, params);
}

/**
 * Validation-only helper: D3 enforces that VOID/POST/REVERSE operations
 * MUST carry a reason. Handlers call this before invoking the RPC to
 * return a clean 400 to the caller instead of a 500 from the trigger
 * (the trigger raises check_violation with a less-friendly message).
 *
 * Returns null on success or { status, error } on failure.
 */
export function requireReason(op, reason) {
  const opUpper = String(op || "").toUpperCase();
  if (!["VOID", "POST", "REVERSE"].includes(opUpper)) return null;
  const r = reason ? String(reason).trim() : "";
  if (r.length === 0) {
    return {
      status: 400,
      error: `A reason is required for ${opUpper} operations (T11 D3).`,
    };
  }
  return null;
}

/**
 * Convenience wrapper that mirrors the doc-comment signature:
 *
 *   await withAuditContext({ admin, actor, source, reason, correlation_id },
 *     async (client) => {
 *       // any writes via this client carry the audit context to the trigger
 *     });
 *
 * v1 implementation: this calls `set_audit_context` and then runs `fn`
 * with the same admin client. The connection-pool caveat means the
 * session vars set here only survive into writes that fire in the SAME
 * statement (i.e. into rpc() calls of `_with_audit` siblings — which
 * already set the vars themselves). The wrapper exists for forward
 * compatibility — once PostgREST gains transaction support or a
 * connection-pinning mode, this helper will plumb the vars without an
 * RPC family.
 */
export async function withAuditContext(opts, fn) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("withAuditContext: opts must be an object");
  }
  const { admin, ...ctx } = opts;
  if (!admin) throw new TypeError("withAuditContext: admin is required");
  if (typeof fn !== "function") {
    throw new TypeError("withAuditContext: fn must be a function");
  }
  // Set the vars on the current connection. Caller is responsible for
  // routing writes through `callWithAudit` / `_with_audit` RPCs to
  // guarantee the vars travel to the trigger.
  await setAuditSessionVars(admin, ctx);
  return fn(admin);
}

// Re-export the T10 source set so callers + tests share one definition.
export const AUDIT_SOURCE_VALUES = Object.freeze(Array.from(T10_SOURCES));
