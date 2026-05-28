-- Tangerine P5-2 — Trial Balance view + RPC.
--
-- Per docs/tangerine/P5-close-core-financials-architecture.md §4.
--
-- The Trial Balance is the foundation view for every other financial
-- statement (P&L, Balance Sheet, Cash Flow). It rolls up posted journal
-- entry lines per (entity, basis, account) into SUM(debit) / SUM(credit)
-- with net columns for both directions.
--
-- Two surfaces:
--   1. View `v_trial_balance` — unfiltered cumulative posting history,
--      one row per (entity_id, basis, account_id). Cheap point-in-time
--      lookup for "give me everything posted to this account forever."
--   2. Function `trial_balance(entity, basis, from, to)` — STABLE; same
--      shape but filtered by posting_date BETWEEN p_from_date AND p_to_date.
--      Validates basis ∈ {ACCRUAL, CASH}.
--
-- RLS: views inherit from underlying tables (journal_entries +
-- journal_entry_lines + gl_accounts all carry the P1 auth_internal_*
-- template). Function is STABLE SECURITY-INVOKER (default).

-- ────────────────────────────────────────────────────────────────────────────
-- 1. View: v_trial_balance
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_trial_balance AS
SELECT
  je.entity_id,
  je.basis,
  jel.account_id,
  ga.code,
  ga.name,
  ga.account_type,
  ga.normal_balance,
  SUM(jel.debit)                       AS debit_cents,
  SUM(jel.credit)                      AS credit_cents,
  SUM(jel.debit) - SUM(jel.credit)     AS net_debit_cents,
  SUM(jel.credit) - SUM(jel.debit)     AS net_credit_cents
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga          ON ga.id = jel.account_id
WHERE je.status = 'posted'
GROUP BY je.entity_id, je.basis, jel.account_id, ga.code, ga.name, ga.account_type, ga.normal_balance;

COMMENT ON VIEW v_trial_balance IS
  'P5-2: cumulative trial balance across all posted JEs. One row per (entity_id, basis, account_id). debit/credit/net columns are SUM(jel.debit)/SUM(jel.credit) and their differences in both directions. Use trial_balance() for a date-bounded variant.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Function: trial_balance(entity, basis, from, to)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trial_balance(
  p_entity_id  uuid,
  p_basis      text,
  p_from_date  date,
  p_to_date    date
)
RETURNS TABLE (
  entity_id        uuid,
  basis            text,
  account_id       uuid,
  code             text,
  name             text,
  account_type     text,
  normal_balance   text,
  debit_cents      bigint,
  credit_cents     bigint,
  net_debit_cents  bigint,
  net_credit_cents bigint
) AS $$
BEGIN
  -- Basis validation — guard rail against typos / SQL injection.
  IF p_basis NOT IN ('ACCRUAL', 'CASH') THEN
    RAISE EXCEPTION 'trial_balance: p_basis must be one of (ACCRUAL, CASH), got %', p_basis
      USING ERRCODE = '22023'; -- invalid_parameter_value
  END IF;

  RETURN QUERY
  SELECT
    je.entity_id,
    je.basis,
    jel.account_id,
    ga.code,
    ga.name,
    ga.account_type,
    ga.normal_balance,
    SUM(jel.debit)::bigint                       AS debit_cents,
    SUM(jel.credit)::bigint                      AS credit_cents,
    (SUM(jel.debit) - SUM(jel.credit))::bigint   AS net_debit_cents,
    (SUM(jel.credit) - SUM(jel.debit))::bigint   AS net_credit_cents
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id = jel.account_id
  WHERE je.status = 'posted'
    AND je.entity_id = p_entity_id
    AND je.basis = p_basis
    AND je.posting_date BETWEEN p_from_date AND p_to_date
  GROUP BY je.entity_id, je.basis, jel.account_id, ga.code, ga.name, ga.account_type, ga.normal_balance;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION trial_balance(uuid, text, date, date) IS
  'P5-2: parameterized trial balance filtered by posting_date BETWEEN p_from_date AND p_to_date. STABLE so callers (admin UI / Income Statement / Balance Sheet RPCs) can cache plans. Raises 22023 if p_basis is not ACCRUAL or CASH.';

-- Reload PostgREST schema cache so the function + view appear in the API.
NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Migration-tracking record-keeping
--    (Defensive DO $$ guard per the p3-all-migrations.sql pattern.)
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations'
      AND table_name   = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    VALUES
      ('20260603000000', 'p5_chunk2_trial_balance', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
