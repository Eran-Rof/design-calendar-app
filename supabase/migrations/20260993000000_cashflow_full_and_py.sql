-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Cash Flow Statement: real INVESTING + FINANCING sections, and a
-- deterministic, data-driven account classification that GUARANTEES the
-- statement FOOTS (operating + investing + financing = Δcash).
--
-- BACKGROUND
--   cash_flow_indirect() (P5-5, mig 20260603300000 / 20260970000000) shipped
--   with a live indirect OPERATING section (Net Income + ΔAR + ΔInventory + ΔAP)
--   but $0 placeholder INVESTING and FINANCING sections. The GL is now a
--   complete 1:1 Xoro mirror (~99k posted JEs, incl. opening-balance + year-end
--   closing entries), so every section is derivable from GL account activity.
--
-- THE FOOTING GUARANTEE (why this is exact, not approximate)
--   The ledger is perfectly balanced: Σ(debit − credit) over ALL posted lines
--   for the entity = 0 (verified on prod = 0). Therefore, for any period,
--       Δcash = Σ_cash(debit − credit) = − Σ_noncash(debit − credit)
--             = Σ_noncash(credit − debit).
--   If we classify EVERY non-cash account into operating / investing / financing
--   (or an explicit "unclassified" residual) and define each section's cash
--   contribution as Σ(credit − debit) of its accounts, then
--       operating + investing + financing + unclassified = Σ_noncash(credit−debit)
--                                                         = Δcash,   EXACTLY.
--   Net Income is presented as the operating anchor because, by the same double
--   entry, Net Income = Σ_P&L(credit − debit); the working-capital adjustment
--   lines are the Σ(credit − debit) of the operating balance-sheet accounts.
--
-- YEAR-END CLOSE / RE-ROLL HANDLING (so financing is not polluted)
--   Xoro mirrors an annual closing entry that zeroes the P&L into Retained
--   Earnings (e.g. the 2024-12-31 173-line entry), and small P&L↔RE reclasses.
--   These are pure equity reclassifications: they touch Retained Earnings / the
--   Opening Balance Equity roll accounts AND a P&L account AND NO cash account.
--   Left in, they (a) understate Net Income for a period spanning the close and
--   (b) surface the reversed income as a spurious FINANCING equity movement —
--   the two exactly offset so the statement still foots, but the PRESENTATION is
--   wrong. We therefore EXCLUDE such entries from every flow computation. This
--   is footing-safe: an excluded entry touches no cash (removes 0 from Δcash)
--   and is internally balanced across non-cash lines (removes 0 from the
--   non-cash sum). The OPENING-BALANCE entry (which DOES touch cash — it seeds
--   opening cash + balances) is deliberately NOT excluded (the "no cash" guard
--   protects it).
--
-- THE MAPPING IS DATA, NOT MAGIC LISTS
--   Three columns on gl_accounts encode the classification, populated by
--   documented COA code ranges below:
--     • cashflow_section  operating | investing | financing | cash | NULL(=P&L)
--     • cashflow_line     the statement line label a BS account rolls up into
--     • cashflow_sort     display order of the lines within a section
--   The RPC reads these columns; adding a new BS account with no mapping shows up
--   as an explicit "Change in Other / Unclassified Accounts" operating line
--   (never silently hidden). Re-running this migration re-applies the mapping.
--
-- Idempotent throughout (ADD COLUMN IF NOT EXISTS; UPDATEs are set-based;
-- CREATE OR REPLACE FUNCTION). All amounts TRUE integer cents (mig 20260970).
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Classification columns
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS cashflow_section text;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS cashflow_line    text;
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS cashflow_sort    smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'gl_accounts' AND constraint_name = 'gl_accounts_cashflow_section_chk'
  ) THEN
    ALTER TABLE gl_accounts
      ADD CONSTRAINT gl_accounts_cashflow_section_chk
      CHECK (cashflow_section IS NULL
             OR cashflow_section IN ('operating','investing','financing','cash'));
  END IF;
END $$;

COMMENT ON COLUMN gl_accounts.cashflow_section IS
  'Cash-flow statement classification for balance-sheet accounts: operating | investing | financing | cash. NULL for P&L accounts (revenue/contra_revenue/expense) which flow through Net Income, and for as-yet-unclassified BS accounts (surfaced as an explicit residual line). See mig 20260993000000.';
COMMENT ON COLUMN gl_accounts.cashflow_line IS
  'The cash-flow statement line label this account rolls up into (data-driven; grouped + summed by cash_flow_indirect). See mig 20260993000000.';
COMMENT ON COLUMN gl_accounts.cashflow_sort IS
  'Display order of cash-flow lines within their section. See mig 20260993000000.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Populate the mapping from COA code ranges (documented; re-run-safe).
--    Applied by code convention across entities (codes are the shared ROF COA).
--    Reset first so removed/renamed ranges do not leave stale tags.
-- ────────────────────────────────────────────────────────────────────────────
UPDATE gl_accounts
   SET cashflow_section = NULL, cashflow_line = NULL, cashflow_sort = NULL
 WHERE cashflow_section IS NOT NULL OR cashflow_line IS NOT NULL OR cashflow_sort IS NOT NULL;

-- ── CASH & cash equivalents (1000–1030: banks, petty cash, PayPal, undeposited,
--    cash clearing). This set defines Δcash and beginning/ending cash. ─────────
UPDATE gl_accounts SET cashflow_section='cash', cashflow_line='Cash & Cash Equivalents', cashflow_sort=0
 WHERE account_type='asset' AND code BETWEEN '1000' AND '1030';

-- ── OPERATING — working-capital assets ──────────────────────────────────────
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Accounts Receivable', cashflow_sort=10
 WHERE account_type IN ('asset','contra_asset') AND code BETWEEN '1100' AND '1113';
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Factor Advances', cashflow_sort=11
 WHERE account_type='asset' AND code BETWEEN '1050' AND '1051';
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Inventory', cashflow_sort=12
 WHERE account_type='asset' AND code BETWEEN '1200' AND '1210';
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Prepaid Expenses & Other Current Assets', cashflow_sort=13
 WHERE account_type='asset' AND (code BETWEEN '1300' AND '1303' OR code='1308' OR code BETWEEN '1400' AND '1409');

-- ── OPERATING — working-capital liabilities ─────────────────────────────────
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Accounts Payable', cashflow_sort=20
 WHERE account_type='liability' AND code BETWEEN '2000' AND '2001';
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Accrued Liabilities', cashflow_sort=21
 WHERE account_type='liability' AND (code BETWEEN '2010' AND '2021' OR code='2160' OR code='2450');
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Credit Card Balances', cashflow_sort=22
 WHERE account_type='liability' AND code BETWEEN '2100' AND '2108';
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Customer Deposits & Unearned Revenue', cashflow_sort=23
 WHERE account_type='liability' AND code BETWEEN '2200' AND '2201';
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Taxes Payable', cashflow_sort=24
 WHERE account_type='liability' AND code BETWEEN '2300' AND '2315';
UPDATE gl_accounts SET cashflow_section='operating', cashflow_line='Change in Payroll Liabilities', cashflow_sort=25
 WHERE account_type='liability' AND code BETWEEN '2400' AND '2412';

-- ── INVESTING — long-term assets ────────────────────────────────────────────
UPDATE gl_accounts SET cashflow_section='investing', cashflow_line='Purchases of Property & Equipment (net)', cashflow_sort=40
 WHERE account_type IN ('asset','contra_asset') AND code BETWEEN '1500' AND '1599';
UPDATE gl_accounts SET cashflow_section='investing', cashflow_line='Deposits & Other Long-Term Assets (net)', cashflow_sort=41
 WHERE account_type='asset' AND (code BETWEEN '1304' AND '1307' OR code BETWEEN '1600' AND '1699');
UPDATE gl_accounts SET cashflow_section='investing', cashflow_line='Loans & Notes Receivable (net)', cashflow_sort=42
 WHERE account_type='asset' AND code BETWEEN '1450' AND '1455';

-- ── FINANCING — debt ────────────────────────────────────────────────────────
UPDATE gl_accounts SET cashflow_section='financing', cashflow_line='Loans & Notes Payable (net)', cashflow_sort=60
 WHERE account_type='liability' AND (code BETWEEN '2250' AND '2251' OR code BETWEEN '2451' AND '2452'
        OR code BETWEEN '2500' AND '2599' OR code BETWEEN '2700' AND '2703');
UPDATE gl_accounts SET cashflow_section='financing', cashflow_line='Factor Borrowings (net)', cashflow_sort=61
 WHERE account_type='liability' AND code='2460';
UPDATE gl_accounts SET cashflow_section='financing', cashflow_line='SBA & Government Loans (net)', cashflow_sort=62
 WHERE account_type='liability' AND code BETWEEN '2800' AND '2805';

-- ── FINANCING — equity ──────────────────────────────────────────────────────
UPDATE gl_accounts SET cashflow_section='financing', cashflow_line='Owner Contributions & Distributions (net)', cashflow_sort=70
 WHERE account_type='equity' AND code BETWEEN '3000' AND '3003';
-- 'Other Equity Changes' = Retained Earnings + Opening Balance Equity. The RPC
-- keys its close/re-roll exclusion off exactly this label, so it must stay.
UPDATE gl_accounts SET cashflow_section='financing', cashflow_line='Other Equity Changes', cashflow_sort=71
 WHERE account_type='equity' AND (code='3004' OR code='3900' OR code BETWEEN '3005' AND '3899');

-- ────────────────────────────────────────────────────────────────────────────
-- 3. cash_flow_indirect() — full statement.
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
  v_basis        text;
  v_excl         uuid[];
  v_ni           bigint;
  v_uncl         bigint;
  v_op_sub       bigint;
  v_inv_sub      bigint;
  v_fin_sub      bigint;
  v_begin_cash   bigint;
  v_end_cash     bigint;
  r              record;
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

  -- ── Close / RE-roll exclusion set ──────────────────────────────────────────
  -- Entries that touch an "Other Equity Changes" account (Retained Earnings /
  -- Opening Balance Equity) AND a P&L account AND NO cash account. Cashless +
  -- balanced ⇒ excluding them is footing-neutral; it un-pollutes Net Income and
  -- Financing. The opening-balance entry touches cash, so it is NOT excluded.
  -- Narrow to candidate JEs (those touching an RE/OBE roll account) FIRST — a
  -- few hundred at most — then test the P&L + no-cash conditions. Scanning every
  -- JE would time out on a ~100k-entry ledger.
  SELECT COALESCE(array_agg(je_id), ARRAY[]::uuid[]) INTO v_excl
  FROM (
    SELECT je.id AS je_id
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN gl_accounts ga          ON ga.id = jel.account_id
    WHERE je.entity_id = p_entity_id
      AND je.status = 'posted'
      AND je.basis = v_basis
      AND je.id IN (
        SELECT je2.id
        FROM journal_entries je2
        JOIN journal_entry_lines jl2 ON jl2.journal_entry_id = je2.id
        JOIN gl_accounts g2          ON g2.id = jl2.account_id
        WHERE je2.entity_id = p_entity_id
          AND je2.status = 'posted'
          AND je2.basis = v_basis
          AND g2.cashflow_line = 'Other Equity Changes'
      )
    GROUP BY je.id
    HAVING bool_or(ga.account_type IN ('revenue','contra_revenue','expense'))
       AND NOT bool_or(ga.cashflow_section = 'cash')
  ) x;

  -- ── Net Income (= Σ_P&L(credit − debit)), excluding close entries ──────────
  SELECT ROUND(COALESCE(SUM(jel.credit - jel.debit), 0) * 100)::bigint
    INTO v_ni
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id = jel.account_id
  WHERE je.entity_id = p_entity_id
    AND je.status = 'posted'
    AND je.basis = v_basis
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.account_type IN ('revenue','contra_revenue','expense')
    AND NOT (je.id = ANY(v_excl));

  -- ── Unclassified BS residual (surfaced, never hidden) ──────────────────────
  SELECT ROUND(COALESCE(SUM(jel.credit - jel.debit), 0) * 100)::bigint
    INTO v_uncl
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id = jel.account_id
  WHERE je.entity_id = p_entity_id
    AND je.status = 'posted'
    AND je.basis = v_basis
    AND je.posting_date BETWEEN p_from_date AND p_to_date
    AND ga.cashflow_section IS NULL
    AND ga.account_type IN ('asset','contra_asset','liability','equity')
    AND NOT (je.id = ANY(v_excl));

  -- ── Beginning + ending cash (cumulative; cash = section 'cash') ────────────
  SELECT
    ROUND(COALESCE(SUM(CASE WHEN je.posting_date <= (p_from_date - 1) THEN jel.debit - jel.credit ELSE 0 END), 0) * 100)::bigint,
    ROUND(COALESCE(SUM(CASE WHEN je.posting_date <= p_to_date          THEN jel.debit - jel.credit ELSE 0 END), 0) * 100)::bigint
    INTO v_begin_cash, v_end_cash
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id = jel.account_id
  WHERE je.entity_id = p_entity_id
    AND je.status = 'posted'
    AND je.basis = v_basis
    AND ga.cashflow_section = 'cash';

  -- ════════════════════════════ OPERATING ═══════════════════════════════════
  v_op_sub := v_ni;
  section := 'operating'; line_item := 'Net Income'; amount_cents := v_ni; RETURN NEXT;

  FOR r IN
    SELECT ga.cashflow_line AS ln,
           MIN(ga.cashflow_sort) AS srt,
           ROUND(SUM(jel.credit - jel.debit) * 100)::bigint AS amt
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN gl_accounts ga          ON ga.id = jel.account_id
    WHERE je.entity_id = p_entity_id
      AND je.status = 'posted'
      AND je.basis = v_basis
      AND je.posting_date BETWEEN p_from_date AND p_to_date
      AND ga.cashflow_section = 'operating'
      AND NOT (je.id = ANY(v_excl))
    GROUP BY ga.cashflow_line
    HAVING ROUND(SUM(jel.credit - jel.debit) * 100)::bigint <> 0
    ORDER BY MIN(ga.cashflow_sort)
  LOOP
    section := 'operating'; line_item := r.ln; amount_cents := r.amt; RETURN NEXT;
    v_op_sub := v_op_sub + r.amt;
  END LOOP;

  IF v_uncl <> 0 THEN
    section := 'operating'; line_item := 'Change in Other / Unclassified Accounts';
    amount_cents := v_uncl; RETURN NEXT;
    v_op_sub := v_op_sub + v_uncl;
  END IF;

  section := 'operating'; line_item := 'Net cash from operating activities';
  amount_cents := v_op_sub; RETURN NEXT;

  -- ════════════════════════════ INVESTING ═══════════════════════════════════
  v_inv_sub := 0;
  FOR r IN
    SELECT ga.cashflow_line AS ln,
           MIN(ga.cashflow_sort) AS srt,
           ROUND(SUM(jel.credit - jel.debit) * 100)::bigint AS amt
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN gl_accounts ga          ON ga.id = jel.account_id
    WHERE je.entity_id = p_entity_id
      AND je.status = 'posted'
      AND je.basis = v_basis
      AND je.posting_date BETWEEN p_from_date AND p_to_date
      AND ga.cashflow_section = 'investing'
      AND NOT (je.id = ANY(v_excl))
    GROUP BY ga.cashflow_line
    HAVING ROUND(SUM(jel.credit - jel.debit) * 100)::bigint <> 0
    ORDER BY MIN(ga.cashflow_sort)
  LOOP
    section := 'investing'; line_item := r.ln; amount_cents := r.amt; RETURN NEXT;
    v_inv_sub := v_inv_sub + r.amt;
  END LOOP;
  section := 'investing'; line_item := 'Net cash from investing activities';
  amount_cents := v_inv_sub; RETURN NEXT;

  -- ════════════════════════════ FINANCING ═══════════════════════════════════
  v_fin_sub := 0;
  FOR r IN
    SELECT ga.cashflow_line AS ln,
           MIN(ga.cashflow_sort) AS srt,
           ROUND(SUM(jel.credit - jel.debit) * 100)::bigint AS amt
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN gl_accounts ga          ON ga.id = jel.account_id
    WHERE je.entity_id = p_entity_id
      AND je.status = 'posted'
      AND je.basis = v_basis
      AND je.posting_date BETWEEN p_from_date AND p_to_date
      AND ga.cashflow_section = 'financing'
      AND NOT (je.id = ANY(v_excl))
    GROUP BY ga.cashflow_line
    HAVING ROUND(SUM(jel.credit - jel.debit) * 100)::bigint <> 0
    ORDER BY MIN(ga.cashflow_sort)
  LOOP
    section := 'financing'; line_item := r.ln; amount_cents := r.amt; RETURN NEXT;
    v_fin_sub := v_fin_sub + r.amt;
  END LOOP;
  section := 'financing'; line_item := 'Net cash from financing activities';
  amount_cents := v_fin_sub; RETURN NEXT;

  -- ════════════════════════ CASH RECONCILIATION ═════════════════════════════
  section := '_cash_reference'; line_item := 'Beginning Cash'; amount_cents := v_begin_cash; RETURN NEXT;
  section := '_cash_reference'; line_item := 'Ending Cash';    amount_cents := v_end_cash;   RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION cash_flow_indirect(uuid, text, date, date) IS
  'Cash Flow Statement (indirect). OPERATING = Net Income + Σ(credit−debit) of operating BS accounts (working-capital changes); INVESTING / FINANCING = Σ(credit−debit) of investing / financing BS accounts, grouped by gl_accounts.cashflow_line (data-driven, mig 20260993000000). FOOTS EXACTLY: operating + investing + financing (+ unclassified residual line) = Δcash = ending − beginning cash, because the ledger is balanced. Year-end close / RE-roll entries (touch Retained Earnings/OBE + P&L + no cash) are excluded from all flows so Net Income and Financing are not polluted (footing-neutral). Any unmapped BS account surfaces as an explicit "Change in Other / Unclassified Accounts" line. Emits two _cash_reference rows. All amounts TRUE integer cents. STABLE.';

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
    VALUES ('20260993000000', 'cashflow_full_and_py', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
