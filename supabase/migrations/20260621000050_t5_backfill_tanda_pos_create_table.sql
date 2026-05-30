-- ════════════════════════════════════════════════════════════════════════════
-- T5 follow-up — Backfill CREATE TABLE for tanda_pos
--
-- tanda_pos was originally created via the Supabase Dashboard UI BEFORE the
-- `supabase/migrations/` folder existed in this repo. As a result the
-- T5 schema-snapshot generator only sees the later ALTER TABLE additions
-- (vendor_id, buyer_po, buyer_name, date_expected_delivery, uuid_id,
-- entity_id) and marks the table "(alter only)" in CURRENT-SCHEMA.md.
--
-- The T10-3 AP-mirror agent had to recover the actual base shape from
-- the JS upsert payload in src/tanda/hooks/useSyncOps.ts. This migration
-- backfills the CREATE TABLE statement so future bundles can grep the
-- schema doc directly.
--
-- Fully idempotent — CREATE TABLE IF NOT EXISTS is a no-op when the
-- table already exists. The existing ALTER TABLE migrations
-- (20260415100001, 20260416100000, 20260514120000, etc.) still apply
-- on top.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tanda_pos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number     text NOT NULL UNIQUE,            -- Xoro's PO# — primary lookup key
  vendor        text NOT NULL DEFAULT '',        -- vendor name string (free text; resolves to vendor_id via later ALTER)
  date_order    date,
  date_expected date,
  status        text NOT NULL DEFAULT '',
  data          jsonb NOT NULL DEFAULT '{}'::jsonb, -- full Xoro PO payload
  synced_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tanda_pos IS 'Xoro PO mirror — read-only feed populated by the rof_xoro_project nightly fetch. The data jsonb column holds the full Xoro payload; the columns at the top are the most-queried fields hoisted for index-friendliness. Later ALTER migrations add vendor_id (FK to vendors), buyer_po, buyer_name, date_expected_delivery, uuid_id, entity_id.';

NOTIFY pgrst, 'reload schema';
