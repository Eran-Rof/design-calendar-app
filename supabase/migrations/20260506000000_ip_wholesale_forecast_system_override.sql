-- 20260506000000_ip_wholesale_forecast_system_override.sql
--
-- Planner can directly override the System forecast qty (not just add
-- to it via the additive Override column). When the override column
-- is non-null, the grid renders it in place of the computed system
-- value and shows a tooltip "changed from X to Y on DATE".
--
-- Three new columns:
--   system_forecast_qty_override     — the planner's typed value
--   system_forecast_qty_overridden_at — when the override was last set
--   system_forecast_qty_overridden_by — who set it (free text; we
--                                       don't have real user auth yet)
--
-- The original computed value stays in system_forecast_qty so the
-- tooltip can show "from X to Y". Clearing the override (setting to
-- null) reverts display to the computed value with no audit row.

ALTER TABLE ip_wholesale_forecast
  ADD COLUMN IF NOT EXISTS system_forecast_qty_override     numeric(14, 3),
  ADD COLUMN IF NOT EXISTS system_forecast_qty_overridden_at timestamptz,
  ADD COLUMN IF NOT EXISTS system_forecast_qty_overridden_by text;

-- Partial index — most rows never get a system override, so only
-- index the rare ones for quick "show me planner-edited rows" queries.
CREATE INDEX IF NOT EXISTS idx_ip_wf_system_override
  ON ip_wholesale_forecast (planning_run_id, id)
  WHERE system_forecast_qty_override IS NOT NULL;
