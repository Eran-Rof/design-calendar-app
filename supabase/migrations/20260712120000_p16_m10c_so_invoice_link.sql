-- P16 / M10-C — link AR invoices back to their originating sales order.
--
-- M10-C generates a draft AR invoice from a confirmed SO's open lines. These
-- nullable FKs let the AR invoice (and each line) point back to the SO it came
-- from, so the SO panel can show "invoiced" provenance and so future reporting
-- can roll AR up by sales order. Existing manual AR invoices keep NULL.

ALTER TABLE ar_invoices
  ADD COLUMN IF NOT EXISTS sales_order_id uuid REFERENCES sales_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ar_invoices_sales_order ON ar_invoices (sales_order_id);

ALTER TABLE ar_invoice_lines
  ADD COLUMN IF NOT EXISTS sales_order_line_id uuid REFERENCES sales_order_lines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ar_invoice_lines_so_line ON ar_invoice_lines (sales_order_line_id);

COMMENT ON COLUMN ar_invoices.sales_order_id IS 'P16/M10-C — set when the AR invoice was generated from a sales order. NULL for manual invoices.';

NOTIFY pgrst, 'reload schema';
