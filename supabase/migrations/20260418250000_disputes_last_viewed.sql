-- 20260418250000_disputes_last_viewed.sql
--
-- Phase 5 part 4 add-on — per-side "last viewed" timestamps on disputes
-- so we can compute unread counts cheaply without a read-flag column on
-- every dispute_messages row. Updated when a side opens the detail view.

ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS last_viewed_by_vendor_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_viewed_by_internal_at timestamptz;
