-- Restore vendor_users rows incorrectly set to 'pending' by the 20260805
-- backfill. That backfill assumed last_login IS NULL = never logged in, but
-- last_login was never written by any code, so it was NULL for everyone —
-- including long-active vendors who pre-date the 72h invite-token flow
-- (migration 20260726000000). Those vendors have no vendor_invite_tokens row
-- but have clearly been active (they have submitted RFQ quotes, etc.).
--
-- Restore to 'active' if the vendor has an accepted invite token OR has
-- submitted RFQ quotes (direct proof they have logged into the portal).
UPDATE vendor_users vu
SET status = 'active'
WHERE vu.status = 'pending'
  AND (
    EXISTS (
      SELECT 1 FROM vendor_invite_tokens t
      WHERE t.auth_id = vu.auth_id AND t.used_at IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM rfq_quotes q WHERE q.vendor_id = vu.vendor_id
    )
  );
