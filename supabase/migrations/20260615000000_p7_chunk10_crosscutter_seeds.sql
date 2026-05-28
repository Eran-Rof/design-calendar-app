-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P7-10 — Cross-cutter wiring seeds (close-out for P7)
--
-- 1. Seeds 1 approval rule (commission_rate_change > 2pp) into the existing
--    P2-1 approval_rules table.
-- 2. Adds 3 AFTER triggers that emit notification_events rows into the
--    P2-3 queue when:
--       a) cases.assignee_user_id is set or changed → notify assignee
--       b) cases.status transitions to 'resolved'    → notify reporter
--       c) commission_accruals INSERT                → notify rep email
--
-- The actual delivery (email send) is handled by the existing
-- notification_dispatches drain cron from P2-3.
--
-- All inserts use NOT EXISTS guards; triggers use DROP TRIGGER IF EXISTS +
-- CREATE TRIGGER. Fully idempotent. No new tables.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Approval rule: commission rate change > 2pp ───────────────────────
DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping P7-10 approval seed';
    RETURN;
  END IF;

  INSERT INTO approval_rules (entity_id, kind, name, match, steps, is_active)
  SELECT
    v_rof,
    'sales_reps_rate_change',
    'Commission rate change > 2pp',
    jsonb_build_object(
      'description',         'Requires CEO approval when default_commission_pct delta exceeds 2 percentage points.',
      'field',               'default_commission_pct',
      'delta_threshold_pp',  2
    ),
    jsonb_build_array(
      jsonb_build_object('approver_role', 'ceo', 'order', 1)
    ),
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM approval_rules
     WHERE entity_id = v_rof
       AND kind = 'sales_reps_rate_change'
       AND name = 'Commission rate change > 2pp'
  );
END $$;

-- ─── 2a. Case-assignment notification trigger ─────────────────────────────
CREATE OR REPLACE FUNCTION cases_emit_notify_assigned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Fire when assignee_user_id is set (was null, now non-null) OR changed.
  IF NEW.assignee_user_id IS NOT NULL
     AND (OLD.assignee_user_id IS NULL OR OLD.assignee_user_id IS DISTINCT FROM NEW.assignee_user_id)
  THEN
    INSERT INTO notification_events (entity_id, kind, severity, subject, body, context_table, context_id, payload)
    VALUES (
      NEW.entity_id,
      'case_assigned_to_user',
      CASE NEW.severity
        WHEN 'urgent' THEN 'critical'
        WHEN 'high'   THEN 'warning'
        ELSE 'info'
      END,
      format('Case assigned: [%s] %s', NEW.case_number, NEW.subject),
      format('You have been assigned case %s — "%s". Severity: %s. Open: https://tangerine.ringoffireclothing.com/?view=cases&id=%s',
             NEW.case_number, NEW.subject, NEW.severity, NEW.id),
      'cases',
      NEW.id,
      jsonb_build_object(
        'case_number',      NEW.case_number,
        'case_id',          NEW.id,
        'assignee_user_id', NEW.assignee_user_id,
        'severity',         NEW.severity
      )
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cases_emit_notify_assigned_trg ON cases;
CREATE TRIGGER cases_emit_notify_assigned_trg
  AFTER INSERT OR UPDATE OF assignee_user_id ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_emit_notify_assigned();

-- ─── 2b. Case-resolved notification trigger ───────────────────────────────
CREATE OR REPLACE FUNCTION cases_emit_notify_resolved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'resolved' AND (OLD.status IS DISTINCT FROM 'resolved') THEN
    INSERT INTO notification_events (entity_id, kind, severity, subject, body, context_table, context_id, payload)
    VALUES (
      NEW.entity_id,
      'case_status_resolved',
      'info',
      format('Case resolved: [%s] %s', NEW.case_number, NEW.subject),
      format('Case %s — "%s" has been marked resolved.', NEW.case_number, NEW.subject),
      'cases',
      NEW.id,
      jsonb_build_object(
        'case_number',         NEW.case_number,
        'case_id',             NEW.id,
        'created_by_user_id',  NEW.created_by_user_id
      )
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cases_emit_notify_resolved_trg ON cases;
CREATE TRIGGER cases_emit_notify_resolved_trg
  AFTER UPDATE OF status ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_emit_notify_resolved();

-- ─── 2c. Commission-accrued notification trigger ──────────────────────────
CREATE OR REPLACE FUNCTION commission_accruals_emit_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rep_email text;
  v_invoice_number text;
BEGIN
  SELECT email INTO v_rep_email FROM sales_reps WHERE id = NEW.sales_rep_id;
  IF v_rep_email IS NULL OR v_rep_email = '' THEN
    RETURN NEW; -- no email, no notification
  END IF;
  SELECT invoice_number INTO v_invoice_number FROM ar_invoices WHERE id = NEW.ar_invoice_id;

  INSERT INTO notification_events (entity_id, kind, severity, subject, body, context_table, context_id, payload)
  VALUES (
    NEW.entity_id,
    'commission_accrued_email',
    'info',
    format('Commission accrued: $%s', to_char((NEW.commission_cents::numeric / 100), 'FM999,999,990.00')),
    format('A commission of $%s has accrued on invoice %s at rate %s%%. Settles at next payout.',
           to_char((NEW.commission_cents::numeric / 100), 'FM999,999,990.00'),
           v_invoice_number,
           to_char(NEW.rate_pct, 'FM990.00')),
    'commission_accruals',
    NEW.id,
    jsonb_build_object(
      'commission_cents',  NEW.commission_cents,
      'ar_invoice_id',     NEW.ar_invoice_id,
      'ar_invoice_number', v_invoice_number,
      'sales_rep_id',      NEW.sales_rep_id,
      'sales_rep_email',   v_rep_email,
      'rate_pct',          NEW.rate_pct
    )
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS commission_accruals_emit_notify_trg ON commission_accruals;
CREATE TRIGGER commission_accruals_emit_notify_trg
  AFTER INSERT ON commission_accruals
  FOR EACH ROW EXECUTE FUNCTION commission_accruals_emit_notify();

NOTIFY pgrst, 'reload schema';
