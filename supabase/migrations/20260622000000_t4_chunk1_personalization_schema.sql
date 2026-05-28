-- ════════════════════════════════════════════════════════════════════════════
-- Cross-cutter T4-1 — Personalization schema + click telemetry
--
-- Adds two new tables for the favorites + auto-landing personalization
-- system (favorites side drawer, personalized landing, settings panel):
--
--   1. user_preferences   — per-user, per-entity, key/value JSON preferences
--                            (favorites list, home_route, drawer_collapsed,
--                             etc.). Key/value design avoids ALTERs for new
--                             preference types.
--
--   2. user_menu_usage    — per-user, per-menu-item click counter. Two
--                            counters: alltime (monotonic) and 30d (decayed
--                            nightly so 'most used' is a rolling average
--                            without per-click rows).
--
-- Plus the nightly decay cron entry is registered in routes.js and
-- vercel.json crons[] (runs at 03:00 UTC).
--
-- RLS uses the standard P1 anon_all_* template — user-scope enforcement
-- happens at the API layer where every handler resolves auth.uid() before
-- query and refuses cross-user reads/writes.
--
-- See docs/tangerine/T4-personalization-architecture.md §3.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. user_preferences ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id    uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  key          text NOT NULL,                  -- 'favorites' | 'home_route' | 'drawer_collapsed' | etc.
  value        jsonb NOT NULL,                 -- shape depends on key
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_id, key)
);

COMMENT ON TABLE user_preferences IS 'T4-1: per-user, per-entity key/value preferences. Composite PK (user_id, entity_id, key). Value JSON shape is per-key (see T4 arch §3 value-shapes table).';
COMMENT ON COLUMN user_preferences.key IS 'Preference key. Known keys today: favorites, home_route, drawer_collapsed. Forward-compatible — new keys do not require an ALTER.';
COMMENT ON COLUMN user_preferences.value IS 'JSONB blob whose shape depends on key. favorites = {items:[{menu_key,label,route,icon,added_at}], v:1}. home_route = {menu_key, route, v:1}. drawer_collapsed = {collapsed: boolean}.';

-- ─── 2. user_menu_usage ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_menu_usage (
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  menu_key             text NOT NULL,                  -- 'tangerine:trial-balance', 'ats:planning', etc.
  click_count_30d      int  NOT NULL DEFAULT 0,        -- decayed nightly via api/cron/menu-usage-decay
  click_count_alltime  int  NOT NULL DEFAULT 0,        -- monotonic
  last_clicked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_id, menu_key)
);

CREATE INDEX IF NOT EXISTS idx_user_menu_usage_top
  ON user_menu_usage (user_id, entity_id, click_count_30d DESC);

COMMENT ON TABLE user_menu_usage IS 'T4-1: per-user, per-menu-item click counter. Composite PK (user_id, entity_id, menu_key). click_count_30d decayed nightly by the menu-usage-decay cron so the rolling 30d window does not require per-click rows.';
COMMENT ON COLUMN user_menu_usage.click_count_30d IS 'Approximate rolling 30-day count. Decayed nightly by floor((count - ceil(count/30)), 0). Used to rank top-N most-used menu items for personalized landing.';
COMMENT ON COLUMN user_menu_usage.click_count_alltime IS 'Monotonic lifetime click counter. Used for tie-breaks and the Settings → Personalization "recent activity" stats panel.';

-- ─── 3. RLS — standard P1 anon_all_* template ──────────────────────────────
-- User-scope enforcement is at the API layer (handler resolves auth.uid()
-- and refuses cross-user reads/writes). anon_all_* keeps the path open for
-- the existing service-role/anon-key API surface used by every other table.
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_menu_usage  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_all_user_preferences" ON user_preferences
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon_all_user_menu_usage" ON user_menu_usage
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
