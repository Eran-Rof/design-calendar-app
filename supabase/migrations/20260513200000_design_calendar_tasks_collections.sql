-- 20260513200000_design_calendar_tasks_collections.sql
--
-- Captures the `tasks` and `collections` tables used by the Design Calendar
-- app. These tables exist in prod (created out-of-band via the SQL editor
-- before migrations were standard) but had no corresponding migration file,
-- so fresh setups (staging, local, demo) didn't have them.
--
-- IF NOT EXISTS means this is a no-op in prod and only creates rows in
-- environments that are missing the tables. Safe to apply anywhere.

-- ── tasks ───────────────────────────────────────────────────────────────
-- One row per Design Calendar task. `id` is a client-generated string
-- (typically uuid v4). `data` is the full task object — see src/store/types.ts
-- for the Task interface. Index on a couple of jsonb paths used by the
-- timeline and dashboard queries.
CREATE TABLE IF NOT EXISTS tasks (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_collection ON tasks ((data->>'collection'));
CREATE INDEX IF NOT EXISTS idx_tasks_due        ON tasks ((data->>'due'));
CREATE INDEX IF NOT EXISTS idx_tasks_phase      ON tasks ((data->>'phase'));

-- ── collections ────────────────────────────────────────────────────────
-- One row per Design Calendar collection (season grouping). `id` is the
-- collection key, `data` carries name/season/color/etc.
CREATE TABLE IF NOT EXISTS collections (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
