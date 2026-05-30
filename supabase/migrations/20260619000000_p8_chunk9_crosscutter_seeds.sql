-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P8-9 — Cross-cutter wiring seeds (CRM close-out for P8)
--
-- Adds 2 AFTER triggers that emit notification_events rows into the
-- P2-3 queue:
--   a) crm_tasks.assignee_user_id set or changed → notify assignee
--   b) crm_opportunities.stage transition          → notify owner (when set)
--
-- The task-due-tomorrow daily cron lives in api/cron/crm-tasks-due-tomorrow.js
-- and emits notification_events from JS (not a trigger) since "due tomorrow"
-- is a time-based condition.
--
-- The actual delivery (email send) is handled by the existing P2-3
-- notification_dispatches drain cron.
--
-- All triggers use DROP TRIGGER IF EXISTS + CREATE TRIGGER. Fully
-- idempotent. No new tables. Mirrors the P7-10 pattern (Cases triggers).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Task-assignment notification trigger ──────────────────────────────
CREATE OR REPLACE FUNCTION crm_tasks_emit_notify_assigned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Fire when assignee_user_id is set (was null, now non-null) OR changed.
  IF NEW.assignee_user_id IS NOT NULL
     AND (OLD.assignee_user_id IS NULL OR OLD.assignee_user_id IS DISTINCT FROM NEW.assignee_user_id)
  THEN
    INSERT INTO notification_events (entity_id, kind, severity, subject, body, context_table, context_id, payload)
    VALUES (
      NEW.entity_id,
      'crm_task_assigned_to_user',
      CASE NEW.priority
        WHEN 'urgent' THEN 'critical'
        WHEN 'high'   THEN 'warning'
        ELSE 'info'
      END,
      format('CRM task assigned: %s', NEW.title),
      format('You have been assigned task "%s". Priority: %s. Due: %s. Open: https://tangerine.ringoffireclothing.com/?view=crm_tasks&id=%s',
             NEW.title,
             NEW.priority,
             COALESCE(NEW.due_date::text, '(no due date)'),
             NEW.id),
      'crm_tasks',
      NEW.id,
      jsonb_build_object(
        'task_id',          NEW.id,
        'title',            NEW.title,
        'assignee_user_id', NEW.assignee_user_id,
        'priority',         NEW.priority,
        'due_date',         NEW.due_date
      )
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_tasks_emit_notify_assigned_trg ON crm_tasks;
CREATE TRIGGER crm_tasks_emit_notify_assigned_trg
  AFTER INSERT OR UPDATE OF assignee_user_id ON crm_tasks
  FOR EACH ROW EXECUTE FUNCTION crm_tasks_emit_notify_assigned();

-- ─── 2. Opp stage-change notification trigger ─────────────────────────────
CREATE OR REPLACE FUNCTION crm_opps_emit_notify_stage_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Fire only on actual stage change AND when owner is set (no orphan emails).
  IF NEW.stage IS DISTINCT FROM OLD.stage
     AND NEW.owner_user_id IS NOT NULL
  THEN
    INSERT INTO notification_events (entity_id, kind, severity, subject, body, context_table, context_id, payload)
    VALUES (
      NEW.entity_id,
      'crm_opp_stage_changed',
      CASE NEW.stage
        WHEN 'won'  THEN 'info'
        WHEN 'lost' THEN 'warning'
        ELSE             'info'
      END,
      format('Opportunity stage: %s → %s — %s',
             OLD.stage, NEW.stage, NEW.opportunity_number),
      format('Opportunity %s — "%s" moved from %s to %s. Open: https://tangerine.ringoffireclothing.com/?view=crm_opportunities&id=%s',
             NEW.opportunity_number, NEW.title, OLD.stage, NEW.stage, NEW.id),
      'crm_opportunities',
      NEW.id,
      jsonb_build_object(
        'opp_id',             NEW.id,
        'opportunity_number', NEW.opportunity_number,
        'old_stage',          OLD.stage,
        'new_stage',          NEW.stage,
        'owner_user_id',      NEW.owner_user_id,
        'expected_cents',     NEW.expected_cents,
        'probability_pct',    NEW.probability_pct
      )
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_opps_emit_notify_stage_change_trg ON crm_opportunities;
CREATE TRIGGER crm_opps_emit_notify_stage_change_trg
  AFTER UPDATE OF stage ON crm_opportunities
  FOR EACH ROW EXECUTE FUNCTION crm_opps_emit_notify_stage_change();

NOTIFY pgrst, 'reload schema';
