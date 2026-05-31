-- Costing Module — mirror the three project header dates onto each RFQ.
--
-- Operator ask: the RFQ detail should show the same Request / Due /
-- Projected Delivery dates as the source costing project header, not the
-- generic `submission_deadline` + `delivery_required_by` fields. Add the
-- three new columns so generate-rfqs can stamp them from the project
-- header and the UI can render them cleanly.
--
-- The existing `submission_deadline` and `delivery_required_by` columns
-- stay (no DROP) so the Tangerine procurement schema invariant doesn't
-- break and any other reader keeps working. The costing UI just stops
-- rendering them.

ALTER TABLE rfqs
  ADD COLUMN IF NOT EXISTS request_date            date,
  ADD COLUMN IF NOT EXISTS due_date                date,
  ADD COLUMN IF NOT EXISTS projected_delivery_date date;

COMMENT ON COLUMN rfqs.request_date            IS 'Snapshot of costing_projects.request_date at generate-rfqs time. NULL on legacy rows.';
COMMENT ON COLUMN rfqs.due_date                IS 'Snapshot of costing_projects.due_date at generate-rfqs time. NULL on legacy rows. Distinct from the existing delivery_required_by, which the costing UI no longer shows.';
COMMENT ON COLUMN rfqs.projected_delivery_date IS 'Snapshot of costing_projects.projected_delivery_date at generate-rfqs time. NULL on legacy rows.';

NOTIFY pgrst, 'reload schema';
