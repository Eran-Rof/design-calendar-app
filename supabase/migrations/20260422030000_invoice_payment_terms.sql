-- 20260422030000_invoice_payment_terms.sql
--
-- Payment terms on invoices + vendor-level default so the invoice form
-- can prefill to the vendor's preset choice.
--
-- Canonical values (UI-enforced, not a CHECK constraint — kept flexible
-- so future additions don't need a migration):
--   FOB, DDP 30, DDP 60, DDP 90, DDP 120, DDP 150, DDP 180, DP, TT

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_terms text;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS default_payment_terms text;
