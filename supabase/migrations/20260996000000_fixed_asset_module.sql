-- ════════════════════════════════════════════════════════════════════════════
-- Fixed-Asset & Depreciation module (#1762)
--
-- Builds on the schema-only M21 tables from 20260803000000_p25_finance.sql
-- (fixed_assets + fixed_asset_depreciation, both 0 rows). This migration:
--   1. Extends fixed_assets: multi-method depreciation, in-service date,
--      units-of-production capacity.
--   2. Extends fixed_asset_depreciation: accumulated + book-value snapshots,
--      posted flag, source tag (the per-period schedule row shape).
--   3. Adds fixed_asset_settings — a single per-entity row whose
--      posting_enabled bool (DEFAULT FALSE) is the CUTOVER GATE for the GL
--      poster. It MUST stay FALSE while Xoro is the system of record, because
--      Tangerine's GL is a faithful 1:1 mirror of Xoro (journal_type
--      'xoro_gl_mirror') and Xoro ALREADY posts depreciation into the GL we
--      mirror. Turning posting on before Xoro cutover would DOUBLE-COUNT
--      depreciation. This module therefore only RECONCILES the register
--      against the mirror (see v_fixed_asset_gl_tieout); it does not post.
--   4. Adds v_fixed_asset_gl_tieout — per-period comparison of the register's
--      computed depreciation/accumulated vs the mirror GL's depreciation-
--      expense (6319) and accumulated-depreciation (1590) activity.
--
-- GL accounts (verified present in COA): 1500 Fixed Assets, 1590 Accumulated
-- Depreciation, 6319 Depreciation Expense, 4903 Gain/loss-fixed assets disposal.
--
-- Idempotent throughout (IF NOT EXISTS / guarded DO blocks / CREATE OR REPLACE).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Extend fixed_assets ───────────────────────────────────────────────────
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS description        text;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS in_service_date    date;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS units_total        bigint
  CHECK (units_total IS NULL OR units_total > 0);

-- Backfill in_service_date for any pre-existing rows (module ships with 0).
UPDATE fixed_assets
   SET in_service_date = COALESCE(in_service_date, depreciation_start, acquisition_date)
 WHERE in_service_date IS NULL;

-- Relax the method CHECK (was straight_line-only) to the four supported methods.
-- The original constraint is system-named; drop it by discovery, then re-add.
DO $$
DECLARE c_name text;
BEGIN
  FOR c_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'fixed_assets'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%method%straight_line%'
  LOOP
    EXECUTE format('ALTER TABLE fixed_assets DROP CONSTRAINT %I', c_name);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'fixed_assets'::regclass AND conname = 'fixed_assets_method_chk'
  ) THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_method_chk
      CHECK (method IN ('straight_line','declining_balance_200','declining_balance_150','units_of_production'));
  END IF;
END $$;

COMMENT ON COLUMN fixed_assets.in_service_date IS 'Date the asset was placed in service; depreciation begins the month containing this date (half-month convention in the engine). Defaults to depreciation_start/acquisition_date.';
COMMENT ON COLUMN fixed_assets.units_total IS 'Total expected lifetime units for method=units_of_production (denominator for the per-unit rate).';

-- ── 2. Extend fixed_asset_depreciation (the per-period schedule row) ──────────
-- amount_cents already holds the period depreciation amount (the "depreciation_cents").
ALTER TABLE fixed_asset_depreciation ADD COLUMN IF NOT EXISTS accumulated_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE fixed_asset_depreciation ADD COLUMN IF NOT EXISTS book_value_cents  bigint NOT NULL DEFAULT 0;
ALTER TABLE fixed_asset_depreciation ADD COLUMN IF NOT EXISTS posted            boolean NOT NULL DEFAULT false;
ALTER TABLE fixed_asset_depreciation ADD COLUMN IF NOT EXISTS source            text NOT NULL DEFAULT 'schedule';

COMMENT ON COLUMN fixed_asset_depreciation.amount_cents IS 'Depreciation for this period (the depreciation_cents of the schedule row).';
COMMENT ON COLUMN fixed_asset_depreciation.accumulated_cents IS 'Accumulated depreciation through and including this period.';
COMMENT ON COLUMN fixed_asset_depreciation.book_value_cents IS 'Net book value at period end (cost - accumulated).';
COMMENT ON COLUMN fixed_asset_depreciation.posted IS 'TRUE once a GL depreciation JE has been posted for this period (gated off until Xoro cutover).';

-- ── 3. fixed_asset_settings — the cutover gate ───────────────────────────────
CREATE TABLE IF NOT EXISTS fixed_asset_settings (
  entity_id        uuid PRIMARY KEY DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE CASCADE,
  posting_enabled  boolean NOT NULL DEFAULT false,   -- CUTOVER GATE: keep FALSE while Xoro is SoR
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid
);
COMMENT ON TABLE fixed_asset_settings IS 'Per-entity fixed-asset config. posting_enabled is the cutover gate for the depreciation GL poster; MUST stay FALSE while Xoro is system of record (Tangerine GL mirrors Xoro, which already books depreciation — posting here would double-count).';

-- Seed a disabled row for ROF (idempotent).
INSERT INTO fixed_asset_settings (entity_id, posting_enabled)
SELECT id, false FROM entities WHERE code = 'ROF'
ON CONFLICT (entity_id) DO NOTHING;

-- ── 4. GL tie-out view ───────────────────────────────────────────────────────
-- Per accounting month, compare the register's depreciation/accumulated against
-- the mirror GL's depreciation-expense (net debit) and accumulated-depreciation
-- (net credit) activity. The GL side uses the expense/accum accounts that assets
-- are mapped to, falling back to the canonical COA codes 6319 / 1590.
CREATE OR REPLACE VIEW v_fixed_asset_gl_tieout AS
WITH ent AS (
  SELECT id AS entity_id FROM entities
),
-- Register depreciation per month (all assets, and mapped-account subset).
reg AS (
  SELECT
    fa.entity_id,
    date_trunc('month', fad.period_date)::date          AS period_month,
    SUM(fad.amount_cents)::bigint                        AS reg_depr_cents,
    SUM(fad.amount_cents) FILTER (WHERE fa.deprec_expense_account_id IS NOT NULL)::bigint
                                                          AS reg_depr_mapped_cents
  FROM fixed_asset_depreciation fad
  JOIN fixed_assets fa ON fa.id = fad.fixed_asset_id
  GROUP BY fa.entity_id, date_trunc('month', fad.period_date)
),
-- The GL accounts depreciation lives on: whatever assets map to, else 6319/1590.
exp_accts AS (
  SELECT ga.id, ga.entity_id
    FROM gl_accounts ga
   WHERE ga.code = '6319'
      OR ga.id IN (SELECT deprec_expense_account_id FROM fixed_assets WHERE deprec_expense_account_id IS NOT NULL)
),
accum_accts AS (
  SELECT ga.id, ga.entity_id
    FROM gl_accounts ga
   WHERE ga.code = '1590'
      OR ga.id IN (SELECT accum_deprec_account_id FROM fixed_assets WHERE accum_deprec_account_id IS NOT NULL)
),
gl_exp AS (
  SELECT je.entity_id,
         date_trunc('month', je.posting_date)::date AS period_month,
         ROUND(SUM(jel.debit - jel.credit) * 100)::bigint AS gl_expense_cents
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted' AND je.basis = 'ACCRUAL'
    JOIN exp_accts ea ON ea.id = jel.account_id AND ea.entity_id = je.entity_id
   GROUP BY je.entity_id, date_trunc('month', je.posting_date)
),
gl_accum AS (
  SELECT je.entity_id,
         date_trunc('month', je.posting_date)::date AS period_month,
         ROUND(SUM(jel.credit - jel.debit) * 100)::bigint AS gl_accum_cents
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted' AND je.basis = 'ACCRUAL'
    JOIN accum_accts aa ON aa.id = jel.account_id AND aa.entity_id = je.entity_id
   GROUP BY je.entity_id, date_trunc('month', je.posting_date)
),
months AS (
  SELECT entity_id, period_month FROM reg
  UNION SELECT entity_id, period_month FROM gl_exp
  UNION SELECT entity_id, period_month FROM gl_accum
)
SELECT
  m.entity_id,
  m.period_month,
  COALESCE(reg.reg_depr_cents, 0)        AS reg_depr_cents,
  COALESCE(reg.reg_depr_mapped_cents, 0) AS reg_depr_mapped_cents,
  COALESCE(gx.gl_expense_cents, 0)       AS gl_expense_cents,
  COALESCE(ga.gl_accum_cents, 0)         AS gl_accum_cents,
  (COALESCE(reg.reg_depr_cents, 0) - COALESCE(gx.gl_expense_cents, 0)) AS diff_cents,
  CASE
    WHEN COALESCE(reg.reg_depr_cents, 0) > 0 AND COALESCE(reg.reg_depr_mapped_cents, 0) = 0
      THEN 'unmapped'
    WHEN COALESCE(reg.reg_depr_cents, 0) = COALESCE(gx.gl_expense_cents, 0)
      THEN 'tie'
    WHEN COALESCE(reg.reg_depr_cents, 0) > COALESCE(gx.gl_expense_cents, 0)
      THEN 'register_ahead'
    ELSE 'gl_ahead'
  END AS category
FROM months m
LEFT JOIN reg      ON reg.entity_id = m.entity_id AND reg.period_month = m.period_month
LEFT JOIN gl_exp   gx ON gx.entity_id = m.entity_id AND gx.period_month = m.period_month
LEFT JOIN gl_accum ga ON ga.entity_id = m.entity_id AND ga.period_month = m.period_month;

COMMENT ON VIEW v_fixed_asset_gl_tieout IS 'Per-month reconciliation: fixed-asset register depreciation/accumulated vs mirror GL depreciation-expense (6319) and accumulated-depreciation (1590) activity. category: tie | register_ahead | gl_ahead | unmapped. Controllership control — does the asset register agree with what Xoro booked into the mirror GL.';

-- ── 5. RLS for the new settings table (anon read-only, like siblings) ────────
DO $$ BEGIN
  ALTER TABLE fixed_asset_settings ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fixed_asset_settings' AND policyname='anon_read_fa_settings') THEN
    CREATE POLICY "anon_read_fa_settings" ON fixed_asset_settings FOR SELECT TO anon USING (true); END IF;
END $$;

NOTIFY pgrst, 'reload schema';
