-- 20260891000000_customer_locations_xoro_sync.sql
--
-- Extends customer_locations for idempotent Xoro REST sync:
--   • xoro_location_ref  — opaque dedup key (hash of customer+ship-to addr)
--                          set by rest_customer_locations_sync.py; unique per
--                          customer so re-runs are safe.
--   • xoro_customer_id   — Xoro numeric CustomerId stored on customers so
--                          future syncs join on a stable int ID instead of
--                          fragile name-matching.
--   • dc_store_map       — records which stores a given DC serves (one DC can
--                          distribute to many stores on the same shipment).
--
-- Idempotent: all DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. customer_locations: add Xoro sync columns
-- ─────────────────────────────────────────────────────────────────────────────
-- location_type already exists in prod (added by 20260712090000).
ALTER TABLE customer_locations
  ADD COLUMN IF NOT EXISTS xoro_location_ref  text;

-- Unique per customer so re-sync of the same Xoro ship-to is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_location_xoro_ref
  ON customer_locations (customer_id, xoro_location_ref)
  WHERE xoro_location_ref IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. customers: add Xoro numeric customer ID for robust future matching
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS xoro_customer_id  integer;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_xoro_customer_id
  ON customers (xoro_customer_id)
  WHERE xoro_customer_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. dc_store_map — DC location → store locations it distributes to
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dc_store_map (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  dc_id       uuid  NOT NULL REFERENCES customer_locations(id) ON DELETE CASCADE,
  store_id    uuid  NOT NULL REFERENCES customer_locations(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_store_map
  ON dc_store_map (dc_id, store_id);

CREATE INDEX IF NOT EXISTS ix_dc_store_map_dc_id
  ON dc_store_map (dc_id);

CREATE INDEX IF NOT EXISTS ix_dc_store_map_store_id
  ON dc_store_map (store_id);

NOTIFY pgrst, 'reload schema';
