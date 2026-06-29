-- 20260805010000_invoices_payment_terms_id.sql
--
-- Add a structured FK reference from invoices (AP bills) to the payment_terms
-- master so the AP-invoice form can default the vendor's preset terms.
--
-- The legacy free-text `invoices.payment_terms` column stays for display
-- compatibility; this adds the canonical FK used for auto-fill from the
-- vendor master (vendors.payment_terms_id).

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_terms_id uuid REFERENCES payment_terms(id);

COMMENT ON COLUMN invoices.payment_terms_id IS 'FK to payment_terms master; defaulted from the vendor master on the AP-invoice form.';
