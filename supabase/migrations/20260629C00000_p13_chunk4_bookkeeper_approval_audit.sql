-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P13-4 — Bookkeeper approval audit log + audit-context RPCs
--
-- Fourth chunk of P13 Procurement (see docs/tangerine/P13-procurement-
-- architecture.md §7 row P13-4). P13-3 (PR #548) shipped the bookkeeper
-- approval QUEUE UI + 9 procurement handlers including a STUB for
-- bookkeeper-approve at h499 returning 501. This chunk lands:
--
--   1. bookkeeper_approval_log — append-only per-invoice audit row capturing
--      who approved or rejected each receipt-rollup AP invoice, with the
--      operator-typed reason (D3 required) + the JE id (approve path only).
--
--   2. set_audit_context / clear_audit_context RPCs — the T11-2 session-var
--      bridge that lets the API handler stamp the trigger session vars from
--      the service-role admin client. T11-1 (PR #527) shipped the trigger
--      that READS app.actor_auth_id / app.audit_source / app.audit_reason
--      session vars; the RPCs land here so the bookkeeper-approve handler
--      (and any future mutating handler) can SET them via supabase.rpc().
--
-- Operator-confirmed decisions (P13 arch §6.9 + T11 §14):
--   D3 reason REQUIRED on void/post/reverse (T11) AND on bookkeeper
--      approve/reject (P13 §6.9 — operator typed the rationale into the
--      approval queue panel before clicking Approve/Reject).
--   D19 only is_receipt_rollup=true invoices route through this gate; the
--      legacy AP path keeps its existing 'pending_approval' workflow.
--
-- Fully idempotent (CREATE TABLE IF NOT EXISTS; CREATE INDEX IF NOT EXISTS;
-- CREATE OR REPLACE FUNCTION; DO $$ guards on policies).
-- No COMMENT-concat (the P12-0 hotfix lint catches `IS 'a' || 'b'`).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. bookkeeper_approval_log audit table ──────────────────────────────
CREATE TABLE IF NOT EXISTS bookkeeper_approval_log (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  invoice_id               uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  action                   text NOT NULL CHECK (action IN ('approved','rejected')),
  bookkeeper_employee_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  bookkeeper_auth_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason                   text NOT NULL,
  je_id                    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  approved_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bookkeeper_approval_log_invoice_idx
  ON bookkeeper_approval_log (invoice_id, approved_at DESC);
CREATE INDEX IF NOT EXISTS bookkeeper_approval_log_entity_idx
  ON bookkeeper_approval_log (entity_id, approved_at DESC);
CREATE INDEX IF NOT EXISTS bookkeeper_approval_log_action_idx
  ON bookkeeper_approval_log (action, approved_at DESC);

COMMENT ON TABLE bookkeeper_approval_log IS 'P13-4 D19 audit ledger. One row per bookkeeper approve/reject decision on a receipt-rollup AP invoice. Append-only — no UPDATE/DELETE from application code.';

-- ─── 2. RLS on bookkeeper_approval_log ───────────────────────────────────
ALTER TABLE bookkeeper_approval_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'anon_all_bookkeeper_approval_log'
       AND tablename = 'bookkeeper_approval_log'
  ) THEN
    CREATE POLICY anon_all_bookkeeper_approval_log
      ON bookkeeper_approval_log FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'auth_internal_bookkeeper_approval_log'
       AND tablename = 'bookkeeper_approval_log'
  ) THEN
    CREATE POLICY auth_internal_bookkeeper_approval_log
      ON bookkeeper_approval_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 3. T11-2 audit-context bridge RPCs ──────────────────────────────────
--
-- The T11-1 trigger (PR #527) reads six session vars set by the API
-- handler. Vercel serverless handlers use the service-role admin client
-- which can't issue raw `SET LOCAL ...` from outside a transaction. These
-- two tiny RPCs wrap set_config(...) so the JS handler can call
-- supabase.rpc('set_audit_context', { ... }) once at the top of the
-- request and let every mutating SQL statement that follows in the same
-- connection see the actor + reason + source.
--
-- The is_local=false form of set_config persists for the lifetime of the
-- session (= the PostgREST request scope); we explicitly clear at the
-- end of the handler to be safe under PgBouncer transaction pooling.

CREATE OR REPLACE FUNCTION set_audit_context(
  p_actor_auth_id       uuid    DEFAULT NULL,
  p_actor_employee_id   uuid    DEFAULT NULL,
  p_actor_display_name  text    DEFAULT NULL,
  p_audit_source        text    DEFAULT 'manual',
  p_audit_reason        text    DEFAULT NULL,
  p_audit_correlation_id text   DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.actor_auth_id',        coalesce(p_actor_auth_id::text, ''),       false);
  PERFORM set_config('app.actor_employee_id',    coalesce(p_actor_employee_id::text, ''),   false);
  PERFORM set_config('app.actor_display_name',   coalesce(p_actor_display_name, ''),        false);
  PERFORM set_config('app.audit_source',         coalesce(p_audit_source, 'manual'),        false);
  PERFORM set_config('app.audit_reason',         coalesce(p_audit_reason, ''),              false);
  PERFORM set_config('app.audit_correlation_id', coalesce(p_audit_correlation_id, ''),      false);
END;
$$;

COMMENT ON FUNCTION set_audit_context(uuid, uuid, text, text, text, text) IS 'T11-2 audit-context bridge. Called by api/_lib/audit/context.js withAuditContext() at the top of every mutating handler. Stamps six session vars consumed by the T11-1 audit_row_changes_trigger().';

CREATE OR REPLACE FUNCTION clear_audit_context()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.actor_auth_id',        '', false);
  PERFORM set_config('app.actor_employee_id',    '', false);
  PERFORM set_config('app.actor_display_name',   '', false);
  PERFORM set_config('app.audit_source',         '', false);
  PERFORM set_config('app.audit_reason',         '', false);
  PERFORM set_config('app.audit_correlation_id', '', false);
END;
$$;

COMMENT ON FUNCTION clear_audit_context() IS 'T11-2 audit-context bridge. Called by api/_lib/audit/context.js withAuditContext() in the finally{} block to clear session vars after the mutating handler completes (defense-in-depth under PgBouncer transaction pooling).';

-- ─── 4. PostgREST schema cache reload ───────────────────────────────────
NOTIFY pgrst, 'reload schema';
