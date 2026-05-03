-- 20260510000000_ip_wholesale_forecast_tbd_user_added.sql
--
-- TBD rows split into two populations: rows the planner created via
-- the inline "+ Add row" affordance, and rows synthesized by the
-- build / aggregate-edit machinery as catch-all stock-buy slots
-- (per-style and per-period TBD/TBD lines). The two populations
-- need different UI affordances:
--   - User-added rows: visually distinct (left accent), STYLE cell
--     editable so the planner can promote TBD into a real style,
--     deletable.
--   - Auto-synthesized rows: receive aggregate edits but the cells
--     stay read-only at the row level; the planner uses "+ Add row"
--     to create a fresh editable line instead.
--
-- A boolean flag on the row is the simplest carrier. Default false
-- so existing rows + future auto-synthesized writes don't accidentally
-- claim user-added status.

ALTER TABLE ip_wholesale_forecast_tbd
  ADD COLUMN IF NOT EXISTS is_user_added boolean NOT NULL DEFAULT false;
