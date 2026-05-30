-- Paired migration for the iCloud bundle:
-- Producton Orders/sql/2026_05_30_costing_avg_cost_column.sql
--
-- Adds avg_cost column to costing_lines so the grid can show a read-only
-- historical reference separate from the editable target_cost. See the
-- iCloud bundle header for the full rationale.

ALTER TABLE costing_lines
  ADD COLUMN IF NOT EXISTS avg_cost numeric(12,4);

COMMENT ON COLUMN costing_lines.avg_cost IS 'Historical reference cost from ip_item_avg_cost at style-pick time. Read-only in the grid. Distinct from target_cost (editable) so the operator always has a source-of-truth reference even after target_cost is overridden.';

NOTIFY pgrst, 'reload schema';
