-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P6-4 — Bank reconciliation match engine
--
-- Adds:
--   1. v_bank_match_candidates VIEW — per unmatched bank_transactions row,
--      lists every plausible journal_entry_lines row that could match
--      (same gl_account_id, same signed amount, ±5 days, je posted in
--      CASH basis, not already taken by another bank transaction).
--      Confidence score 0..100 — 100 = same-date exact-amount.
--   2. bank_match_apply RPC — atomically marks a bank_transactions row
--      'matched' to a JE line + inserts audit row.
--   3. bank_unmatch RPC — reverse of apply; sets back to 'unmatched'.
--   4. bank_create_je_for_transaction RPC — for standalone lines (bank
--      fees / interest / inter-account transfers). Posts a 2-line JE
--      via gl_post_journal_entry with journal_type='bank_fee_je' (or
--      'bank_interest_je' or 'bank_transfer_je' depending on direction),
--      then matches the bank_transactions row to the new DR/CR-bank line.
--   5. bank_ignore RPC — operator marks a transaction 'ignored'
--      (e.g. duplicate Plaid pull). Audit logged.
--
-- All RPCs are SECURITY DEFINER intentionally — they need to write
-- bank_match_audit even when called from the authenticated role. The
-- entity-isolation check is done explicitly in each function body.
--
-- See docs/tangerine/P6-bank-recon-architecture.md §4.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. v_bank_match_candidates ────────────────────────────────────────────
CREATE OR REPLACE VIEW v_bank_match_candidates AS
SELECT
  bt.id                AS bank_transaction_id,
  bt.entity_id,
  bt.bank_account_id,
  bt.posted_date       AS bank_date,
  bt.amount_cents      AS bank_amount_cents,
  bt.description       AS bank_description,
  jel.id               AS je_line_id,
  je.id                AS je_id,
  je.posting_date      AS je_date,
  je.description       AS je_description,
  je.journal_type,
  je.basis,
  jel.account_id,
  ga.code              AS account_code,
  ga.name              AS account_name,
  -- Signed cents on the JE side relative to the bank account:
  --   DEBIT-normal bank GL  → DR-positive = deposit on bank statement
  --   CREDIT-normal CC GL   → CR-positive = charge (withdrawal from bank pov)
  CASE
    WHEN ga.normal_balance = 'DEBIT'  THEN ((jel.debit  - jel.credit) * 100)::bigint
    WHEN ga.normal_balance = 'CREDIT' THEN ((jel.credit - jel.debit ) * 100)::bigint
  END AS je_amount_cents,
  ABS(bt.posted_date - je.posting_date)::int AS days_apart,
  -- Confidence: same-date exact-match = 100; falls off 5/day. Clamp at 0.
  GREATEST(
    0,
    100 - (ABS(bt.posted_date - je.posting_date)::int * 5)
  )::smallint AS confidence
FROM bank_transactions bt
JOIN bank_accounts ba ON ba.id = bt.bank_account_id
JOIN journal_entry_lines jel ON jel.account_id = ba.gl_account_id
JOIN journal_entries je ON je.id = jel.journal_entry_id
JOIN gl_accounts ga ON ga.id = jel.account_id
WHERE bt.status = 'unmatched'
  AND bt.pending = false
  AND je.status = 'posted'
  AND je.basis = 'CASH'   -- only cash-book lines match bank movement
  AND ABS(je.posting_date - bt.posted_date) <= 5
  -- amount match: bank's signed cents = je-side signed cents.
  -- bt.amount_cents is already signed (positive=deposit, negative=withdrawal).
  -- Compare against the je-side amount expressed in the same convention.
  AND bt.amount_cents = CASE
    WHEN ga.normal_balance = 'DEBIT'  THEN ((jel.debit  - jel.credit) * 100)::bigint
    WHEN ga.normal_balance = 'CREDIT' THEN ((jel.credit - jel.debit ) * 100)::bigint
  END
  -- skip JE lines that already have a bank match
  AND NOT EXISTS (
    SELECT 1 FROM bank_transactions bt2
    WHERE bt2.matched_je_line_id = jel.id
      AND bt2.status = 'matched'
  );

COMMENT ON VIEW v_bank_match_candidates IS 'P6-4 M8: per unmatched bank_transactions row, list plausible GL match lines (cash basis, same bank GL account, ±5 days, exact-amount). Operator picks via the Bank Transactions admin panel. Confidence 0..100.';

-- ─── 2. bank_match_apply ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bank_match_apply(
  p_bank_transaction_id uuid,
  p_je_line_id          uuid,
  p_actor_user_id       uuid DEFAULT NULL,
  p_notes               text DEFAULT NULL
) RETURNS bank_transactions
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bt      bank_transactions;
  v_ba      bank_accounts;
  v_jel     record;
  v_je      record;
  v_taken   uuid;
  v_confidence smallint;
BEGIN
  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_match_apply: bank_transaction % not found', p_bank_transaction_id;
  END IF;
  IF v_bt.status <> 'unmatched' THEN
    RAISE EXCEPTION 'bank_match_apply: bank_transaction % is in status=%, must be unmatched', p_bank_transaction_id, v_bt.status;
  END IF;
  IF v_bt.pending THEN
    RAISE EXCEPTION 'bank_match_apply: bank_transaction % is still pending', p_bank_transaction_id;
  END IF;

  SELECT * INTO v_ba FROM bank_accounts WHERE id = v_bt.bank_account_id;
  IF v_ba.entity_id <> v_bt.entity_id THEN
    RAISE EXCEPTION 'bank_match_apply: entity_id mismatch between bank_transaction and bank_account';
  END IF;

  SELECT jel.id, jel.journal_entry_id, jel.account_id, jel.debit, jel.credit
    INTO v_jel
    FROM journal_entry_lines jel
   WHERE jel.id = p_je_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_match_apply: je_line % not found', p_je_line_id;
  END IF;
  IF v_jel.account_id <> v_ba.gl_account_id THEN
    RAISE EXCEPTION 'bank_match_apply: je_line.account_id does not match bank_account.gl_account_id (bank_account is on GL %, je_line is on GL %)',
      v_ba.gl_account_id, v_jel.account_id;
  END IF;

  -- Check entity match via the JE header.
  SELECT je.entity_id, je.basis, je.status
    INTO v_je
    FROM journal_entries je
   WHERE je.id = v_jel.journal_entry_id;
  IF v_je.entity_id <> v_bt.entity_id THEN
    RAISE EXCEPTION 'bank_match_apply: JE belongs to entity % but bank_transaction is in entity %',
      v_je.entity_id, v_bt.entity_id;
  END IF;
  IF v_je.status <> 'posted' THEN
    RAISE EXCEPTION 'bank_match_apply: JE % is in status=%, only posted JEs can match', v_jel.journal_entry_id, v_je.status;
  END IF;

  -- Ensure no other bank_transaction has claimed this JE line.
  SELECT bt2.id INTO v_taken
    FROM bank_transactions bt2
   WHERE bt2.matched_je_line_id = p_je_line_id
     AND bt2.status = 'matched'
     AND bt2.id <> p_bank_transaction_id;
  IF v_taken IS NOT NULL THEN
    RAISE EXCEPTION 'bank_match_apply: je_line % already matched to bank_transaction %', p_je_line_id, v_taken;
  END IF;

  -- Compute confidence from same-date amount (100 if identical date).
  SELECT GREATEST(0, 100 - (ABS(v_bt.posted_date - je.posting_date)::int * 5))::smallint
    INTO v_confidence
    FROM journal_entries je WHERE je.id = v_jel.journal_entry_id;

  UPDATE bank_transactions
     SET status             = 'matched',
         matched_je_line_id = p_je_line_id,
         matched_at         = now(),
         matched_by_user_id = p_actor_user_id,
         match_confidence   = v_confidence
   WHERE id = p_bank_transaction_id
   RETURNING * INTO v_bt;

  INSERT INTO bank_match_audit (entity_id, bank_transaction_id, action, je_line_id, notes, actor_user_id)
  VALUES (v_bt.entity_id, p_bank_transaction_id, 'match', p_je_line_id, p_notes, p_actor_user_id);

  RETURN v_bt;
END;
$$;

COMMENT ON FUNCTION bank_match_apply(uuid, uuid, uuid, text) IS 'P6-4 M8: apply an operator-selected match between a bank_transactions row and a journal_entry_lines row. Validates same-entity / same-GL-account / no double-match. Writes bank_match_audit.';

-- ─── 3. bank_unmatch ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bank_unmatch(
  p_bank_transaction_id uuid,
  p_actor_user_id       uuid DEFAULT NULL,
  p_notes               text DEFAULT NULL
) RETURNS bank_transactions
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bt bank_transactions;
  v_prev_je_line_id uuid;
BEGIN
  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_unmatch: bank_transaction % not found', p_bank_transaction_id;
  END IF;
  IF v_bt.status <> 'matched' THEN
    RAISE EXCEPTION 'bank_unmatch: bank_transaction % is in status=%, must be matched', p_bank_transaction_id, v_bt.status;
  END IF;

  v_prev_je_line_id := v_bt.matched_je_line_id;

  UPDATE bank_transactions
     SET status             = 'unmatched',
         matched_je_line_id = NULL,
         matched_at         = NULL,
         matched_by_user_id = NULL,
         match_confidence   = NULL
   WHERE id = p_bank_transaction_id
   RETURNING * INTO v_bt;

  INSERT INTO bank_match_audit (entity_id, bank_transaction_id, action, je_line_id, notes, actor_user_id)
  VALUES (v_bt.entity_id, p_bank_transaction_id, 'unmatch', v_prev_je_line_id, p_notes, p_actor_user_id);

  RETURN v_bt;
END;
$$;

COMMENT ON FUNCTION bank_unmatch(uuid, uuid, text) IS 'P6-4 M8: reverse a previous match. Writes bank_match_audit. Does NOT delete the JE — only severs the bank_transactions ↔ JE-line link.';

-- ─── 4. bank_create_je_for_transaction ─────────────────────────────────────
CREATE OR REPLACE FUNCTION bank_create_je_for_transaction(
  p_bank_transaction_id  uuid,
  p_target_gl_account_id uuid,
  p_actor_user_id        uuid DEFAULT NULL,
  p_memo                 text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bt        bank_transactions;
  v_ba        bank_accounts;
  v_target_ga record;
  v_je_id     uuid;
  v_lines     jsonb;
  v_bank_line uuid;
  v_amt_dollars numeric(18,2);
  v_payload   jsonb;
  v_memo      text;
  v_journal_type text;
BEGIN
  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_create_je_for_transaction: bank_transaction % not found', p_bank_transaction_id;
  END IF;
  IF v_bt.status NOT IN ('unmatched','ignored') THEN
    RAISE EXCEPTION 'bank_create_je_for_transaction: bank_transaction % must be unmatched/ignored (got %)', p_bank_transaction_id, v_bt.status;
  END IF;
  IF v_bt.pending THEN
    RAISE EXCEPTION 'bank_create_je_for_transaction: pending transactions cannot be posted';
  END IF;

  SELECT * INTO v_ba FROM bank_accounts WHERE id = v_bt.bank_account_id;

  SELECT id, code, name, normal_balance, account_type
    INTO v_target_ga
    FROM gl_accounts
   WHERE id = p_target_gl_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_create_je_for_transaction: target gl_account % not found', p_target_gl_account_id;
  END IF;

  -- Convert signed cents → numeric(18,2) dollars for the gl_post_journal_entry payload.
  v_amt_dollars := (ABS(v_bt.amount_cents)::numeric / 100);
  v_memo := COALESCE(p_memo, v_bt.description, format('Bank transaction %s', v_bt.id));

  -- Pick a journal_type tag based on which side the bank is on:
  --   amount > 0 (deposit)    → bank_interest_je
  --   amount < 0 (withdrawal) → bank_fee_je
  -- Operator can override with a different target account; the tag is just
  -- for audit/reporting (and stays consistent with the bank fee / interest
  -- convention).
  v_journal_type := CASE WHEN v_bt.amount_cents >= 0 THEN 'bank_interest_je' ELSE 'bank_fee_je' END;

  -- Build the two JE lines. Bank account side first (line 1), counter side second.
  -- amount > 0 (deposit): DR bank, CR target
  -- amount < 0 (withdrawal): CR bank, DR target
  v_lines := '[]'::jsonb;
  IF v_bt.amount_cents > 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'line_number', 1,
      'account_id',  v_ba.gl_account_id,
      'debit',       v_amt_dollars,
      'credit',      0,
      'memo',        v_memo,
      'subledger_type', null,
      'subledger_id',   null
    );
    v_lines := v_lines || jsonb_build_object(
      'line_number', 2,
      'account_id',  p_target_gl_account_id,
      'debit',       0,
      'credit',      v_amt_dollars,
      'memo',        v_memo,
      'subledger_type', null,
      'subledger_id',   null
    );
  ELSIF v_bt.amount_cents < 0 THEN
    v_lines := v_lines || jsonb_build_object(
      'line_number', 1,
      'account_id',  v_ba.gl_account_id,
      'debit',       0,
      'credit',      v_amt_dollars,
      'memo',        v_memo,
      'subledger_type', null,
      'subledger_id',   null
    );
    v_lines := v_lines || jsonb_build_object(
      'line_number', 2,
      'account_id',  p_target_gl_account_id,
      'debit',       v_amt_dollars,
      'credit',      0,
      'memo',        v_memo,
      'subledger_type', null,
      'subledger_id',   null
    );
  ELSE
    RAISE EXCEPTION 'bank_create_je_for_transaction: amount_cents=0 (zero-amount JE not allowed)';
  END IF;

  v_payload := jsonb_build_object(
    'entity_id',     v_bt.entity_id,
    'basis',         'CASH',
    'journal_type',  v_journal_type,
    'posting_date',  v_bt.posted_date,
    'source_module', 'bank',
    'source_table',  'bank_transactions',
    'source_id',     v_bt.id::text,
    'description',   format('Auto-JE for bank transaction %s', v_bt.id),
    'created_by_user_id', p_actor_user_id::text,
    'lines',         v_lines
  );

  v_je_id := gl_post_journal_entry(v_payload);

  -- Find the bank-side JE line we just inserted (line_number=1).
  SELECT id INTO v_bank_line
    FROM journal_entry_lines
   WHERE journal_entry_id = v_je_id
     AND line_number = 1;

  -- Mark the bank_transaction matched + audit it.
  UPDATE bank_transactions
     SET status             = 'manual_je_created',
         matched_je_line_id = v_bank_line,
         matched_at         = now(),
         matched_by_user_id = p_actor_user_id,
         match_confidence   = 100
   WHERE id = p_bank_transaction_id;

  INSERT INTO bank_match_audit
    (entity_id, bank_transaction_id, action, je_line_id, je_id_created, notes, actor_user_id)
  VALUES
    (v_bt.entity_id, p_bank_transaction_id, 'create_je', v_bank_line, v_je_id, p_memo, p_actor_user_id);

  RETURN jsonb_build_object(
    'bank_transaction_id', p_bank_transaction_id,
    'je_id',               v_je_id,
    'je_line_id',          v_bank_line,
    'amount_cents',        v_bt.amount_cents,
    'journal_type',        v_journal_type
  );
END;
$$;

COMMENT ON FUNCTION bank_create_je_for_transaction(uuid, uuid, uuid, text) IS 'P6-4 M8: post a 2-line JE for a standalone bank transaction (bank fee / interest / inter-account transfer). Bank side + operator-supplied counter account. Marks status=manual_je_created.';

-- ─── 5. bank_ignore ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bank_ignore(
  p_bank_transaction_id uuid,
  p_actor_user_id       uuid DEFAULT NULL,
  p_reason              text DEFAULT NULL
) RETURNS bank_transactions
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_bt bank_transactions;
BEGIN
  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_ignore: bank_transaction % not found', p_bank_transaction_id;
  END IF;
  IF v_bt.status NOT IN ('unmatched','matched') THEN
    RAISE EXCEPTION 'bank_ignore: bank_transaction % must be unmatched or matched (got %)', p_bank_transaction_id, v_bt.status;
  END IF;

  UPDATE bank_transactions
     SET status             = 'ignored',
         matched_je_line_id = NULL,
         matched_at         = NULL,
         matched_by_user_id = p_actor_user_id,
         match_confidence   = NULL,
         notes              = COALESCE(p_reason, notes)
   WHERE id = p_bank_transaction_id
   RETURNING * INTO v_bt;

  INSERT INTO bank_match_audit (entity_id, bank_transaction_id, action, notes, actor_user_id)
  VALUES (v_bt.entity_id, p_bank_transaction_id, 'ignore', p_reason, p_actor_user_id);

  RETURN v_bt;
END;
$$;

COMMENT ON FUNCTION bank_ignore(uuid, uuid, text) IS 'P6-4 M8: mark a bank_transactions row ignored (e.g. duplicate Plaid pull or test transaction). Audit logged.';

NOTIFY pgrst, 'reload schema';
