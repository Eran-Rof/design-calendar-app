-- 20260422200000_forecast_method_preference.sql
--
-- Adds planner-facing forecast method preference to ip_planning_runs.
--
-- Three user-selectable values:
--   ly_sales         — same-period last-year demand (default)
--   weighted_recent  — recent-period weighted average
--   cadence          — reorder cadence heuristic
--
-- The preference is a hint to the compute layer, not a hard override.
-- If the preferred method has insufficient data the engine falls through
-- the normal waterfall and records the method that was actually used.

ALTER TABLE ip_planning_runs
  ADD COLUMN IF NOT EXISTS forecast_method_preference text
    NOT NULL DEFAULT 'ly_sales'
    CHECK (forecast_method_preference IN ('ly_sales', 'weighted_recent', 'cadence'));
