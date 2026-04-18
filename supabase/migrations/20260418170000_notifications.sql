-- 20260418170000_notifications.sql
--
-- Phase 2.6 — notifications table (in-app + email delivery via Resend).
--
-- Recipients come in two flavours: external vendor users (via auth.uid())
-- and internal staff (via app_data['users'] — their id is a string, no
-- auth.users row). We track both with nullable recipient_auth_id +
-- recipient_internal_id; exactly one is set per row.
--
-- Email delivery is fire-and-forget: the trigger/app inserts a row with
-- email_status='pending', the Resend worker updates it to 'sent' or
-- 'failed'. If email isn't configured, rows stay pending indefinitely
-- (harmless — the in-app bell still works).

CREATE TABLE IF NOT EXISTS notifications (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  recipient_auth_id      uuid,                       -- vendor auth.users.id (set for external)
  recipient_internal_id  text,                       -- internal user id from app_data['users'].id (set for internal)
  recipient_email        text,                       -- resolved email for delivery

  event_type             text NOT NULL,              -- invoice.submitted, invoice.approved, shipment.received, match.discrepancy, ...
  title                  text NOT NULL,
  body                   text,
  link                   text,                       -- relative URL within the app (e.g. /vendor/invoices/<id>)
  metadata               jsonb,                      -- any event-specific structured payload

  read_at                timestamptz,
  email_status           text NOT NULL DEFAULT 'pending'
                           CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
  email_attempts         integer NOT NULL DEFAULT 0,
  email_sent_at          timestamptz,
  email_error            text,
  resend_message_id      text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- exactly one recipient type
  CONSTRAINT chk_notifications_recipient
    CHECK ((recipient_auth_id IS NOT NULL AND recipient_internal_id IS NULL)
        OR (recipient_auth_id IS NULL AND recipient_internal_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_auth_id
  ON notifications (recipient_auth_id) WHERE recipient_auth_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_internal_id
  ON notifications (recipient_internal_id) WHERE recipient_internal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (recipient_auth_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_email_pending
  ON notifications (created_at) WHERE email_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notifications_event_type
  ON notifications (event_type);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Internal anon: full access (server-side writes, internal dashboards read).
DROP POLICY IF EXISTS "anon_all_notifications" ON notifications;
CREATE POLICY "anon_all_notifications" ON notifications
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- Vendors: read and update (for mark-as-read) their own rows.
DROP POLICY IF EXISTS "vendor_own_notifications_select" ON notifications;
CREATE POLICY "vendor_own_notifications_select" ON notifications
  FOR SELECT TO authenticated
  USING (recipient_auth_id = auth.uid());

DROP POLICY IF EXISTS "vendor_own_notifications_update" ON notifications;
CREATE POLICY "vendor_own_notifications_update" ON notifications
  FOR UPDATE TO authenticated
  USING (recipient_auth_id = auth.uid())
  WITH CHECK (recipient_auth_id = auth.uid());
