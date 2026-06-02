-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P5 / Chunk 3 / Migration
-- M6 Income Statement (P&L) view + parameterized RPC.
--
-- Per docs/tangerine/P5-close-core-financials-architecture.md §5.
--
-- Scope:
--   1. v_income_statement              — per-account net amount per
--                                        entity / basis / year / month
--                                        for accounts of type
--                                        revenue / contra_revenue / expense.
--   2. income_statement(...) RPC       — same shape, parameterized by
--                                        entity_id, basis, posting_date range.
--                                        STABLE; basis validated to be in
--                                        ('ACCRUAL','CASH').
--
-- Amount sign convention (matches arch §5.1):
--   revenue          : CR - DR  → positive when revenue is earned
--   contra_revenue   : DR - CR  → positive when contra (returns, discounts) reduce revenue
--   expense          : DR - CR  → positive when expense is incurred
--
-- Net Income = SUM(revenue) - SUM(contra_revenue) - SUM(expense)
-- (callers compute subtotals; the view returns per-account rows.)
--
-- Idempotent: CREATE OR REPLACE throughout. No new tables; no constraints.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. v_income_statement — foundation view
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_income_statement AS
SELECT
  je.entity_id,
  je.basis,
  EXTRACT(YEAR FROM je.posting_date)::int  AS year,
  EXTRACT(MONTH FROM je.posting_date)::int AS month,
  ga.account_type,
  ga.code,
  ga.name,
  SUM(
    CASE
      WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit  -- revenue: CR positive
      WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit -- contra-revenue: DR positive, REDUCES revenue
      WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit -- expense: DR positive
    END
  )::bigint AS amount_cents
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga          ON ga.id              = jel.account_id
WHERE je.status = 'posted'
  AND ga.account_type IN ('revenue', 'contra_revenue', 'expense')
GROUP BY
  je.entity_id, je.basis,
  EXTRACT(YEAR FROM je.posting_date),
  EXTRACT(MONTH FROM je.posting_date),
  ga.account_type, ga.code, ga.name;

COMMENT ON VIEW v_income_statement IS
  'Tangerine P5-3 / M6 — per-account income statement rows per entity / basis / year / month. amount_cents follows the CASE convention: revenue=CR-DR, contra_revenue=DR-CR, expense=DR-CR. See arch §5.1.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. income_statement(...) — parameterized RPC over a posting_date range
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION income_statement(
  p_entity_id  uuid,
  p_basis      text,
  p_from_date  date,
  p_to_date    date
)
RETURNS TABLE (
  entity_id    uuid,
  basis        text,
  account_type text,
  code         text,
  name         text,
  amount_cents bigint
) AS $$
  -- Basis validation — fail loudly so callers don't silently aggregate the
  -- wrong book. Arch §5.2 requires basis ∈ {ACCRUAL, CASH}.
  SELECT
    je.entity_id,
    je.basis,
    ga.account_type,
    ga.code,
    ga.name,
    SUM(
      CASE
        WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
        WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
        WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
      END
    )::bigint AS amount_cents
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id              = jel.account_id
  WHERE je.status     = 'posted'
    AND je.entity_id  = p_entity_id
    AND je.basis      = (
      CASE
        WHEN upper(p_basis) IN ('ACCRUAL','CASH') THEN upper(p_basis)
        ELSE (1/0)::text  -- forces div-by-zero error if basis is invalid
      END
    )
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.account_type IN ('revenue', 'contra_revenue', 'expense')
  GROUP BY je.entity_id, je.basis, ga.account_type, ga.code, ga.name
  ORDER BY ga.code;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION income_statement(uuid, text, date, date) IS
  'Tangerine P5-3 / M6 — parameterized Income Statement. Returns per-account net amounts for posted JEs within [p_from_date, p_to_date]. STABLE. p_basis must be ACCRUAL or CASH (other values trigger a runtime divide-by-zero so callers see a clear failure). Arch §5.2.';

NOTIFY pgrst, 'reload schema';
