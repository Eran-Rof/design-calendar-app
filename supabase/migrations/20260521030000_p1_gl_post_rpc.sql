-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 3 / Migration 10
-- gl_post_journal_entry: atomic posting RPC. Inserts journal_entries header
-- at status='draft', inserts journal_entry_lines, then flips header to
-- status='posted' which fires the guard trigger (mig 7). Optionally links a
-- sibling JE id via UPDATE in the same transaction.
--
-- Why an RPC: PostgREST does not expose explicit BEGIN/COMMIT. A stored
-- function gives us a single round-trip + automatic rollback on any error
-- inside the function body.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.3
-- ════════════════════════════════════════════════════════════════════════════

-- Payload shape:
-- {
--   "entity_id":     "uuid",
--   "basis":         "ACCRUAL" | "CASH",
--   "journal_type":  "manual" | "ap_invoice" | ... ,
--   "posting_date":  "YYYY-MM-DD",
--   "source_module": "ap" | "ar" | ...,
--   "source_table":  "invoices" | "payments" | ... | null,
--   "source_id":     "...uuid or text..." | null,
--   "description":   "free text",
--   "sibling_je_id": "uuid" | null,
--   "created_by_user_id": "uuid" | null,
--   "lines": [
--     { "line_number": 1, "account_id": "uuid", "debit": "12.00", "credit": "0",
--       "memo": null, "subledger_type": null, "subledger_id": null },
--     ...
--   ]
-- }

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

  -- Resolve the period for this posting_date / entity.
  v_period_id := gl_find_period(v_entity_id, v_posting_date);
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'gl_post_journal_entry: no gl_periods row covers % for entity %', v_posting_date, v_entity_id;
  END IF;

  -- Hard-lock check (also enforced in the posting trigger; check here too for a
  -- friendlier error before we start inserting lines).
  SELECT posting_locked_through INTO v_lock_through
    FROM entities WHERE id = v_entity_id;
  IF v_lock_through IS NOT NULL AND v_posting_date <= v_lock_through THEN
    RAISE EXCEPTION 'gl_post_journal_entry: posting_date % is on or before entity hard-lock %',
      v_posting_date, v_lock_through;
  END IF;

  -- Insert header at status='draft' (so the post-guard trigger does NOT fire yet).
  INSERT INTO journal_entries (
    entity_id, period_id, basis, journal_type, posting_date,
    source_module, source_table, source_id,
    description, status, sibling_je_id, created_by_user_id
  ) VALUES (
    v_entity_id, v_period_id, v_basis, v_journal_type, v_posting_date,
    v_source_module, v_source_table, v_source_id,
    v_description, 'draft', v_sibling_id, v_created_by
  ) RETURNING id INTO v_je_id;

  -- Insert lines.
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines)
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit,
      memo, subledger_type, subledger_id
    ) VALUES (
      v_je_id,
      (v_line->>'line_number')::smallint,
      (v_line->>'account_id')::uuid,
      COALESCE((v_line->>'debit')::numeric(18,2), 0),
      COALESCE((v_line->>'credit')::numeric(18,2), 0),
      v_line->>'memo',
      NULLIF(v_line->>'subledger_type', ''),
      NULLIF(v_line->>'subledger_id', '')::uuid
    );
  END LOOP;

  -- Flip to status='posted' — this fires journal_entry_post_guards() which
  -- validates balance, period status, account membership, control-subledger,
  -- postable, and posting_date bounds. On any guard violation, the whole
  -- transaction (header + lines + flip) rolls back atomically.
  UPDATE journal_entries SET status = 'posted' WHERE id = v_je_id;

  RETURN v_je_id;
END;
$$;

COMMENT ON FUNCTION gl_post_journal_entry(jsonb) IS 'Atomic posting RPC. Inserts header at draft, inserts lines, flips to posted (which fires all guard triggers). Whole call rolls back on any failure. Returns the new journal_entries.id.';

-- ════════════════════════════════════════════════════════════════════════════
-- gl_link_sibling_je: helper to link two journal_entries as sibling twins
-- (one ACCRUAL, one CASH for the same source event). Sets sibling_je_id on
-- both rows in a single transaction.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gl_link_sibling_je(je_a uuid, je_b uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  basis_a text;
  basis_b text;
BEGIN
  SELECT basis INTO basis_a FROM journal_entries WHERE id = je_a;
  SELECT basis INTO basis_b FROM journal_entries WHERE id = je_b;

  IF basis_a IS NULL OR basis_b IS NULL THEN
    RAISE EXCEPTION 'gl_link_sibling_je: one or both journal_entries not found';
  END IF;
  IF basis_a = basis_b THEN
    RAISE EXCEPTION 'gl_link_sibling_je: cannot link two JEs with the same basis (%)', basis_a;
  END IF;

  UPDATE journal_entries SET sibling_je_id = je_b WHERE id = je_a;
  UPDATE journal_entries SET sibling_je_id = je_a WHERE id = je_b;
END;
$$;

COMMENT ON FUNCTION gl_link_sibling_je(uuid, uuid) IS 'Bi-directionally link the ACCRUAL and CASH twin of a dual-basis posting event.';
