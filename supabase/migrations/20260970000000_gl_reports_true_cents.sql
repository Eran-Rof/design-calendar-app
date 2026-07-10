-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — GL core-financial reports return TRUE cents (retire the
-- "dollars labeled as cents" gotcha).
--
-- ROOT CAUSE
--   journal_entry_lines.debit / credit are numeric(18,2) DOLLARS. The P5 core
--   report surfaces SUM those columns and cast the result straight to bigint,
--   labelling the output `*_cents` — but a plain ::bigint of a dollar amount is
--   still DOLLARS (and, worse, TRUNCATES the fractional dollars: $9,947,831.51
--   became 9947831, losing the 51¢). Every consumer that divides by 100 for
--   display then rendered these figures 100× too small.
--
-- FIX (this migration)
--   Recreate the affected views + RPCs so each cents column is
--   ROUND(SUM(<dollars>) * 100)::bigint — genuine integer cents, no precision
--   loss. Signatures, sign conventions, basis validation, column order and
--   STABLE marking are all unchanged; only the scale of the *_cents outputs
--   moves by ×100.
--
--   Objects converted:
--     • v_trial_balance                     debit/credit/net_debit/net_credit_cents
--     • trial_balance(uuid,text,date,date)  same four columns
--     • v_income_statement                  amount_cents (keeps account_subtype)
--     • income_statement(uuid,text,date,date) amount_cents (keeps account_subtype)
--     • v_balance_sheet                     balance_cents
--     • balance_sheet_as_of(uuid,text,date) balance_cents
--     • cash_flow_indirect(uuid,text,date,date) amount_cents (all rows)
--
--   The balance sheet + cash flow objects are included because the Balance
--   Sheet panel combines balance_sheet_as_of with a sibling income_statement
--   fetch for its "Current Year Earnings" row — converting income_statement
--   alone would leave that row 100× larger than the rest of the statement.
--   All P5 core statements move to true cents together so they stay consistent.
--
-- NOT TOUCHED (already true cents via explicit *100): gl_detail / gl_detail_b,
--   v_coa_balances, gl_range_activity_by_code, segment_pl_gl_drill,
--   bank_recon_compute. gl_post_year_end_close inlines its own P&L math and is
--   unaffected by these definitions.
--
-- Idempotent: CREATE OR REPLACE throughout (income_statement is DROP+CREATE
-- because its live definition already carries the account_subtype column).
-- ════════════════════════════════════════════════════════════════════════════

-- The three views change a column type (numeric dollars → bigint cents), which
-- CREATE OR REPLACE VIEW cannot do — DROP + recreate. No SQL objects depend on
-- them (verified), so a plain DROP (no CASCADE) is safe.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. v_trial_balance
-- ────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_trial_balance;
CREATE OR REPLACE VIEW v_trial_balance AS
SELECT
  je.entity_id,
  je.basis,
  jel.account_id,
  ga.code,
  ga.name,
  ga.account_type,
  ga.normal_balance,
  ROUND(SUM(jel.debit)  * 100)::bigint                     AS debit_cents,
  ROUND(SUM(jel.credit) * 100)::bigint                     AS credit_cents,
  ROUND((SUM(jel.debit)  - SUM(jel.credit)) * 100)::bigint AS net_debit_cents,
  ROUND((SUM(jel.credit) - SUM(jel.debit)) * 100)::bigint  AS net_credit_cents
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga          ON ga.id = jel.account_id
WHERE je.status = 'posted'
GROUP BY je.entity_id, je.basis, jel.account_id, ga.code, ga.name, ga.account_type, ga.normal_balance;

COMMENT ON VIEW v_trial_balance IS
  'P5-2: cumulative trial balance across all posted JEs. One row per (entity_id, basis, account_id). debit/credit/net columns are TRUE integer cents = ROUND(SUM(jel.debit|credit) * 100) (jel.debit/credit are numeric DOLLARS). Use trial_balance() for a date-bounded variant.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. trial_balance(entity, basis, from, to)
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
  IF p_basis NOT IN ('ACCRUAL', 'CASH') THEN
    RAISE EXCEPTION 'trial_balance: p_basis must be one of (ACCRUAL, CASH), got %', p_basis
      USING ERRCODE = '22023';
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
    ROUND(SUM(jel.debit)  * 100)::bigint                     AS debit_cents,
    ROUND(SUM(jel.credit) * 100)::bigint                     AS credit_cents,
    ROUND((SUM(jel.debit)  - SUM(jel.credit)) * 100)::bigint AS net_debit_cents,
    ROUND((SUM(jel.credit) - SUM(jel.debit)) * 100)::bigint  AS net_credit_cents
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
  'P5-2: parameterized trial balance filtered by posting_date BETWEEN p_from_date AND p_to_date. *_cents columns are TRUE integer cents = ROUND(SUM(<dollars>) * 100). STABLE. Raises 22023 if p_basis is not ACCRUAL or CASH.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. v_income_statement (keeps account_subtype from p16)
-- ────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_income_statement;
CREATE OR REPLACE VIEW v_income_statement AS
SELECT
  je.entity_id,
  je.basis,
  EXTRACT(YEAR FROM je.posting_date)::int  AS year,
  EXTRACT(MONTH FROM je.posting_date)::int AS month,
  ga.account_type,
  ga.code,
  ga.name,
  ROUND(SUM(
    CASE
      WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
      WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
      WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
    END
  ) * 100)::bigint AS amount_cents,
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

COMMENT ON VIEW v_income_statement IS
  'Tangerine P5-3 / M6 — per-account income statement rows per entity / basis / year / month. amount_cents is TRUE integer cents = ROUND(SUM(<signed dollars>) * 100): revenue=CR-DR, contra_revenue=DR-CR, expense=DR-CR. See arch §5.1.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. income_statement(entity, basis, from, to) — keeps account_subtype
-- ────────────────────────────────────────────────────────────────────────────
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
    ROUND(SUM(
      CASE
        WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
        WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
        WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
      END
    ) * 100)::bigint AS amount_cents
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
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION income_statement(uuid, text, date, date) IS
  'Tangerine P5-3 / M6 — parameterized Income Statement. amount_cents is TRUE integer cents = ROUND(SUM(<signed dollars>) * 100). STABLE. p_basis restricted to ACCRUAL/CASH via a plain WHERE check (no constant divide-by-zero guard). Arch §5.2.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5. v_balance_sheet
-- ────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_balance_sheet;
CREATE OR REPLACE VIEW v_balance_sheet AS
SELECT
  je.entity_id,
  je.basis,
  ga.account_type,
  ga.code,
  ga.name,
  ROUND(SUM(
    CASE
      WHEN ga.normal_balance = 'DEBIT'  THEN jel.debit - jel.credit
      WHEN ga.normal_balance = 'CREDIT' THEN jel.credit - jel.debit
    END
  ) * 100)::bigint AS balance_cents
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga ON ga.id = jel.account_id
WHERE je.status = 'posted'
  AND ga.account_type IN ('asset', 'liability', 'equity', 'contra_asset')
GROUP BY je.entity_id, je.basis, ga.account_type, ga.code, ga.name;

COMMENT ON VIEW v_balance_sheet IS
  'Foundation Balance Sheet view per arch §6.1. balance_cents is TRUE integer cents = ROUND(SUM(<signed dollars>) * 100). Use balance_sheet_as_of(entity_id, basis, as_of_date) for date-filtered snapshots.';

-- ────────────────────────────────────────────────────────────────────────────
-- 6. balance_sheet_as_of(entity, basis, as_of)
-- ────────────────────────────────────────────────────────────────────────────
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
    ROUND(SUM(
      CASE
        WHEN ga.normal_balance = 'DEBIT'  THEN jel.debit - jel.credit
        WHEN ga.normal_balance = 'CREDIT' THEN jel.credit - jel.debit
      END
    ) * 100)::bigint AS balance_cents
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

COMMENT ON FUNCTION balance_sheet_as_of(uuid, text, date) IS
  'Parameterized Balance Sheet RPC per arch §6.2. balance_cents is TRUE integer cents = ROUND(SUM(<signed dollars>) * 100). STABLE; filters je.posting_date <= p_as_of_date. UI computes Current Year Earnings from a sibling income_statement fetch (now also true cents).';

-- ────────────────────────────────────────────────────────────────────────────
-- 7. cash_flow_indirect(entity, basis, from, to) — every emitted amount_cents
--    row now carries TRUE cents. Only the four aggregating SELECT INTO blocks
--    change (each × 100); the RETURN NEXT emit section is untouched.
-- ────────────────────────────────────────────────────────────────────────────
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
    WHERE ga.entity_id = p_entity_id AND ga.code = '1200'
    LIMIT 1;
  END IF;

  IF v_ap_account_id IS NULL THEN
    SELECT ga.id INTO v_ap_account_id
    FROM gl_accounts ga
    WHERE ga.entity_id = p_entity_id AND ga.code = '2010'
    LIMIT 1;
  END IF;

  IF v_inv_account_id IS NULL THEN
    SELECT ga.id INTO v_inv_account_id
    FROM gl_accounts ga
    WHERE ga.entity_id = p_entity_id AND ga.code = '1300'
    LIMIT 1;
  END IF;

  -- Net Income over [from..to] — TRUE cents.
  SELECT ROUND(COALESCE(SUM(
    CASE
      WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
      WHEN ga.account_type = 'contra_revenue' THEN -(jel.debit - jel.credit)
      WHEN ga.account_type = 'expense'        THEN -(jel.debit - jel.credit)
      ELSE 0
    END
  ), 0) * 100)::bigint
  INTO v_net_income
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga ON ga.id = jel.account_id
  WHERE je.entity_id = p_entity_id
    AND je.basis = v_basis
    AND je.status = 'posted'
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.account_type IN ('revenue', 'contra_revenue', 'expense');

  -- Working-capital deltas — TRUE cents.
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
    ROUND(COALESCE((SELECT (end_bal - begin_bal) FROM bal WHERE account_id = v_ar_account_id), 0)  * 100)::bigint,
    ROUND(COALESCE((SELECT (end_bal - begin_bal) FROM bal WHERE account_id = v_ap_account_id), 0)  * 100)::bigint,
    ROUND(COALESCE((SELECT (end_bal - begin_bal) FROM bal WHERE account_id = v_inv_account_id), 0) * 100)::bigint
  INTO v_ar_delta, v_ap_delta, v_inv_delta;

  v_op_total := v_net_income - v_ar_delta - v_inv_delta + v_ap_delta;

  -- Beginning + ending cash — TRUE cents.
  WITH cash_accts AS (
    SELECT ga.id
    FROM gl_accounts ga
    WHERE ga.entity_id = p_entity_id
      AND ga.account_type = 'asset'
      AND ga.code LIKE '1%'
      AND (ga.name ILIKE '%cash%' OR ga.name ILIKE '%bank%')
  )
  SELECT
    ROUND(COALESCE(SUM(CASE WHEN je.posting_date <= (p_from_date - INTERVAL '1 day')::date
                      THEN jel.debit - jel.credit ELSE 0 END), 0) * 100)::bigint,
    ROUND(COALESCE(SUM(CASE WHEN je.posting_date <= p_to_date
                      THEN jel.debit - jel.credit ELSE 0 END), 0) * 100)::bigint
  INTO v_beginning_cash, v_ending_cash
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  WHERE je.entity_id = p_entity_id
    AND je.basis = v_basis
    AND je.status = 'posted'
    AND jel.account_id IN (SELECT id FROM cash_accts);

  -- Operating section.
  section := 'operating';
  line_item := 'Net Income';
  amount_cents := v_net_income;
  RETURN NEXT;

  section := 'operating';
  line_item := 'Change in Accounts Receivable';
  amount_cents := -v_ar_delta;
  RETURN NEXT;

  section := 'operating';
  line_item := 'Change in Inventory';
  amount_cents := -v_inv_delta;
  RETURN NEXT;

  section := 'operating';
  line_item := 'Change in Accounts Payable';
  amount_cents := v_ap_delta;
  RETURN NEXT;

  section := 'operating';
  line_item := 'Net cash from operating activities';
  amount_cents := v_op_total;
  RETURN NEXT;

  section := 'investing';
  line_item := 'Investing activities (configure in P22+)';
  amount_cents := 0;
  RETURN NEXT;

  section := 'investing';
  line_item := 'Net cash from investing activities';
  amount_cents := 0;
  RETURN NEXT;

  section := 'financing';
  line_item := 'Financing activities (configure in P22+)';
  amount_cents := 0;
  RETURN NEXT;

  section := 'financing';
  line_item := 'Net cash from financing activities';
  amount_cents := 0;
  RETURN NEXT;

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
  'P5-5 indirect-method cash flow statement. All amount_cents rows are TRUE integer cents = ROUND(<signed dollars> * 100). Operating section computed live from net income + working-capital deltas (ΔAR, ΔInventory, ΔAP). Investing + Financing are $0 placeholders. Emits two _cash_reference rows (Beginning Cash, Ending Cash). STABLE.';

-- Reload PostgREST schema cache so the API sees the new definitions.
NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- Migration-tracking footer.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations'
      AND table_name   = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    VALUES ('20260970000000', 'gl_reports_true_cents', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
