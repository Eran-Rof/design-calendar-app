-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P8-1 — CRM schema (M25, arch §3)
--
-- Three new tables (idempotent):
--   1. crm_opportunities   — pipeline records (new → qualified → proposal → won/lost)
--   2. crm_activities      — append-only audit log of touchpoints (notes, calls,
--                            emails, meetings, stage changes). Only `is_hidden`
--                            may be toggled post-insert.
--   3. crm_tasks           — todo items (open / in_progress / done / cancelled)
--
-- Plus three triggers:
--   - crm_opp_stage_changed_at_trg       BEFORE UPDATE — updates stage_changed_at
--   - crm_opp_stage_change_audit_trg     AFTER  UPDATE — inserts stage_change activity
--   - crm_activities_immutability_trg    BEFORE UPDATE — blocks all mutations except is_hidden
--   - crm_tasks_completion_audit_trg     BEFORE UPDATE — auto-completes + logs task_done activity
--   - touch-updated_at triggers on crm_opportunities + crm_tasks
--
-- RLS: standard P1 template + crm_activities = SELECT+INSERT only (no DELETE
--      policy → no role can delete activity rows; UPDATE further restricted by
--      trigger to is_hidden only).
--
-- Operator-confirmed decisions (PR #426 §2):
--   D1 5-stage pipeline (new/qualified/proposal/won/lost)
--   D2 append-only activity log
--   D3 auth.users assignee
--
-- See docs/tangerine/P8-data-crm-architecture.md §3.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. crm_opportunities ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_opportunities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id          uuid REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_number   text NOT NULL,                                       -- 'OPP-YYYY-NNNNN'
  title                text NOT NULL,
  stage                text NOT NULL DEFAULT 'new'
                       CHECK (stage IN ('new','qualified','proposal','won','lost')),
  stage_changed_at     timestamptz NOT NULL DEFAULT now(),
  expected_cents       bigint CHECK (expected_cents IS NULL OR expected_cents >= 0),
  probability_pct      smallint NOT NULL DEFAULT 50 CHECK (probability_pct BETWEEN 0 AND 100),
  expected_close_date  date,
  actual_close_date    date,
  loss_reason          text,
  owner_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  description          text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT crm_opp_number_per_entity_unique UNIQUE (entity_id, opportunity_number),
  CONSTRAINT crm_opp_title_nonempty CHECK (char_length(trim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_crm_opp_stage
  ON crm_opportunities (stage);
CREATE INDEX IF NOT EXISTS idx_crm_opp_customer
  ON crm_opportunities (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opp_owner
  ON crm_opportunities (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opp_stage_value
  ON crm_opportunities (stage, expected_cents DESC NULLS LAST);

COMMENT ON TABLE crm_opportunities IS 'P8 M25: sales-pipeline opportunity. 5-stage state machine. stage_changed_at auto-touched on stage transitions; AFTER-UPDATE trigger writes a crm_activities row of type stage_change.';
COMMENT ON COLUMN crm_opportunities.opportunity_number IS 'Per-entity human-readable identifier, format OPP-YYYY-NNNNN (handler-generated).';
COMMENT ON COLUMN crm_opportunities.expected_cents IS 'Expected revenue value in cents. Weighted pipeline = expected_cents * probability_pct / 100.';

-- ─── 2. crm_activities (append-only) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_activities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id          uuid REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id       uuid REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  case_id              uuid REFERENCES cases(id) ON DELETE SET NULL,         -- M47 link (P7-8)
  activity_type        text NOT NULL
                       CHECK (activity_type IN ('note','call','email_in','email_out','meeting','task_done','stage_change','system')),
  subject              text NOT NULL,
  body                 text,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  duration_minutes     int CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  external_email       text,                                                 -- Resend inbound sender
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,                   -- raw Resend payload / stage-change details
  is_hidden            boolean NOT NULL DEFAULT false,                       -- soft hide; row remains for audit
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT crm_act_subject_nonempty CHECK (char_length(trim(subject)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_crm_act_customer
  ON crm_activities (customer_id, occurred_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_act_opp
  ON crm_activities (opportunity_id, occurred_at DESC) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_act_type_date
  ON crm_activities (activity_type, occurred_at DESC);

COMMENT ON TABLE crm_activities IS 'P8 M25: append-only touchpoint log per customer / opportunity / case. Only is_hidden may be mutated post-insert (enforced by trigger). No role may DELETE (no policy granted).';
COMMENT ON COLUMN crm_activities.is_hidden IS 'Soft-hide flag — the only column that may be mutated after insert. Row persists for audit.';
COMMENT ON COLUMN crm_activities.payload IS 'Raw event payload — stage-change diff, Resend webhook body, task-done snapshot, etc.';

-- ─── 3. crm_tasks ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id          uuid REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id       uuid REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  title                text NOT NULL,
  description          text,
  due_date             date,
  status               text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_progress','done','cancelled')),
  priority             text NOT NULL DEFAULT 'normal'
                       CHECK (priority IN ('low','normal','high','urgent')),
  assignee_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at         timestamptz,
  completed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT crm_task_title_nonempty CHECK (char_length(trim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_assignee_open
  ON crm_tasks (assignee_user_id, due_date)
  WHERE status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS idx_crm_tasks_customer
  ON crm_tasks (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_tasks_opportunity
  ON crm_tasks (opportunity_id) WHERE opportunity_id IS NOT NULL;

COMMENT ON TABLE crm_tasks IS 'P8 M25: todo items for sales / CSR ops. Auto-completes (sets completed_at + completed_by_user_id) when status flips to done; logs a crm_activities row of type task_done.';

-- ─── 4. Triggers ───────────────────────────────────────────────────────────

-- 4a. BEFORE UPDATE on crm_opportunities — touch updated_at + stage_changed_at
CREATE OR REPLACE FUNCTION crm_opp_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_changed_at = now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_opp_touch_trg ON crm_opportunities;
CREATE TRIGGER crm_opp_touch_trg
  BEFORE UPDATE ON crm_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION crm_opp_touch();

-- 4b. AFTER UPDATE on crm_opportunities — log stage_change to crm_activities
CREATE OR REPLACE FUNCTION crm_opp_stage_change_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_changed_by uuid;
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    -- Best-effort session-var pickup; null is fine.
    BEGIN
      v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    EXCEPTION WHEN others THEN
      v_changed_by := NULL;
    END;

    INSERT INTO crm_activities (
      entity_id,
      customer_id,
      opportunity_id,
      activity_type,
      subject,
      body,
      occurred_at,
      payload,
      created_by_user_id
    ) VALUES (
      NEW.entity_id,
      NEW.customer_id,
      NEW.id,
      'stage_change',
      format('Stage: %s -> %s', OLD.stage, NEW.stage),
      NEW.loss_reason,
      now(),
      jsonb_build_object(
        'old_stage', OLD.stage,
        'new_stage', NEW.stage,
        'changed_by_user_id', v_changed_by,
        'opportunity_number', NEW.opportunity_number
      ),
      v_changed_by
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_opp_stage_change_audit_trg ON crm_opportunities;
CREATE TRIGGER crm_opp_stage_change_audit_trg
  AFTER UPDATE OF stage ON crm_opportunities
  FOR EACH ROW
  WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
  EXECUTE FUNCTION crm_opp_stage_change_audit();

-- 4c. BEFORE UPDATE on crm_activities — append-only immutability guard
CREATE OR REPLACE FUNCTION crm_activities_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id              IS DISTINCT FROM OLD.id
  OR NEW.entity_id       IS DISTINCT FROM OLD.entity_id
  OR NEW.customer_id     IS DISTINCT FROM OLD.customer_id
  OR NEW.opportunity_id  IS DISTINCT FROM OLD.opportunity_id
  OR NEW.case_id         IS DISTINCT FROM OLD.case_id
  OR NEW.activity_type   IS DISTINCT FROM OLD.activity_type
  OR NEW.subject         IS DISTINCT FROM OLD.subject
  OR NEW.body            IS DISTINCT FROM OLD.body
  OR NEW.occurred_at     IS DISTINCT FROM OLD.occurred_at
  OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
  OR NEW.external_email  IS DISTINCT FROM OLD.external_email
  OR NEW.payload         IS DISTINCT FROM OLD.payload
  OR NEW.created_at      IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  THEN
    RAISE EXCEPTION 'crm_activities is append-only; only is_hidden may be toggled';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_activities_immutability_trg ON crm_activities;
CREATE TRIGGER crm_activities_immutability_trg
  BEFORE UPDATE ON crm_activities
  FOR EACH ROW
  EXECUTE FUNCTION crm_activities_immutability();

-- 4d. BEFORE UPDATE on crm_tasks — touch + auto-complete + log task_done
CREATE OR REPLACE FUNCTION crm_tasks_completion_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_completer uuid;
BEGIN
  NEW.updated_at = now();

  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    BEGIN
      v_completer := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    EXCEPTION WHEN others THEN
      v_completer := NULL;
    END;

    NEW.completed_at         = COALESCE(NEW.completed_at, now());
    NEW.completed_by_user_id = COALESCE(NEW.completed_by_user_id, v_completer);

    INSERT INTO crm_activities (
      entity_id,
      customer_id,
      opportunity_id,
      activity_type,
      subject,
      body,
      occurred_at,
      payload,
      created_by_user_id
    ) VALUES (
      NEW.entity_id,
      NEW.customer_id,
      NEW.opportunity_id,
      'task_done',
      format('Task completed: %s', NEW.title),
      NEW.description,
      NEW.completed_at,
      jsonb_build_object(
        'task_id', NEW.id,
        'completed_by_user_id', NEW.completed_by_user_id,
        'priority', NEW.priority,
        'due_date', NEW.due_date
      ),
      NEW.completed_by_user_id
    );
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_tasks_completion_audit_trg ON crm_tasks;
CREATE TRIGGER crm_tasks_completion_audit_trg
  BEFORE UPDATE ON crm_tasks
  FOR EACH ROW
  EXECUTE FUNCTION crm_tasks_completion_audit();

-- ─── 5. RLS — standard P1 template ─────────────────────────────────────────
ALTER TABLE crm_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_tasks         ENABLE ROW LEVEL SECURITY;

-- crm_opportunities — anon all + auth_internal scoped to entity_users
DO $$ BEGIN
  CREATE POLICY "anon_all_crm_opportunities" ON crm_opportunities
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_crm_opportunities" ON crm_opportunities
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- crm_activities — SELECT + INSERT + UPDATE (is_hidden only, enforced by trigger).
-- NO DELETE policy → no role may delete activity rows.
DO $$ BEGIN
  CREATE POLICY "anon_select_crm_activities" ON crm_activities
    FOR SELECT TO anon USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_insert_crm_activities" ON crm_activities
    FOR INSERT TO anon WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_update_crm_activities_is_hidden" ON crm_activities
    FOR UPDATE TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_crm_activities_select" ON crm_activities
    FOR SELECT TO authenticated
    USING (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_crm_activities_insert" ON crm_activities
    FOR INSERT TO authenticated
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_crm_activities_update" ON crm_activities
    FOR UPDATE TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- crm_tasks — anon all + auth_internal scoped to entity_users
DO $$ BEGIN
  CREATE POLICY "anon_all_crm_tasks" ON crm_tasks
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_crm_tasks" ON crm_tasks
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 6. PostgREST schema cache reload ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
