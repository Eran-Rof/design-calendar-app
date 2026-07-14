-- ════════════════════════════════════════════════════════════════════════════
-- P28-2 — assistant morning briefs (Phase 2: the assistant takes the stage)
-- (#p28-assistant-briefs, 2026-07-14)
--
-- One AI-phrased brief per user per day, generated on the first Today-page
-- load of the day from the SAME deterministic aggregate the page renders
-- (source_json snapshots it for auditability — the brief can only cite
-- facts that were in the aggregate). Cached so the model runs once per
-- user per day, not on every page view; ?refresh=1 regenerates.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS assistant_briefs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL DEFAULT rof_entity_id(),
  user_id     uuid NOT NULL,
  brief_date  date NOT NULL,
  body        text NOT NULL,
  source_json jsonb,
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_briefs_unique UNIQUE (user_id, brief_date)
);

CREATE INDEX IF NOT EXISTS idx_assistant_briefs_user_day
  ON assistant_briefs (user_id, brief_date);

COMMENT ON TABLE assistant_briefs IS
  'P28-2: per-user per-day AI-phrased morning brief for the Today page. body is generated from source_json (the deterministic Today aggregate) by the Tangerine assistant model; regenerate via /api/internal/assistant/brief?refresh=1.';
