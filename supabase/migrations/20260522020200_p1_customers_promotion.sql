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
-- Step 1: Rename table — handles 4 prod-state cases.
--
-- Case A: ip_customer_master exists (table), customers does NOT
--   → straightforward rename
-- Case B: ip_customer_master gone (view from prior run), customers exists (table from prior run)
--   → no-op, re-run scenario
-- Case C: ip_customer_master exists (table), customers also exists (table from a
--         DIFFERENT system / pre-Tangerine app) — this is the collision we hit
--         on the actual prod where a pre-existing `customers` stub lived
--   → archive the existing customers to customers_pretangerine_YYYYMMDDHH24MISS,
--     preserving its data, then rename ip_customer_master to customers
-- Case D: Neither exists → abort with a clear error
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  ipcm_is_table boolean;
  cust_is_table boolean;
  archive_name  text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ip_customer_master' AND table_type = 'BASE TABLE'
  ) INTO ipcm_is_table;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'customers' AND table_type = 'BASE TABLE'
  ) INTO cust_is_table;

  IF ipcm_is_table AND cust_is_table THEN
    -- Case C: collision. Archive the pre-existing customers, then rename ip_customer_master.
    archive_name := 'customers_pretangerine_' || to_char(now(), 'YYYYMMDDHH24MISS');
    EXECUTE format('ALTER TABLE customers RENAME TO %I', archive_name);
    RAISE NOTICE 'Tangerine: pre-existing customers table archived as % (data preserved). Inspect after migration to decide whether to keep or drop it.', archive_name;
    ALTER TABLE ip_customer_master RENAME TO customers;
    RAISE NOTICE 'Tangerine: ip_customer_master renamed to customers';
  ELSIF ipcm_is_table AND NOT cust_is_table THEN
    -- Case A: clean first run
    ALTER TABLE ip_customer_master RENAME TO customers;
    RAISE NOTICE 'Tangerine: ip_customer_master renamed to customers';
  ELSIF NOT ipcm_is_table AND cust_is_table THEN
    -- Case B: re-run; nothing to do
    RAISE NOTICE 'Tangerine: customers already exists, ip_customer_master is gone — skipping rename (re-run case)';
  ELSE
    -- Case D: nothing to promote
    RAISE EXCEPTION 'Tangerine: neither ip_customer_master nor customers exists as a base table. Cannot promote.';
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

-- Backfill: `code` from existing `customer_code` (if that column exists);
-- `status` from `active` (if that column exists). Guarded because some
-- legacy installs of ip_customer_master may differ from the Phase 0 schema.
DO $$
DECLARE
  has_customer_code boolean;
  has_active        boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'customer_code'
  ) INTO has_customer_code;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'active'
  ) INTO has_active;

  IF has_customer_code THEN
    EXECUTE 'UPDATE customers SET code = COALESCE(code, customer_code) WHERE code IS NULL';
  END IF;

  IF has_active THEN
    EXECUTE $sql$
      UPDATE customers
         SET status = COALESCE(status, CASE WHEN active THEN 'active' ELSE 'inactive' END)
       WHERE status IS NULL
    $sql$;
  ELSE
    -- No legacy active column → default everyone to active where status is null
    EXECUTE 'UPDATE customers SET status = ''active'' WHERE status IS NULL';
  END IF;
END $$;

-- customer_type backfill: heuristic from channel_id if present; otherwise 'wholesale'.
-- ip_channel_master has channel_type column (wholesale/ecom/marketplace/retail/other);
-- map directly when channel is set. Guarded too (channel_id may not exist on all installs).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'channel_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ip_channel_master'
  ) THEN
    EXECUTE $sql$
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
       WHERE (c.channel_id = ch.id OR c.channel_id IS NULL)
         AND c.customer_type IS NULL
    $sql$;
  END IF;
END $$;

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

-- ────────────────────────────────────────────────────────────────────────────
-- entity_id safety net. Chunk 1 mig 3 was supposed to add this to
-- ip_customer_master, but if it didn't (table missing at the time, partial
-- failure, etc.), the indexes below would fail with "column entity_id does
-- not exist." Add it now if missing; backfill from the ROF entity row.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'entity_id'
  ) THEN
    ALTER TABLE customers ADD COLUMN entity_id uuid;
    UPDATE customers SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
    -- Only enforce NOT NULL if there IS at least one row (otherwise the
    -- backfill matched nothing because customers is empty, which is fine).
    IF EXISTS (SELECT 1 FROM customers WHERE entity_id IS NULL) THEN
      RAISE NOTICE 'Tangerine 6 fix: customers has rows with NULL entity_id after backfill (no ROF entity yet?). Skipping NOT NULL.';
    ELSE
      ALTER TABLE customers ALTER COLUMN entity_id SET NOT NULL;
    END IF;
    ALTER TABLE customers
      ADD CONSTRAINT customers_entity_id_fkey
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
    RAISE NOTICE 'Tangerine 6 fix: added entity_id to customers + backfilled from ROF';
  END IF;
END $$;

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
--
-- Built dynamically because legacy schemas vary: some installs of
-- ip_customer_master had customer_code / customer_tier / active / channel_id,
-- some didn't. The view only selects columns that exist on customers.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  view_cols text;
  legacy_cols text[] := ARRAY[
    'id', 'customer_code', 'name', 'parent_customer_id', 'customer_tier',
    'country', 'channel_id', 'active', 'external_refs', 'created_at', 'updated_at', 'entity_id'
  ];
  c text;
  selected text[] := ARRAY[]::text[];
BEGIN
  FOREACH c IN ARRAY legacy_cols LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = c
    ) THEN
      selected := array_append(selected, c);
    END IF;
  END LOOP;

  IF array_length(selected, 1) IS NULL THEN
    RAISE EXCEPTION 'Tangerine: customers table has none of the legacy columns; cannot create ip_customer_master view';
  END IF;

  view_cols := array_to_string(selected, ', ');
  EXECUTE format('CREATE OR REPLACE VIEW ip_customer_master AS SELECT %s FROM customers', view_cols);

  RAISE NOTICE 'Tangerine: created ip_customer_master view with cols [%]', view_cols;
END $$;

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
