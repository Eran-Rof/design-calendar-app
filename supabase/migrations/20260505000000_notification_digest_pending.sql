-- 20260505000000_notification_digest_pending.sql
--
-- CLAUDE.md spec: "if more than 3 notifications of the same type arrive
-- within 1 hour for the same recipient and entity, batch them into a
-- single digest email."
--
-- Previous implementation in vendor/pos/[id]/messages.js suppressed the
-- email past the 3-per-hour threshold but never sent the digest, so
-- recipients silently missed messages 4..N until they manually checked
-- the portal. This table is the queue that the new digest cron flushes.
--
-- Each row represents ONE notification that hit the threshold and is
-- waiting to be rolled up. The flush cron groups by (recipient_email,
-- event_type, hour_bucket), emails a single rollup, deletes the rows.

CREATE TABLE IF NOT EXISTS notification_digest_pending (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email text NOT NULL,
  event_type      text NOT NULL,
  -- Truncated-to-the-hour timestamp; rows in the same bucket roll up
  -- into one digest email. Computed at insert time so the lookup
  -- predicate is a simple equality match.
  hour_bucket     timestamptz NOT NULL,
  -- Free-form payload from the original notification — title / body /
  -- link / metadata. The flush cron renders these into the digest.
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Optional vendor / entity scoping so a digest never blends across
  -- tenants on a recipient who has access to multiple.
  vendor_id       uuid REFERENCES vendors(id) ON DELETE SET NULL,
  entity_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Index for the flush cron's primary scan: "find buckets older than the
-- current hour, grouped by (recipient, type, bucket)".
CREATE INDEX IF NOT EXISTS idx_notification_digest_pending_bucket
  ON notification_digest_pending (hour_bucket);
CREATE INDEX IF NOT EXISTS idx_notification_digest_pending_lookup
  ON notification_digest_pending (recipient_email, event_type, hour_bucket);

-- RLS: this is an internal queue. Service role only — no anon policy.
ALTER TABLE notification_digest_pending ENABLE ROW LEVEL SECURITY;
