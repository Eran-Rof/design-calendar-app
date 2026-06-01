-- 20260712090000_customer_locations.sql
--
-- Adds customer_locations — a child table that models the set of distribution
-- centers, stores, or ship-to addresses a customer can have.  Each customer
-- can have zero-to-many locations.  At most ONE location may be flagged
-- is_default per customer (enforced by the partial unique index below).
--
-- Also adds ship_to_location_id to ar_invoices so that each invoice can
-- reference the specific DC / store the goods are being shipped to.
--
-- Dependencies:
--   entities        — rof_entity_id() default + FK
--   customers       — FK (ON DELETE CASCADE so orphan rows are impossible)
--   ar_invoices     — ship_to_location_id FK (nullable; existing invoices = NULL)
--
-- Idempotent: all DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. customer_locations table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_locations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid        NOT NULL DEFAULT rof_entity_id()
                              REFERENCES entities(id),
  customer_id     uuid        NOT NULL
                              REFERENCES customers(id) ON DELETE CASCADE,
  code            text,
  name            text        NOT NULL,
  address         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  contact_name    text,
  phone           text,
  email           text,
  is_default      boolean     NOT NULL DEFAULT false,
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Fast look-up by customer (the dominant query pattern).
CREATE INDEX IF NOT EXISTS ix_customer_locations_customer_id
  ON customer_locations (customer_id);

-- At most one default ship-to per customer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_location_default
  ON customer_locations (customer_id)
  WHERE is_default;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ar_invoices — add ship_to_location_id
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE ar_invoices
  ADD COLUMN IF NOT EXISTS ship_to_location_id uuid
    REFERENCES customer_locations(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Notify PostgREST to pick up the new table + column
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
