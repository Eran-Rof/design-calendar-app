-- Fix: income_statement() threw "division by zero" on every run.
--
-- The original (P5-3) guarded the basis parameter with a SQL CASE whose ELSE
-- branch was `(1/0)::text`, intended to "fail loudly" only when p_basis was
-- neither ACCRUAL nor CASH. But `1/0` is a *constant* subexpression, and
-- PostgreSQL folds constant subexpressions during planning — so the division
-- was evaluated (and raised "division by zero") regardless of the basis value,
-- breaking the Income Statement panel for valid ACCRUAL/CASH requests too.
--
-- Rewrite as a plpgsql function that validates p_basis with an explicit
-- RAISE EXCEPTION (the loud-failure intent, without the constant-folding
-- footgun) and then RETURN QUERY the same per-account aggregation. The HTTP
-- handler already rejects bad basis with a 400, so in practice the guard only
-- ever sees ACCRUAL/CASH; the RAISE is defence-in-depth for direct RPC callers.
--
-- Signature, return shape, and amount_cents sign conventions are unchanged.

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
DECLARE
  v_basis text := upper(p_basis);
BEGIN
  IF v_basis NOT IN ('ACCRUAL', 'CASH') THEN
    RAISE EXCEPTION 'income_statement: p_basis must be ACCRUAL or CASH (got %)', p_basis
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
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
    AND je.basis      = v_basis
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.account_type IN ('revenue', 'contra_revenue', 'expense')
  GROUP BY je.entity_id, je.basis, ga.account_type, ga.code, ga.name
  ORDER BY ga.code;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION income_statement(uuid, text, date, date) IS
  'Tangerine P5-3 / M6 — parameterized Income Statement. Returns per-account net amounts for posted JEs within [p_from_date, p_to_date]. STABLE. p_basis must be ACCRUAL or CASH (RAISEs invalid_parameter_value otherwise). Rewritten from SQL→plpgsql to remove a constant (1/0) basis-guard that PostgreSQL folded at plan time and threw division-by-zero on every call. Arch §5.2.';
