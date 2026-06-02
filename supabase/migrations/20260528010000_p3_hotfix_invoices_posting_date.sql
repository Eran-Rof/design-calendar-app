-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 hotfix — invoices.posting_date column
--
-- The P3-1 schema migration (`20260527060000_p3_chunk1_ap_schema.sql`) extended
-- the `invoices` table with several accounting columns but forgot
-- `posting_date`. The P3-2 admin UI + handlers query and write this column
-- (`api/_handlers/internal/ap-invoices/index.js` GET orders by posting_date,
-- POST inserts it; the UI's edit modal exposes it as the line-of-demarcation
-- between accrual and cash JEs).
--
-- Without this column the AP Invoices panel returns:
--   ERROR: column invoices.posting_date does not exist
--
-- This hotfix:
--   1. Adds the column nullable (so existing rows don't fail)
--   2. Backfills from the legacy `invoice_date` column when present; falls back
--      to `current_date` for any remaining rows.
--   3. Adds an index on posting_date for the list-query order-by.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + UPDATE on NULL only.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS posting_date date;

-- Backfill: prefer legacy invoice_date; fall back to current_date for rows
-- that have neither. UPDATE only touches rows where posting_date IS NULL so
-- re-runs are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'invoices'
      AND column_name = 'invoice_date'
  ) THEN
    UPDATE invoices SET posting_date = COALESCE(invoice_date, current_date)
     WHERE posting_date IS NULL;
  ELSE
    UPDATE invoices SET posting_date = current_date
     WHERE posting_date IS NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_entity_posting_date
  ON invoices (entity_id, posting_date DESC);

COMMENT ON COLUMN invoices.posting_date IS 'GL posting date for the invoice (drives period assignment + accrual JE date). Distinct from invoice_date which is the vendor-facing bill date. Added in P3 hotfix 2026-05-28.';
