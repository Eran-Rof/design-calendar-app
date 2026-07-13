-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P5-3 / M6 — income_statement_monthly(): per-account, per-MONTH P&L
-- rows carrying the account hierarchy (parent group), for the best-in-class
-- Income Statement panel (monthly-column "spreadsheet P&L" + group headers).
--
-- WHY A NEW RPC
--   The existing income_statement(entity, basis, from, to) returns one row per
--   account for the WHOLE range — great for a single-period statement, but the
--   CEO wants MONTHLY COLUMNS across any date range (Jan | Feb | … | Total) plus
--   parent GROUP HEADERS with indented sub-accounts. This RPC returns one row
--   per (account, year, month) so the panel can pivot months into columns, and
--   it surfaces parent_code / parent_name so the panel can render the colon-path
--   hierarchy (Xoro/ROF chart is relational via gl_accounts.parent_account_id).
--
--   One set-based round-trip beats N per-month calls (a 24-month range would be
--   24 RPC calls); the panel sums the monthly rows for the Total column and for
--   single-period mode, so both modes share one tested data path.
--
-- SIGN CONVENTION (identical to income_statement / v_income_statement):
--   revenue        = credit − debit   (positive = income)
--   contra_revenue = debit  − credit   (positive = a deduction from revenue)
--   expense        = debit  − credit   (positive = cost)
--   amount_cents   = ROUND(SUM(<signed dollars>) * 100)::bigint  — TRUE integer
--   cents (jel.debit/credit are numeric(18,2) DOLLARS; see mig 20260970).
--
-- The panel classifies each account into the presentation bands (Net Sales,
-- COGS, Gross Profit, Operating Expenses, Net Operating Income, Other Income &
-- Expense, Net Income); this RPC stays a neutral data provider and does NOT
-- bake in that band mapping, so the mapping can be tuned in the UI without a
-- migration.
--
-- STABLE, posted-only, basis restricted to ACCRUAL/CASH (raises 22023 otherwise).
-- Idempotent: DROP + CREATE.
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS income_statement_monthly(uuid, text, date, date);
CREATE FUNCTION income_statement_monthly(
  p_entity_id  uuid,
  p_basis      text,
  p_from_date  date,
  p_to_date    date
)
RETURNS TABLE (
  entity_id       uuid,
  basis           text,
  year            int,
  month           int,
  account_id      uuid,
  account_type    text,
  account_subtype text,
  code            text,
  name            text,
  parent_code     text,
  parent_name     text,
  amount_cents    bigint
) AS $$
  SELECT
    je.entity_id,
    je.basis,
    EXTRACT(YEAR  FROM je.posting_date)::int  AS year,
    EXTRACT(MONTH FROM je.posting_date)::int  AS month,
    ga.id AS account_id,
    ga.account_type,
    ga.account_subtype,
    ga.code,
    ga.name,
    pa.code AS parent_code,
    pa.name AS parent_name,
    ROUND(SUM(
      CASE
        WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
        WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
        WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
      END
    ) * 100)::bigint AS amount_cents
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id = jel.account_id
  LEFT JOIN gl_accounts pa     ON pa.id = ga.parent_account_id
  WHERE je.status = 'posted'
    AND je.entity_id = p_entity_id
    AND upper(p_basis) IN ('ACCRUAL','CASH')
    AND je.basis = upper(p_basis)
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.account_type IN ('revenue', 'contra_revenue', 'expense')
  GROUP BY
    je.entity_id, je.basis,
    EXTRACT(YEAR  FROM je.posting_date),
    EXTRACT(MONTH FROM je.posting_date),
    ga.id, ga.account_type, ga.account_subtype, ga.code, ga.name, pa.code, pa.name
  ORDER BY ga.code, year, month;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION income_statement_monthly(uuid, text, date, date) IS
  'Tangerine P5-3 / M6 — per-account, per-MONTH Income Statement rows for the monthly-column P&L. One row per (account, year, month) with parent_code/parent_name (gl_accounts.parent_account_id hierarchy) + account_id for drill-down. amount_cents = ROUND(SUM(<signed dollars>) * 100) TRUE cents (revenue=CR-DR, contra_revenue=DR-CR, expense=DR-CR). STABLE, posted-only, basis in ACCRUAL/CASH.';

-- Reload PostgREST schema cache so the API sees the new function.
NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- Migration-tracking footer.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations'
      AND table_name   = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    VALUES ('20260983000000', 'income_statement_monthly', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
