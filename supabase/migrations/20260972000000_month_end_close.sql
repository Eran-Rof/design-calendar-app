-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Month-End Close module (per-period close checklist + tie-outs)
--
-- 1. close_periods          — one row per (entity, gl_period): overall close
--                             status open → in_close → closed, run/close stamps.
-- 2. close_checklist_items  — checklist rows per close period: automated
--                             tie-out checks (kind=auto, status pass/fail with
--                             the numbers behind the verdict in detail jsonb)
--                             and manual sign-offs (kind=manual, status
--                             pending → signed_off with who/when/note).
-- 3. close_run_auto_checks(entity, period) RPC — computes EVERY automated
--                             check in SQL (no PostgREST row caps) and returns
--                             a jsonb array [{item_key, status, detail}].
--                             READ-ONLY (STABLE): the API handler upserts the
--                             results into close_checklist_items.
-- 4. gl_post_year_end_close 100x FIX — the P5-6 function labeled the
--                             journal_entry_lines debit/credit aggregation
--                             "amount_cents" but jel.debit/credit are numeric
--                             DOLLARS (same bug class as the report RPCs fixed
--                             in migration 20260970000000). Every closing JE
--                             line then divided by 100 → posted at 1/100 of
--                             the true amount, and net_income_cents reported
--                             dollars. The function has NEVER been run; this
--                             fixes the scaling before any first year-end close.
--
-- Semantics of the automated checks mirror the #1665 subledger tie-out engine
-- (api/_lib/accounting/tieouts.js): cumulative posted-ACCRUAL GL balances vs
-- live subledger open items, tolerance one cent, AP 2000 waived as
-- pending_payments while sum(paid_amount_cents)=0 across posted bills.
--
-- Security posture per 20260964000000: NO anon policies; auth_internal RLS
-- only. Handlers run with the service role. T11: both tables get the
-- audit_row_changes trigger; period status flips go through the P5-1
-- gl_period_transition_status RPC (actor + reason captured by its trigger).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. close_periods ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS close_periods (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT
                       DEFAULT coalesce(current_entity_id(), rof_entity_id()),
  period_id          uuid NOT NULL REFERENCES gl_periods(id) ON DELETE CASCADE,
  period_month       date NOT NULL,               -- first day of the calendar month
  status             text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_close','closed')),
  checks_last_run_at timestamptz,
  closed_at          timestamptz,
  closed_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reopened_at        timestamptz,
  reopened_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  source             text NOT NULL DEFAULT 'month_end_close',   -- T10 tagging
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT close_periods_entity_period_unique UNIQUE (entity_id, period_id),
  CONSTRAINT close_periods_entity_month_unique  UNIQUE (entity_id, period_month)
);

CREATE INDEX IF NOT EXISTS idx_close_periods_entity_month
  ON close_periods (entity_id, period_month DESC);

COMMENT ON TABLE close_periods IS 'Month-End Close: one row per (entity, gl_period). Overall close status open/in_close/closed; the gl_periods row is the actual lock (je_period_lock triggers). Status flips ride gl_period_transition_status so actor + reason land in gl_period_status_log.';

-- ─── 2. close_checklist_items ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS close_checklist_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id        uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT
                     DEFAULT coalesce(current_entity_id(), rof_entity_id()),
  close_period_id  uuid NOT NULL REFERENCES close_periods(id) ON DELETE CASCADE,
  item_key         text NOT NULL,
  label            text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('auto','manual')),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','pass','fail','signed_off')),
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  signed_off_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  signed_off_at    timestamptz,
  note             text,
  sort_order       smallint NOT NULL DEFAULT 100,
  source           text NOT NULL DEFAULT 'month_end_close',     -- T10 tagging
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT close_checklist_items_unique UNIQUE (close_period_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_close_checklist_items_period
  ON close_checklist_items (close_period_id, sort_order);

COMMENT ON TABLE close_checklist_items IS 'Month-End Close checklist rows. kind=auto rows are upserted by the run-checks API from close_run_auto_checks() with the numbers behind each verdict in detail jsonb; kind=manual rows are signed off by an operator with a required note (who/when in signed_off_by/at).';

-- ─── touch triggers ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_tables_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS close_periods_touch_trg ON close_periods;
CREATE TRIGGER close_periods_touch_trg
  BEFORE UPDATE ON close_periods
  FOR EACH ROW EXECUTE FUNCTION close_tables_touch();

DROP TRIGGER IF EXISTS close_checklist_items_touch_trg ON close_checklist_items;
CREATE TRIGGER close_checklist_items_touch_trg
  BEFORE UPDATE ON close_checklist_items
  FOR EACH ROW EXECUTE FUNCTION close_tables_touch();

-- ─── T11 audit coverage ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_row_changes ON close_periods;
CREATE TRIGGER audit_row_changes
  AFTER INSERT OR UPDATE OR DELETE ON close_periods
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

DROP TRIGGER IF EXISTS audit_row_changes ON close_checklist_items;
CREATE TRIGGER audit_row_changes
  AFTER INSERT OR UPDATE OR DELETE ON close_checklist_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

-- ─── RLS: auth_internal only (20260964 posture — NO anon policies) ──────────
ALTER TABLE close_periods         ENABLE ROW LEVEL SECURITY;
ALTER TABLE close_checklist_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_internal_close_periods" ON close_periods;
CREATE POLICY "auth_internal_close_periods" ON close_periods
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_close_checklist_items" ON close_checklist_items;
CREATE POLICY "auth_internal_close_checklist_items" ON close_checklist_items
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ─── 3. close_run_auto_checks ────────────────────────────────────────────────
-- Computes every automated month-end check in one round trip. All money math
-- happens in SQL (journal_entry_lines.debit/credit are numeric DOLLARS →
-- ROUND(SUM(dollars) * 100) = TRUE integer cents, the 20260970000000 rule).
-- Read-only; the API handler persists the results.
CREATE OR REPLACE FUNCTION close_run_auto_checks(
  p_entity_id uuid,
  p_period_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_period            record;
  v_checks            jsonb := '[]'::jsonb;
  v_accrual_imb       bigint;
  v_cash_imb          bigint;
  v_posted_jes        int;
  v_draft             int;
  v_ar_rows           jsonb;
  v_ar_ok             boolean;
  v_ar_unmapped       bigint;
  v_ar_considered     int;
  v_ap_gl             bigint;
  v_ap_open           bigint;
  v_ap_paid           bigint;
  v_ap_bills          int;
  v_ap_ok             boolean;
  v_ap_waived         boolean;
  v_bank_rows         jsonb;
  v_bank_total        int;
  v_bank_reconciled   int;
  v_8007_accrual      bigint;
  v_8007_cash         bigint;
  v_8007_lines        int;
  v_stmt              record;
  v_1107_asof         bigint;
  v_rev               bigint;
BEGIN
  SELECT id, entity_id, status, starts_on, ends_on, fiscal_year, period_number
    INTO v_period
    FROM gl_periods
   WHERE id = p_period_id AND entity_id = p_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'close_run_auto_checks: period % not found for entity %', p_period_id, p_entity_id;
  END IF;

  -- 1. gl_balanced — posted JEs in the period must sum to zero per basis.
  SELECT
    COALESCE(ROUND(SUM(CASE WHEN je.basis = 'ACCRUAL' THEN jel.debit - jel.credit ELSE 0 END) * 100), 0)::bigint,
    COALESCE(ROUND(SUM(CASE WHEN je.basis = 'CASH'    THEN jel.debit - jel.credit ELSE 0 END) * 100), 0)::bigint,
    COUNT(DISTINCT je.id)::int
    INTO v_accrual_imb, v_cash_imb, v_posted_jes
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE je.entity_id = p_entity_id
     AND je.period_id = p_period_id
     AND je.status = 'posted';

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'gl_balanced',
    'status', CASE WHEN v_accrual_imb = 0 AND v_cash_imb = 0 THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object(
      'accrual_imbalance_cents', v_accrual_imb,
      'cash_imbalance_cents',    v_cash_imb,
      'posted_je_count',         v_posted_jes));

  -- 2. ar_subledger_tie — cumulative posted-ACCRUAL GL per AR control account
  --    vs open ar_invoices grouped by ar_account_id (#1665 semantics: gl_status
  --    NOT IN draft/pending_approval/void/reversed; tolerance one cent).
  WITH gl AS (
    SELECT ga.code, ga.id AS account_id,
           COALESCE((
             SELECT ROUND(SUM(jel.debit - jel.credit) * 100)
               FROM journal_entry_lines jel
               JOIN journal_entries je ON je.id = jel.journal_entry_id
              WHERE jel.account_id = ga.id
                AND je.entity_id = p_entity_id
                AND je.status = 'posted'
                AND je.basis = 'ACCRUAL'
           ), 0)::bigint AS gl_cents
      FROM gl_accounts ga
     WHERE ga.entity_id = p_entity_id
       AND ga.code IN ('1105','1107','1108')
  ), sub AS (
    SELECT ar_account_id,
           SUM(total_amount_cents - paid_amount_cents)::bigint AS open_cents
      FROM ar_invoices
     WHERE entity_id = p_entity_id
       AND gl_status NOT IN ('draft','pending_approval','void','reversed')
     GROUP BY ar_account_id
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      'account_code',    gl.code,
      'gl_cents',        gl.gl_cents,
      'subledger_cents', COALESCE(sub.open_cents, 0),
      'diff_cents',      gl.gl_cents - COALESCE(sub.open_cents, 0),
      'ok',              abs(gl.gl_cents - COALESCE(sub.open_cents, 0)) <= 1
    ) ORDER BY gl.code),
    bool_and(abs(gl.gl_cents - COALESCE(sub.open_cents, 0)) <= 1)
    INTO v_ar_rows, v_ar_ok
    FROM gl
    LEFT JOIN sub ON sub.ar_account_id = gl.account_id;

  SELECT COALESCE(SUM(total_amount_cents - paid_amount_cents), 0)::bigint, COUNT(*)::int
    INTO v_ar_unmapped, v_ar_considered
    FROM ar_invoices
   WHERE entity_id = p_entity_id
     AND ar_account_id IS NULL
     AND gl_status NOT IN ('draft','pending_approval','void','reversed');

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'ar_subledger_tie',
    'status', CASE WHEN COALESCE(v_ar_ok, false) THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object(
      'accounts',           COALESCE(v_ar_rows, '[]'::jsonb),
      'unmapped_open_cents', v_ar_unmapped,
      'unmapped_invoices',   v_ar_considered,
      'tolerance_cents',     1));

  -- 3. ap_subledger_tie — GL 2000 (CR-net) vs unpaid posted vendor bills.
  --    #1665 waiver: while sum(paid_amount_cents)=0 across posted bills the
  --    payments ledger is not live → report pending_payments, do not block.
  SELECT COALESCE((
    SELECT ROUND(SUM(jel.credit - jel.debit) * 100)
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jel.account_id
     WHERE ga.entity_id = p_entity_id
       AND ga.code = '2000'
       AND je.entity_id = p_entity_id
       AND je.status = 'posted'
       AND je.basis = 'ACCRUAL'
  ), 0)::bigint INTO v_ap_gl;

  SELECT COALESCE(SUM(total_amount_cents - paid_amount_cents), 0)::bigint,
         COALESCE(SUM(paid_amount_cents), 0)::bigint,
         COUNT(*)::int
    INTO v_ap_open, v_ap_paid, v_ap_bills
    FROM invoices
   WHERE entity_id = p_entity_id
     AND gl_status = 'posted';

  v_ap_ok     := abs(v_ap_gl - v_ap_open) <= 1;
  v_ap_waived := (NOT v_ap_ok) AND v_ap_paid = 0;

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'ap_subledger_tie',
    'status', CASE WHEN v_ap_ok OR v_ap_waived THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object(
      'gl_cents',         v_ap_gl,
      'subledger_cents',  v_ap_open,
      'diff_cents',       v_ap_gl - v_ap_open,
      'posted_bills',     v_ap_bills,
      'paid_total_cents', v_ap_paid,
      'waived',           CASE WHEN v_ap_waived THEN 'pending_payments' ELSE NULL END,
      'tolerance_cents',  1));

  -- 4. bank_recon — every bank_recon_runs row for this period must be
  --    status=reconciled, and at least one run must exist.
  SELECT COUNT(*)::int,
         COUNT(*) FILTER (WHERE brr.status = 'reconciled')::int,
         COALESCE(jsonb_agg(jsonb_build_object(
           'account',    ba.name,
           'code',       ga.code,
           'status',     brr.status,
           'diff_cents', brr.reconciled_diff_cents
         ) ORDER BY ga.code), '[]'::jsonb)
    INTO v_bank_total, v_bank_reconciled, v_bank_rows
    FROM bank_recon_runs brr
    JOIN bank_accounts ba ON ba.id = brr.bank_account_id
    JOIN gl_accounts  ga ON ga.id = ba.gl_account_id
   WHERE brr.entity_id = p_entity_id
     AND brr.period_id = p_period_id;

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'bank_recon',
    'status', CASE WHEN v_bank_total > 0 AND v_bank_reconciled = v_bank_total THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object(
      'runs',            v_bank_total,
      'reconciled',      v_bank_reconciled,
      'accounts',        v_bank_rows,
      'note',            CASE WHEN v_bank_total = 0 THEN 'no reconciliation runs exist for this period' ELSE NULL END));

  -- 5. no_draft_jes — mirror of the P5-7 preflight blocking check.
  SELECT COUNT(*)::int INTO v_draft
    FROM journal_entries
   WHERE entity_id = p_entity_id
     AND period_id = p_period_id
     AND status IN ('draft','pending_approval','unposted');

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'no_draft_jes',
    'status', CASE WHEN v_draft = 0 THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object('draft_je_count', v_draft));

  -- 6. uncategorized_8007 — Uncategorized Expense activity in the period.
  SELECT
    COALESCE(ROUND(SUM(CASE WHEN je.basis = 'ACCRUAL' THEN jel.debit - jel.credit ELSE 0 END) * 100), 0)::bigint,
    COALESCE(ROUND(SUM(CASE WHEN je.basis = 'CASH'    THEN jel.debit - jel.credit ELSE 0 END) * 100), 0)::bigint,
    COUNT(*)::int
    INTO v_8007_accrual, v_8007_cash, v_8007_lines
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jel.account_id
   WHERE ga.entity_id = p_entity_id
     AND ga.code = '8007'
     AND je.entity_id = p_entity_id
     AND je.period_id = p_period_id
     AND je.status = 'posted';

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'uncategorized_8007',
    'status', CASE WHEN v_8007_accrual = 0 THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object(
      'accrual_net_cents', v_8007_accrual,
      'cash_net_cents',    v_8007_cash,
      'line_count',        v_8007_lines));

  -- 7. factor_recon — if a Rosenthal statement covers this month, its ending
  --    Net OAR must tie to GL 1107 as of period end. No statement → pass with
  --    covered=false (the manual "Factor statement received" item still gates).
  SELECT * INTO v_stmt
    FROM factor_statements
   WHERE entity_id = p_entity_id
     AND statement_month = v_period.starts_on
   LIMIT 1;

  IF v_stmt.id IS NULL THEN
    v_checks := v_checks || jsonb_build_object(
      'item_key', 'factor_recon',
      'status', 'pass',
      'detail', jsonb_build_object('covered', false, 'note', 'no factor statement imported for this month'));
  ELSE
    SELECT COALESCE((
      SELECT ROUND(SUM(jel.debit - jel.credit) * 100)
        FROM journal_entry_lines jel
        JOIN journal_entries je ON je.id = jel.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jel.account_id
       WHERE ga.entity_id = p_entity_id
         AND ga.code = '1107'
         AND je.entity_id = p_entity_id
         AND je.status = 'posted'
         AND je.basis = 'ACCRUAL'
         AND je.posting_date <= v_period.ends_on
    ), 0)::bigint INTO v_1107_asof;

    v_checks := v_checks || jsonb_build_object(
      'item_key', 'factor_recon',
      'status', CASE WHEN abs(v_stmt.ending_net_oar_cents - v_1107_asof) <= 1 THEN 'pass' ELSE 'fail' END,
      'detail', jsonb_build_object(
        'covered',                 true,
        'statement_month',         v_stmt.statement_month,
        'ending_net_oar_cents',    v_stmt.ending_net_oar_cents,
        'gl_1107_asof_cents',      v_1107_asof,
        'diff_cents',              v_stmt.ending_net_oar_cents - v_1107_asof,
        'tolerance_cents',         1));
  END IF;

  -- 8. revenue_posted — sanity: some revenue posted in the period (ACCRUAL).
  SELECT COALESCE(ROUND(SUM(jel.credit - jel.debit) * 100), 0)::bigint
    INTO v_rev
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jel.account_id
   WHERE ga.entity_id = p_entity_id
     AND ga.account_type = 'revenue'
     AND je.entity_id = p_entity_id
     AND je.period_id = p_period_id
     AND je.status = 'posted'
     AND je.basis = 'ACCRUAL';

  v_checks := v_checks || jsonb_build_object(
    'item_key', 'revenue_posted',
    'status', CASE WHEN v_rev > 0 THEN 'pass' ELSE 'fail' END,
    'detail', jsonb_build_object('revenue_cents', v_rev));

  RETURN jsonb_build_object(
    'period_id',     v_period.id,
    'fiscal_year',   v_period.fiscal_year,
    'period_number', v_period.period_number,
    'starts_on',     v_period.starts_on,
    'ends_on',       v_period.ends_on,
    'gl_status',     v_period.status,
    'ran_at',        now(),
    'checks',        v_checks);
END;
$$;

COMMENT ON FUNCTION close_run_auto_checks(uuid, uuid) IS 'Month-End Close automated tie-out battery: gl_balanced, ar_subledger_tie (1105/1107/1108), ap_subledger_tie (2000, pending_payments waiver), bank_recon (bank_recon_runs per period), no_draft_jes, uncategorized_8007, factor_recon (statement Net OAR vs GL 1107 as of period end), revenue_posted. Read-only STABLE; the run-checks handler upserts results into close_checklist_items. Semantics mirror api/_lib/accounting/tieouts.js.';

-- ─── 4. gl_post_year_end_close 100x scaling fix ─────────────────────────────
-- journal_entry_lines.debit/credit are numeric DOLLARS. The P5-6 version
-- aggregated them raw and named the result amount_cents, then divided by 100
-- to build the closing JE lines — posting 1/100 of the true amounts. Fix:
-- aggregate in dollars and convert ONCE via ROUND(SUM(dollars) * 100) → TRUE
-- integer cents (the 20260970000000 rule). Everything downstream (cents → the
-- gl_post_journal_entry numeric(18,2) dollar payload) is unchanged.
CREATE OR REPLACE FUNCTION gl_post_year_end_close(
  p_entity_id   uuid,
  p_fiscal_year smallint,
  p_dry_run     boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_re_account_id   uuid;
  v_period_ids      uuid[];
  v_already_closed  int;
  v_year_start      date;
  v_year_end        date;
  v_basis           text;
  v_accrual_je_id   uuid;
  v_cash_je_id      uuid;
  v_result          jsonb := '{}'::jsonb;
  v_per_basis       jsonb := '{}'::jsonb;
  v_net_income      bigint;
  v_lines           jsonb;
  v_payload         jsonb;
  v_line_no         int;
  v_account         record;
  v_basis_lines     jsonb := '[]'::jsonb;
BEGIN
  -- Validate entity + retained-earnings account
  SELECT default_retained_earnings_account_id INTO v_re_account_id
    FROM entities WHERE id = p_entity_id;
  IF v_re_account_id IS NULL THEN
    RAISE EXCEPTION
      'gl_post_year_end_close: entity % has no default_retained_earnings_account_id; set it via Entities admin first',
      p_entity_id;
  END IF;

  -- All 12 periods of this FY for this entity
  SELECT array_agg(id) INTO v_period_ids
    FROM gl_periods
   WHERE entity_id = p_entity_id
     AND fiscal_year = p_fiscal_year;
  IF v_period_ids IS NULL OR array_length(v_period_ids, 1) = 0 THEN
    RAISE EXCEPTION
      'gl_post_year_end_close: no gl_periods rows for entity % fiscal_year %',
      p_entity_id, p_fiscal_year;
  END IF;

  -- Block re-run: if ANY period in the FY is already closed_with_closing_jes,
  -- the close has already happened. One-shot per FY.
  SELECT count(*) INTO v_already_closed
    FROM gl_periods
   WHERE id = ANY(v_period_ids)
     AND status = 'closed_with_closing_jes';
  IF v_already_closed > 0 THEN
    RAISE EXCEPTION
      'gl_post_year_end_close: fiscal_year % already has % periods in closed_with_closing_jes; cannot re-run year-end close',
      p_fiscal_year, v_already_closed;
  END IF;

  -- FY year boundaries (12 calendar months per locked decision 4)
  v_year_start := make_date(p_fiscal_year::int,  1,  1);
  v_year_end   := make_date(p_fiscal_year::int, 12, 31);

  -- Build the closing JE for BOTH bases (sibling-linked when both have activity)
  FOREACH v_basis IN ARRAY ARRAY['ACCRUAL','CASH'] LOOP
    v_lines := '[]'::jsonb;
    v_line_no := 1;
    v_net_income := 0;
    v_basis_lines := '[]'::jsonb;

    -- Sum each revenue + expense account from the posted JE lines.
    -- jel.debit/credit are numeric DOLLARS: aggregate in dollars, then
    -- convert ONCE per account via ROUND(SUM(dollars) * 100) = TRUE cents.
    -- The closing JE flips each account:
    --   revenue (CR-positive normal) → DR by its CR-net (zero it out)
    --   expense (DR-positive normal) → CR by its DR-net (zero it out)
    FOR v_account IN
      SELECT
        account_id,
        account_type,
        code,
        name,
        ROUND(SUM(amount_dollars) * 100)::bigint AS amount_cents
      FROM (
        SELECT
          jel.account_id,
          ga.account_type,
          ga.code,
          ga.name,
          CASE
            WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
            WHEN ga.account_type = 'contra_revenue' THEN jel.debit - jel.credit
            WHEN ga.account_type = 'expense'        THEN jel.debit - jel.credit
          END AS amount_dollars
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        JOIN gl_accounts ga ON ga.id = jel.account_id
        WHERE je.status = 'posted'
          AND je.entity_id = p_entity_id
          AND je.basis = v_basis
          AND ga.account_type IN ('revenue','contra_revenue','expense')
          AND je.posting_date >= v_year_start
          AND je.posting_date <= v_year_end
      ) src
      GROUP BY account_id, account_type, code, name
      HAVING ROUND(SUM(amount_dollars) * 100) <> 0
      ORDER BY account_type, code
    LOOP
      -- Build closing line: zero the account out by posting the opposite side.
      -- gl_post_journal_entry's payload schema reads debit/credit as
      -- numeric(18,2) dollars, so convert cents → dollars here.
      IF v_account.account_type = 'revenue' THEN
        -- amount_cents is positive (net CR). Close with a DR of the same amount.
        v_lines := v_lines || jsonb_build_object(
          'line_number', v_line_no,
          'account_id',  v_account.account_id,
          'debit',       (v_account.amount_cents::numeric / 100),
          'credit',      0,
          'memo',        format('Year-end close %s: zero %s', p_fiscal_year, v_account.code),
          'subledger_type', null,
          'subledger_id',   null
        );
        v_net_income := v_net_income + v_account.amount_cents;
        v_basis_lines := v_basis_lines || jsonb_build_object(
          'code', v_account.code, 'name', v_account.name, 'side','DR', 'amount_cents', v_account.amount_cents);
      ELSIF v_account.account_type = 'contra_revenue' THEN
        -- amount_cents positive (net DR). Contra-revenue closes with a CR.
        v_lines := v_lines || jsonb_build_object(
          'line_number', v_line_no,
          'account_id',  v_account.account_id,
          'debit',       0,
          'credit',      (v_account.amount_cents::numeric / 100),
          'memo',        format('Year-end close %s: zero %s', p_fiscal_year, v_account.code),
          'subledger_type', null,
          'subledger_id',   null
        );
        v_net_income := v_net_income - v_account.amount_cents;
        v_basis_lines := v_basis_lines || jsonb_build_object(
          'code', v_account.code, 'name', v_account.name, 'side','CR', 'amount_cents', v_account.amount_cents);
      ELSE  -- expense
        -- amount_cents positive (net DR). Close with a CR.
        v_lines := v_lines || jsonb_build_object(
          'line_number', v_line_no,
          'account_id',  v_account.account_id,
          'debit',       0,
          'credit',      (v_account.amount_cents::numeric / 100),
          'memo',        format('Year-end close %s: zero %s', p_fiscal_year, v_account.code),
          'subledger_type', null,
          'subledger_id',   null
        );
        v_net_income := v_net_income - v_account.amount_cents;
        v_basis_lines := v_basis_lines || jsonb_build_object(
          'code', v_account.code, 'name', v_account.name, 'side','CR', 'amount_cents', v_account.amount_cents);
      END IF;
      v_line_no := v_line_no + 1;
    END LOOP;

    -- Retained Earnings plug line
    -- If net_income > 0: CR retained_earnings (income increases equity)
    -- If net_income < 0: DR retained_earnings (loss decreases equity)
    -- If net_income = 0: skip this basis entirely (no JE needed)
    IF v_net_income <> 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'line_number', v_line_no,
        'account_id',  v_re_account_id,
        'debit',       CASE WHEN v_net_income < 0 THEN ((-v_net_income)::numeric / 100) ELSE 0 END,
        'credit',      CASE WHEN v_net_income > 0 THEN  (v_net_income::numeric / 100)    ELSE 0 END,
        'memo',        format('Year-end close %s: net income to retained earnings', p_fiscal_year),
        'subledger_type', null,
        'subledger_id',   null
      );

      v_per_basis := v_per_basis || jsonb_build_object(
        v_basis, jsonb_build_object(
          'net_income_cents', v_net_income,
          'line_count',       v_line_no,
          'projected_lines',  v_basis_lines
        )
      );

      IF NOT p_dry_run THEN
        v_payload := jsonb_build_object(
          'entity_id',     p_entity_id,
          'basis',         v_basis,
          'journal_type',  'gl_year_end_close',
          'posting_date',  v_year_end,
          'source_module', 'gl',
          'source_table',  'entities',
          'source_id',     p_entity_id::text,
          'description',   format('Year-end close FY%s (%s)', p_fiscal_year, v_basis),
          'audit_reason',  format('Year-end close FY%s', p_fiscal_year),
          'lines',         v_lines
        );
        IF v_basis = 'ACCRUAL' THEN
          v_accrual_je_id := gl_post_journal_entry(v_payload);
        ELSE
          v_cash_je_id := gl_post_journal_entry(v_payload);
        END IF;
      END IF;
    ELSE
      v_per_basis := v_per_basis || jsonb_build_object(
        v_basis, jsonb_build_object(
          'net_income_cents', 0,
          'line_count',       0,
          'projected_lines',  '[]'::jsonb,
          'skipped_reason',   'no revenue/expense activity for this basis in FY'
        )
      );
    END IF;
  END LOOP;

  -- Link sibling JEs if both were posted
  IF NOT p_dry_run AND v_accrual_je_id IS NOT NULL AND v_cash_je_id IS NOT NULL THEN
    PERFORM gl_link_sibling_je(v_accrual_je_id, v_cash_je_id);
  END IF;

  -- Flip every period of the FY to closed_with_closing_jes — terminal state.
  -- Skip in dry-run mode.
  IF NOT p_dry_run THEN
    UPDATE gl_periods
       SET status = 'closed_with_closing_jes',
           closed_at = COALESCE(closed_at, now())
     WHERE id = ANY(v_period_ids);
  END IF;

  v_result := jsonb_build_object(
    'entity_id',       p_entity_id,
    'fiscal_year',     p_fiscal_year,
    'dry_run',         p_dry_run,
    'accrual_je_id',   v_accrual_je_id,
    'cash_je_id',      v_cash_je_id,
    'periods_flipped', CASE WHEN p_dry_run THEN 0 ELSE array_length(v_period_ids, 1) END,
    'basis_breakdown', v_per_basis
  );

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION gl_post_year_end_close(uuid, smallint, boolean) IS
  'P5-6 year-end close, 100x-scaling FIXED (jel dollars aggregated then ROUND(SUM*100) to true cents; the original labeled raw dollar sums amount_cents and divided by 100). Posts the closing JE for the FY on both bases with sibling linkage, then flips all 12 periods to closed_with_closing_jes. One-shot per FY; dry_run=true returns the projection without inserts.';

NOTIFY pgrst, 'reload schema';
