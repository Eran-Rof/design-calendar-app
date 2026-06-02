-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 hotfix #2 — invoices.description + invoices.updated_at
--
-- The P3-1 schema migration (20260527060000_p3_chunk1_ap_schema.sql) extended
-- the `invoices` table with accounting columns but did not add `description`
-- or `updated_at`. The P3-2 AP UI + handlers (`api/_handlers/internal/
-- ap-invoices/index.js` SELECT list, [id].js PATCH path) query both.
--
-- Symptoms without this fix:
--   ERROR: column invoices.description does not exist
--   ERROR: column invoices.updated_at does not exist
--
-- The first hotfix (20260528010000) covered posting_date. This one covers the
-- remaining two columns identified after operator reported the description
-- error on the AP Invoices panel.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS for both.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN invoices.description IS 'Free-form invoice description / line memo. Added in P3 hotfix #2 (2026-05-28). Distinct from invoice_number and any vendor-portal notes.';
COMMENT ON COLUMN invoices.updated_at  IS 'Last-modified timestamp. Maintained by trigger below. Added in P3 hotfix #2 (2026-05-28).';

-- Touch trigger so updated_at is maintained automatically.
CREATE OR REPLACE FUNCTION invoices_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoices_touch_updated_at_trg ON invoices;
CREATE TRIGGER invoices_touch_updated_at_trg
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_touch_updated_at();

-- Force PostgREST to reload its schema cache so the new columns are visible
-- to the API layer immediately. Without this the operator would need to wait
-- ~10 min for the cache to expire.
NOTIFY pgrst, 'reload schema';
