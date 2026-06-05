-- RFQ messages: per-vendor (private 1:1) threads.
--
-- Until now rfq_messages had NO vendor_id, so a thread was shared by the WHOLE
-- RFQ — every invited vendor saw every other vendor's messages (a leak). We add
-- vendor_id so each (rfq, vendor) pair is its own private conversation: the
-- vendor only ever sees their own thread, and the internal buyer picks which
-- vendor's thread to read/reply to.
--
-- Column is left NULLABLE so legacy/unscoped rows are tolerated (the vendor
-- handler treats vendor_id IS NULL as visible to the inviting vendor too).

ALTER TABLE rfq_messages
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES vendors(id) ON DELETE CASCADE;

-- Backfill (best-effort; data volume is ~0 today).
-- 1) Vendor-sent rows: derive vendor_id from the sender's vendor_users mapping.
UPDATE rfq_messages m
   SET vendor_id = vu.vendor_id
  FROM vendor_users vu
 WHERE m.vendor_id IS NULL
   AND m.sender_type = 'vendor'
   AND m.sender_auth_id IS NOT NULL
   AND vu.auth_id = m.sender_auth_id;

-- 2) Internal-sent rows: only safe to attribute when the RFQ has EXACTLY ONE
--    invited vendor — then the internal message unambiguously belongs to that
--    vendor's thread. Multi-vendor RFQs are left NULL (cannot disambiguate).
UPDATE rfq_messages m
   SET vendor_id = single.vendor_id
  FROM (
    SELECT rfq_id, MIN(vendor_id) AS vendor_id
      FROM rfq_invitations
     GROUP BY rfq_id
    HAVING COUNT(*) = 1
  ) single
 WHERE m.vendor_id IS NULL
   AND m.sender_type = 'internal'
   AND m.rfq_id = single.rfq_id;

CREATE INDEX IF NOT EXISTS idx_rfq_messages_rfq_vendor
  ON rfq_messages (rfq_id, vendor_id);
