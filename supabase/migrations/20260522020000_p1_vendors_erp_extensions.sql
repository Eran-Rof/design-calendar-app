-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 6 / Migration 13
-- vendors ERP-grade extensions. Promotes `vendors` to canonical M35 (per arch
-- §7.1) by adding the ERP-grade columns AP/AR/inventory modules will need.
--
-- Existing `deleted_at` soft-delete semantics preserved. `status` is added
-- alongside (derived from deleted_at on backfill) so future code can use the
-- enum directly without joining on null-checks.
--
-- ip_vendor_master is NOT converted to a view in this migration — pre-flight
-- found WRITES to ip_vendor_master in scripts/seed-demo-celebpink.mjs. That
-- conversion lands in a follow-up chunk (6.5) after the seed script is
-- updated to write to vendors directly. Arch §12 risk register documented
-- this mitigation.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §7.2
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS code                            text,
  ADD COLUMN IF NOT EXISTS legal_name                      text,
  ADD COLUMN IF NOT EXISTS tax_id                          text,
  ADD COLUMN IF NOT EXISTS payment_terms                   text,
  ADD COLUMN IF NOT EXISTS default_currency                char(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS default_gl_ap_account_id        uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_gl_expense_account_id   uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status                          text,
  ADD COLUMN IF NOT EXISTS is_1099_vendor                  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS address                         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS bank_account_encrypted          bytea,
  ADD COLUMN IF NOT EXISTS created_by_user_id              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by_user_id              uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill `status` from existing soft-delete state.
UPDATE vendors
   SET status = CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'inactive' END
 WHERE status IS NULL;

ALTER TABLE vendors
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_status_check;
ALTER TABLE vendors ADD CONSTRAINT vendors_status_check
  CHECK (status IN ('active', 'on_hold', 'inactive'));

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_default_currency_check;
ALTER TABLE vendors ADD CONSTRAINT vendors_default_currency_check
  CHECK (default_currency ~ '^[A-Z]{3}$');

CREATE INDEX IF NOT EXISTS idx_vendors_status      ON vendors (status);
CREATE INDEX IF NOT EXISTS idx_vendors_is_1099     ON vendors (is_1099_vendor) WHERE is_1099_vendor = true;
CREATE INDEX IF NOT EXISTS idx_vendors_ap_account  ON vendors (default_gl_ap_account_id) WHERE default_gl_ap_account_id IS NOT NULL;

-- Touched timestamp (vendors already has updated_at column from Phase 0; no
-- trigger existed since the JSON-blob mirror handled it. Add an explicit one
-- so direct UPDATEs maintain updated_at correctly.)
CREATE OR REPLACE FUNCTION vendors_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendors_touch_trg ON vendors;
CREATE TRIGGER vendors_touch_trg
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION vendors_touch();

COMMENT ON COLUMN vendors.code                          IS 'Vendor short code (e.g. V0042). Nullable at launch; merchandiser populates via admin UI. Per-entity uniqueness via entity_vendors.vendor_code; vendors.code itself is global identifier.';
COMMENT ON COLUMN vendors.tax_id                        IS 'EIN / VAT. PII per CLAUDE.md — app layer must encrypt before INSERT/UPDATE (AES-256). Schema stores ciphertext as text. NEVER log this column.';
COMMENT ON COLUMN vendors.bank_account_encrypted        IS 'AES-256-GCM ciphertext of routing+account number, populated only when vendor opts into ACH. NEVER log. Schema enforces bytea so any string-coerced write fails loudly.';
COMMENT ON COLUMN vendors.status                        IS 'active | on_hold | inactive. Backfilled from deleted_at on migration; both columns coexist (status is the forward-facing enum, deleted_at remains for soft-delete semantics).';
COMMENT ON COLUMN vendors.is_1099_vendor                IS 'Pre-flags M20 1099 reporting eligibility. Default false; CPA flips via admin UI.';
COMMENT ON COLUMN vendors.default_gl_ap_account_id      IS 'Override of entity-default AP account. When NULL, posting service uses the entity-level default (configured in chart of accounts seed).';
COMMENT ON COLUMN vendors.default_gl_expense_account_id IS 'Default expense account for bills without explicit line coding. NULL → require line-level account on every bill.';
