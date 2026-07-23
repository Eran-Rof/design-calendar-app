-- ════════════════════════════════════════════════════════════════════════════
-- 20265900000000_beta_config_registry_test_masters.sql
--
-- Beta guardrails — CHUNK A (beta window tagging).
--
-- Real users are about to use PRODUCTION during a beta window. Every document
-- a beta user creates must be identifiable later for reviewed cleanup.
--
--   1. beta_config        — single-row global switch (active=false until the
--                           beta starts; flipped via the Beta Data screen,
--                           chunk C).
--   2. beta_created_docs  — central registry of rows created while the beta
--                           window is active. One row per (table_name, row_id).
--   3. fn_beta_registry() — ONE generic AFTER INSERT trigger function attached
--                           to all human-creatable document/master header
--                           tables. No-op while beta is inactive. Skips
--                           mirror/feed-origin rows (human-origin guard).
--                           The ENTIRE body is exception-wrapped so it can
--                           NEVER fail the business insert.
--   4. ZZ-BETA test masters — permanent named fixtures (1 customer, 1 vendor,
--                           2 styles) beta users are told to play with.
--                           Seeded idempotently; NOT registered in
--                           beta_created_docs (seeded while active=false, and
--                           in this file the seeds run BEFORE the triggers are
--                           attached).
--
-- Idempotent throughout — safe to re-run. Applied via Supabase Management API
-- (single self-contained script; no statement relies on returning rows).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. beta_config — single-row global switch ──────────────────────────────

CREATE TABLE IF NOT EXISTS beta_config (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  active             boolean NOT NULL DEFAULT false,
  started_at         timestamptz,
  ended_at           timestamptz,
  started_by_user_id text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE beta_config IS
  'Beta guardrails (chunk A): single-row global switch. active=true means the beta window is OPEN and fn_beta_registry() tags every human-origin INSERT on registered tables into beta_created_docs. Singleton enforced by beta_config_singleton unique index.';

-- Singleton guard: a unique index on a constant expression admits at most one row.
CREATE UNIQUE INDEX IF NOT EXISTS beta_config_singleton ON beta_config ((true));

-- Touch updated_at on any change.
CREATE OR REPLACE FUNCTION beta_config_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_beta_config_touch ON beta_config;
CREATE TRIGGER trg_beta_config_touch BEFORE UPDATE ON beta_config
  FOR EACH ROW EXECUTE FUNCTION beta_config_touch();

-- Seed exactly one row, inactive. Idempotent (singleton index backstops races).
INSERT INTO beta_config (active)
SELECT false
WHERE NOT EXISTS (SELECT 1 FROM beta_config)
ON CONFLICT DO NOTHING;

-- ─── 2. beta_created_docs — central registry ────────────────────────────────

CREATE TABLE IF NOT EXISTS beta_created_docs (
  id                 bigserial PRIMARY KEY,
  table_name         text NOT NULL,
  row_id             uuid NOT NULL,
  doc_label          text,
  source             text,
  created_by_user_id text,
  entity_id          uuid,
  created_at         timestamptz DEFAULT now()
);

COMMENT ON TABLE beta_created_docs IS
  'Beta guardrails (chunk A): every row INSERTed into a registered table while beta_config.active=true, for reviewed post-beta cleanup. Populated only by fn_beta_registry(). doc_label is a best-effort human identifier (invoice/order/PO number, code, name, ...).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_beta_created_docs_table_row
  ON beta_created_docs (table_name, row_id);

CREATE INDEX IF NOT EXISTS idx_beta_created_docs_table
  ON beta_created_docs (table_name);

-- RLS: repo pattern (cases/case_comments) — enabled with permissive policies;
-- service-role writes bypass RLS, and fn_beta_registry() is SECURITY DEFINER
-- so registration works no matter which role performed the business insert.
ALTER TABLE beta_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_created_docs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_beta_config' AND tablename = 'beta_config') THEN
    CREATE POLICY anon_all_beta_config ON beta_config FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'auth_all_beta_config' AND tablename = 'beta_config') THEN
    CREATE POLICY auth_all_beta_config ON beta_config FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_beta_created_docs' AND tablename = 'beta_created_docs') THEN
    CREATE POLICY anon_all_beta_created_docs ON beta_created_docs FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'auth_all_beta_created_docs' AND tablename = 'beta_created_docs') THEN
    CREATE POLICY auth_all_beta_created_docs ON beta_created_docs FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 3. fn_beta_registry() — generic AFTER INSERT registrar ─────────────────
--
-- NON-NEGOTIABLE: the entire body is wrapped in
-- BEGIN ... EXCEPTION WHEN OTHERS THEN RETURN NEW; END — registration must
-- NEVER fail the business insert, under any circumstance.

CREATE OR REPLACE FUNCTION fn_beta_registry() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  j        jsonb;
  v_row_id uuid;
  v_source text;
BEGIN
  -- Beta window closed → no-op (the common case; keep it cheap).
  IF (SELECT active FROM beta_config LIMIT 1) IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  j := to_jsonb(NEW);

  -- HUMAN-ORIGIN GUARD: rows stamped by mirrors/feeds (xoro_mirror, shopify,
  -- fba, walmart, faire, edi_3pl, plaid_sync, system, excel, schedule, ...)
  -- must never be tagged. Only register when source is absent, NULL, or one of
  -- the human/app origins.
  IF j ? 'source' THEN
    v_source := j ->> 'source';
    IF v_source IS NOT NULL
       AND v_source NOT IN ('manual', 'tangerine', 'buyer', 'api') THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Tables without a uuid `id` (or with a non-uuid id) are skipped silently:
  -- the cast raises and the outer handler swallows it.
  v_row_id := (j ->> 'id')::uuid;
  IF v_row_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO beta_created_docs
    (table_name, row_id, doc_label, source, created_by_user_id, entity_id)
  VALUES (
    TG_TABLE_NAME,
    v_row_id,
    -- Best-effort human identifier — first present-and-non-null common key.
    COALESCE(
      j ->> 'invoice_number',
      j ->> 'order_number',
      j ->> 'so_number',          -- sales_orders
      j ->> 'po_number',          -- purchase_orders
      j ->> 'je_number',
      j ->> 'case_number',        -- cases
      j ->> 'customer_code',      -- customers (legacy Xoro ref / CUST-NNNNN)
      j ->> 'vendor_code',
      j ->> 'style_code',         -- style_master
      j ->> 'sku_code',           -- ip_item_master
      j ->> 'code',               -- customers/vendors/rfqs (CUST-/VEND-/RFQ-NNNNN)
      j ->> 'name',
      j ->> 'title',              -- rfqs
      j ->> 'reference',          -- ar_receipts / invoice_payments
      j ->> 'reason',             -- inventory_adjustments
      j ->> 'description'         -- journal_entries
    ),
    v_source,
    COALESCE(j ->> 'created_by_user_id', j ->> 'created_by'),
    (j ->> 'entity_id')::uuid
  )
  ON CONFLICT (table_name, row_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Registration must never break the business insert.
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION fn_beta_registry() IS
  'Beta guardrails (chunk A): generic AFTER INSERT registrar. No-op unless beta_config.active. Skips mirror/feed-origin rows (source not in manual/tangerine/buyer/api/NULL). Whole body exception-wrapped — can never fail the triggering insert.';

-- ─── 4. ZZ-BETA test masters (permanent fixtures) ───────────────────────────
--
-- Seeded BEFORE the registry triggers are attached (and while active=false),
-- so they are never registered in beta_created_docs. entity_id is omitted
-- everywhere — customers/style_master carry DEFAULT coalesce(current_entity_id(),
-- rof_entity_id()); vendors are global (no entity_id column).

-- 4a. Customer — code convention CUST-NNNNN (5-digit pad), next = MAX(numeric
--     suffix)+1 (never COUNT+1; mirrors api/_lib/autoCode.js nextCode()).
--     customer_code is NOT NULL (legacy Xoro ref) → same generated code,
--     matching the customer-master handler's app-created-customer behavior.
DO $$
DECLARE
  next_num integer;
  new_code text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM customers
    WHERE name = 'ZZ-BETA TEST CUSTOMER' AND deleted_at IS NULL
  ) THEN
    RETURN;
  END IF;

  SELECT COALESCE(MAX(substring(code FROM '([0-9]+)$')::int), 0) + 1
    INTO next_num
    FROM customers
   WHERE code ~* '^CUST-[0-9]+$';

  new_code := 'CUST-' || lpad(next_num::text, 5, '0');

  INSERT INTO customers (customer_code, code, name, customer_type, status)
  VALUES (new_code, new_code, 'ZZ-BETA TEST CUSTOMER', 'other', 'active')
  ON CONFLICT DO NOTHING;
END $$;

-- 4b. Vendor — code convention VEND-NNNNN (5-digit pad, global scope), next =
--     MAX(numeric suffix)+1 (mirrors vendor-master handler's insertWithAutoCode).
DO $$
DECLARE
  next_num integer;
  new_code text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM vendors
    WHERE lower(name) = lower('ZZ-BETA TEST VENDOR') AND deleted_at IS NULL
  ) THEN
    RETURN;
  END IF;

  SELECT COALESCE(MAX(substring(code FROM '([0-9]+)$')::int), 0) + 1
    INTO next_num
    FROM vendors
   WHERE code ~* '^VEND-[0-9]+$';

  new_code := 'VEND-' || lpad(next_num::text, 5, '0');

  INSERT INTO vendors (code, name, status)
  VALUES (new_code, 'ZZ-BETA TEST VENDOR', 'active')
  ON CONFLICT DO NOTHING;
END $$;

-- 4c. Styles — style_code + description are NOT NULL; unique per
--     (entity_id, style_code) among live rows.
INSERT INTO style_master (style_code, description, lifecycle_status)
SELECT 'ZZBETA001', 'ZZ-BETA test style 1 (beta guardrails fixture — do not sell)', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM style_master WHERE style_code = 'ZZBETA001' AND deleted_at IS NULL
)
ON CONFLICT DO NOTHING;

INSERT INTO style_master (style_code, description, lifecycle_status)
SELECT 'ZZBETA002', 'ZZ-BETA test style 2 (beta guardrails fixture — do not sell)', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM style_master WHERE style_code = 'ZZBETA002' AND deleted_at IS NULL
)
ON CONFLICT DO NOTHING;

-- ─── 5. Attach trg_beta_registry to document/master HEADER tables ───────────
--
-- Headers only — a header row is enough to identify the document; line tables
-- are intentionally NOT triggered. Each attach is guarded by to_regclass so
-- the migration survives environments where a table is absent.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ar_invoices',            -- AR invoices (invoice_number)
    'ar_receipts',            -- AR customer receipts
    'invoices',               -- AP bills (invoice_number)
    'invoice_payments',       -- AP payments
    'journal_entries',        -- manual JEs
    'sales_orders',           -- native SOs (so_number)
    'purchase_orders',        -- native POs (po_number)
    'cases',                  -- deduction/dispute cases (case_number)
    'customers',              -- customer master (CUST-NNNNN)
    'vendors',                -- vendor master (VEND-NNNNN)
    'style_master',           -- style master (style_code)
    'ip_item_master',         -- item/SKU master (sku_code)
    'inventory_adjustments',  -- inventory adjustments
    'inventory_transfers',    -- inventory transfers
    'rfqs'                    -- RFQs (RFQ-NNNNN / title)
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_beta_registry ON public.%I', t);
      EXECUTE format(
        'CREATE TRIGGER trg_beta_registry AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION fn_beta_registry()',
        t
      );
    END IF;
  END LOOP;
END $$;
