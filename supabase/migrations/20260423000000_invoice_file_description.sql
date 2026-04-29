-- 20260423000000_invoice_file_description.sql
--
-- Adds file_description to invoices so vendors can label the attached
-- document (e.g. "Invoice PDF", "Packing list", "Certificate of origin")
-- instead of the UI always rendering the raw file path.
--
-- Nullable; existing rows keep NULL which the UI renders as the filename
-- fallback.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS file_description text;
