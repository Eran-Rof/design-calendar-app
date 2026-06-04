-- Per-employee notification subscriptions.
--
-- Lets an operator route an internal notification category (onboarding,
-- invoice, dispute, …) to a specific person by ticking a box on their
-- employee record, instead of (or in addition to) the INTERNAL_*_EMAILS
-- env vars. api/_lib/internal-recipients.js#resolveInternalRecipients unions
-- the env recipients with active employees subscribed to the category.
--
-- The array holds category keys from internal-recipients.js CATEGORY_VARS:
--   invoice, shipment, dispute, message, compliance, contract, onboarding,
--   procurement, finance, edi, vendor_alert.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS notification_subscriptions text[] NOT NULL DEFAULT '{}';

-- GIN index supports the `notification_subscriptions @> ARRAY[category]`
-- containment query the resolver runs on every notification send.
CREATE INDEX IF NOT EXISTS idx_employees_notification_subscriptions
  ON employees USING GIN (notification_subscriptions);

COMMENT ON COLUMN employees.notification_subscriptions IS
  'Internal notification categories this employee receives email alerts for (keys from internal-recipients.js CATEGORY_VARS). Resolved by resolveInternalRecipients alongside INTERNAL_*_EMAILS env vars.';
