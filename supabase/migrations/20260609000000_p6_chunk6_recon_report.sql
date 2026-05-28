-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P6-6 — Reconciliation report compute + period-close pre-flight
--
-- Adds:
--   1. bank_recon_compute(p_bank_account_id, p_period_id) RETURNS jsonb
--      — computes gl_balance_cents + uncleared_txn_cents and returns them
--      alongside the operator-supplied bank_statement_balance_cents on
--      the bank_recon_runs row. Also returns the diff so the UI can show
--      a green checkmark / red flag.
--   2. Extends gl_period_close_preflight() (from P5-7) with a 10th check:
--      bank_recon_complete — for the period being closed, every active
--      bank_accounts row has a bank_recon_runs row with status='reconciled'.
--      Warning-level (not blocking) — operator can override.
--
-- Per docs/tangerine/P6-bank-recon-architecture.md §4.6, §7, §9.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. bank_recon_compute ──────────────────────────────────────────────────
-- Computes the three balance components for a (bank_account, period):
--   gl_balance_cents    = sum of posted CASH-basis JE line activity on the
--                          account's gl_account, through period.ends_on
--   uncleared_txn_cents = sum of unmatched bank_transactions through ends_on
--                          (everything that's posted in our books but NOT
--                          yet matched to a bank txn — i.e. checks in flight)
--   reconciled_diff_cents = (operator's typed bank_statement_balance) -
--                            (gl_balance + uncleared)
--
-- A reconciled bank account has diff = 0.
--
-- This RPC does NOT touch bank_statement_balance_cents — that comes from
-- the operator typing the value off the bank's statement. The RPC updates
-- gl_balance_cents + uncleared_txn_cents + reconciled_diff_cents in the
-- bank_recon_runs row.

CREATE OR REPLACE FUNCTION bank_recon_compute(
  p_bank_account_id uuid,
  p_period_id       uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ba       bank_accounts;
  v_period   record;
  v_run_id   uuid;
  v_gl_cents bigint;
  v_unc_cents bigint;
  v_stmt_cents bigint;
  v_diff     bigint;
BEGIN
  SELECT * INTO v_ba FROM bank_accounts WHERE id = p_bank_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_recon_compute: bank_account % not found', p_bank_account_id;
  END IF;

  SELECT id, entity_id, fiscal_year, period_number, starts_on, ends_on
    INTO v_period
    FROM gl_periods
   WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_recon_compute: period % not found', p_period_id;
  END IF;

  IF v_period.entity_id <> v_ba.entity_id THEN
    RAISE EXCEPTION 'bank_recon_compute: entity_id mismatch between bank_account and period';
  END IF;

  -- GL balance: sum of cash-book JE-line signed activity on the bank's GL
  -- account through period.ends_on. We express it as signed cents using the
  -- account's normal_balance:
  --   DEBIT-normal (asset/bank):    DR - CR
  --   CREDIT-normal (liability/CC): CR - DR
  SELECT COALESCE(SUM(
    CASE
      WHEN ga.normal_balance = 'DEBIT'  THEN ((jel.debit  - jel.credit) * 100)::bigint
      WHEN ga.normal_balance = 'CREDIT' THEN ((jel.credit - jel.debit ) * 100)::bigint
    END
  ), 0) INTO v_gl_cents
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga ON ga.id = jel.account_id
  WHERE je.status = 'posted'
    AND je.basis = 'CASH'
    AND je.entity_id = v_ba.entity_id
    AND jel.account_id = v_ba.gl_account_id
    AND je.posting_date <= v_period.ends_on;

  -- Uncleared bank-side movement: unmatched bank_transactions through ends_on.
  -- Sum already-signed amount_cents (positive=deposit, negative=withdrawal).
  -- These are bank lines that have NOT been matched to a GL JE yet — they
  -- represent in-flight money the bank knows about but our books don't.
  SELECT COALESCE(SUM(amount_cents), 0)::bigint
    INTO v_unc_cents
    FROM bank_transactions
   WHERE bank_account_id = p_bank_account_id
     AND status = 'unmatched'
     AND pending = false
     AND posted_date <= v_period.ends_on;

  -- Upsert the bank_recon_runs row. Keep the operator-supplied
  -- bank_statement_balance_cents intact if it's already been entered.
  INSERT INTO bank_recon_runs (
    entity_id, bank_account_id, period_id,
    gl_balance_cents, uncleared_txn_cents, status
  ) VALUES (
    v_ba.entity_id, p_bank_account_id, p_period_id,
    v_gl_cents, v_unc_cents, 'in_progress'
  )
  ON CONFLICT (bank_account_id, period_id) DO UPDATE
    SET gl_balance_cents    = EXCLUDED.gl_balance_cents,
        uncleared_txn_cents = EXCLUDED.uncleared_txn_cents,
        updated_at          = now()
  RETURNING id, bank_statement_balance_cents
    INTO v_run_id, v_stmt_cents;

  -- Recompute diff using whatever statement balance is set.
  IF v_stmt_cents IS NOT NULL THEN
    v_diff := v_gl_cents + v_unc_cents - v_stmt_cents;
    UPDATE bank_recon_runs
       SET reconciled_diff_cents = v_diff
     WHERE id = v_run_id;
  END IF;

  RETURN jsonb_build_object(
    'bank_recon_run_id',           v_run_id,
    'gl_balance_cents',            v_gl_cents,
    'uncleared_txn_cents',         v_unc_cents,
    'bank_statement_balance_cents', v_stmt_cents,
    'reconciled_diff_cents',       v_diff
  );
END;
$$;

COMMENT ON FUNCTION bank_recon_compute(uuid, uuid) IS 'P6-6 M8: compute gl_balance + uncleared for one (bank_account, period). Upserts bank_recon_runs. Returns the current diff if operator has typed a statement balance.';

-- ─── 2. Extend gl_period_close_preflight with bank_recon_complete check ────
-- We replace the existing function from P5-7 entirely, adding one final
-- RETURN QUERY block. Everything else from the P5-7 version is preserved.

CREATE OR REPLACE FUNCTION gl_period_close_preflight(
  p_entity_id uuid,
  p_period_id uuid
) RETURNS TABLE (
  check_name text,
  status     text,
  detail     text,
  blocking   boolean
) LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_period       record;
  v_accrual_diff numeric;
  v_cash_diff    numeric;
  v_draft_count  int;
  v_ar_unposted  int;
  v_ap_unposted  int;
  v_inv_adj      int;
  v_unapplied    int;
  v_neg_layers   int;
  v_active_banks int;
  v_reconciled_banks int;
BEGIN
  SELECT id, entity_id, status, starts_on, ends_on, fiscal_year, period_number
    INTO v_period
    FROM gl_periods
   WHERE id = p_period_id AND entity_id = p_entity_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'period_exists'::text, 'fail'::text,
      format('No gl_periods row found for id=%s entity_id=%s', p_period_id, p_entity_id), true;
    RETURN;
  END IF;

  IF v_period.status IN ('open','soft_close') THEN
    RETURN QUERY SELECT 'period_status_allows_close'::text, 'pass'::text,
      format('Period currently in status=%s', v_period.status), true;
  ELSIF v_period.status = 'closed' THEN
    RETURN QUERY SELECT 'period_status_allows_close'::text, 'pass'::text,
      'Period already closed (idempotent)', true;
  ELSE
    RETURN QUERY SELECT 'period_status_allows_close'::text, 'fail'::text,
      format('Period is %s — terminal status; cannot transition', v_period.status), true;
  END IF;

  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
    INTO v_accrual_diff
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE je.entity_id = p_entity_id AND je.period_id = p_period_id
     AND je.basis = 'ACCRUAL' AND je.status = 'posted';
  IF v_accrual_diff = 0 THEN
    RETURN QUERY SELECT 'accrual_trial_balanced'::text, 'pass'::text,
      'ACCRUAL book balances to $0.00 for this period', true;
  ELSE
    RETURN QUERY SELECT 'accrual_trial_balanced'::text, 'fail'::text,
      format('ACCRUAL book out of balance by $%s — investigate via Trial Balance', v_accrual_diff::text), true;
  END IF;

  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
    INTO v_cash_diff
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE je.entity_id = p_entity_id AND je.period_id = p_period_id
     AND je.basis = 'CASH' AND je.status = 'posted';
  IF v_cash_diff = 0 THEN
    RETURN QUERY SELECT 'cash_trial_balanced'::text, 'pass'::text,
      'CASH book balances to $0.00 for this period', true;
  ELSE
    RETURN QUERY SELECT 'cash_trial_balanced'::text, 'fail'::text,
      format('CASH book out of balance by $%s — investigate via Trial Balance', v_cash_diff::text), true;
  END IF;

  SELECT count(*) INTO v_draft_count
    FROM journal_entries
   WHERE entity_id = p_entity_id AND period_id = p_period_id
     AND status IN ('draft','pending_approval','unposted');
  IF v_draft_count = 0 THEN
    RETURN QUERY SELECT 'no_draft_jes'::text, 'pass'::text,
      'No unposted journal entries in this period', true;
  ELSE
    RETURN QUERY SELECT 'no_draft_jes'::text, 'fail'::text,
      format('%s journal_entries are still draft / pending_approval / unposted — finalize before close', v_draft_count), true;
  END IF;

  BEGIN
    SELECT count(*) INTO v_ar_unposted
      FROM ar_invoices
     WHERE entity_id = p_entity_id
       AND invoice_date BETWEEN v_period.starts_on AND v_period.ends_on
       AND gl_status IN ('draft','pending_approval','unposted');
  EXCEPTION WHEN undefined_table THEN v_ar_unposted := 0;
  END;
  IF v_ar_unposted = 0 THEN
    RETURN QUERY SELECT 'no_unposted_ar_invoices'::text, 'pass'::text,
      'No unposted AR invoices in this period', false;
  ELSE
    RETURN QUERY SELECT 'no_unposted_ar_invoices'::text, 'fail'::text,
      format('%s AR invoices are still draft/pending_approval — review before close', v_ar_unposted), false;
  END IF;

  BEGIN
    SELECT count(*) INTO v_ap_unposted
      FROM invoices
     WHERE entity_id = p_entity_id
       AND COALESCE(posting_date, invoice_date) BETWEEN v_period.starts_on AND v_period.ends_on
       AND gl_status IN ('unposted','draft','pending_approval');
  EXCEPTION WHEN undefined_table OR undefined_column THEN v_ap_unposted := 0;
  END;
  IF v_ap_unposted = 0 THEN
    RETURN QUERY SELECT 'no_unposted_ap_invoices'::text, 'pass'::text,
      'No unposted AP invoices in this period', false;
  ELSE
    RETURN QUERY SELECT 'no_unposted_ap_invoices'::text, 'fail'::text,
      format('%s AP invoices are still unposted/draft — review before close', v_ap_unposted), false;
  END IF;

  BEGIN
    SELECT count(*) INTO v_inv_adj
      FROM inventory_adjustments
     WHERE entity_id = p_entity_id
       AND created_at::date BETWEEN v_period.starts_on AND v_period.ends_on
       AND posted_at IS NULL;
  EXCEPTION WHEN undefined_table OR undefined_column THEN v_inv_adj := 0;
  END;
  IF v_inv_adj = 0 THEN
    RETURN QUERY SELECT 'no_unposted_inventory_adjustments'::text, 'pass'::text,
      'No unposted inventory adjustments touching this period', false;
  ELSE
    RETURN QUERY SELECT 'no_unposted_inventory_adjustments'::text, 'fail'::text,
      format('%s inventory adjustments are still draft — post or cancel before close', v_inv_adj), false;
  END IF;

  BEGIN
    SELECT count(*) INTO v_unapplied
      FROM v_ar_unapplied_receipts r
     WHERE r.entity_id = p_entity_id
       AND r.receipt_date BETWEEN v_period.starts_on AND v_period.ends_on;
  EXCEPTION WHEN undefined_table OR undefined_column THEN v_unapplied := 0;
  END;
  IF v_unapplied = 0 THEN
    RETURN QUERY SELECT 'no_unapplied_receipts'::text, 'pass'::text,
      'No AR receipts with unapplied balance in this period', false;
  ELSE
    RETURN QUERY SELECT 'no_unapplied_receipts'::text, 'fail'::text,
      format('%s AR receipts carry unapplied balance — review on-account amounts before close', v_unapplied), false;
  END IF;

  BEGIN
    SELECT count(*) INTO v_neg_layers
      FROM inventory_layers
     WHERE entity_id = p_entity_id AND remaining_qty < 0;
  EXCEPTION WHEN undefined_table OR undefined_column THEN v_neg_layers := 0;
  END;
  IF v_neg_layers = 0 THEN
    RETURN QUERY SELECT 'fifo_negative_layers'::text, 'pass'::text,
      'No inventory_layers with negative remaining_qty (no FIFO corruption)', true;
  ELSE
    RETURN QUERY SELECT 'fifo_negative_layers'::text, 'fail'::text,
      format('%s inventory_layers have remaining_qty<0 — FIFO corruption; investigate via Inventory Adjustments before close', v_neg_layers), true;
  END IF;

  -- NEW in P6-6: bank_recon_complete — every active bank_accounts row must
  -- have a bank_recon_runs row with status='reconciled' for this period.
  -- Warning-level (not blocking) — operator can override.
  BEGIN
    SELECT count(*) INTO v_active_banks
      FROM bank_accounts
     WHERE entity_id = p_entity_id AND is_active = true;
    SELECT count(*) INTO v_reconciled_banks
      FROM bank_recon_runs
     WHERE entity_id = p_entity_id
       AND period_id = p_period_id
       AND status = 'reconciled';
  EXCEPTION WHEN undefined_table THEN
    v_active_banks := 0;
    v_reconciled_banks := 0;
  END;

  IF v_active_banks = 0 THEN
    RETURN QUERY SELECT 'bank_recon_complete'::text, 'pass'::text,
      'No active bank accounts to reconcile (skipped)', false;
  ELSIF v_reconciled_banks >= v_active_banks THEN
    RETURN QUERY SELECT 'bank_recon_complete'::text, 'pass'::text,
      format('All %s active bank accounts reconciled for this period', v_active_banks), false;
  ELSE
    RETURN QUERY SELECT 'bank_recon_complete'::text, 'fail'::text,
      format('%s of %s bank accounts reconciled — finish bank reconciliation before close',
        v_reconciled_banks, v_active_banks), false;
  END IF;

  RETURN;
END;
$$;

COMMENT ON FUNCTION gl_period_close_preflight(uuid, uuid) IS
  'P5-7 + P6-6: 10 checks per period (9 from P5-7 + bank_recon_complete from P6-6). Returns one row per check with status (pass/fail), detail, and blocking flag.';

NOTIFY pgrst, 'reload schema';
