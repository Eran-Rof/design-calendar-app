-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P2 / Chunk 3 / Migration 1
-- M28 Notifications - schema for notification_events, notification_dispatches,
-- notification_preferences.
--
-- Per docs/tangerine/P2-cross-cutters-architecture.md §5.
--
-- Event/dispatch separation: notification_events is immutable (one row per
-- thing that happened). notification_dispatches is one row per recipient ×
-- channel for that event, and is mutable (status flows pending → sent → read
-- / failed). This decouples "what happened" from "did we deliver it" and lets
-- us replay failed deliveries without rederiving the event.
--
-- Channels at launch: in_app + email. Add push/sms/digest by ALTERing the
-- notification_dispatches.channel CHECK constraint.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- notification_events: immutable "what happened" rows
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  kind                 text NOT NULL,
  severity             text NOT NULL DEFAULT 'info',
  subject              text NOT NULL,
  body                 text NOT NULL,
  context_table        text,
  context_id           uuid,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT notification_events_severity_check
    CHECK (severity IN ('info','warn','error'))
);

CREATE INDEX IF NOT EXISTS idx_notification_events_entity_kind_created
  ON notification_events (entity_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_context
  ON notification_events (context_table, context_id)
  WHERE context_id IS NOT NULL;

COMMENT ON TABLE  notification_events IS 'Immutable event log. One row per "thing happened" - JE posted, AP invoice approved, period closed, approval requested, etc. Fan-out to dispatches happens via api/_lib/notifications/enqueue.';
COMMENT ON COLUMN notification_events.kind   IS 'Discriminator (je_posted, ap_invoice_approved, period_closed, approval_requested, ...). Open vocabulary - no enum.';
COMMENT ON COLUMN notification_events.severity IS 'info | warn | error. Drives UI styling + email subject prefix.';

-- ────────────────────────────────────────────────────────────────────────────
-- notification_dispatches: one row per (event × recipient × channel)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_dispatches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  recipient_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel              text NOT NULL,
  status               text NOT NULL DEFAULT 'pending',
  sent_at              timestamptz,
  read_at              timestamptz,
  error_message        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_dispatches_channel_check
    CHECK (channel IN ('in_app','email')),
  CONSTRAINT notification_dispatches_status_check
    CHECK (status IN ('pending','sent','read','failed'))
);

CREATE INDEX IF NOT EXISTS idx_notification_dispatches_pending_email
  ON notification_dispatches (channel, status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notification_dispatches_recipient_inbox
  ON notification_dispatches (recipient_user_id, channel, status)
  WHERE channel = 'in_app';
CREATE INDEX IF NOT EXISTS idx_notification_dispatches_event
  ON notification_dispatches (event_id);

-- One dispatch per (event, recipient, channel) - prevents accidental duplicate
-- fan-out if enqueue() runs twice with the same recipient list.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_dispatches_event_rcpt_ch
  ON notification_dispatches (event_id, recipient_user_id, channel);

COMMENT ON TABLE notification_dispatches IS 'One row per (event × recipient × channel). status flows pending → sent → read (in_app) / failed. The cron worker drains pending email rows and updates status.';

-- ────────────────────────────────────────────────────────────────────────────
-- notification_preferences: per-user per-(kind, channel) opt-in / opt-out
-- Default is opt-in (rows are only created when the user explicitly opts out
-- or the admin tunes their defaults).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  channel    text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, channel),
  CONSTRAINT notification_preferences_channel_check
    CHECK (channel IN ('in_app','email'))
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user
  ON notification_preferences (user_id);

COMMENT ON TABLE notification_preferences IS 'Per-user opt-in/out per (kind, channel). Missing row = opt-in (default). Insert with enabled=false to suppress.';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS - P1 template
-- - notification_events: entity-scoped via entity_users.auth_id
-- - notification_dispatches: recipient_user_id-scoped (user sees their own)
-- - notification_preferences: user_id-scoped (user manages their own)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE notification_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_dispatches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- Anon-key SPA path - full access
CREATE POLICY "anon_all_notification_events" ON notification_events
  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_notification_dispatches" ON notification_dispatches
  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_notification_preferences" ON notification_preferences
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- Authenticated internal users
CREATE POLICY "auth_internal_notification_events" ON notification_events
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- Dispatches: each user sees their own (no peeking at other people's inboxes).
CREATE POLICY "auth_own_notification_dispatches" ON notification_dispatches
  FOR ALL TO authenticated
  USING      (recipient_user_id = auth.uid())
  WITH CHECK (recipient_user_id = auth.uid());

-- Preferences: each user manages their own.
CREATE POLICY "auth_own_notification_preferences" ON notification_preferences
  FOR ALL TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ════════════════════════════════════════════════════════════════════════════
-- Touched-at on preferences (mutable)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION notification_preferences_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notification_preferences_touch_trg ON notification_preferences;
CREATE TRIGGER notification_preferences_touch_trg
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION notification_preferences_touch();
