-- 20260822000000_gl_detail_basis_aware.sql
--
-- Tangerine — basis-aware GL Detail drill-down.
--
-- The existing gl_detail(uuid, date, date) RPC (migration
-- 20260614000000) hardcodes je.basis = 'ACCRUAL'. Financial reports
-- (Income Statement, Trial Balance, Balance Sheet) let the operator toggle
-- ACCRUAL vs CASH, and the new GL-account drill-down on those reports must
-- open the ledger on the SAME basis the report is showing.
--
-- This migration adds gl_detail_b(p_account_id, p_from, p_to, p_basis), an
-- exact copy of gl_detail with the basis parameterized. The original
-- gl_detail is left untouched so existing callers keep working.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION gl_detail_b(
  p_account_id uuid,
  p_from       date,
  p_to         date,
  p_basis      text DEFAULT 'ACCRUAL'
)
RETURNS TABLE (
  posting_date          date,
  je_id                 uuid,
  description           text,
  debit_cents           bigint,
  credit_cents          bigint,
  running_balance_cents bigint,
  source_module         text,
  source_id             text
)
LANGUAGE sql STABLE
AS $$
  WITH lines AS (
    SELECT
      je.id                          AS je_id,
      je.posting_date,
      je.description,
      je.source_module,
      je.source_id,
      (jel.debit  * 100)::bigint     AS debit_cents,
      (jel.credit * 100)::bigint     AS credit_cents
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id    = p_account_id
      AND je.status         = 'posted'
      AND je.basis          = COALESCE(NULLIF(upper(p_basis), ''), 'ACCRUAL')
      AND je.posting_date  BETWEEN p_from AND p_to
  )
  SELECT
    posting_date,
    je_id,
    description,
    debit_cents,
    credit_cents,
    SUM(debit_cents - credit_cents) OVER (ORDER BY posting_date, je_id)::bigint AS running_balance_cents,
    source_module,
    source_id
  FROM lines
  ORDER BY posting_date, je_id;
$$;

COMMENT ON FUNCTION gl_detail_b(uuid, date, date, text) IS
  'Tangerine: ordered journal_entry_lines for one account in a date window on a given basis (ACCRUAL or CASH), with running DEBIT-positive balance. Basis-aware sibling of gl_detail for report drill-downs. UI normal-balance flip presented at render time.';

-- Reload PostgREST schema cache so the new RPC is callable immediately.
NOTIFY pgrst, 'reload schema';
