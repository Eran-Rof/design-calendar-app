-- Customer-contact notes + reminders (operator #12).
--
-- Each AP/Transportation/Chargeback contact (customers.contacts[] — keyed by a
-- stable `id` stamped per contact) can carry timestamped notes by a user. A note
-- may set a reminder (remind_at); when due, a daily/hourly cron fires an in-app
-- notification to the user who set it, deep-linking back to the customer contact.

CREATE TABLE IF NOT EXISTS customer_contact_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contact_id         text NOT NULL,                 -- stable id of the contact within customers.contacts
  body               text NOT NULL,
  created_by_user_id uuid,                           -- auth.users.id of the author (= reminder owner)
  created_by_name    text,                           -- display name snapshot
  created_at         timestamptz NOT NULL DEFAULT now(),
  remind_at          timestamptz,                    -- optional reminder time
  reminder_sent      boolean NOT NULL DEFAULT false  -- set true by the cron when notified
);

CREATE INDEX IF NOT EXISTS idx_ccn_customer_contact
  ON customer_contact_notes (customer_id, contact_id, created_at DESC);
-- The reminder cron scans for due, not-yet-sent reminders.
CREATE INDEX IF NOT EXISTS idx_ccn_due_reminders
  ON customer_contact_notes (remind_at)
  WHERE remind_at IS NOT NULL AND reminder_sent = false;

-- Service-role only (internal endpoints use the service key; RLS denies anon).
ALTER TABLE customer_contact_notes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE customer_contact_notes IS 'Timestamped notes (+ optional reminder) on a customer AP/Trans/CB contact. contact_id = the stable id on customers.contacts[].';
