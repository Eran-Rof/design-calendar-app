-- Adds a channel column to ip_open_purchase_orders so the wholesale and
-- ecom planning grids can each see only their own POs.
--
-- Background: the user's Xoro setup tags ecom POs with an 'ecom' prefix
-- on the PO number. Until now both grids read every PO, so wholesale
-- planning included ecom-bound stock in receipts (overstating supply,
-- understating buy recommendations). The reverse was true for ecom.
--
-- Default 'wholesale' so existing callers don't break; the sync code
-- (api/_lib/planning-sync.js) sets the column from the po_number prefix
-- on every upsert. The backfill UPDATE below handles existing rows.

ALTER TABLE ip_open_purchase_orders
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'wholesale';

-- Backfill: any existing PO whose number starts with "ROF ECOM"
-- (case-insensitive, with optional whitespace / dash / underscore
-- between ROF and ECOM) gets re-classified as ecom. Rows already
-- correct (default 'wholesale') stay put.
UPDATE ip_open_purchase_orders
SET channel = 'ecom'
WHERE po_number ~* '^rof[ _-]*ecom';

CREATE INDEX IF NOT EXISTS idx_ip_open_pos_channel
  ON ip_open_purchase_orders (channel, sku_id, expected_date);

-- Surface the new column to the PostgREST schema cache so the
-- frontend can SELECT it without a redeploy.
NOTIFY pgrst, 'reload schema';
