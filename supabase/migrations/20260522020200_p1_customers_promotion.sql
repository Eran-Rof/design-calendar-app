-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 6 / Migration 15 (was 16 in arch §9.1)
-- Promote ip_customer_master to canonical `customers` table per arch §8.
--
-- Strategy: ALTER TABLE RENAME + CREATE VIEW. The view is a simple SELECT
-- with no expressions, so PostgreSQL treats it as auto-updatable — existing
-- code paths that read/write ip_customer_master continue to work transparently
-- (xoro-sales-sync, planning-sync, AI executors, seed files all keep working).
--
-- New ERP-grade columns land on the renamed table. View doesn't expose them
-- by default — legacy callers ignore the new fields.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §8.1, §8.2
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: Rename table.
--
-- Idempotency note: on first run, ip_customer_master is a TABLE that gets
-- renamed to customers. On any subsequent re-run, ip_customer_master is now
-- a VIEW (created at the end of this same migration as a backward-compat
-- alias). `ALTER TABLE IF EXISTS ip_customer_master` would still match the
-- view and try to rename it — which collides with the existing customers
-- table. Guard the rename to only fire when customers does NOT yet exist as
-- a base table.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'customers'
      AND table_type   = 'BASE TABLE'
  ) THEN
    ALTER TABLE IF EXISTS ip_customer_master RENAME TO customers;
  END IF;
END $$;

-- The Phase 0 migration created two indexes named idx_ip_customer_master_*.
-- PG keeps index names attached to the table after RENAME; the names become
-- misleading. Rename them for clarity but the renaming is purely cosmetic.
ALTER INDEX IF EXISTS idx_ip_customer_master_name   RENAME TO idx_customers_name;
ALTER INDEX IF EXISTS idx_ip_customer_master_parent RENAME TO idx_customers_parent;

-- Also rename the touched-timestamp trigger. (PostgreSQL does NOT support
-- ALTER TRIGGER IF EXISTS — wrap in a DO block that checks pg_trigger first.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_ip_customer_master_updated'
      AND tgrelid = 'customers'::regclass
  ) THEN
    ALTER TRIGGER trg_ip_customer_master_updated ON customers
      RENAME TO trg_customers_updated;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: ERP-grade column additions.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS code                              text,
  ADD COLUMN IF NOT EXISTS customer_type                     text,
  ADD COLUMN IF NOT EXISTS default_gl_ar_account_id          uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_gl_revenue_account_id     uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_terms                     text,
  ADD COLUMN IF NOT EXISTS default_currency                  char(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS tax_exempt                        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_exempt_certificate            text,
  ADD COLUMN IF NOT EXISTS credit_limit                      numeric(14, 2),
  ADD COLUMN IF NOT EXISTS status                            text,
  ADD COLUMN IF NOT EXISTS billing_address                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shipping_address                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attributes                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deleted_at                        timestamptz,
  ADD COLUMN IF NOT EXISTS created_by_user_id                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by_user_id                uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill: `code` from existing `customer_code`; `status` from `active`.
UPDATE customers
   SET code   = COALESCE(code,   customer_code),
       status = COALESCE(status, CASE WHEN active THEN 'active' ELSE 'inactive' END);

-- customer_type backfill: heuristic from channel_id if present; otherwise 'wholesale'.
-- ip_channel_master has channel_type column (wholesale/ecom/marketplace/retail/other);
-- map directly when channel is set.
UPDATE customers c
   SET customer_type = COALESCE(
         c.customer_type,
         CASE ch.channel_type
           WHEN 'wholesale'   THEN 'wholesale'
           WHEN 'ecom'        THEN 'ecom'
           WHEN 'retail'      THEN 'showroom'
           WHEN 'marketplace' THEN 'ecom'
           ELSE 'wholesale'
         END,
         'wholesale'
       )
  FROM ip_channel_master ch
 WHERE c.channel_id = ch.id OR c.channel_id IS NULL;

UPDATE customers SET customer_type = 'wholesale' WHERE customer_type IS NULL;

ALTER TABLE customers
  ALTER COLUMN customer_type SET NOT NULL,
  ALTER COLUMN customer_type SET DEFAULT 'wholesale',
  ALTER COLUMN status        SET NOT NULL,
  ALTER COLUMN status        SET DEFAULT 'active';

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_type_check
  CHECK (customer_type IN ('wholesale', 'ecom', 'showroom', 'employee', 'other'));

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_status_check
  CHECK (status IN ('active', 'inactive', 'on_hold'));

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_default_currency_check;
ALTER TABLE customers ADD CONSTRAINT customers_default_currency_check
  CHECK (default_currency ~ '^[A-Z]{3}$');

-- Unique (entity_id, code) among non-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_entity_code
  ON customers (entity_id, code)
  WHERE deleted_at IS NULL AND code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_entity_type     ON customers (entity_id, customer_type);
CREATE INDEX IF NOT EXISTS idx_customers_entity_status   ON customers (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_ar_account      ON customers (default_gl_ar_account_id)
  WHERE default_gl_ar_account_id IS NOT NULL;

COMMENT ON TABLE  customers IS 'Canonical customer master (M36). Renamed from ip_customer_master in Tangerine P1 Chunk 6. Backward-compat view ip_customer_master still exposes the original schema for legacy callers.';
COMMENT ON COLUMN customers.code               IS 'Customer short code. Backfilled from customer_code on migration. Unique per entity among non-deleted rows.';
COMMENT ON COLUMN customers.customer_type      IS 'wholesale | ecom | showroom | employee | other. Drives default GL revenue account selection and reporting buckets.';
COMMENT ON COLUMN customers.credit_limit       IS 'Optional. When set, AR module blocks new orders that would push balance past this limit.';
COMMENT ON COLUMN customers.tax_exempt         IS 'When true, AR invoice tax calculation skipped. tax_exempt_certificate should be populated.';
COMMENT ON COLUMN customers.deleted_at         IS 'Soft delete. Indexes exclude soft-deleted rows.';

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: Backward-compat view alias.
--
-- Simple SELECT from one base table with no expressions → auto-updatable per
-- PostgreSQL view-update rules. xoro-sales-sync, planning-sync, AI executors,
-- seed scripts all continue to work without modification.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW ip_customer_master AS
SELECT
  id,
  customer_code,
  name,
  parent_customer_id,
  customer_tier,
  country,
  channel_id,
  active,
  external_refs,
  created_at,
  updated_at,
  entity_id
FROM customers;

COMMENT ON VIEW ip_customer_master IS
  'Auto-updatable view over `customers` (Tangerine P1 Chunk 6). Preserves the original schema so legacy callers (xoro-sales-sync, planning-sync, AI executors, seed scripts) work without changes. Inserts/updates through the view propagate to customers.';

-- ────────────────────────────────────────────────────────────────────────────
-- Step 4: RLS — re-apply on the renamed table. RLS on the old name carries
-- over (RLS is attached to the table OID, not the name), but the policy names
-- still reference the old table name. Rename the policy for clarity.
--
-- The view doesn't need its own RLS — view access uses the security_invoker
-- caller's permissions against the base table per PG default.
-- ────────────────────────────────────────────────────────────────────────────
-- ALTER POLICY does NOT support IF EXISTS — wrap each in a pg_policies check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'customers' AND policyname = 'anon_all_ip_customer_master') THEN
    ALTER POLICY "anon_all_ip_customer_master" ON customers RENAME TO "anon_all_customers";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'customers' AND policyname = 'auth_internal_ip_customer_master') THEN
    ALTER POLICY "auth_internal_ip_customer_master" ON customers RENAME TO "auth_internal_customers";
  END IF;
END $$;
