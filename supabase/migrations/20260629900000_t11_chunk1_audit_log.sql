-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine T11-1 — Universal audit log schema + trigger across 16 entities
--
-- First chunk of cross-cutter T11 (Universal Audit Log / Row-Change Timeline —
-- see docs/tangerine/T11-audit-log-architecture.md).
--
-- One ledger (`row_changes`) writes by AFTER INSERT/UPDATE/DELETE trigger on
-- every covered entity. Trigger reads three session vars set by the API
-- handler via api/_lib/audit/context.js (T11-2):
--   app.actor_auth_id          uuid    auth.users.id of the actor
--   app.actor_employee_id      uuid    employees.id (resolved via v_audit_user_resolved)
--   app.actor_display_name     text    cached display name
--   app.audit_source           text    T10 source enum value
--   app.audit_reason           text    operator-typed reason (D3 required on VOID/POST/REVERSE)
--   app.audit_correlation_id   text    request_id / batch_id for tracing
--
-- v1 coverage — 16 tables confirmed via CURRENT-SCHEMA.md:
--   ar_invoices, ar_invoice_lines, invoices (AP), invoice_line_items (AP lines),
--   journal_entries, journal_entry_lines, gl_accounts, gl_periods,
--   customers, vendors, employees, cases, sales_reps, commission_payouts,
--   bank_accounts, virtual_cards (the "credit cards" table in the suite —
--   pre-P managed-card provisioning; payment_methods does not exist).
--
-- Operator-confirmed decisions (architecture §14):
--   D1: 16 v1 entities
--   D2: include line tables (ar_invoice_lines + journal_entry_lines + invoice_line_items)
--   D3: reason REQUIRED on void/post/reverse events (trigger raises on missing)
--
-- Fully idempotent (CREATE TABLE IF NOT EXISTS; CREATE INDEX IF NOT EXISTS;
-- CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS + CREATE TRIGGER;
-- DO $$ guards on policies + table-existence checks for trigger attach).
--
-- Detection of void/post operations:
--   - ar_invoices, invoices: gl_status transitioned to 'void' → VOID operation
--   - journal_entries: status transitioned to 'posted' → POST operation
--   - journal_entries: status transitioned to 'reversed' → REVERSE operation
--
-- Trigger errors NEVER block business writes (except the explicit D3 reason
-- check) — fall-through inserts a row tagged 'audit_trigger_failure' so the
-- failure is visible without breaking the parent INSERT/UPDATE/DELETE.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. row_changes master ledger ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS row_changes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid REFERENCES entities(id) ON DELETE SET NULL,
  source_table        text NOT NULL,
  source_id           text NOT NULL,
  operation           text NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE','VOID','POST','REVERSE')),
  before_jsonb        jsonb,
  after_jsonb         jsonb,
  changed_columns     text[],
  actor_auth_id       uuid,
  actor_employee_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  actor_display_name  text,
  source              text CHECK (source IS NULL OR source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system')),
  reason              text,
  correlation_id      text,
  user_agent          text,
  ip_address          inet,
  changed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS row_changes_source_idx
  ON row_changes (source_table, source_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS row_changes_entity_idx
  ON row_changes (entity_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS row_changes_actor_idx
  ON row_changes (actor_employee_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS row_changes_operation_idx
  ON row_changes (operation, changed_at DESC);

COMMENT ON TABLE row_changes IS 'T11 universal audit ledger. One row per INSERT/UPDATE/DELETE/VOID/POST/REVERSE on any covered entity. Append-only — no UPDATE/DELETE from application code.';

-- ─── 2. Universal trigger function ──────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_row_changes_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation text;
  v_entity_id uuid;
  v_source_id text;
  v_changed_cols text[];
  v_reason text;
  v_source text;
  v_correlation text;
  v_actor_auth uuid;
  v_actor_employee uuid;
  v_actor_name text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  -- Resolve operation + before/after jsonb
  IF (TG_OP = 'INSERT') THEN
    v_operation := 'INSERT';
    v_before := NULL;
    v_after := to_jsonb(NEW);
  ELSIF (TG_OP = 'UPDATE') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      -- Detect VOID / POST / REVERSE via column transitions on specific tables
      IF (TG_TABLE_NAME IN ('ar_invoices','invoices')) AND
         (to_jsonb(NEW)->>'gl_status' = 'void' AND coalesce(to_jsonb(OLD)->>'gl_status','') <> 'void') THEN
        v_operation := 'VOID';
      ELSIF (TG_TABLE_NAME = 'journal_entries') AND
            (to_jsonb(NEW)->>'status' = 'posted' AND coalesce(to_jsonb(OLD)->>'status','') <> 'posted') THEN
        v_operation := 'POST';
      ELSIF (TG_TABLE_NAME = 'journal_entries') AND
            (to_jsonb(NEW)->>'status' = 'reversed' AND coalesce(to_jsonb(OLD)->>'status','') <> 'reversed') THEN
        v_operation := 'REVERSE';
      ELSE
        v_operation := 'UPDATE';
      END IF;
      v_before := to_jsonb(OLD);
      v_after := to_jsonb(NEW);
      -- Compute changed columns (exclude noise columns)
      SELECT array_agg(key) INTO v_changed_cols
        FROM jsonb_each(v_after)
       WHERE v_after->key IS DISTINCT FROM v_before->key
         AND key NOT IN ('updated_at','synced_at','search_doc');
    ELSE
      -- No-op update; skip
      RETURN NEW;
    END IF;
  ELSIF (TG_OP = 'DELETE') THEN
    v_operation := 'DELETE';
    v_before := to_jsonb(OLD);
    v_after := NULL;
  END IF;

  -- Resolve entity_id (column may or may not be present on the row)
  IF v_after IS NOT NULL AND v_after ? 'entity_id' AND v_after->>'entity_id' IS NOT NULL THEN
    BEGIN
      v_entity_id := (v_after->>'entity_id')::uuid;
    EXCEPTION WHEN others THEN v_entity_id := NULL;
    END;
  ELSIF v_before IS NOT NULL AND v_before ? 'entity_id' AND v_before->>'entity_id' IS NOT NULL THEN
    BEGIN
      v_entity_id := (v_before->>'entity_id')::uuid;
    EXCEPTION WHEN others THEN v_entity_id := NULL;
    END;
  END IF;

  -- Resolve source_id (every covered table uses 'id' uuid PK)
  v_source_id := coalesce(v_after->>'id', v_before->>'id', 'unknown');

  -- Read session vars set by withAuditContext() in T11-2
  BEGIN
    v_actor_auth := nullif(current_setting('app.actor_auth_id', true), '')::uuid;
  EXCEPTION WHEN others THEN v_actor_auth := NULL;
  END;
  BEGIN
    v_actor_employee := nullif(current_setting('app.actor_employee_id', true), '')::uuid;
  EXCEPTION WHEN others THEN v_actor_employee := NULL;
  END;
  v_actor_name := nullif(current_setting('app.actor_display_name', true), '');
  v_source := nullif(current_setting('app.audit_source', true), '');
  v_reason := nullif(current_setting('app.audit_reason', true), '');
  v_correlation := nullif(current_setting('app.audit_correlation_id', true), '');

  -- D3: enforce reason REQUIRED on VOID/POST/REVERSE
  IF v_operation IN ('VOID','POST','REVERSE') AND (v_reason IS NULL OR v_reason = '') THEN
    RAISE EXCEPTION 'T11 audit: reason is required for % operations on %', v_operation, TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            HINT = 'Call withAuditContext({reason}) before the operation.';
  END IF;

  INSERT INTO row_changes (
    entity_id, source_table, source_id, operation,
    before_jsonb, after_jsonb, changed_columns,
    actor_auth_id, actor_employee_id, actor_display_name,
    source, reason, correlation_id
  ) VALUES (
    v_entity_id, TG_TABLE_NAME, v_source_id, v_operation,
    v_before, v_after, v_changed_cols,
    v_actor_auth, v_actor_employee, v_actor_name,
    v_source, v_reason, v_correlation
  );

  RETURN coalesce(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Re-raise the D3 reason-required check; never let any other trigger
  -- failure block business writes.
  IF SQLSTATE = '23514' AND SQLERRM LIKE 'T11 audit: reason is required%' THEN
    RAISE;
  END IF;
  -- Otherwise log the failure into row_changes itself and continue
  BEGIN
    INSERT INTO row_changes (source_table, source_id, operation, after_jsonb, reason)
      VALUES (TG_TABLE_NAME, coalesce(v_source_id, 'unknown'), 'INSERT',
              jsonb_build_object('audit_trigger_error', SQLERRM, 'sqlstate', SQLSTATE),
              'audit_trigger_failure');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- last-ditch swallow; never block the parent write
  END;
  RETURN coalesce(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION audit_row_changes_trigger() IS 'T11 universal audit trigger. Attached AFTER INSERT/UPDATE/DELETE on every covered entity. Reads session vars set by api/_lib/audit/context.js. Enforces D3 reason-required on VOID/POST/REVERSE; never blocks parent writes on any other failure.';

-- ─── 3. Attach trigger to 16 v1 entities ─────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'ar_invoices',
    'ar_invoice_lines',
    'invoices',
    'invoice_line_items',
    'journal_entries',
    'journal_entry_lines',
    'gl_accounts',
    'gl_periods',
    'customers',
    'vendors',
    'employees',
    'cases',
    'sales_reps',
    'commission_payouts',
    'bank_accounts',
    'virtual_cards'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS audit_row_changes ON %I', t);
      EXECUTE format(
        'CREATE TRIGGER audit_row_changes
           AFTER INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger()',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ─── 4. RLS on row_changes ───────────────────────────────────────────────
ALTER TABLE row_changes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'anon_all_row_changes' AND tablename = 'row_changes'
  ) THEN
    CREATE POLICY anon_all_row_changes
      ON row_changes FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'auth_internal_row_changes' AND tablename = 'row_changes'
  ) THEN
    CREATE POLICY auth_internal_row_changes
      ON row_changes FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 5. PostgREST schema cache reload ───────────────────────────────────
NOTIFY pgrst, 'reload schema';
