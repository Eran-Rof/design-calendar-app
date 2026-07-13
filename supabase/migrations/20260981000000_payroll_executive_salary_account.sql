-- ════════════════════════════════════════════════════════════════════════════
-- Payroll mirror COA addition (#xoro-gl-truth payroll slice, 2026-07-12)
--
-- The Xoro→Tangerine payroll GL mirror (scripts/mirror-xoro-payroll.mjs) posts
-- BOTH legs of every Xoro payroll Journal Entry into Tangerine, mapping each
-- leg's Xoro account to its ROF gl_accounts equivalent by exact leaf name. The
-- 20260801 ROF chart already mirrors Xoro's payroll chart 1:1 (6113-6132
-- Payroll Expense/Hourly/Salaries/Tax/…, 2401 Payroll Payable, 1408 Payroll
-- Asset, 6305 Bad Debt) — EXCEPT Xoro's leaf "Payroll Expense - Executive
-- Salary", which had no ROF equivalent. This migration adds it (6135), grouped
-- under 6100 Payroll like its siblings, so the mirror resolves it faithfully
-- instead of routing exec salary to a generic account.
--
-- Idempotent (ON CONFLICT DO NOTHING); re-running after the mirror already
-- created the row in prod is a no-op.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_rof uuid := rof_entity_id();
BEGIN
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_control, status)
  VALUES (v_rof, '6135', 'Payroll Expense - Executive Salary', 'expense', 'DEBIT', true, false, 'active')
  ON CONFLICT (entity_id, code) DO NOTHING;

  UPDATE gl_accounts c
     SET parent_account_id = (SELECT id FROM gl_accounts WHERE entity_id = v_rof AND code = '6100')
   WHERE c.entity_id = v_rof AND c.code = '6135' AND c.parent_account_id IS NULL;
END $$;

NOTIFY pgrst, 'reload schema';
