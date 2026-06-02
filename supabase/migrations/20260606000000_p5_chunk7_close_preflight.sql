-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P5-7 — Period-close pre-flight RPC
--
-- gl_period_close_preflight(entity_id, period_id) returns one row per check
-- with: check_name, status ('pass' | 'fail'), detail, blocking (bool).
--
-- The Periods admin panel shows these as a green/yellow/red list; the close
-- handler (P5-1) consumes them and rejects with 409 if any blocking row
-- fails. Warnings can be overridden via ?ignore_warnings=true.
--
-- Per docs/tangerine/P5-close-core-financials-architecture.md §3.3.
-- ════════════════════════════════════════════════════════════════════════════

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
BEGIN
  -- Resolve the period (its date range and status).
  SELECT id, entity_id, status, starts_on, ends_on, fiscal_year, period_number
    INTO v_period
    FROM gl_periods
   WHERE id = p_period_id AND entity_id = p_entity_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'period_exists'::text,
      'fail'::text,
      format('No gl_periods row found for id=%s entity_id=%s', p_period_id, p_entity_id),
      true;
    RETURN;
  END IF;

  -- 1. period_status_allows_close — can only soft-close from open, or hard-close
  --    from soft_close. Same-status idempotent reads as pass.
  IF v_period.status IN ('open','soft_close') THEN
    RETURN QUERY SELECT
      'period_status_allows_close'::text,
      'pass'::text,
      format('Period currently in status=%s', v_period.status),
      true;
  ELSIF v_period.status = 'closed' THEN
    RETURN QUERY SELECT
      'period_status_allows_close'::text,
      'pass'::text,
      'Period already closed (idempotent)',
      true;
  ELSE  -- closed_with_closing_jes
    RETURN QUERY SELECT
      'period_status_allows_close'::text,
      'fail'::text,
      format('Period is %s — terminal status; cannot transition', v_period.status),
      true;
  END IF;

  -- 2. accrual_trial_balanced — sum(debit) - sum(credit) over posted JEs in
  --    this period_id, basis=ACCRUAL, should be 0.
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
    INTO v_accrual_diff
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE je.entity_id = p_entity_id
     AND je.period_id = p_period_id
     AND je.basis = 'ACCRUAL'
     AND je.status = 'posted';

  IF v_accrual_diff = 0 THEN
    RETURN QUERY SELECT
      'accrual_trial_balanced'::text,
      'pass'::text,
      'ACCRUAL book balances to $0.00 for this period',
      true;
  ELSE
    RETURN QUERY SELECT
      'accrual_trial_balanced'::text,
      'fail'::text,
      format('ACCRUAL book out of balance by $%s — investigate via Trial Balance', v_accrual_diff::text),
      true;
  END IF;

  -- 3. cash_trial_balanced — same for CASH basis.
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
    INTO v_cash_diff
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
   WHERE je.entity_id = p_entity_id
     AND je.period_id = p_period_id
     AND je.basis = 'CASH'
     AND je.status = 'posted';

  IF v_cash_diff = 0 THEN
    RETURN QUERY SELECT
      'cash_trial_balanced'::text,
      'pass'::text,
      'CASH book balances to $0.00 for this period',
      true;
  ELSE
    RETURN QUERY SELECT
      'cash_trial_balanced'::text,
      'fail'::text,
      format('CASH book out of balance by $%s — investigate via Trial Balance', v_cash_diff::text),
      true;
  END IF;

  -- 4. no_draft_jes — any journal_entries in this period with status
  --    draft / pending_approval / unposted blocks the close.
  SELECT count(*) INTO v_draft_count
    FROM journal_entries
   WHERE entity_id = p_entity_id
     AND period_id = p_period_id
     AND status IN ('draft','pending_approval','unposted');

  IF v_draft_count = 0 THEN
    RETURN QUERY SELECT
      'no_draft_jes'::text,
      'pass'::text,
      'No unposted journal entries in this period',
      true;
  ELSE
    RETURN QUERY SELECT
      'no_draft_jes'::text,
      'fail'::text,
      format('%s journal_entries are still draft / pending_approval / unposted — finalize before close', v_draft_count),
      true;
  END IF;

  -- 5. no_unposted_ar_invoices — warning only (operator decides). Counts
  --    ar_invoices whose invoice_date falls in this period and gl_status is
  --    pre-posted.
  BEGIN
    SELECT count(*) INTO v_ar_unposted
      FROM ar_invoices
     WHERE entity_id = p_entity_id
       AND invoice_date BETWEEN v_period.starts_on AND v_period.ends_on
       AND gl_status IN ('draft','pending_approval','unposted');
  EXCEPTION WHEN undefined_table THEN
    v_ar_unposted := 0;
  END;

  IF v_ar_unposted = 0 THEN
    RETURN QUERY SELECT
      'no_unposted_ar_invoices'::text,
      'pass'::text,
      'No unposted AR invoices in this period',
      false;
  ELSE
    RETURN QUERY SELECT
      'no_unposted_ar_invoices'::text,
      'fail'::text,
      format('%s AR invoices are still draft/pending_approval — review before close', v_ar_unposted),
      false;
  END IF;

  -- 6. no_unposted_ap_invoices — warning. Same idea for legacy invoices (AP).
  BEGIN
    SELECT count(*) INTO v_ap_unposted
      FROM invoices
     WHERE entity_id = p_entity_id
       AND COALESCE(posting_date, invoice_date) BETWEEN v_period.starts_on AND v_period.ends_on
       AND gl_status IN ('unposted','draft','pending_approval');
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_ap_unposted := 0;
  END;

  IF v_ap_unposted = 0 THEN
    RETURN QUERY SELECT
      'no_unposted_ap_invoices'::text,
      'pass'::text,
      'No unposted AP invoices in this period',
      false;
  ELSE
    RETURN QUERY SELECT
      'no_unposted_ap_invoices'::text,
      'fail'::text,
      format('%s AP invoices are still unposted/draft — review before close', v_ap_unposted),
      false;
  END IF;

  -- 7. no_unposted_inventory_adjustments — warning.
  BEGIN
    SELECT count(*) INTO v_inv_adj
      FROM inventory_adjustments
     WHERE entity_id = p_entity_id
       AND created_at::date BETWEEN v_period.starts_on AND v_period.ends_on
       AND posted_at IS NULL;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_inv_adj := 0;
  END;

  IF v_inv_adj = 0 THEN
    RETURN QUERY SELECT
      'no_unposted_inventory_adjustments'::text,
      'pass'::text,
      'No unposted inventory adjustments touching this period',
      false;
  ELSE
    RETURN QUERY SELECT
      'no_unposted_inventory_adjustments'::text,
      'fail'::text,
      format('%s inventory adjustments are still draft — post or cancel before close', v_inv_adj),
      false;
  END IF;

  -- 8. no_unapplied_receipts — warning. Receipts with unapplied balance dated
  --    inside the period; v_ar_unapplied_receipts is the P4-1 view.
  BEGIN
    SELECT count(*) INTO v_unapplied
      FROM v_ar_unapplied_receipts r
     WHERE r.entity_id = p_entity_id
       AND r.receipt_date BETWEEN v_period.starts_on AND v_period.ends_on;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_unapplied := 0;
  END;

  IF v_unapplied = 0 THEN
    RETURN QUERY SELECT
      'no_unapplied_receipts'::text,
      'pass'::text,
      'No AR receipts with unapplied balance in this period',
      false;
  ELSE
    RETURN QUERY SELECT
      'no_unapplied_receipts'::text,
      'fail'::text,
      format('%s AR receipts carry unapplied balance — review on-account amounts before close', v_unapplied),
      false;
  END IF;

  -- 9. fifo_negative_layers — blocking. Entity-wide; not period-scoped (FIFO
  --    layers don't carry a period concept). A negative remaining_qty is a
  --    corruption indicator.
  BEGIN
    SELECT count(*) INTO v_neg_layers
      FROM inventory_layers
     WHERE entity_id = p_entity_id
       AND remaining_qty < 0;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_neg_layers := 0;
  END;

  IF v_neg_layers = 0 THEN
    RETURN QUERY SELECT
      'fifo_negative_layers'::text,
      'pass'::text,
      'No inventory_layers with negative remaining_qty (no FIFO corruption)',
      true;
  ELSE
    RETURN QUERY SELECT
      'fifo_negative_layers'::text,
      'fail'::text,
      format('%s inventory_layers have remaining_qty<0 — FIFO corruption; investigate via Inventory Adjustments before close', v_neg_layers),
      true;
  END IF;

  RETURN;
END;
$$;

COMMENT ON FUNCTION gl_period_close_preflight(uuid, uuid) IS
  'P5-7: returns one row per period-close check with status (pass/fail), detail, and blocking flag. Consumed by the Periods panel "Run checks" button and the close handler (rejects 409 if any blocking row fails).';

NOTIFY pgrst, 'reload schema';
