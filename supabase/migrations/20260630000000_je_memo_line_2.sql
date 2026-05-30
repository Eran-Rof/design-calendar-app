-- ════════════════════════════════════════════════════════════════════════════
-- JE modal polish — Operator asks #16 + #17
--
-- Adds a second memo line to journal_entry_lines. The existing `memo` column
-- is kept as-is (acts as memo line 1) so that audit triggers, Xoro mirror
-- writes, and the JE Detail view continue to read it unchanged. The new
-- `memo_line_2` column is nullable; both lines render in the read-only JE
-- detail view when populated, and the manual JE modal stacks the two inputs
-- inside a single Memo column so the table stays narrow.
--
-- Idempotent — uses ADD COLUMN IF NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS memo_line_2 text;

COMMENT ON COLUMN journal_entry_lines.memo IS
  'Memo line 1. Original single-memo column kept under its original name so audit triggers and source-system mirrors do not need updating. Pairs with memo_line_2 — the manual JE UI mirrors line 1 into line 2 on first edit.';
COMMENT ON COLUMN journal_entry_lines.memo_line_2 IS
  'Memo line 2 — operator-typed second-line annotation. Auto-mirrored from memo (line 1) on first edit; once both fields have been touched the link breaks and either side is independently editable.';

-- ────────────────────────────────────────────────────────────────────────────
-- Extend the atomic posting RPC to persist memo_line_2 alongside memo.
-- Replace-in-place — same signature, same return type, additional field
-- pulled from the lines jsonb payload. Older callers that omit memo_line_2
-- continue to work (jsonb ->> returns NULL for missing keys, which the
-- column accepts).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_post_journal_entry(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_entity_id      uuid          := (payload->>'entity_id')::uuid;
  v_basis          text          := payload->>'basis';
  v_journal_type   text          := payload->>'journal_type';
  v_posting_date   date          := (payload->>'posting_date')::date;
  v_source_module  text          := payload->>'source_module';
  v_source_table   text          := NULLIF(payload->>'source_table', '');
  v_source_id      text          := NULLIF(payload->>'source_id', '');
  v_description    text          := payload->>'description';
  v_sibling_id     uuid          := NULLIF(payload->>'sibling_je_id', '')::uuid;
  v_created_by     uuid          := NULLIF(payload->>'created_by_user_id', '')::uuid;
  v_lines          jsonb         := payload->'lines';
  v_period_id      uuid;
  v_je_id          uuid;
  v_line           jsonb;
  v_lock_through   date;
BEGIN
  IF v_entity_id IS NULL THEN
    RAISE EXCEPTION 'gl_post_journal_entry: entity_id is required';
  END IF;
  IF v_basis NOT IN ('ACCRUAL','CASH') THEN
    RAISE EXCEPTION 'gl_post_journal_entry: basis must be ACCRUAL or CASH (got %)', v_basis;
  END IF;
  IF v_journal_type IS NULL OR v_journal_type = '' THEN
    RAISE EXCEPTION 'gl_post_journal_entry: journal_type is required';
  END IF;
  IF v_posting_date IS NULL THEN
    RAISE EXCEPTION 'gl_post_journal_entry: posting_date is required';
  END IF;
  IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'gl_post_journal_entry: at least one line is required';
  END IF;

  v_period_id := gl_find_period(v_entity_id, v_posting_date);
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'gl_post_journal_entry: no gl_periods row covers % for entity %', v_posting_date, v_entity_id;
  END IF;

  SELECT posting_locked_through INTO v_lock_through
    FROM entities WHERE id = v_entity_id;
  IF v_lock_through IS NOT NULL AND v_posting_date <= v_lock_through THEN
    RAISE EXCEPTION 'gl_post_journal_entry: posting_date % is on or before entity hard-lock %',
      v_posting_date, v_lock_through;
  END IF;

  INSERT INTO journal_entries (
    entity_id, period_id, basis, journal_type, posting_date,
    source_module, source_table, source_id,
    description, status, sibling_je_id, created_by_user_id
  ) VALUES (
    v_entity_id, v_period_id, v_basis, v_journal_type, v_posting_date,
    v_source_module, v_source_table, v_source_id,
    v_description, 'draft', v_sibling_id, v_created_by
  ) RETURNING id INTO v_je_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines)
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit,
      memo, memo_line_2, subledger_type, subledger_id
    ) VALUES (
      v_je_id,
      (v_line->>'line_number')::smallint,
      (v_line->>'account_id')::uuid,
      COALESCE((v_line->>'debit')::numeric(18,2), 0),
      COALESCE((v_line->>'credit')::numeric(18,2), 0),
      v_line->>'memo',
      v_line->>'memo_line_2',
      NULLIF(v_line->>'subledger_type', ''),
      NULLIF(v_line->>'subledger_id', '')::uuid
    );
  END LOOP;

  UPDATE journal_entries SET status = 'posted' WHERE id = v_je_id;

  RETURN v_je_id;
END;
$$;

COMMENT ON FUNCTION gl_post_journal_entry(jsonb) IS 'Atomic posting RPC. Inserts header at draft, inserts lines (memo + memo_line_2), flips to posted (which fires all guard triggers). Whole call rolls back on any failure. Returns the new journal_entries.id.';
