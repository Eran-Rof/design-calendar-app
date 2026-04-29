-- 20260422040000_shipment_invoice_marker.sql
--
-- When a vendor submits an invoice linked to a shipment (either through
-- the "Submit ASN + Invoice" combined flow on a new shipment or via
-- "Create Invoice from PL" on the detail page), stamp the shipment so
-- the list and detail views can show an at-a-glance "Invoiced — <date>"
-- indicator without a subquery.
--
-- `shipments.invoice_id` already exists (added in Phase 2.1); we just
-- add the timestamp column.

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS invoice_created_at timestamptz;
