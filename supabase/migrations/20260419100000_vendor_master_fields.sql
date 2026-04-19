-- 20260419100000_vendor_master_fields.sql
--
-- Phase 5 part 7 — vendor master record fields that the internal
-- vendor-management API lets ops update:
--   status          active | inactive  (inactive revokes portal access)
--   payment_terms   free-form text, e.g. "Net 30"
--   tax_id          EIN / VAT / etc.

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'inactive')),
  ADD COLUMN IF NOT EXISTS payment_terms  text,
  ADD COLUMN IF NOT EXISTS tax_id         text;

CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors (status);
