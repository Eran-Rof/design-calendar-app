-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P7-5 — Commission accrue / reverse / settle RPCs (arch §4.3 + §4.5)
--
-- Three SECURITY DEFINER RPCs that wrap the P7-4 commission_accruals and
-- commission_payouts subledger with GL postings via gl_post_journal_entry.
--
--   1. commissions_accrue_for_invoice(ar_invoice_id, actor_user_id?)
--      → Called from AR invoice-post path. Looks up
--        customer_sales_rep_assignments active on the invoice_date, computes
--        commissionable cents per rep × share_pct via either the tier table
--        OR sales_reps.default_commission_pct, INSERTs commission_accruals
--        rows, and posts ONE JE per (invoice, rep):
--          DR 6210 Sales Commissions Expense
--          CR 2300 Commissions Payable
--        journal_type='commission_accrual_je'. Sets accrual_je_id on the
--        commission_accruals row. Idempotent: if any accrual already exists
--        for (ar_invoice_id, sales_rep_id), it is skipped (the unique
--        constraint would error anyway, but we pre-skip with NOTICE).
--        Returns {commissions:[{rep_id, commission_cents, je_id}], total_cents}.
--
--   2. commissions_reverse_for_invoice(ar_invoice_id, reason, actor_user_id?)
--      → Called from AR void / credit-memo apply path (D5 ✅: credit memo is
--        a sibling AR void via the existing P4 path, so both flow through
--        this one RPC). Flips matching status='accrued' rows to 'reversed',
--        posts mirror JE (DR 2300 / CR 6210) per rep, sets reversal_je_id +
--        reversed_at + reversal_reason. Idempotent: rows already reversed
--        are skipped. Returns {reversed_count, total_reversed_cents}.
--
--   3. commissions_settle_payout(sales_rep_id, period_id, payment_method,
--                                paid_at, bank_account_id, actor_user_id?)
--      → Operator-driven batch payout. Sums all status='accrued' rows for
--        this rep through period_id.ends_on, INSERTs a commission_payouts
--        row with the total, posts JE
--          DR 2300 Commissions Payable
--          CR <gl_account behind bank_account_id>
--        Flips matching accruals to status='paid' + sets payout_je_id +
--        paid_at. Returns {payout_id, total_cents, accrual_count, je_id}.
--
-- All three:
--   • SECURITY DEFINER with explicit entity_id isolation
--   • RAISE EXCEPTION on guards → handlers regex-map to HTTP 409
--   • Use gl_post_journal_entry (P1) which already validates period status,
--     entity hard-lock, etc.
--   • Dollars to gl_post_journal_entry (cents::numeric / 100)
--
-- See docs/tangerine/P7-revenue-ops-architecture.md §4.3, §4.5.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Resolve a rep's effective commission rate ─────────────────────────────
-- Tier-bracket resolution: highest tier where threshold_cents <= cumulative
-- invoiced cents (period-to-date) and effective_from <= invoice_date and
-- (effective_to IS NULL OR effective_to >= invoice_date). If no tier matches
-- (e.g. tier table is empty for this rep) → sales_reps.default_commission_pct.
CREATE OR REPLACE FUNCTION commissions_resolve_rate(
  p_sales_rep_id  uuid,
  p_invoice_date  date,
  p_cumulative_cents bigint
) RETURNS numeric(5,2)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_rate    numeric(5,2);
  v_default numeric(5,2);
BEGIN
  SELECT default_commission_pct INTO v_default
    FROM sales_reps WHERE id = p_sales_rep_id;

  -- Look up the highest applicable tier as of p_invoice_date for cumulative
  -- through p_cumulative_cents.
  SELECT rate_pct INTO v_rate
    FROM sales_rep_commission_tiers
   WHERE sales_rep_id = p_sales_rep_id
     AND threshold_cents <= p_cumulative_cents
     AND effective_from <= p_invoice_date
     AND (effective_to IS NULL OR effective_to >= p_invoice_date)
   ORDER BY threshold_cents DESC
   LIMIT 1;

  RETURN COALESCE(v_rate, v_default, 0);
END;
$$;

COMMENT ON FUNCTION commissions_resolve_rate(uuid, date, bigint) IS
  'P7-5 helper. Resolves a rep''s effective commission % at invoice-post. Tier table takes precedence; falls back to sales_reps.default_commission_pct when no tier matches.';

-- ════════════════════════════════════════════════════════════════════════════
-- 1. commissions_accrue_for_invoice
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION commissions_accrue_for_invoice(
  p_ar_invoice_id  uuid,
  p_actor_user_id  uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice              record;
  v_assignment           record;
  v_rep                  record;
  v_net_cents            bigint;
  v_rep_commissionable   bigint;
  v_rate                 numeric(5,2);
  v_commission_cents     bigint;
  v_cumulative_cents     bigint;
  v_year_start           date;
  v_je_id                uuid;
  v_je_payload           jsonb;
  v_accrual_id           uuid;
  v_acct_expense         uuid;
  v_acct_payable         uuid;
  v_commissions          jsonb := '[]'::jsonb;
  v_total_cents          bigint := 0;
  v_existing_accrual     uuid;
BEGIN
  IF p_ar_invoice_id IS NULL THEN
    RAISE EXCEPTION 'commissions_accrue_for_invoice: ar_invoice_id is required';
  END IF;

  -- Load invoice with entity isolation embedded.
  SELECT id, entity_id, customer_id, invoice_date, invoice_number,
         total_amount_cents, gl_status, invoice_kind
    INTO v_invoice
    FROM ar_invoices
   WHERE id = p_ar_invoice_id;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'commissions_accrue_for_invoice: ar_invoice % not found', p_ar_invoice_id;
  END IF;

  -- Only accrue for posted/sent customer invoices. Skip credit memos + historicals.
  IF v_invoice.invoice_kind <> 'customer_invoice' THEN
    RETURN jsonb_build_object(
      'commissions',     '[]'::jsonb,
      'total_cents',     0,
      'skipped_reason',  format('invoice_kind=%s (only customer_invoice accrues)', v_invoice.invoice_kind)
    );
  END IF;
  IF v_invoice.gl_status NOT IN ('sent','posted','paid','partial_paid') THEN
    RAISE EXCEPTION 'commissions_accrue_for_invoice: invoice % gl_status=% — must be sent/posted before accruing',
      v_invoice.invoice_number, v_invoice.gl_status;
  END IF;

  -- Resolve 6210 Sales Commissions Expense + 2300 Commissions Payable
  -- under this entity.
  SELECT id INTO v_acct_expense
    FROM gl_accounts WHERE entity_id = v_invoice.entity_id AND code = '6210' AND is_active LIMIT 1;
  SELECT id INTO v_acct_payable
    FROM gl_accounts WHERE entity_id = v_invoice.entity_id AND code = '2300' AND is_active LIMIT 1;
  IF v_acct_expense IS NULL THEN
    RAISE EXCEPTION 'commissions_accrue_for_invoice: gl_accounts code=6210 (Sales Commissions Expense) missing for entity %', v_invoice.entity_id;
  END IF;
  IF v_acct_payable IS NULL THEN
    RAISE EXCEPTION 'commissions_accrue_for_invoice: gl_accounts code=2300 (Commissions Payable) missing for entity %', v_invoice.entity_id;
  END IF;

  -- Net revenue commission base (D2): SUM(line_total_cents) - SUM(tax_amount_cents).
  -- line_total_cents is already post-discount per P4-1 conventions.
  SELECT COALESCE(SUM(line_total_cents), 0) - COALESCE(SUM(tax_amount_cents), 0)
    INTO v_net_cents
    FROM ar_invoice_lines
   WHERE ar_invoice_id = p_ar_invoice_id;

  IF v_net_cents <= 0 THEN
    RETURN jsonb_build_object(
      'commissions',    '[]'::jsonb,
      'total_cents',    0,
      'skipped_reason', 'net commissionable cents <= 0'
    );
  END IF;

  v_year_start := make_date(EXTRACT(year FROM v_invoice.invoice_date)::int, 1, 1);

  -- Iterate active assignments for this customer, valid on invoice_date.
  FOR v_assignment IN
    SELECT a.sales_rep_id, a.share_pct
      FROM customer_sales_rep_assignments a
     WHERE a.customer_id = v_invoice.customer_id
       AND a.effective_from <= v_invoice.invoice_date
       AND (a.effective_to IS NULL OR a.effective_to >= v_invoice.invoice_date)
  LOOP
    -- Verify rep belongs to this entity (entity isolation).
    SELECT id, entity_id INTO v_rep
      FROM sales_reps
     WHERE id = v_assignment.sales_rep_id AND is_active = true;
    IF v_rep.id IS NULL THEN
      CONTINUE;  -- inactive rep — silently skip per arch
    END IF;
    IF v_rep.entity_id <> v_invoice.entity_id THEN
      RAISE EXCEPTION 'commissions_accrue_for_invoice: rep % entity mismatch with invoice %',
        v_rep.id, p_ar_invoice_id;
    END IF;

    -- Idempotency: if accrual already exists for (invoice, rep), skip.
    SELECT id INTO v_existing_accrual
      FROM commission_accruals
     WHERE ar_invoice_id = p_ar_invoice_id AND sales_rep_id = v_assignment.sales_rep_id;
    IF v_existing_accrual IS NOT NULL THEN
      CONTINUE;
    END IF;

    -- Per-rep commissionable cents (post share_pct).
    v_rep_commissionable := ROUND(v_net_cents * v_assignment.share_pct / 100.0);

    -- Cumulative invoiced cents this calendar year for this rep, prior to this invoice.
    -- Used for tier-bracket resolution.
    SELECT COALESCE(SUM(ca.commissionable_cents), 0)
      INTO v_cumulative_cents
      FROM commission_accruals ca
      JOIN ar_invoices inv ON inv.id = ca.ar_invoice_id
     WHERE ca.sales_rep_id = v_assignment.sales_rep_id
       AND ca.status IN ('accrued','paid')
       AND inv.invoice_date >= v_year_start
       AND inv.invoice_date <= v_invoice.invoice_date;

    -- Resolve effective rate (tier or default).
    v_rate := commissions_resolve_rate(
      v_assignment.sales_rep_id,
      v_invoice.invoice_date,
      v_cumulative_cents + v_rep_commissionable
    );

    v_commission_cents := ROUND(v_rep_commissionable * v_rate / 100.0);
    IF v_commission_cents <= 0 THEN
      -- Still record a zero-cents accrual so we have an audit trail; but
      -- skip the JE to avoid an unbalanced posting.
      INSERT INTO commission_accruals (
        entity_id, ar_invoice_id, sales_rep_id, commissionable_cents,
        rate_pct, commission_cents, status, accrual_je_id
      ) VALUES (
        v_invoice.entity_id, p_ar_invoice_id, v_assignment.sales_rep_id,
        v_rep_commissionable, v_rate, 0, 'accrued', NULL
      ) RETURNING id INTO v_accrual_id;

      v_commissions := v_commissions || jsonb_build_object(
        'rep_id',           v_assignment.sales_rep_id,
        'commission_cents', 0,
        'je_id',            null
      );
      CONTINUE;
    END IF;

    -- Post the JE: DR 6210 / CR 2300 (dollars).
    v_je_payload := jsonb_build_object(
      'entity_id',     v_invoice.entity_id,
      'basis',         'ACCRUAL',
      'journal_type',  'commission_accrual_je',
      'posting_date',  v_invoice.invoice_date,
      'source_module', 'ar',
      'source_table',  'commission_accruals',
      'source_id',     p_ar_invoice_id::text,
      'description',   format('Commission accrual %s rep %s', v_invoice.invoice_number, v_assignment.sales_rep_id),
      'created_by_user_id', p_actor_user_id,
      'lines',         jsonb_build_array(
        jsonb_build_object(
          'line_number', 1,
          'account_id',  v_acct_expense,
          'debit',       (v_commission_cents::numeric / 100),
          'credit',      0,
          'memo',        format('Commission accrual: %s', v_invoice.invoice_number),
          'subledger_type', 'sales_rep',
          'subledger_id',   v_assignment.sales_rep_id::text
        ),
        jsonb_build_object(
          'line_number', 2,
          'account_id',  v_acct_payable,
          'debit',       0,
          'credit',      (v_commission_cents::numeric / 100),
          'memo',        format('Commission payable: %s', v_invoice.invoice_number),
          'subledger_type', 'sales_rep',
          'subledger_id',   v_assignment.sales_rep_id::text
        )
      )
    );

    v_je_id := gl_post_journal_entry(v_je_payload);

    -- INSERT the accrual row + link JE.
    INSERT INTO commission_accruals (
      entity_id, ar_invoice_id, sales_rep_id, commissionable_cents,
      rate_pct, commission_cents, status, accrual_je_id
    ) VALUES (
      v_invoice.entity_id, p_ar_invoice_id, v_assignment.sales_rep_id,
      v_rep_commissionable, v_rate, v_commission_cents, 'accrued', v_je_id
    ) RETURNING id INTO v_accrual_id;

    v_commissions := v_commissions || jsonb_build_object(
      'rep_id',           v_assignment.sales_rep_id,
      'commission_cents', v_commission_cents,
      'je_id',            v_je_id
    );
    v_total_cents := v_total_cents + v_commission_cents;
  END LOOP;

  RETURN jsonb_build_object(
    'commissions', v_commissions,
    'total_cents', v_total_cents
  );
END;
$$;

COMMENT ON FUNCTION commissions_accrue_for_invoice(uuid, uuid) IS
  'P7-5 §4.3: accrue commissions for an AR invoice at post-time. Inserts commission_accruals rows + posts one JE per (invoice, rep). Idempotent.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. commissions_reverse_for_invoice
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION commissions_reverse_for_invoice(
  p_ar_invoice_id uuid,
  p_reason        text,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice          record;
  v_accrual          record;
  v_je_id            uuid;
  v_je_payload       jsonb;
  v_acct_expense     uuid;
  v_acct_payable     uuid;
  v_reversed_count   int := 0;
  v_total_reversed   bigint := 0;
  v_posting_date     date;
BEGIN
  IF p_ar_invoice_id IS NULL THEN
    RAISE EXCEPTION 'commissions_reverse_for_invoice: ar_invoice_id is required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'commissions_reverse_for_invoice: reason is required';
  END IF;

  SELECT id, entity_id, invoice_date, invoice_number
    INTO v_invoice
    FROM ar_invoices
   WHERE id = p_ar_invoice_id;
  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'commissions_reverse_for_invoice: ar_invoice % not found', p_ar_invoice_id;
  END IF;

  SELECT id INTO v_acct_expense
    FROM gl_accounts WHERE entity_id = v_invoice.entity_id AND code = '6210' AND is_active LIMIT 1;
  SELECT id INTO v_acct_payable
    FROM gl_accounts WHERE entity_id = v_invoice.entity_id AND code = '2300' AND is_active LIMIT 1;
  IF v_acct_expense IS NULL OR v_acct_payable IS NULL THEN
    RAISE EXCEPTION 'commissions_reverse_for_invoice: gl_accounts 6210/2300 missing for entity %', v_invoice.entity_id;
  END IF;

  -- Use current_date for reversal posting (today). If period closed, posting RPC will error.
  v_posting_date := current_date;

  -- Iterate accrued (not yet reversed/paid) rows for this invoice.
  FOR v_accrual IN
    SELECT id, entity_id, sales_rep_id, commission_cents, accrual_je_id
      FROM commission_accruals
     WHERE ar_invoice_id = p_ar_invoice_id
       AND status = 'accrued'
  LOOP
    -- Entity isolation guard.
    IF v_accrual.entity_id <> v_invoice.entity_id THEN
      RAISE EXCEPTION 'commissions_reverse_for_invoice: accrual % entity mismatch', v_accrual.id;
    END IF;

    IF v_accrual.commission_cents > 0 THEN
      v_je_payload := jsonb_build_object(
        'entity_id',     v_invoice.entity_id,
        'basis',         'ACCRUAL',
        'journal_type',  'commission_reversal_je',
        'posting_date',  v_posting_date,
        'source_module', 'ar',
        'source_table',  'commission_accruals',
        'source_id',     v_accrual.id::text,
        'sibling_je_id', v_accrual.accrual_je_id,
        'description',   format('Commission reversal %s rep %s: %s', v_invoice.invoice_number, v_accrual.sales_rep_id, p_reason),
        'created_by_user_id', p_actor_user_id,
        'lines',         jsonb_build_array(
          jsonb_build_object(
            'line_number', 1,
            'account_id',  v_acct_payable,
            'debit',       (v_accrual.commission_cents::numeric / 100),
            'credit',      0,
            'memo',        format('Reverse commission: %s', v_invoice.invoice_number),
            'subledger_type', 'sales_rep',
            'subledger_id',   v_accrual.sales_rep_id::text
          ),
          jsonb_build_object(
            'line_number', 2,
            'account_id',  v_acct_expense,
            'debit',       0,
            'credit',      (v_accrual.commission_cents::numeric / 100),
            'memo',        format('Reverse commission expense: %s', v_invoice.invoice_number),
            'subledger_type', 'sales_rep',
            'subledger_id',   v_accrual.sales_rep_id::text
          )
        )
      );
      v_je_id := gl_post_journal_entry(v_je_payload);
    ELSE
      v_je_id := NULL;
    END IF;

    UPDATE commission_accruals
       SET status          = 'reversed',
           reversal_je_id  = v_je_id,
           reversed_at     = now(),
           reversal_reason = p_reason,
           updated_at      = now()
     WHERE id = v_accrual.id;

    v_reversed_count := v_reversed_count + 1;
    v_total_reversed := v_total_reversed + v_accrual.commission_cents;
  END LOOP;

  RETURN jsonb_build_object(
    'reversed_count',       v_reversed_count,
    'total_reversed_cents', v_total_reversed
  );
END;
$$;

COMMENT ON FUNCTION commissions_reverse_for_invoice(uuid, text, uuid) IS
  'P7-5 §4.5: reverse all accrued commissions for an AR invoice (called from AR void / credit memo). Idempotent: rows already reversed are silently skipped.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. commissions_settle_payout
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION commissions_settle_payout(
  p_sales_rep_id    uuid,
  p_period_id       uuid,
  p_payment_method  text,
  p_paid_at         date,
  p_bank_account_id uuid,
  p_actor_user_id   uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rep              record;
  v_period           record;
  v_bank             record;
  v_acct_payable     uuid;
  v_accrual_ids      uuid[];
  v_total_cents      bigint := 0;
  v_accrual_count    int    := 0;
  v_payout_id        uuid;
  v_je_id            uuid;
  v_je_payload       jsonb;
BEGIN
  IF p_sales_rep_id IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: sales_rep_id is required';
  END IF;
  IF p_period_id IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: period_id is required';
  END IF;
  IF p_payment_method NOT IN ('check','wire','ach','cash','other') THEN
    RAISE EXCEPTION 'commissions_settle_payout: payment_method must be check/wire/ach/cash/other (got %)', p_payment_method;
  END IF;
  IF p_paid_at IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: paid_at is required';
  END IF;
  IF p_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: bank_account_id is required';
  END IF;

  SELECT id, entity_id, display_name, is_active INTO v_rep
    FROM sales_reps WHERE id = p_sales_rep_id;
  IF v_rep.id IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: sales_rep % not found', p_sales_rep_id;
  END IF;

  SELECT id, entity_id, ends_on, fiscal_year, period_number INTO v_period
    FROM gl_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: gl_period % not found', p_period_id;
  END IF;

  IF v_rep.entity_id <> v_period.entity_id THEN
    RAISE EXCEPTION 'commissions_settle_payout: rep entity % does not match period entity %',
      v_rep.entity_id, v_period.entity_id;
  END IF;

  -- Idempotency: refuse a second payout for the same (rep, period).
  IF EXISTS (
    SELECT 1 FROM commission_payouts
     WHERE sales_rep_id = p_sales_rep_id AND period_id = p_period_id
  ) THEN
    RAISE EXCEPTION 'commissions_settle_payout: payout already exists for rep % period %',
      p_sales_rep_id, p_period_id;
  END IF;

  -- Resolve bank account → its underlying gl_account (cash account).
  SELECT id, entity_id, gl_account_id, is_active INTO v_bank
    FROM bank_accounts WHERE id = p_bank_account_id;
  IF v_bank.id IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: bank_account % not found', p_bank_account_id;
  END IF;
  IF v_bank.entity_id <> v_rep.entity_id THEN
    RAISE EXCEPTION 'commissions_settle_payout: bank_account entity % does not match rep entity %',
      v_bank.entity_id, v_rep.entity_id;
  END IF;
  IF v_bank.gl_account_id IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: bank_account % has no gl_account_id', p_bank_account_id;
  END IF;

  SELECT id INTO v_acct_payable
    FROM gl_accounts WHERE entity_id = v_rep.entity_id AND code = '2300' AND is_active LIMIT 1;
  IF v_acct_payable IS NULL THEN
    RAISE EXCEPTION 'commissions_settle_payout: gl_accounts code=2300 (Commissions Payable) missing for entity %', v_rep.entity_id;
  END IF;

  -- Sum accrued (status='accrued') rows for this rep where the underlying
  -- ar_invoices.invoice_date <= period.ends_on AND entity matches.
  SELECT
    COALESCE(SUM(ca.commission_cents), 0),
    COUNT(*)::int,
    array_agg(ca.id)
  INTO v_total_cents, v_accrual_count, v_accrual_ids
    FROM commission_accruals ca
    JOIN ar_invoices inv ON inv.id = ca.ar_invoice_id
   WHERE ca.sales_rep_id = p_sales_rep_id
     AND ca.entity_id    = v_rep.entity_id
     AND ca.status       = 'accrued'
     AND ca.commission_cents > 0
     AND inv.invoice_date <= v_period.ends_on;

  IF v_accrual_count = 0 THEN
    RAISE EXCEPTION 'commissions_settle_payout: no accrued rows for rep % through period ends_on=%',
      p_sales_rep_id, v_period.ends_on;
  END IF;

  -- Post the payout JE: DR 2300 Commissions Payable / CR bank cash.
  v_je_payload := jsonb_build_object(
    'entity_id',     v_rep.entity_id,
    'basis',         'ACCRUAL',
    'journal_type',  'commission_payout_je',
    'posting_date',  p_paid_at,
    'source_module', 'ar',
    'source_table',  'commission_payouts',
    'source_id',     p_sales_rep_id::text,
    'description',   format('Commission payout %s FY%s P%s (%s)',
                            v_rep.display_name, v_period.fiscal_year, v_period.period_number, p_payment_method),
    'created_by_user_id', p_actor_user_id,
    'lines',         jsonb_build_array(
      jsonb_build_object(
        'line_number', 1,
        'account_id',  v_acct_payable,
        'debit',       (v_total_cents::numeric / 100),
        'credit',      0,
        'memo',        format('Payout %s', v_rep.display_name),
        'subledger_type', 'sales_rep',
        'subledger_id',   p_sales_rep_id::text
      ),
      jsonb_build_object(
        'line_number', 2,
        'account_id',  v_bank.gl_account_id,
        'debit',       0,
        'credit',      (v_total_cents::numeric / 100),
        'memo',        format('Cash out %s', p_payment_method),
        'subledger_type', null,
        'subledger_id',   null
      )
    )
  );
  v_je_id := gl_post_journal_entry(v_je_payload);

  -- INSERT commission_payouts row.
  INSERT INTO commission_payouts (
    entity_id, sales_rep_id, period_id, total_cents,
    payment_method, paid_at, payout_je_id, created_by_user_id
  ) VALUES (
    v_rep.entity_id, p_sales_rep_id, p_period_id, v_total_cents,
    p_payment_method, p_paid_at, v_je_id, p_actor_user_id
  ) RETURNING id INTO v_payout_id;

  -- Flip matching accruals to 'paid' + link payout_je_id.
  UPDATE commission_accruals
     SET status        = 'paid',
         payout_je_id  = v_je_id,
         paid_at       = now(),
         updated_at    = now()
   WHERE id = ANY(v_accrual_ids);

  RETURN jsonb_build_object(
    'payout_id',     v_payout_id,
    'total_cents',   v_total_cents,
    'accrual_count', v_accrual_count,
    'je_id',         v_je_id
  );
END;
$$;

COMMENT ON FUNCTION commissions_settle_payout(uuid, uuid, text, date, uuid, uuid) IS
  'P7-5 §4.3: operator-driven batch payout. Sums accrued rows through period.ends_on, INSERTs commission_payouts, posts DR 2300 / CR bank JE, flips accruals to status=paid. Idempotent per (rep, period).';

-- ─── PostgREST schema cache reload ─────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
