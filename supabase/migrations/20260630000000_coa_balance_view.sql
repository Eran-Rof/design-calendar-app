-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine COA — real-money balance column for the Chart of Accounts panel.
--
-- Operator ask #15 (2026-05-29): the COA list's "Balance" column currently
-- showed the normal_balance label (DEBIT / CREDIT), not a dollar number.
-- Rename that column to "Normal" in the UI and add a real $ balance column
-- powered by the view below.
--
-- Basis convention: ACCRUAL only (matches gl_detail RPC / P7-7). The Trial
-- Balance is the source of truth for CASH balances; the COA list is a
-- foundational management view that mirrors the same convention as the
-- existing GL Detail report so click-through stays internally consistent.
--
-- Sign convention: balance_signed_cents is POSITIVE on the account's normal
-- side. An asset with $1,000.00 of net debit activity returns +100000;
-- a liability with $1,000.00 of net credit activity also returns +100000.
-- This mirrors the Trial Balance and Balance Sheet display convention.
--
-- Cents on the wire: matches journal_entry_lines * 100 pattern used by
-- v_gl_detail / gl_detail RPC (numeric(18,2) dollars in storage, bigint
-- cents in API responses).
--
-- Idempotent: CREATE OR REPLACE VIEW + CREATE INDEX IF NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW vw_gl_account_balances AS
SELECT
  a.id                                                          AS account_id,
  a.entity_id,
  COALESCE(SUM(
    CASE
      WHEN a.normal_balance = 'DEBIT'  THEN (jel.debit  - jel.credit) * 100
      WHEN a.normal_balance = 'CREDIT' THEN (jel.credit - jel.debit) * 100
      ELSE 0
    END
  ), 0)::bigint                                                 AS balance_signed_cents,
  COALESCE(SUM(jel.debit  * 100), 0)::bigint                    AS total_debit_cents,
  COALESCE(SUM(jel.credit * 100), 0)::bigint                    AS total_credit_cents,
  COUNT(jel.id)                                                 AS line_count
FROM gl_accounts a
LEFT JOIN journal_entry_lines jel
       ON jel.account_id = a.id
LEFT JOIN journal_entries je
       ON je.id          = jel.journal_entry_id
      AND je.status      = 'posted'
      AND je.basis       = 'ACCRUAL'
GROUP BY a.id, a.entity_id, a.normal_balance;

COMMENT ON VIEW vw_gl_account_balances IS
  'Tangerine COA panel balance column. ACCRUAL-basis sum of posted journal_entry_lines per gl_accounts.id, sign-flipped so balance_signed_cents is positive on the accounts normal-balance side. Cents on the wire. Matches gl_detail RPC convention so click-through reconciles.';

-- The FK column journal_entry_lines.account_id is already indexed by
-- idx_jel_account from the original journal_entries migration; this CREATE
-- INDEX IF NOT EXISTS is a belt-and-braces safety net so the view stays fast
-- even if that migration is ever rolled back.
CREATE INDEX IF NOT EXISTS idx_jel_account ON journal_entry_lines (account_id);

-- Composite index helps the LEFT JOIN scan since the view filters on
-- je.status AND je.basis on the inner join. idx_je_period_basis_status from
-- the P1 migration partially covers (period_id, basis, status); this adds a
-- narrower (basis, status, id) index so the view's join planner doesn't have
-- to scan the larger composite index.
CREATE INDEX IF NOT EXISTS idx_je_basis_status_id
  ON journal_entries (basis, status, id);

-- Tell PostgREST to reload its schema cache so the new view is queryable
-- immediately after migration.
NOTIFY pgrst, 'reload schema';
