-- ════════════════════════════════════════════════════════════════════════════
-- P28-1-1 — Assistant-First foundation (Today page data layer)
-- (#p28-assistant-foundation, 2026-07-14)
--
-- Per docs/tangerine/P28-assistant-first-architecture.md §5. Two objects:
--
-- 1. assistant_dismissals — per-user "done for today" state for Today-page
--    to-do / suggestion items. An item is identified by its stable provider
--    key (e.g. 'po.portal_replies_unread'); dismissing hides it for the rest
--    of that calendar day only (queues re-surface tomorrow if still non-empty).
--    Deliberately NOT a task table — to-dos are computed live from source
--    queues; only the dismissal is stored.
--
-- 2. ai_insights.pack_key — lets the Today page's "Current state" section
--    attribute an insight to the capability pack (module) that produced it,
--    so RBAC can filter insights the same way it filters to-dos. Existing
--    rows stay NULL (= visible to any signed-in Today user, legacy behavior).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS assistant_dismissals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    uuid NOT NULL DEFAULT rof_entity_id(),
  user_id      uuid NOT NULL,
  item_key     text NOT NULL,
  dismissed_on date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_dismissals_unique UNIQUE (user_id, item_key, dismissed_on)
);

CREATE INDEX IF NOT EXISTS idx_assistant_dismissals_user_day
  ON assistant_dismissals (user_id, dismissed_on);

COMMENT ON TABLE assistant_dismissals IS
  'P28 Today page: per-user per-day dismissals of computed to-do/suggestion items. item_key = stable provider key from api/_lib/assistant/packs/*. Rows are day-scoped; queues re-surface next day.';

ALTER TABLE ai_insights
  ADD COLUMN IF NOT EXISTS pack_key text;

COMMENT ON COLUMN ai_insights.pack_key IS
  'P28: capability pack that produced this insight (e.g. po, accounting). NULL = legacy/unattributed; shown unfiltered on the Today page.';
