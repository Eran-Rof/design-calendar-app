-- invoice_line_items.po_number — the Xoro PO number carried on each AP bill
-- item line (billItemLineArr[].PoNumber, e.g. 'ROF-P000080'). Captured by the
-- AP bill sync so the Inventory Snapshot "Purchased" drill can bridge a bill
-- line to its goods-receipt date (ip_receipts_history.po_number → received_date)
-- and surface the originating PO.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — the CI "Supabase DB push" re-runs
-- manually-applied migrations, so this must be safe to run more than once.

ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS po_number text;

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_po_number
  ON invoice_line_items (po_number)
  WHERE po_number IS NOT NULL;
