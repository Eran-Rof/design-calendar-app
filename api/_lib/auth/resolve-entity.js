// api/_lib/auth/resolve-entity.js
//
// Tangerine P10-4 — Entity-resolution helper for authenticated requests.
//
// Resolves the effective entity_id for the calling user, in priority order:
//
//   1. `X-Entity-ID` header — the caller explicitly asked to operate inside a
//      specific entity. The header is honoured ONLY if the caller has an
//      entity_users row for that entity. Header-supplied ids that the caller
//      doesn't belong to are rejected (returns { entity_id: null, source:
//      'denied' }) so callers can't probe membership by trying random uuids.
//   2. The caller's entity_users row with `is_default = true` (P10-1 partial
//      unique index enforces at most one default per auth user).
//   3. The caller's first entity_users row, ordered by created_at ASC. This
//      is the fall-through when a user has no default flag set (e.g. legacy
//      rows seeded before P10-1 backfilled is_default).
//   4. `'none'` — caller is authenticated but has zero entity_users rows.
//      Handlers should refuse the operation with a "no entity context" 403
//      rather than silently writing under rof_entity_id().
//
// Returned shape:
//   {
//     entity_id: string | null,  // uuid the request should operate under
//     source: 'header' | 'default' | 'first' | 'denied' | 'none',
//     header_value: string | null,  // the raw header that was inspected
//     row_count: number,            // how many entity_users rows the caller has
//   }
//
// Why this helper instead of api/_lib/entity.js?
//   • entity.js#resolveEntityContext is the older "internal vs vendor" entity
//     resolver. It accepts an X-Entity-ID header without validating that the
//     authenticated caller actually belongs to that entity, and it falls
//     through to the "oldest entity" as default. That's wrong for multi-
//     tenant — a stale header from a logged-out user must not yield a row
//     write under another tenant.
//   • This helper is the strict version: it ALWAYS validates the header
//     against entity_users for the specific caller, and it returns null +
//     a structured `source` so handlers can branch ("no entity → 403"
//     vs "validated header → SET LOCAL guc" vs "default → SET LOCAL guc").
//   • Once P10-5 ships the switcher UI, every authenticated internal
//     handler should adopt resolveCallerEntity in place of entity.js. The
//     older helper stays around for the vendor surface (entity_vendors)
//     until the multi-entity vendor flow lands in P10-6+.
//
// Threading the result through the request:
//   The dispatcher (P10-4 follow-up) calls resolveCallerEntity once per
//   request, stashes the result on `req.context.entity_id`, and the
//   handlers read from req.context. For v1 we expose the helper as a
//   callable so per-handler adoption is incremental — preferences,
//   entity-switch, JE post, and the cron handlers can opt in now while
//   the long tail catches up in P10-5/P10-6.
//
// Note on the PG GUC:
//   We deliberately do NOT call `SET LOCAL app.current_entity_id` from this
//   helper. supabase-js pools connections — a SET LOCAL inside one rpc()
//   does not survive into the next .from() call. The arch note in P10-3
//   §3.5 documents the rollout path: resolve on the JS side now, plumb the
//   GUC via PostgREST `request.header.x-tangerine-entity-id` once we move
//   to a header-driven GUC in P10-4b. Until then, the coalesce DEFAULT
//   on entity-scoped tables keeps service-role inserts safe.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the `X-Entity-ID` header in a case-insensitive, hyphenless-safe way.
 * Vercel / Node lowercase header keys; some test harnesses preserve the
 * original casing. Accept both. Returns the trimmed value or null.
 */
export function readEntityHeader(req) {
  const h = req && req.headers ? req.headers : {};
  const raw =
    h["x-entity-id"] ??
    h["X-Entity-ID"] ??
    h["x-tangerine-entity-id"] ?? // optional alias documented in arch §3.5
    null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length === 0 ? null : s;
}

/**
 * Resolve the effective entity_id for an authenticated request.
 *
 * @param {object} req  - Vercel-style req with .headers
 * @param {object} admin - Supabase service-role client
 * @param {string} authId - The caller's auth.users.id, as returned by
 *                          authenticateCaller(req, admin).
 * @returns {Promise<{
 *   entity_id: string | null,
 *   source: 'header' | 'default' | 'first' | 'denied' | 'none',
 *   header_value: string | null,
 *   row_count: number,
 * }>}
 */
export async function resolveCallerEntity(req, admin, authId) {
  const header_value = readEntityHeader(req);

  // Fetch all entity_users rows for the caller in one round-trip. Even
  // with the partial unique index on is_default, we still need the full
  // set so the "first" fallback works without a second query, and so
  // header-validation is a list membership check rather than a row probe
  // (which leaks "user X belongs to entity Y" via timing).
  const { data, error } = await admin
    .from("entity_users")
    .select("entity_id, is_default, created_at")
    .eq("auth_id", authId)
    .order("created_at", { ascending: true });

  if (error) {
    // Bubble up — the dispatcher will translate to a 500.
    const e = new Error(`entity_users lookup failed: ${error.message}`);
    e.code = "ENTITY_LOOKUP_FAILED";
    throw e;
  }

  const rows = Array.isArray(data) ? data : [];
  const row_count = rows.length;

  // (4) No rows — caller is authenticated but has no entity. Handlers
  // should 403 with "no entity context".
  if (row_count === 0) {
    return { entity_id: null, source: "none", header_value, row_count: 0 };
  }

  // (1) Header path — must be a valid uuid AND must match one of the
  // caller's rows. If the header is present but invalid (bad uuid) we
  // drop through to the default — being strict about header format gives
  // a friendlier developer experience without leaking membership.
  if (header_value && UUID_RE.test(header_value)) {
    const member = rows.find((r) => r.entity_id === header_value);
    if (member) {
      return {
        entity_id: header_value,
        source: "header",
        header_value,
        row_count,
      };
    }
    // Header present, well-formed, but the caller is not a member of
    // that entity — DENY explicitly. Don't fall back to default, because
    // the caller has signalled intent and silently swapping entities
    // would be a footgun.
    return { entity_id: null, source: "denied", header_value, row_count };
  }

  // (2) Default row — entity_users.is_default = true.
  const def = rows.find((r) => r.is_default === true);
  if (def) {
    return {
      entity_id: def.entity_id,
      source: "default",
      header_value,
      row_count,
    };
  }

  // (3) First-by-created-at fallback.
  return {
    entity_id: rows[0].entity_id,
    source: "first",
    header_value,
    row_count,
  };
}

/**
 * Convenience: throw a 403-shaped object if the resolution produced no
 * entity_id. Handlers can do:
 *
 *   const ctx = await resolveCallerEntity(req, admin, authId);
 *   const gate = requireEntity(ctx);
 *   if (gate) return res.status(gate.status).json({ error: gate.error });
 *
 * @returns {null | { status: number, error: string, source: string }}
 */
export function requireEntity(ctx) {
  if (ctx && ctx.entity_id) return null;
  if (ctx && ctx.source === "denied") {
    return {
      status: 403,
      error:
        "X-Entity-ID does not match any entity the caller belongs to",
      source: "denied",
    };
  }
  return {
    status: 403,
    error: "Caller has no entity context (no entity_users row)",
    source: ctx && ctx.source ? ctx.source : "none",
  };
}
