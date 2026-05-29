-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P10-4 — Final DEFAULT entity_id swap for tanda_pos + po_line_items
--
-- Implements the schema deltas accepted in
--   docs/tangerine/P10-tenancy-architecture.md §3.5 + §6 chunk P10-4.
--
-- Context:
--   • PR #463 added DEFAULT rof_entity_id() to tanda_pos + po_line_items so
--     the Tanda Xoro sync could insert without explicitly passing entity_id.
--   • P10-3 (PR #492) swapped 93 other entity-scoped tables from "no DEFAULT"
--     or "DEFAULT rof_entity_id()" to DEFAULT coalesce(current_entity_id(),
--     rof_entity_id()).
--   • Tanda_pos and po_line_items were deliberately deferred to this chunk
--     so the swap lands together with the JS-side entity-resolution helper
--     (api/_lib/auth/resolve-entity.js) that handlers will use to pick the
--     correct entity from the X-Entity-ID header or the caller's default.
--
-- Why coalesce(current_entity_id(), rof_entity_id()) and not raw
-- current_entity_id():
--   See the P10-3 migration header for the full rationale. Short version:
--   current_entity_id() returns NULL when neither the per-request GUC nor
--   the caller's default-entity row resolves. Coalescing back to ROF
--   preserves the safe single-tenant behaviour for service-role inserts
--   (nightly Xoro sync, master refresh, backfills) that don't run inside
--   an authenticated session. Once P10-4b plumbs the GUC reliably on every
--   authenticated request, P10-3b will drop the coalesce.
--
-- Scope (this migration only):
--   1. ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(),
--      rof_entity_id()) on tanda_pos.
--   2. Same on po_line_items.
--   3. Sanity-probe both helpers (current_entity_id() + rof_entity_id())
--      are present so this migration cannot silently no-op against a DB
--      that's missing P10-2 or PR #463.
--   4. NOTIFY pgrst to refresh PostgREST's schema cache.
--
-- Idempotent: ALTER COLUMN SET DEFAULT is unconditional. Re-applying the
-- same DEFAULT is a no-op. The sanity probe uses RAISE EXCEPTION on a
-- missing prerequisite, never on the swap itself.
--
-- Not in this chunk (deferred):
--   • Dispatcher-side SET LOCAL app.current_entity_id wiring (the actual
--     GUC plumbing on every request)               → P10-4b
--   • Switcher UI                                  → P10-5
--   • Drop the coalesce fallback once dispatcher is reliable → P10-3b
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. tanda_pos — swap rof_entity_id() → coalesce(current_entity_id(), rof) ─
ALTER TABLE tanda_pos      ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- ─── 2. po_line_items — same swap ──────────────────────────────────────────
ALTER TABLE po_line_items  ALTER COLUMN entity_id SET DEFAULT coalesce(current_entity_id(), rof_entity_id());

-- ─── 3. Sanity probe — both helpers must exist ─────────────────────────────
-- Reaffirm both helpers exist so this migration can't silently get applied
-- against a DB missing P10-2 (current_entity_id) or PR #463 (rof_entity_id).
DO $$
DECLARE
  has_helper boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'current_entity_id'
  ) INTO has_helper;
  IF NOT has_helper THEN
    RAISE EXCEPTION 'P10-4 prerequisite missing: current_entity_id() function not found. Apply 20260629010000_p10_chunk2_current_entity_helper.sql first.';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'rof_entity_id'
  ) INTO has_helper;
  IF NOT has_helper THEN
    RAISE EXCEPTION 'P10-4 prerequisite missing: rof_entity_id() function not found. Apply 20260528000000_tanda_entity_id_default_fix.sql first.';
  END IF;
END $$;

-- ─── 4. PostgREST schema reload ────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
