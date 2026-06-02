-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine T11-2 — Audit-context RPC family
--
-- Second chunk of cross-cutter T11 (Universal Audit Log / Row-Change Timeline).
--
-- T11-1 installed the trigger that reads six session vars
-- (app.actor_auth_id, app.actor_employee_id, app.actor_display_name,
--  app.audit_source, app.audit_reason, app.audit_correlation_id) and writes
-- one row into `row_changes` per INSERT/UPDATE/DELETE on 16 covered entities.
--
-- The connection-pool problem
-- ───────────────────────────
-- supabase-js + PostgREST pool connections, so SET LOCAL issued in one
-- request doesn't survive into the next .from()/.update() call. The trigger
-- only sees the vars set on the SAME connection that runs the INSERT/UPDATE.
--
-- T11-2's solution
-- ────────────────
-- A pair of layered helpers:
--
--   1. set_audit_context(p_actor_auth_id, p_actor_employee_id,
--                        p_actor_display_name, p_audit_source,
--                        p_audit_reason, p_audit_correlation_id)
--        Pure SECURITY DEFINER PL/pgSQL that issues set_config(...) for
--        each session var. Returns void. Callers who own their own
--        SECURITY DEFINER routine can invoke this inline at the top of
--        the routine to push the vars onto the current statement's
--        connection before doing their write.
--
--   2. Four convenience wrappers — void_ar_invoice_with_audit,
--        void_ap_invoice_with_audit, post_journal_entry_with_audit,
--        reverse_journal_entry_with_audit — that take the audit context
--        + operation params, call set_audit_context internally, then run
--        the actual write. Because the set_config + write happen in the
--        same statement, the trigger sees the vars and stamps the
--        row_changes row correctly.
--
-- D3 enforcement
-- ──────────────
-- The trigger raises a check_violation when reason is missing on
-- VOID/POST/REVERSE. The wrappers do NOT pre-validate (they let the
-- trigger be authoritative) but the handler-side `requireReason()` helper
-- in withAuditContext.js returns 400 first so the operator sees a clean
-- error instead of a SQL exception bubbling up.
--
-- Idempotency
-- ───────────
-- All five functions use CREATE OR REPLACE. No COMMENT-concat
-- (a hard-rule from prior CI failures on Tangerine — comment strings
-- must not concatenate to avoid quoting hazards). Each function has its
-- own COMMENT ON FUNCTION statement.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Pure session-var setter ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_audit_context(
  p_actor_auth_id        uuid,
  p_actor_employee_id    uuid,
  p_actor_display_name   text,
  p_audit_source         text,
  p_audit_reason         text,
  p_audit_correlation_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Each set_config(..., is_local=true) scopes the var to the current
  -- transaction. The wrapper RPCs below run set_audit_context + their
  -- write in the same statement, so the trigger sees the vars.
  PERFORM set_config('app.actor_auth_id',
                     coalesce(p_actor_auth_id::text, ''), true);
  PERFORM set_config('app.actor_employee_id',
                     coalesce(p_actor_employee_id::text, ''), true);
  PERFORM set_config('app.actor_display_name',
                     coalesce(p_actor_display_name, ''), true);
  PERFORM set_config('app.audit_source',
                     coalesce(p_audit_source, ''), true);
  PERFORM set_config('app.audit_reason',
                     coalesce(p_audit_reason, ''), true);
  PERFORM set_config('app.audit_correlation_id',
                     coalesce(p_audit_correlation_id, ''), true);
END;
$$;

COMMENT ON FUNCTION set_audit_context(uuid, uuid, text, text, text, text) IS 'T11-2 audit-context session-var setter. Pushes the six T11 audit vars (actor_auth_id, actor_employee_id, actor_display_name, audit_source, audit_reason, audit_correlation_id) onto the current connection via set_config(..., is_local=true). Called from each _with_audit wrapper RPC to plumb context to the audit_row_changes_trigger.';

-- ─── 2. void_ar_invoice_with_audit ──────────────────────────────────────
CREATE OR REPLACE FUNCTION void_ar_invoice_with_audit(
  invoice_id               uuid,
  audit_actor_auth_id      uuid,
  audit_actor_employee_id  uuid,
  audit_actor_display_name text,
  audit_source             text,
  audit_reason             text,
  audit_correlation_id     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv ar_invoices%ROWTYPE;
BEGIN
  -- Push audit vars onto this connection FIRST so the trigger sees them
  -- when the UPDATE fires.
  PERFORM set_audit_context(
    audit_actor_auth_id,
    audit_actor_employee_id,
    audit_actor_display_name,
    audit_source,
    audit_reason,
    audit_correlation_id
  );

  SELECT * INTO v_inv FROM ar_invoices WHERE id = invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ar_invoice not found: %', invoice_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_inv.gl_status = 'void' THEN
    RAISE EXCEPTION 'ar_invoice % is already void', invoice_id
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  -- Flip gl_status — the audit_row_changes_trigger picks this up as a
  -- VOID operation because gl_status transitioned to 'void'.
  UPDATE ar_invoices
     SET gl_status = 'void'
   WHERE id = invoice_id;

  RETURN jsonb_build_object(
    'invoice_id', invoice_id,
    'gl_status', 'void',
    'previous_gl_status', v_inv.gl_status
  );
END;
$$;

COMMENT ON FUNCTION void_ar_invoice_with_audit(uuid, uuid, uuid, text, text, text, text) IS 'T11-2 audit-aware AR invoice void. Sets the T11 audit session vars then flips ar_invoices.gl_status to void inside the same statement so the audit trigger stamps the row_changes ledger with the correct actor + reason. Returns {invoice_id, gl_status, previous_gl_status}.';

-- ─── 3. void_ap_invoice_with_audit ──────────────────────────────────────
CREATE OR REPLACE FUNCTION void_ap_invoice_with_audit(
  invoice_id               uuid,
  audit_actor_auth_id      uuid,
  audit_actor_employee_id  uuid,
  audit_actor_display_name text,
  audit_source             text,
  audit_reason             text,
  audit_correlation_id     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv invoices%ROWTYPE;
BEGIN
  PERFORM set_audit_context(
    audit_actor_auth_id,
    audit_actor_employee_id,
    audit_actor_display_name,
    audit_source,
    audit_reason,
    audit_correlation_id
  );

  SELECT * INTO v_inv FROM invoices WHERE id = invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ap_invoice not found: %', invoice_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_inv.gl_status = 'void' THEN
    RAISE EXCEPTION 'ap_invoice % is already void', invoice_id
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  UPDATE invoices
     SET gl_status = 'void'
   WHERE id = invoice_id;

  RETURN jsonb_build_object(
    'invoice_id', invoice_id,
    'gl_status', 'void',
    'previous_gl_status', v_inv.gl_status
  );
END;
$$;

COMMENT ON FUNCTION void_ap_invoice_with_audit(uuid, uuid, uuid, text, text, text, text) IS 'T11-2 audit-aware AP invoice void. Sets the T11 audit session vars then flips invoices.gl_status to void inside the same statement so the audit trigger stamps the row_changes ledger with the correct actor + reason. Returns {invoice_id, gl_status, previous_gl_status}.';

-- ─── 4. post_journal_entry_with_audit ───────────────────────────────────
-- Flips a draft JE to status='posted'. The trigger detects the
-- status transition and tags the row_changes entry as a POST operation.
-- The atomic posting + balance/period/control validation lives in the
-- existing gl_post_journal_entry RPC; this wrapper is for the
-- already-drafted-JE-needs-posting flow that the JE detail screen uses.
CREATE OR REPLACE FUNCTION post_journal_entry_with_audit(
  je_id                    uuid,
  audit_actor_auth_id      uuid,
  audit_actor_employee_id  uuid,
  audit_actor_display_name text,
  audit_source             text,
  audit_reason             text,
  audit_correlation_id     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_je journal_entries%ROWTYPE;
BEGIN
  PERFORM set_audit_context(
    audit_actor_auth_id,
    audit_actor_employee_id,
    audit_actor_display_name,
    audit_source,
    audit_reason,
    audit_correlation_id
  );

  SELECT * INTO v_je FROM journal_entries WHERE id = je_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal_entry not found: %', je_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_je.status = 'posted' THEN
    RAISE EXCEPTION 'journal_entry % is already posted', je_id
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF v_je.status NOT IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION 'journal_entry % cannot be posted from status %', je_id, v_je.status
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  -- Flip status — trigger picks up the 'posted' transition as POST.
  UPDATE journal_entries
     SET status    = 'posted',
         posted_at = COALESCE(posted_at, now())
   WHERE id = je_id;

  RETURN jsonb_build_object(
    'je_id', je_id,
    'status', 'posted',
    'previous_status', v_je.status
  );
END;
$$;

COMMENT ON FUNCTION post_journal_entry_with_audit(uuid, uuid, uuid, text, text, text, text) IS 'T11-2 audit-aware JE post. Sets the T11 audit session vars then flips journal_entries.status to posted inside the same statement so the audit trigger stamps the row_changes ledger with the correct actor + reason. Returns {je_id, status, previous_status}.';

-- ─── 5. reverse_journal_entry_with_audit ────────────────────────────────
-- Flips a posted JE to status='reversed'. The trigger detects the
-- transition and tags the row_changes entry as a REVERSE operation.
-- The line-negation + sibling-JE creation lives in
-- gl_reverse_journal_entry; this wrapper is for the status-flip half so
-- the existing handler can chain both calls in one connection.
CREATE OR REPLACE FUNCTION reverse_journal_entry_with_audit(
  je_id                    uuid,
  reversal_je_id           uuid,
  audit_actor_auth_id      uuid,
  audit_actor_employee_id  uuid,
  audit_actor_display_name text,
  audit_source             text,
  audit_reason             text,
  audit_correlation_id     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_je journal_entries%ROWTYPE;
BEGIN
  PERFORM set_audit_context(
    audit_actor_auth_id,
    audit_actor_employee_id,
    audit_actor_display_name,
    audit_source,
    audit_reason,
    audit_correlation_id
  );

  SELECT * INTO v_je FROM journal_entries WHERE id = je_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal_entry not found: %', je_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_je.status = 'reversed' THEN
    RAISE EXCEPTION 'journal_entry % is already reversed', je_id
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF v_je.status <> 'posted' THEN
    RAISE EXCEPTION 'journal_entry % cannot be reversed from status %', je_id, v_je.status
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  -- Flip status — trigger picks up the 'reversed' transition as REVERSE.
  -- Stamp the cross-link if a reversal JE id was provided (the JS-side
  -- reverse flow creates the new JE first, then calls this with both ids).
  UPDATE journal_entries
     SET status            = 'reversed',
         reversed_by_je_id = COALESCE(reversal_je_id, reversed_by_je_id)
   WHERE id = je_id;

  RETURN jsonb_build_object(
    'je_id', je_id,
    'status', 'reversed',
    'reversal_je_id', reversal_je_id,
    'previous_status', v_je.status
  );
END;
$$;

COMMENT ON FUNCTION reverse_journal_entry_with_audit(uuid, uuid, uuid, uuid, text, text, text, text) IS 'T11-2 audit-aware JE reverse. Sets the T11 audit session vars then flips journal_entries.status to reversed inside the same statement so the audit trigger stamps the row_changes ledger with the correct actor + reason. Returns {je_id, status, reversal_je_id, previous_status}.';

-- ─── 6. PostgREST schema cache reload ───────────────────────────────────
NOTIFY pgrst, 'reload schema';
