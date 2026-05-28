-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P5-6 — Year-End Close
--
-- Adds:
--   1. entities.default_retained_earnings_account_id FK → gl_accounts
--      (one designated equity account per entity; the year-end close JE
--      lands here)
--   2. Auto-wire for ROF: if a gl_accounts row with code='3500' exists,
--      set this FK now. Otherwise NULL; operator picks via the Entities
--      admin panel.
--   3. gl_post_year_end_close(p_entity_id, p_fiscal_year, p_dry_run) RPC
--      — computes net income via the P5-3 income_statement aggregation,
--      builds the closing JE shape (DR revenue / CR expense / CR retained
--      earnings = net income), posts via gl_post_journal_entry with
--      journal_type='gl_year_end_close' which the P4-1 trigger recognizes
--      as a historical-bypass journal_type, then flips all 12 periods of
--      that FY to closed_with_closing_jes (terminal status from P5-1).
--
-- See docs/tangerine/P5-close-core-financials-architecture.md §8.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Entity FK ───────────────────────────────────────────────────────────
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS default_retained_earnings_account_id uuid
    REFERENCES gl_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_entities_default_retained_earnings
  ON entities (default_retained_earnings_account_id)
  WHERE default_retained_earnings_account_id IS NOT NULL;

COMMENT ON COLUMN entities.default_retained_earnings_account_id IS
  'P5-6: the single equity account where the year-end close JE rolls revenue/expense net income. Operator picks via the Entities admin panel; gl_post_year_end_close errors if NULL.';

-- ─── 2. Best-effort auto-wire for ROF ───────────────────────────────────────
DO $$
DECLARE
  v_entity_id  uuid;
  v_account_id uuid;
BEGIN
  SELECT id INTO v_entity_id FROM entities WHERE code = 'ROF';
  IF v_entity_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_account_id
    FROM gl_accounts
   WHERE entity_id = v_entity_id
     AND code = '3500'
     AND account_type = 'equity'
   LIMIT 1;
  IF v_account_id IS NULL THEN
    RAISE NOTICE 'P5-6: no gl_accounts row with code=3500 + type=equity for ROF — operator must set default_retained_earnings_account_id manually before running gl_post_year_end_close.';
    RETURN;
  END IF;

  UPDATE entities
     SET default_retained_earnings_account_id = v_account_id
   WHERE id = v_entity_id
     AND default_retained_earnings_account_id IS NULL;
  RAISE NOTICE 'P5-6: auto-wired entities.default_retained_earnings_account_id to gl_accounts.code=3500 for ROF.';
END $$;

-- ─── 3. The closing RPC ─────────────────────────────────────────────────────
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
  v_dry_lines       jsonb;
  v_basis_lines     jsonb := '[]'::jsonb;
  v_dry_basis       jsonb;
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

    -- Sum each revenue + expense account using v_income_statement.
    -- amount_cents already has revenue as positive and expense as positive
    -- (per arch §5.1 CASE block). The closing JE flips them:
    --   revenue (CR-positive normal) → DR by its CR-net (zero it out)
    --   expense (DR-positive normal) → CR by its DR-net (zero it out)
    FOR v_account IN
      SELECT
        account_id,
        account_type,
        code,
        name,
        SUM(amount_cents) AS amount_cents
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
          END AS amount_cents
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
      HAVING SUM(amount_cents) <> 0
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
  'P5-6: posts the closing JE for the FY (DR revenue / CR expense / CR retained earnings = net income) on both ACCRUAL and CASH books with sibling linkage, then flips all 12 periods to closed_with_closing_jes terminal status. One-shot per FY; re-running errors. dry_run=true returns the projected breakdown without inserts.';

NOTIFY pgrst, 'reload schema';
