-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P10-2 — current_entity_id() helper + RLS audit framework
--                   support + switcher API support
--
-- Implements the runtime helper accepted in
--   docs/tangerine/P10-tenancy-architecture.md §3.4 + §6 chunk P10-2.
--
-- Scope (this migration only):
--   1. current_entity_id() — SECURITY DEFINER SQL helper that resolves
--      the request's effective entity_id with priority order:
--        (a) session-local GUC `app.current_entity_id` set by the auth
--            dispatcher on each request (per-request override from JWT
--            or explicit X-Entity-ID switch).
--        (b) authenticated user's default entity_users row
--            (auth.uid() + is_default = true).
--        (c) NULL — RLS policies that depend on this should deny by
--            default rather than silently leak.
--      The fallback to rof_entity_id() described in the arch doc §3.4
--      is deliberately NOT wired here: P10-2 stays additive (helper-only)
--      so existing DEFAULT rof_entity_id() columns keep behaving exactly
--      as before. The DEFAULT swap is the explicit subject of P10-3.
--
-- Not in this chunk (deferred):
--   • Swap DEFAULT rof_entity_id() → DEFAULT current_entity_id() on the
--     remaining ~11 entity-scoped tables               → P10-3
--   • API dispatcher wiring that calls SET LOCAL on every request → P10-4
--   • Switcher UI                                       → P10-5
--
-- Idempotent: CREATE OR REPLACE FUNCTION + GRANT are safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. current_entity_id() — request-scoped effective entity helper ───────
-- Returns the current request's effective entity_id. Used by RLS policies
-- and DEFAULT expressions on entity-scoped tables (after the P10-3 swap).
-- Reads in priority order:
--   1. session local: `app.current_entity_id` (set by the auth handler
--      on each request, e.g. via SET LOCAL from the X-Entity-ID header).
--   2. auth.uid()'s default entity_users row (is_default = true).
--   3. NULL — RLS policies that depend on this should deny by default.
--
-- Implementation notes:
--   • SECURITY DEFINER so the function can read entity_users even when
--     called inside an RLS policy on another table (the function runs as
--     the migration owner, not the caller).
--   • STABLE — same inputs in the same transaction give the same answer;
--     this lets the planner cache the result inside a single statement.
--   • LANGUAGE plpgsql — needed for the BEGIN/EXCEPTION blocks that
--     swallow current_setting() errors (a missing GUC raises rather than
--     returning NULL even with the `missing_ok = true` second arg, in
--     some Postgres versions, when the value isn't a valid uuid).
--   • current_setting('app.current_entity_id', true) — the `true` second
--     arg makes a missing GUC return '' rather than raising; we still
--     wrap the ::uuid cast in EXCEPTION because a non-uuid GUC value
--     (e.g. left over from an unrelated SET) would otherwise crash the
--     containing query.
CREATE OR REPLACE FUNCTION current_entity_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ent uuid;
  uid uuid;
BEGIN
  -- 1. Session-set entity_id (per-request override from JWT or X-Entity-ID).
  BEGIN
    ent := NULLIF(current_setting('app.current_entity_id', true), '')::uuid;
    IF ent IS NOT NULL THEN
      RETURN ent;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Bad GUC value (non-uuid, stale, etc) — fall through to step 2.
    NULL;
  END;

  -- 2. Authenticated user's default entity (entity_users.is_default = true).
  BEGIN
    uid := auth.uid();
    IF uid IS NOT NULL THEN
      SELECT entity_id INTO ent
        FROM entity_users
       WHERE auth_id = uid
         AND is_default = true
       LIMIT 1;
      IF ent IS NOT NULL THEN
        RETURN ent;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- auth.uid() can raise outside an authenticated context (e.g. when
    -- called by the service role or directly from psql). Fall through.
    NULL;
  END;

  -- 3. No effective entity — caller's RLS policy decides what to do.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION current_entity_id() IS 'P10-2: returns the current request''s effective entity_id. Priority: (1) GUC app.current_entity_id set per-request by the auth dispatcher, (2) auth.uid()''s entity_users row where is_default=true, (3) NULL. SECURITY DEFINER so RLS policies on other tables can call it. STABLE so the planner can cache within a statement.';

-- Anon + authenticated + service_role all need EXECUTE — the helper is
-- called from RLS policies that run under the caller's role, and from
-- DEFAULT expressions that run under the inserting role.
GRANT EXECUTE ON FUNCTION current_entity_id() TO anon, authenticated, service_role;

-- ─── 2. PostgREST schema reload ────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
