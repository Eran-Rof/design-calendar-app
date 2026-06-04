-- Add 'pending' to vendor_users.status so an INVITED-but-not-yet-accepted vendor
-- is distinct from one with live portal access.
--
-- vendor-invite.js creates the vendor_users row at INVITE time (the magic link
-- needs an auth user to attach to). That row previously defaulted to 'active',
-- so every invited vendor showed up under "Active vendor access" before they
-- ever accepted. New lifecycle: invite -> 'pending', accept-invite -> 'active'.
-- The Active-vendor-access panel hides 'pending'; those rows belong to the
-- Outstanding-invitations panel instead.

ALTER TABLE vendor_users DROP CONSTRAINT IF EXISTS vendor_users_status_check;
ALTER TABLE vendor_users
  ADD CONSTRAINT vendor_users_status_check
  CHECK (status IN ('pending', 'active', 'disabled', 'removed'));

-- Backfill: any currently-'active' row that has never logged in AND has no
-- accepted invite token is really just an unaccepted invite -> mark 'pending'.
UPDATE vendor_users vu
SET status = 'pending'
WHERE vu.status = 'active'
  AND vu.last_login IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM vendor_invite_tokens t
    WHERE t.auth_id = vu.auth_id AND t.used_at IS NOT NULL
  );
