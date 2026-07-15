-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine FP&A — BUDGET vs ACTUAL.
--
-- The CEO-approved re-rate flagged "no budget-vs-actual" as an absent reporting
-- capability. A bare `gl_budgets` table (P25/M22) already existed — this
-- migration turns it into a usable FP&A layer:
--
--   1. SCENARIO/VERSION support — one entity can hold several named budget
--      versions (e.g. 'default', 'stretch', 'board') side by side. Adds
--      gl_budgets.scenario and widens the uniqueness key to include it.
--
--   2. v_gl_budget_monthly — expands each budget row into a per-MONTH grain so
--      both the variance RPC and the date-range statement integration share one
--      expansion rule:
--        • period_number 0 (full-year)   → 1/12 of the amount in every month
--        • period_number 1..12 (a month) → the amount in that single month
--      (Operators enter EITHER a full-year OR monthly budget per account, not
--       both; if both exist the month is the sum — documented in the panel.)
--
--   3. budget_vs_actual(entity, basis, fiscal_year, scenario) — per account ×
--      month: budget vs ACTUAL (posted GL activity with the SAME signed
--      semantics the Income Statement uses — revenue = CR−DR, contra_revenue =
--      DR−CR, expense = DR−CR), variance $ (= actual − budget), variance %, and
--      a sign-aware FAVORABLE flag (over-revenue = favorable; over-expense /
--      over-contra = unfavorable). FULL OUTER JOIN so accounts with budget-but-
--      no-actual and actual-but-no-budget both surface.
--
--   4. budget_by_account_range(entity, from, to, scenario) — per account budget
--      total over an arbitrary posting-date window, for the Income Statement /
--      Balance Sheet "Budget" column (actual there comes from the statement's
--      own fetch, so the two stay consistent by construction).
--
--   5. seed_budget_from_actuals(entity, basis, source_year, target_year,
--      growth_pct, scenario, grain) — a fast "draft a budget from history"
--      helper: prior-year actuals × (1 + growth%), written either as one
--      full-year row per account ('annual') or twelve monthly rows ('monthly').
--      Budget is PLANNING data only — this NEVER posts to the GL.
--
-- All *_cents are TRUE integer cents (jel.debit/credit are numeric DOLLARS; see
-- mig 20260970). Idempotent throughout (ADD COLUMN IF NOT EXISTS, CREATE OR
-- REPLACE, DROP+CREATE index). Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Scenario/version column + widened uniqueness key.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE gl_budgets ADD COLUMN IF NOT EXISTS scenario text NOT NULL DEFAULT 'default';

-- Old key was (entity, account, fiscal_year, period_number). The upsert path now
-- keys on scenario too, so replace the index. (Both are plain unique indexes; a
-- DROP/CREATE is safe — no FK references gl_budgets' unique key.)
DROP INDEX IF EXISTS uq_gl_budgets;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_budgets_scn
  ON gl_budgets(entity_id, gl_account_id, fiscal_year, period_number, scenario);

COMMENT ON COLUMN gl_budgets.scenario IS
  'FP&A budget version label (e.g. default / stretch / board). Part of the row uniqueness key so multiple named budgets can coexist per entity/year.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. v_gl_budget_monthly — expand budgets to a per-month grain.
-- ────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_gl_budget_monthly;
CREATE VIEW v_gl_budget_monthly AS
SELECT
  b.entity_id,
  b.gl_account_id,
  b.fiscal_year,
  COALESCE(b.scenario, 'default') AS scenario,
  gs.month::int                   AS month,
  CASE WHEN b.period_number = 0
       THEN round(b.amount_cents / 12.0)::bigint   -- full-year spread evenly
       ELSE b.amount_cents END    AS budget_cents
FROM gl_budgets b
CROSS JOIN generate_series(1, 12) AS gs(month)
WHERE b.period_number = 0 OR b.period_number = gs.month;

COMMENT ON VIEW v_gl_budget_monthly IS
  'Per-month expansion of gl_budgets. period_number 0 (full-year) spreads amount_cents evenly across 12 months (round to the cent); period_number 1..12 emits the amount in that single month. Both the variance RPC and the range RPC read this so the expansion rule lives in one place.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. budget_vs_actual(entity, basis, fiscal_year, scenario)
--    Per account × month, budget vs actual, variance $ / %, favorable flag.
-- ────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS budget_vs_actual(uuid, text, int, text);
CREATE FUNCTION budget_vs_actual(
  p_entity_id   uuid,
  p_basis       text,
  p_fiscal_year int,
  p_scenario    text DEFAULT 'default'
)
RETURNS TABLE (
  entity_id        uuid,
  fiscal_year      int,
  scenario         text,
  month            int,
  account_id       uuid,
  account_type     text,
  account_subtype  text,
  code             text,
  name             text,
  parent_code      text,
  parent_name      text,
  budget_cents     bigint,
  actual_cents     bigint,
  variance_cents   bigint,
  favorable        boolean,
  variance_pct     numeric
) AS $$
  WITH act AS (
    SELECT
      jel.account_id                            AS aid,
      EXTRACT(MONTH FROM je.posting_date)::int  AS month,
      ROUND(SUM(CASE
        WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
        WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
        WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
      END) * 100)::bigint                       AS actual_cents
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN gl_accounts ga          ON ga.id = jel.account_id
    WHERE je.status = 'posted'
      AND je.entity_id = p_entity_id
      AND upper(p_basis) IN ('ACCRUAL','CASH')
      AND je.basis = upper(p_basis)
      AND EXTRACT(YEAR FROM je.posting_date)::int = p_fiscal_year
      AND ga.account_type IN ('revenue','contra_revenue','expense')
    GROUP BY jel.account_id, EXTRACT(MONTH FROM je.posting_date)
  ),
  bud AS (
    SELECT gl_account_id AS aid, month, SUM(budget_cents)::bigint AS budget_cents
    FROM v_gl_budget_monthly
    WHERE entity_id = p_entity_id
      AND fiscal_year = p_fiscal_year
      AND scenario = COALESCE(p_scenario, 'default')
    GROUP BY gl_account_id, month
  ),
  merged AS (
    SELECT
      COALESCE(a.aid, b.aid)                 AS aid,
      COALESCE(a.month, b.month)             AS month,
      COALESCE(b.budget_cents, 0)::bigint    AS budget_cents,
      COALESCE(a.actual_cents, 0)::bigint    AS actual_cents
    FROM act a
    FULL OUTER JOIN bud b ON a.aid = b.aid AND a.month = b.month
  )
  SELECT
    p_entity_id,
    p_fiscal_year,
    COALESCE(p_scenario, 'default'),
    m.month,
    ga.id, ga.account_type, ga.account_subtype, ga.code, ga.name,
    pa.code, pa.name,
    m.budget_cents,
    m.actual_cents,
    (m.actual_cents - m.budget_cents)::bigint AS variance_cents,
    CASE WHEN ga.account_type = 'revenue'
         THEN (m.actual_cents - m.budget_cents) >= 0     -- more income = favorable
         ELSE (m.actual_cents - m.budget_cents) <= 0      -- less cost/contra = favorable
    END AS favorable,
    CASE WHEN m.budget_cents = 0 THEN NULL
         ELSE round((m.actual_cents - m.budget_cents)::numeric / abs(m.budget_cents) * 100, 1)
    END AS variance_pct
  FROM merged m
  JOIN gl_accounts ga      ON ga.id = m.aid
  LEFT JOIN gl_accounts pa ON pa.id = ga.parent_account_id
  WHERE ga.account_type IN ('revenue','contra_revenue','expense')
  ORDER BY ga.code, m.month;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION budget_vs_actual(uuid, text, int, text) IS
  'FP&A budget vs actual per account × month for a fiscal year + scenario. actual_cents = posted GL, TRUE cents, signed like the Income Statement (revenue=CR-DR, contra=DR-CR, expense=DR-CR). variance_cents = actual - budget. favorable is sign-aware: revenue favorable when actual>=budget, expense/contra favorable when actual<=budget. FULL OUTER JOIN so budget-only and actual-only accounts both appear. STABLE.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. budget_by_account_range(entity, from, to, scenario)
--    Per account budget total for an arbitrary posting-date window (for the
--    statement "Budget" column). Maps fiscal_year+month → make_date(y,m,1).
-- ────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS budget_by_account_range(uuid, date, date, text);
CREATE FUNCTION budget_by_account_range(
  p_entity_id  uuid,
  p_from_date  date,
  p_to_date    date,
  p_scenario   text DEFAULT 'default'
)
RETURNS TABLE (
  account_id   uuid,
  code         text,
  name         text,
  account_type text,
  budget_cents bigint
) AS $$
  SELECT
    ga.id, ga.code, ga.name, ga.account_type,
    SUM(vbm.budget_cents)::bigint AS budget_cents
  FROM v_gl_budget_monthly vbm
  JOIN gl_accounts ga ON ga.id = vbm.gl_account_id
  WHERE vbm.entity_id = p_entity_id
    AND vbm.scenario = COALESCE(p_scenario, 'default')
    AND make_date(vbm.fiscal_year, vbm.month, 1) >= date_trunc('month', p_from_date)::date
    AND make_date(vbm.fiscal_year, vbm.month, 1) <= p_to_date
  GROUP BY ga.id, ga.code, ga.name, ga.account_type;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION budget_by_account_range(uuid, date, date, text) IS
  'Per account budget_cents summed over [from,to] from v_gl_budget_monthly (a month is in-window when make_date(fiscal_year,month,1) falls in the range). Feeds the Income Statement / Balance Sheet Budget column. STABLE.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5. seed_budget_from_actuals(...) — draft a budget from prior-year actuals.
--    grain 'annual'  → one period-0 (full-year) row per account.
--    grain 'monthly' → twelve per-month rows per account.
--    Upserts into gl_budgets. Returns the number of rows written. NEVER posts GL.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION seed_budget_from_actuals(
  p_entity_id    uuid,
  p_basis        text,
  p_source_year  int,
  p_target_year  int,
  p_growth_pct   numeric DEFAULT 0,
  p_scenario     text    DEFAULT 'default',
  p_grain        text    DEFAULT 'annual'
) RETURNS integer AS $$
DECLARE
  v_count  int     := 0;
  v_factor numeric := 1 + COALESCE(p_growth_pct, 0) / 100.0;
  v_scn    text    := COALESCE(NULLIF(trim(p_scenario), ''), 'default');
BEGIN
  IF upper(p_basis) NOT IN ('ACCRUAL','CASH') THEN
    RAISE EXCEPTION 'seed_budget_from_actuals: p_basis must be ACCRUAL or CASH, got %', p_basis USING ERRCODE = '22023';
  END IF;
  IF p_grain NOT IN ('annual','monthly') THEN
    RAISE EXCEPTION 'seed_budget_from_actuals: p_grain must be annual or monthly, got %', p_grain USING ERRCODE = '22023';
  END IF;

  WITH act AS (
    SELECT
      jel.account_id                           AS aid,
      EXTRACT(MONTH FROM je.posting_date)::int AS month,
      ROUND(SUM(CASE
        WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
        WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
        WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
      END) * 100)::bigint                      AS actual_cents
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN gl_accounts ga          ON ga.id = jel.account_id
    WHERE je.status = 'posted'
      AND je.entity_id = p_entity_id
      AND je.basis = upper(p_basis)
      AND EXTRACT(YEAR FROM je.posting_date)::int = p_source_year
      AND ga.account_type IN ('revenue','contra_revenue','expense')
    GROUP BY jel.account_id, EXTRACT(MONTH FROM je.posting_date)
  ),
  rows AS (
    SELECT
      aid,
      CASE WHEN p_grain = 'annual' THEN 0 ELSE month END AS period_number,
      round(SUM(actual_cents) * v_factor)::bigint         AS amount_cents
    FROM act
    GROUP BY aid, CASE WHEN p_grain = 'annual' THEN 0 ELSE month END
  ),
  up AS (
    INSERT INTO gl_budgets (entity_id, gl_account_id, fiscal_year, period_number, amount_cents, scenario, notes, updated_at)
    SELECT p_entity_id, aid, p_target_year, period_number, amount_cents, v_scn,
           'Seeded from ' || p_source_year || ' actuals x' || round(v_factor, 4), now()
    FROM rows
    ON CONFLICT (entity_id, gl_account_id, fiscal_year, period_number, scenario)
    DO UPDATE SET amount_cents = EXCLUDED.amount_cents, notes = EXCLUDED.notes, updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION seed_budget_from_actuals(uuid, text, int, int, numeric, text, text) IS
  'Draft a budget from prior-year actuals x (1 + growth%). grain annual = one full-year (period 0) row per account; grain monthly = twelve monthly rows. Upserts gl_budgets and returns rows written. Planning data only — never posts to the GL.';

-- ────────────────────────────────────────────────────────────────────────────
-- Grants (service_role always bypasses RLS; grant read to anon/authenticated so
-- the functions are callable via PostgREST too).
-- ────────────────────────────────────────────────────────────────────────────
GRANT SELECT ON v_gl_budget_monthly TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION budget_vs_actual(uuid, text, int, text)             TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION budget_by_account_range(uuid, date, date, text)     TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION seed_budget_from_actuals(uuid, text, int, int, numeric, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- Migration-tracking footer.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    VALUES ('20261030000000', 'budget_vs_actual', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
