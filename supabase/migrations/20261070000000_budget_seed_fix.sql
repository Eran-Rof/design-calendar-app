-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine FP&A — BUDGET SEED FIX: exclude year-end CLOSING entries from actuals.
--
-- BUG (reported by CEO after PR #1779 shipped seed_budget_from_actuals):
--   "Monthly budget seeded from actuals — populated some expense fields and NONE
--    of the revenue fields."
--
-- ROOT CAUSE
--   seed_budget_from_actuals (and budget_vs_actual) computed each account's
--   actual as the signed sum of ALL posted GL activity for the fiscal year
--   (revenue = CR−DR, expense/contra = DR−CR). That full-year window swept in
--   the YEAR-END CLOSING entries, which zero the temporary P&L accounts into
--   retained earnings: revenue is DEBITED to nil, expenses CREDITED to nil. So
--   over a full closed year `credit − debit` for a revenue account nets to ≈ 0.
--
--   Concretely, on PROD (ROF, FY2025, ACCRUAL) the Xoro-mirrored closing JE
--   JE-2025-63753 (source "JE003565", posting_date 2025-12-31, journal_type
--   xoro_gl_mirror, 158 legs, $26.36M/side) debited Sales Revenue ROF Brands
--   (4005) by $20.8M and credited COGS/expenses + Retained Earnings (3900). Net
--   FY2025 revenue for 4005 collapsed from +$20.5M to −$0.33M. Seven of eleven
--   revenue accounts netted to exactly 0 → "no revenue seeded". A handful of
--   expenses whose close did not perfectly net left small residuals → "some
--   expense fields". The seed HAS no positivity/type filter; it faithfully wrote
--   the (garbage, post-close) numbers.
--
-- FIX
--   Exclude closing entries from the actuals in BOTH the seed and the variance
--   RPC so the two still reconcile (variance ≈ 0 at 0% growth). A closing entry
--   is robustly identifiable — regardless of journal_type or date — as any
--   journal entry that posts to an EQUITY (retained-earnings) account: operating
--   revenue/expense activity never touches equity, whereas both the native
--   gl_post_year_end_close JE (journal_type gl_year_end_close, credits 3500) and
--   the Xoro-mirrored close (journal_type xoro_gl_mirror, credits 3900) do. This
--   keeps legitimate channel_reclass moves (which stay within P&L accounts) in
--   the actuals, and restores every P&L account's natural-direction magnitude
--   (revenue as its positive CREDIT total, expense as its positive DEBIT total).
--
--   After the fix (ROF FY2025 ACCRUAL) all 11 revenue accounts seed with real
--   magnitudes (4005 = $20.5M, 4006 = $3.9M, 4009 = $1.07M, …).
--
-- All *_cents are TRUE integer cents (jel.debit/credit are numeric DOLLARS).
-- CREATE OR REPLACE only — idempotent, safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. budget_vs_actual — same signature, actuals now exclude closing entries.
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
  WITH closing_jes AS (
    -- Year-end CLOSING entries: any JE that posts to an equity account rolls the
    -- temporary P&L accounts into retained earnings and must NOT count as actual
    -- operating activity. Catches native gl_year_end_close AND Xoro-mirrored close.
    SELECT DISTINCT cjl.journal_entry_id AS je_id
    FROM journal_entry_lines cjl
    JOIN journal_entries    cje ON cje.id = cjl.journal_entry_id
    JOIN gl_accounts        cga ON cga.id = cjl.account_id
    WHERE cje.entity_id = p_entity_id
      AND cga.account_type = 'equity'
  ),
  act AS (
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
    LEFT JOIN closing_jes cj     ON cj.je_id = je.id
    WHERE je.status = 'posted'
      AND je.entity_id = p_entity_id
      AND upper(p_basis) IN ('ACCRUAL','CASH')
      AND je.basis = upper(p_basis)
      AND EXTRACT(YEAR FROM je.posting_date)::int = p_fiscal_year
      AND ga.account_type IN ('revenue','contra_revenue','expense')
      AND cj.je_id IS NULL                       -- drop closing entries
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
  'FP&A budget vs actual per account × month for a fiscal year + scenario. actual_cents = posted GL, TRUE cents, signed like the Income Statement (revenue=CR-DR, contra=DR-CR, expense=DR-CR), EXCLUDING year-end closing entries (any JE touching an equity account) so actuals show natural-direction magnitude and reconcile with seed_budget_from_actuals. variance_cents = actual - budget. favorable is sign-aware. FULL OUTER JOIN so budget-only and actual-only accounts both appear. STABLE. (mig 20261070000000 fix.)';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. seed_budget_from_actuals — same signature, actuals now exclude closing entries.
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

  WITH closing_jes AS (
    -- See budget_vs_actual: exclude year-end closing entries (any JE touching an
    -- equity account) so revenue seeds at its natural CREDIT magnitude, not the
    -- post-close ≈ 0. Native gl_year_end_close and Xoro-mirrored close both hit
    -- retained earnings; legitimate channel_reclass stays (P&L-only, kept).
    SELECT DISTINCT cjl.journal_entry_id AS je_id
    FROM journal_entry_lines cjl
    JOIN journal_entries    cje ON cje.id = cjl.journal_entry_id
    JOIN gl_accounts        cga ON cga.id = cjl.account_id
    WHERE cje.entity_id = p_entity_id
      AND cga.account_type = 'equity'
  ),
  act AS (
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
    LEFT JOIN closing_jes cj     ON cj.je_id = je.id
    WHERE je.status = 'posted'
      AND je.entity_id = p_entity_id
      AND je.basis = upper(p_basis)
      AND EXTRACT(YEAR FROM je.posting_date)::int = p_source_year
      AND ga.account_type IN ('revenue','contra_revenue','expense')
      AND cj.je_id IS NULL                       -- drop closing entries
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
  'Draft a budget from prior-year actuals x (1 + growth%), EXCLUDING year-end closing entries (any JE touching an equity account) so revenue seeds at its natural CREDIT magnitude, not the post-close ≈ 0. grain annual = one full-year (period 0) row per account; grain monthly = twelve monthly rows. Upserts gl_budgets and returns rows written. Reconciles with budget_vs_actual at 0% growth. Planning data only — never posts to the GL. (mig 20261070000000 fix.)';

-- ────────────────────────────────────────────────────────────────────────────
-- Grants (unchanged from mig 20261030000000 — re-assert after CREATE).
-- ────────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION budget_vs_actual(uuid, text, int, text)                              TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION seed_budget_from_actuals(uuid, text, int, int, numeric, text, text)  TO service_role;

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
    VALUES ('20261070000000', 'budget_seed_fix', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
