-- Manufacturing module (M5b) — part purchase lines on vendor bills.
--
-- A part purchase is a normal vendor bill (invoices) whose line stocks a
-- part_master part into part inventory (1360) instead of a style SKU. The
-- part_id column flags such a line for traceability; the posting path
-- (apInvoiceReceived part-line branch) creates the part FIFO layer.
ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS part_id uuid REFERENCES part_master(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS invoice_line_items_part_idx ON invoice_line_items(part_id);
