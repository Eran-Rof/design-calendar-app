-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P5-1 — Period close mechanics + audit log
--
-- 1. Extend gl_periods.status CHECK to add 'closed_with_closing_jes' as a
--    terminal status (set only by the year-end close RPC in P5-6; one-way,
--    no reopen path).
-- 2. Create gl_period_status_log audit table (one row per status change).
-- 3. AFTER UPDATE trigger on gl_periods that inserts the audit row when
--    status changes.
-- 4. Standard P1 RLS template on the audit table.
--
-- See docs/tangerine/P5-close-core-financials-architecture.md §3.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Extend status CHECK ─────────────────────────────────────────────────
ALTER TABLE gl_periods DROP CONSTRAINT IF EXISTS gl_periods_status_check;
ALTER TABLE gl_periods ADD CONSTRAINT gl_periods_status_check
  CHECK (status IN ('open', 'soft_close', 'closed', 'closed_with_closing_jes'));

-- ─── 2. Audit table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_period_status_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  period_id     uuid NOT NULL REFERENCES gl_periods(id) ON DELETE CASCADE,
  from_status   text,
  to_status     text NOT NULL,
  reason        text,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gl_period_status_log_transition_check
    CHECK (from_status IS DISTINCT FROM to_status)
);

CREATE INDEX IF NOT EXISTS idx_gl_period_status_log_period
  ON gl_period_status_log (period_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_gl_period_status_log_entity
  ON gl_period_status_log (entity_id, performed_at DESC);

-- ─── 3. AFTER UPDATE trigger writes audit rows ──────────────────────────────
-- Trigger reads the actor + reason from session-local variables set by the
-- caller (the handler uses SELECT set_config(...) before the UPDATE). If
-- session vars are unset, both columns are stored NULL. This keeps the
-- audit log decoupled from the API surface — anyone who UPDATEs status via
-- a direct SQL session also gets logged, just without the actor info.

CREATE OR REPLACE FUNCTION gl_period_status_log_audit() RETURNS trigger AS $$
DECLARE
  v_actor uuid;
  v_reason text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_actor := NULLIF(current_setting('tangerine.period_close_actor', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;
  BEGIN
    v_reason := NULLIF(current_setting('tangerine.period_close_reason', true), '');
  EXCEPTION WHEN OTHERS THEN
    v_reason := NULL;
  END;

  INSERT INTO gl_period_status_log (
    entity_id, period_id, from_status, to_status, reason, actor_user_id
  ) VALUES (
    NEW.entity_id, NEW.id, OLD.status, NEW.status, v_reason, v_actor
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gl_period_status_log_audit_trg ON gl_periods;
CREATE TRIGGER gl_period_status_log_audit_trg
  AFTER UPDATE OF status ON gl_periods
  FOR EACH ROW
  EXECUTE FUNCTION gl_period_status_log_audit();

-- ─── 4. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE gl_period_status_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_all_gl_period_status_log" ON gl_period_status_log
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "auth_internal_gl_period_status_log" ON gl_period_status_log
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE gl_period_status_log IS 'P5-1 audit log: one row per gl_periods.status transition. Populated by AFTER UPDATE trigger that reads tangerine.period_close_actor + tangerine.period_close_reason session vars set by the API handlers.';

-- ─── 5. Atomic transition RPC ───────────────────────────────────────────────
-- The API handler runs approvalsAPI checks + notification enqueue in JS, then
-- calls THIS rpc to perform the actual status change. The rpc sets the
-- session-local vars FIRST so the AFTER UPDATE trigger captures actor +
-- reason, then UPDATEs gl_periods, then returns the row. Wrapping in one
-- PL/pgSQL function ensures the set_config + UPDATE share a transaction
-- (PostgREST opens a fresh pool connection per RPC call, so split JS calls
-- would not share session vars).

CREATE OR REPLACE FUNCTION gl_period_transition_status(
  p_id uuid,
  p_target_status text,
  p_actor_user_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS gl_periods
LANGUAGE plpgsql
AS $$
DECLARE
  v_row gl_periods;
BEGIN
  PERFORM set_config('tangerine.period_close_actor',
    COALESCE(p_actor_user_id::text, ''), true);
  PERFORM set_config('tangerine.period_close_reason',
    COALESCE(p_reason, ''), true);

  UPDATE gl_periods
     SET status = p_target_status,
         soft_closed_at    = CASE WHEN p_target_status = 'soft_close' AND status <> 'soft_close'
                                    THEN now() ELSE soft_closed_at END,
         closed_at         = CASE WHEN p_target_status = 'closed' AND status <> 'closed'
                                    THEN now() ELSE closed_at END,
         closed_by_user_id = CASE WHEN p_target_status = 'closed' AND status <> 'closed'
                                    THEN p_actor_user_id ELSE closed_by_user_id END
   WHERE id = p_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl_period_transition_status: period % not found', p_id;
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION gl_period_transition_status(uuid, text, uuid, text) IS 'P5-1 atomic transition. Sets session vars for the audit trigger, UPDATEs the row, returns the new row. JS handler runs approvals + notifications around it.';

NOTIFY pgrst, 'reload schema';
