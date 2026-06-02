-- ─────────────────────────────────────────────────────────────────────────────
-- Tangerine P5-5 — Cash Flow Statement (indirect method)
--
-- Implements the cash_flow_indirect() RPC per
-- docs/tangerine/P5-close-core-financials-architecture.md §7.
--
-- Indirect-method shape:
--   Operating section:
--     Net Income (= Σ(revenue net credits) − Σ(expense net debits) over [from..to])
--     + Decrease in AR  (or − increase)   -- balance change in AR control account(s)
--     + Decrease in Inventory             -- balance change in inventory asset account(s)
--     − Decrease in AP  (or + increase)   -- balance change in AP control account(s)
--     = Net cash from operating activities
--   Investing section:   $0 placeholder ("Configure account tagging in P22+")
--   Financing section:   $0 placeholder ("Configure account tagging in P22+")
--   _cash_reference rows: beginning_cash + ending_cash, derived from balance-
--                          change of accounts identified by the cash-heuristic.
--
-- AR / AP / Inventory account identification:
--   1. Prefer `entities.default_ar_account_id` / `default_ap_account_id` /
--      `default_inventory_account_id` (set in P3-1/P4-1).
--   2. Fall back to code-prefix heuristic — '1200' for AR, '2010' for AP,
--      '1300' for inventory.
--
-- Cash-account identification (for beginning + ending cash):
--   account_type = 'asset' AND code LIKE '1%' AND (name ILIKE '%cash%'
--   OR name ILIKE '%bank%').
--
-- All amounts in cents (bigint). All filtered by basis (ACCRUAL/CASH) and
-- by `journal_entries.status = 'posted'`.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cash_flow_indirect(
  p_entity_id  uuid,
  p_basis      text,
  p_from_date  date,
  p_to_date    date
)
RETURNS TABLE (
  section       text,
  line_item     text,
  amount_cents  bigint
)
AS $$
DECLARE
  v_basis             text;
  v_ar_account_id     uuid;
  v_ap_account_id     uuid;
  v_inv_account_id    uuid;
  v_net_income        bigint;
  v_ar_delta          bigint;
  v_ap_delta          bigint;
  v_inv_delta         bigint;
  v_op_total          bigint;
  v_beginning_cash    bigint;
  v_ending_cash       bigint;
BEGIN
  -- Validate basis.
  IF p_basis IS NULL THEN
    RAISE EXCEPTION 'cash_flow_indirect: p_basis is required (ACCRUAL or CASH)';
  END IF;
  v_basis := upper(p_basis);
  IF v_basis NOT IN ('ACCRUAL', 'CASH') THEN
    RAISE EXCEPTION 'cash_flow_indirect: invalid basis %, expected ACCRUAL or CASH', p_basis;
  END IF;

  IF p_from_date IS NULL OR p_to_date IS NULL THEN
    RAISE EXCEPTION 'cash_flow_indirect: p_from_date and p_to_date are required';
  END IF;
  IF p_to_date < p_from_date THEN
    RAISE EXCEPTION 'cash_flow_indirect: p_to_date (%) must be >= p_from_date (%)', p_to_date, p_from_date;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Resolve AR / AP / Inventory accounts. Prefer entity defaults; fall back
  -- to code-prefix heuristic on gl_accounts.
  -- ───────────────────────────────────────────────────────────────────────
  SELECT
    e.default_ar_account_id,
    e.default_ap_account_id,
    e.default_inventory_account_id
  INTO v_ar_account_id, v_ap_account_id, v_inv_account_id
  FROM entities e
  WHERE e.id = p_entity_id;

  IF v_ar_account_id IS NULL THEN
    SELECT ga.id INTO v_ar_account_id
    FROM gl_accounts ga
    WHERE ga.entity_id = p_entity_id
      AND ga.code = '1200'
    LIMIT 1;
  END IF;

  IF v_ap_account_id IS NULL THEN
    SELECT ga.id INTO v_ap_account_id
    FROM gl_accounts ga
    WHERE ga.entity_id = p_entity_id
      AND ga.code = '2010'
    LIMIT 1;
  END IF;

  IF v_inv_account_id IS NULL THEN
    SELECT ga.id INTO v_inv_account_id
    FROM gl_accounts ga
    WHERE ga.entity_id = p_entity_id
      AND ga.code = '1300'
    LIMIT 1;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────
  -- Net Income over [from..to]:
  --   revenue → credit minus debit (positive credit = positive revenue)
  --   contra_revenue → debit minus credit (reduces revenue)
  --   expense → debit minus credit (positive debit = positive expense)
  --   Net Income = Σ revenue_net − Σ expense_net
  -- ───────────────────────────────────────────────────────────────────────
  SELECT COALESCE(SUM(
    CASE
      WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
      WHEN ga.account_type = 'contra_revenue' THEN -(jel.debit - jel.credit)
      WHEN ga.account_type = 'expense'        THEN -(jel.debit - jel.credit)
      ELSE 0
    END
  ), 0)::bigint
  INTO v_net_income
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga ON ga.id = jel.account_id
  WHERE je.entity_id = p_entity_id
    AND je.basis = v_basis
    AND je.status = 'posted'
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.account_type IN ('revenue', 'contra_revenue', 'expense');

  -- ───────────────────────────────────────────────────────────────────────
  -- Working-capital deltas — balance(end) − balance(begin − 1 day).
  -- AR/Inv are DEBIT-normal assets: +balance = more invested = uses cash.
  -- AP is CREDIT-normal liability: +balance = more owed = source of cash.
  -- For the cash flow we want: ΔCash = NetIncome − ΔAR − ΔInv + ΔAP.
  -- Compute the raw signed delta of each balance over the period.
  -- ───────────────────────────────────────────────────────────────────────
  WITH bal AS (
    SELECT
      jel.account_id,
      ga.normal_balance,
      SUM(CASE WHEN je.posting_date <= (p_from_date - INTERVAL '1 day')::date
               THEN CASE WHEN ga.normal_balance = 'DEBIT'  THEN jel.debit - jel.credit
                         WHEN ga.normal_balance = 'CREDIT' THEN jel.credit - jel.debit
                    END
               ELSE 0 END) AS begin_bal,
      SUM(CASE WHEN je.posting_date <= p_to_date
               THEN CASE WHEN ga.normal_balance = 'DEBIT'  THEN jel.debit - jel.credit
                         WHEN ga.normal_balance = 'CREDIT' THEN jel.credit - jel.debit
                    END
               ELSE 0 END) AS end_bal
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN gl_accounts ga ON ga.id = jel.account_id
    WHERE je.entity_id = p_entity_id
      AND je.basis = v_basis
      AND je.status = 'posted'
      AND jel.account_id IN (
        COALESCE(v_ar_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(v_ap_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(v_inv_account_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
    GROUP BY jel.account_id, ga.normal_balance
  )
  SELECT
    COALESCE((SELECT (end_bal - begin_bal) FROM bal WHERE account_id = v_ar_account_id), 0)::bigint,
    COALESCE((SELECT (end_bal - begin_bal) FROM bal WHERE account_id = v_ap_account_id), 0)::bigint,
    COALESCE((SELECT (end_bal - begin_bal) FROM bal WHERE account_id = v_inv_account_id), 0)::bigint
  INTO v_ar_delta, v_ap_delta, v_inv_delta;

  -- Operating section total: NI − ΔAR − ΔInv + ΔAP.
  v_op_total := v_net_income - v_ar_delta - v_inv_delta + v_ap_delta;

  -- ───────────────────────────────────────────────────────────────────────
  -- Beginning + ending cash from cash-heuristic accounts.
  -- ───────────────────────────────────────────────────────────────────────
  WITH cash_accts AS (
    SELECT ga.id
    FROM gl_accounts ga
    WHERE ga.entity_id = p_entity_id
      AND ga.account_type = 'asset'
      AND ga.code LIKE '1%'
      AND (ga.name ILIKE '%cash%' OR ga.name ILIKE '%bank%')
  )
  SELECT
    COALESCE(SUM(CASE WHEN je.posting_date <= (p_from_date - INTERVAL '1 day')::date
                      THEN jel.debit - jel.credit ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN je.posting_date <= p_to_date
                      THEN jel.debit - jel.credit ELSE 0 END), 0)::bigint
  INTO v_beginning_cash, v_ending_cash
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  WHERE je.entity_id = p_entity_id
    AND je.basis = v_basis
    AND je.status = 'posted'
    AND jel.account_id IN (SELECT id FROM cash_accts);

  -- ───────────────────────────────────────────────────────────────────────
  -- Emit rows. Order matters — UI preserves it.
  -- ───────────────────────────────────────────────────────────────────────
  -- Operating section.
  section := 'operating';
  line_item := 'Net Income';
  amount_cents := v_net_income;
  RETURN NEXT;

  section := 'operating';
  line_item := 'Change in Accounts Receivable';
  amount_cents := -v_ar_delta;  -- increase in AR REDUCES cash
  RETURN NEXT;

  section := 'operating';
  line_item := 'Change in Inventory';
  amount_cents := -v_inv_delta; -- increase in inventory REDUCES cash
  RETURN NEXT;

  section := 'operating';
  line_item := 'Change in Accounts Payable';
  amount_cents := v_ap_delta;   -- increase in AP INCREASES cash
  RETURN NEXT;

  section := 'operating';
  line_item := 'Net cash from operating activities';
  amount_cents := v_op_total;
  RETURN NEXT;

  -- Investing section — placeholder.
  section := 'investing';
  line_item := 'Investing activities (configure in P22+)';
  amount_cents := 0;
  RETURN NEXT;

  section := 'investing';
  line_item := 'Net cash from investing activities';
  amount_cents := 0;
  RETURN NEXT;

  -- Financing section — placeholder.
  section := 'financing';
  line_item := 'Financing activities (configure in P22+)';
  amount_cents := 0;
  RETURN NEXT;

  section := 'financing';
  line_item := 'Net cash from financing activities';
  amount_cents := 0;
  RETURN NEXT;

  -- Cash reference rows (consumed by UI for the footer reconciliation block).
  section := '_cash_reference';
  line_item := 'Beginning Cash';
  amount_cents := v_beginning_cash;
  RETURN NEXT;

  section := '_cash_reference';
  line_item := 'Ending Cash';
  amount_cents := v_ending_cash;
  RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cash_flow_indirect(uuid, text, date, date) IS
  'P5-5 indirect-method cash flow statement. Operating section is computed live from net income + working-capital deltas (ΔAR, ΔInventory, ΔAP). Investing + Financing are $0 placeholders (M22 Fixed Assets + account-tagging ship later). Emits two _cash_reference rows (Beginning Cash, Ending Cash) derived from the cash-heuristic accounts (asset + code starting with 1 + name ILIKE %cash% or %bank%) for UI footer reconciliation. STABLE.';

-- Tell PostgREST about the new RPC.
NOTIFY pgrst, 'reload schema';
