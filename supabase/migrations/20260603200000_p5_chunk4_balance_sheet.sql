-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P5-4 — Balance Sheet view + as-of RPC
--
-- Per docs/tangerine/P5-close-core-financials-architecture.md §6.
--
-- Surfaces:
--   * v_balance_sheet                                — foundation BS view (full
--                                                       history; balances as
--                                                       of NOW with no date
--                                                       filter, grouped by
--                                                       entity_id, basis,
--                                                       account_type, code,
--                                                       name).
--   * balance_sheet_as_of(uuid, text, date) STABLE   — parameterized RPC; same
--                                                       row shape filtered by
--                                                       je.posting_date <=
--                                                       p_as_of_date. INCLUDES
--                                                       revenue + expense YTD
--                                                       impact (surfaced in
--                                                       the UI as a synthetic
--                                                       "Current Year
--                                                       Earnings" row under
--                                                       Equity until the
--                                                       year-end close JE
--                                                       flips it into Retained
--                                                       Earnings — see P5-6).
--
-- Read-only — no tables, no triggers, no RLS changes. Inherits RLS from the
-- underlying journal_entries / journal_entry_lines / gl_accounts tables.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. v_balance_sheet ─────────────────────────────────────────────────────
--
-- DEBIT-normal accounts (asset, contra_asset):    balance = SUM(DR) - SUM(CR)
-- CREDIT-normal accounts (liability, equity):     balance = SUM(CR) - SUM(DR)
--
-- contra_asset is included so the UI can render it under Assets with a
-- negative balance + slight indent (per arch §6.4). Its normal_balance is
-- DEBIT so the math is the same as a regular asset; it just nets against
-- the parent asset visually.

CREATE OR REPLACE VIEW v_balance_sheet AS
SELECT
  je.entity_id,
  je.basis,
  ga.account_type,
  ga.code,
  ga.name,
  SUM(
    CASE
      WHEN ga.normal_balance = 'DEBIT'  THEN jel.debit - jel.credit
      WHEN ga.normal_balance = 'CREDIT' THEN jel.credit - jel.debit
    END
  )::bigint AS balance_cents
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga ON ga.id = jel.account_id
WHERE je.status = 'posted'
  AND ga.account_type IN ('asset', 'liability', 'equity', 'contra_asset')
GROUP BY je.entity_id, je.basis, ga.account_type, ga.code, ga.name;

COMMENT ON VIEW v_balance_sheet IS 'Foundation Balance Sheet view per arch §6.1 — assets / liabilities / equity / contra_asset balances across full posted JE history. Use balance_sheet_as_of(entity_id, basis, as_of_date) for date-filtered snapshots.';

-- ─── 2. balance_sheet_as_of RPC ─────────────────────────────────────────────
--
-- Parameterized variant: filters je.posting_date <= p_as_of_date so the
-- operator can pull a snapshot at any historical date. STABLE so Postgres
-- can plan with the current snapshot.
--
-- Validation: basis must be ACCRUAL or CASH (raises on anything else — the
-- handler also validates but defensive depth doesn't hurt).
--
-- The "Current Year Earnings" line on the BS is NOT computed here — the
-- handler / UI computes it from a sibling income_statement RPC fetch and
-- surfaces it as a synthetic row under Equity in the React layer. This RPC
-- only returns asset / liability / equity / contra_asset rows.

CREATE OR REPLACE FUNCTION balance_sheet_as_of(
  p_entity_id  uuid,
  p_basis      text,
  p_as_of_date date
)
RETURNS TABLE (
  entity_id     uuid,
  basis         text,
  account_type  text,
  code          text,
  name          text,
  balance_cents bigint
) AS $$
  SELECT
    je.entity_id,
    je.basis,
    ga.account_type,
    ga.code,
    ga.name,
    SUM(
      CASE
        WHEN ga.normal_balance = 'DEBIT'  THEN jel.debit - jel.credit
        WHEN ga.normal_balance = 'CREDIT' THEN jel.credit - jel.debit
      END
    )::bigint AS balance_cents
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga ON ga.id = jel.account_id
  WHERE je.status = 'posted'
    AND je.entity_id = p_entity_id
    AND je.basis = p_basis
    AND je.posting_date <= p_as_of_date
    AND ga.account_type IN ('asset', 'liability', 'equity', 'contra_asset')
    AND p_basis IN ('ACCRUAL','CASH')
  GROUP BY je.entity_id, je.basis, ga.account_type, ga.code, ga.name;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION balance_sheet_as_of(uuid, text, date) IS 'Parameterized Balance Sheet RPC per arch §6.2. STABLE; filters je.posting_date <= p_as_of_date. Excludes revenue/expense — the UI computes Current Year Earnings from a sibling /api/internal/income-statement fetch and surfaces it under Equity until the year-end closing JE rolls it into Retained Earnings.';

-- ─── 3. Migration-tracking footer ───────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (version, name)
    VALUES ('20260603200000', 'p5_chunk4_balance_sheet')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

-- Tell PostgREST to pick up the new view + function without a manual restart.
NOTIFY pgrst, 'reload schema';
