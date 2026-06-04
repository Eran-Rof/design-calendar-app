-- P16 — surface account_subtype on the income statement so the P&L can break
-- out a DILUTION line between gross Revenue and Net Revenue.
--
-- Dilution accounts are modeled as account_type='contra_revenue' with
-- account_subtype='dilution' (returns/discounts use other subtypes or NULL).
-- The RPC already nets ALL contra_revenue out of revenue; this change only
-- adds the subtype column so the UI can present dilution as its own section.
--
-- Sign convention, basis validation, posted-only filter, and STABLE marking
-- are unchanged. The view appends account_subtype at the END (CREATE OR REPLACE
-- VIEW cannot reorder columns); the RPC is dropped + recreated because adding a
-- column to RETURNS TABLE changes the return type.

-- ── v_income_statement — append account_subtype (kept last for OR REPLACE) ────
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
      WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
      WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
      WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
    END
  )::bigint AS amount_cents,
  ga.account_subtype
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga          ON ga.id              = jel.account_id
WHERE je.status = 'posted'
  AND ga.account_type IN ('revenue', 'contra_revenue', 'expense')
GROUP BY
  je.entity_id, je.basis,
  EXTRACT(YEAR FROM je.posting_date),
  EXTRACT(MONTH FROM je.posting_date),
  ga.account_type, ga.account_subtype, ga.code, ga.name;

-- ── income_statement(...) RPC — drop + recreate with account_subtype ─────────
DROP FUNCTION IF EXISTS income_statement(uuid, text, date, date);
CREATE FUNCTION income_statement(
  p_entity_id  uuid,
  p_basis      text,
  p_from_date  date,
  p_to_date    date
)
RETURNS TABLE (
  entity_id       uuid,
  basis           text,
  account_type    text,
  account_subtype text,
  code            text,
  name            text,
  amount_cents    bigint
) AS $$
  SELECT
    je.entity_id,
    je.basis,
    ga.account_type,
    ga.account_subtype,
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
        ELSE (1/0)::text  -- forces a clear runtime error if basis is invalid
      END
    )
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.account_type IN ('revenue', 'contra_revenue', 'expense')
  GROUP BY je.entity_id, je.basis, ga.account_type, ga.account_subtype, ga.code, ga.name
  ORDER BY ga.code;
$$ LANGUAGE sql STABLE;

NOTIFY pgrst, 'reload schema';
