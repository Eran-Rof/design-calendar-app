-- ════════════════════════════════════════════════════════════════════════════
-- gl_post_journal_entry — plumb a T11 audit reason through to the POST trigger.
--
-- BUG (operator #9 / #11): posting a JE flips journal_entries.status draft→posted,
-- which fires the T11 audit trigger's POST branch. Per T11 D3 that branch RAISEs
-- 'reason is required for POST operations on journal_entries' unless the
-- app.audit_reason session var is set. The posting engine
-- (api/_lib/accounting/posting) never set it, so EVERY posting path through this
-- RPC (manufacturing build issue / service capitalize / complete, and AR/AP
-- sends) failed once the T11 trigger shipped (2026-06-29). Manufacturing surfaced
-- it first: "gl_post_journal_entry RPC failed: T11 audit: reason is required for
-- POST operations on journal_entries", and Complete → finished goods "did nothing"
-- because its postEvent threw before the build could be stamped completed.
--
-- FIX: accept an optional payload->>'audit_reason'. When present, set_config the
-- six audit session vars (reason + optional actor/source) with is_local=true
-- BEFORE the status→posted UPDATE. Because the set_config and the UPDATE run in
-- the SAME function call (== same statement == same pooled connection), the
-- trigger sees the reason — this is the identical "combine set_config + write in
-- one statement" pattern the _with_audit RPC family uses (T11-2). Callers that
-- omit audit_reason are unaffected (key absent → var left untouched); the trigger
-- only enforces reason on VOID/POST/REVERSE, and this is the POST path.
--
-- Replace-in-place: same signature (payload jsonb) → uuid, same behaviour for
-- every existing field. Only additions: read audit_* keys + set_config. Fully
-- idempotent via CREATE OR REPLACE.
--
-- NOTE: the body references journal_entry_lines.memo_line_2. That column was
-- meant to be added by 20260629C00000_je_memo_line_2.sql, but that file uses an
-- UPPERCASE version segment ("...C...") that supabase db-push never applied —
-- so on prod the column is MISSING and this function would fail (db-push HALT)
-- without the guard below. We add the column idempotently here so the function
-- is valid regardless of that migration's state. (Renumbered 20260937→20260938
-- to avoid the already-merged 20260937000000_mfg_bom_component_cost.sql.)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS memo_line_2 text;

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
  v_audit_reason   text          := NULLIF(payload->>'audit_reason', '');
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

  -- T11 D3: publish the audit reason (+ any actor/source the caller supplied)
  -- onto this connection so the audit_row_changes trigger's POST branch — which
  -- fires on the status→posted UPDATE below — sees a reason and does not RAISE.
  -- is_local=true scopes the vars to the current transaction. Absent reason =>
  -- no-op (the trigger tolerates null actor/source; it only requires reason).
  IF v_audit_reason IS NOT NULL THEN
    PERFORM set_config('app.audit_reason', v_audit_reason, true);
    PERFORM set_config('app.actor_auth_id',
                       COALESCE(NULLIF(payload->>'audit_actor_auth_id', ''), ''), true);
    PERFORM set_config('app.actor_employee_id',
                       COALESCE(NULLIF(payload->>'audit_actor_employee_id', ''), ''), true);
    PERFORM set_config('app.actor_display_name',
                       COALESCE(NULLIF(payload->>'audit_actor_display_name', ''), ''), true);
    PERFORM set_config('app.audit_source',
                       COALESCE(NULLIF(payload->>'audit_source', ''), 'system'), true);
    PERFORM set_config('app.audit_correlation_id',
                       COALESCE(NULLIF(payload->>'audit_correlation_id', ''), ''), true);
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

COMMENT ON FUNCTION gl_post_journal_entry(jsonb) IS 'Atomic posting RPC. Inserts header at draft, inserts lines (memo + memo_line_2), sets T11 audit session vars from payload.audit_reason (+ optional actor/source) so the audit trigger POST branch is satisfied, then flips to posted (fires all guard triggers). Whole call rolls back on any failure. Returns the new journal_entries.id.';

NOTIFY pgrst, 'reload schema';
