-- Fix income_statement() division-by-zero (regression).
--
-- 20260712000000 fixed a constant 1/0 basis-guard by rewriting the function to
-- plpgsql; 20260712140000 (subtype change) reverted it to a SQL function with the
-- `ELSE (1/0)::text` guard back in. In a SQL function PostgreSQL CONSTANT-FOLDS
-- `(1/0)` at plan time, so EVERY call to income_statement() (and the Income
-- Statement panel + Balance Sheet current-year-earnings) threw "division by zero".
--
-- The handler already restricts p_basis to ACCRUAL/CASH, so the guard is redundant.
-- Replace it with a plain WHERE check (no constant division). Idempotent.

CREATE OR REPLACE FUNCTION public.income_statement(p_entity_id uuid, p_basis text, p_from_date date, p_to_date date)
 RETURNS TABLE(entity_id uuid, basis text, account_type text, account_subtype text, code text, name text, amount_cents bigint)
 LANGUAGE sql STABLE
AS $function$
  SELECT
    je.entity_id, je.basis, ga.account_type, ga.account_subtype, ga.code, ga.name,
    SUM(CASE
      WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
      WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
      WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
    END)::bigint AS amount_cents
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id = jel.account_id
  WHERE je.status = 'posted'
    AND je.entity_id = p_entity_id
    AND upper(p_basis) IN ('ACCRUAL','CASH')
    AND je.basis = upper(p_basis)
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.account_type IN ('revenue', 'contra_revenue', 'expense')
  GROUP BY je.entity_id, je.basis, ga.account_type, ga.account_subtype, ga.code, ga.name
  ORDER BY ga.code;
$function$;
