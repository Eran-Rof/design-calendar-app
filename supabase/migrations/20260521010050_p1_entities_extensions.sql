-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 1 / Migration 1
-- Extend `entities` with ERP-grade columns needed by M1 Tenancy and M2 GL.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §3.1
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Add columns (all nullable first so backfill can run cleanly)
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS code                       text,
  ADD COLUMN IF NOT EXISTS functional_currency        char(3),
  ADD COLUMN IF NOT EXISTS fiscal_year_start_month    smallint,
  ADD COLUMN IF NOT EXISTS accounting_basis_primary   text,
  ADD COLUMN IF NOT EXISTS posting_locked_through     date,
  ADD COLUMN IF NOT EXISTS country                    char(2),
  ADD COLUMN IF NOT EXISTS metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Backfill the seed RoF row + any other existing rows
UPDATE entities
SET
  code                     = COALESCE(code, CASE WHEN slug = 'ring-of-fire' THEN 'ROF' ELSE upper(replace(slug, '-', '')) END),
  functional_currency      = COALESCE(functional_currency, 'USD'),
  fiscal_year_start_month  = COALESCE(fiscal_year_start_month, 1),
  accounting_basis_primary = COALESCE(accounting_basis_primary, 'ACCRUAL')
WHERE code IS NULL
   OR functional_currency IS NULL
   OR fiscal_year_start_month IS NULL
   OR accounting_basis_primary IS NULL;

-- 3. Now lock down NOT NULL + defaults + CHECKs
ALTER TABLE entities
  ALTER COLUMN code                     SET NOT NULL,
  ALTER COLUMN functional_currency      SET NOT NULL,
  ALTER COLUMN functional_currency      SET DEFAULT 'USD',
  ALTER COLUMN fiscal_year_start_month  SET NOT NULL,
  ALTER COLUMN fiscal_year_start_month  SET DEFAULT 1,
  ALTER COLUMN accounting_basis_primary SET NOT NULL,
  ALTER COLUMN accounting_basis_primary SET DEFAULT 'ACCRUAL';

-- 4. Unique code per system (case-sensitive); CHECK on basis + fiscal month
-- All constraints wrapped in DO/EXCEPTION so re-running on a prod state
-- that already has them (from a past paste-bundle apply) is idempotent.
DO $$ BEGIN
  ALTER TABLE entities ADD CONSTRAINT entities_code_unique UNIQUE (code);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE entities ADD CONSTRAINT entities_basis_check
    CHECK (accounting_basis_primary IN ('ACCRUAL', 'CASH'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE entities ADD CONSTRAINT entities_fiscal_month_check
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE entities ADD CONSTRAINT entities_currency_check
    CHECK (functional_currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN entities.code                     IS 'Short entity code (e.g. ROF). Drives PO/SO/invoice numbering prefixes. Unique.';
COMMENT ON COLUMN entities.functional_currency      IS 'Functional reporting currency. USD only at launch (per Tangerine P1 decision); schema future-proofs M2.';
COMMENT ON COLUMN entities.fiscal_year_start_month  IS '1..12; drives gl_periods generator.';
COMMENT ON COLUMN entities.accounting_basis_primary IS 'Primary reporting basis. ACCRUAL or CASH. Both books always exist (dual-basis); this is the default for reports.';
COMMENT ON COLUMN entities.posting_locked_through   IS 'Hard lock: any posting_date on or before this date is rejected. Sub-period grain in gl_periods.status.';
COMMENT ON COLUMN entities.country                  IS 'ISO 3166-1 alpha-2. Informational at launch; drives 1099/tax in later phases.';
COMMENT ON COLUMN entities.metadata                 IS 'Free-form (branding flags, integration toggles).';
