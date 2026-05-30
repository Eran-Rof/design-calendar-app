-- Paired migration for iCloud bundle:
-- Producton Orders/sql/2026_05_30_rfqs_source_costing_project.sql
--
-- Adds rfqs.source_costing_project_id back-pointer so the RFQ list view
-- can join through to costing_projects.customer_id → customers for the
-- customer column.

ALTER TABLE rfqs
  ADD COLUMN IF NOT EXISTS source_costing_project_id uuid
    REFERENCES costing_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rfqs_source_costing_project
  ON rfqs (source_costing_project_id)
  WHERE source_costing_project_id IS NOT NULL;

COMMENT ON COLUMN rfqs.source_costing_project_id IS 'Back-pointer to the costing_projects row that generated this RFQ via the Vendor RFQ button. NULL for RFQs created outside the costing module. Drives the customer-name join in the RFQ list view.';

NOTIFY pgrst, 'reload schema';
