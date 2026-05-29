-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P12-0 — Marketplaces SHARED foundation schema
--
-- This is the GATE chunk for the P12 Marketplaces phase. Once this lands,
-- the three sub-phases (P12a FBA / P12b Walmart / P12c Faire) can wave in
-- parallel. See docs/tangerine/P12-marketplaces-architecture.md §3.
--
-- Operator-accepted decisions (PR #480):
--   D1   Multi seller accounts per channel
--   D2   Per-channel source tags ('fba' / 'walmart' / 'faire') already
--        seeded by T10-1; verified below.
--   D4/D5 FBA / Walmart fees split into separate GL lines
--   D6   Faire fees as marketplace_fees (25%/15%)
--   D7   Sponsored Ads as 6521
--   D8   Marketplace facilitator tax memo-only
--   D13/D14 Multi-location inventory via inventory_locations + layers FK
--
-- ════════════════════════════════════════════════════════════════════════════
-- WARNING — multi-location migration:
--   Every existing FIFO query was written assuming single-location.
--   After this lands, every read endpoint that joins inventory_layers
--   should be sanity-checked. Backfill targets the per-entity MAIN_WH so
--   existing aggregations remain correct in totals; per-location splits
--   are additive.
-- ════════════════════════════════════════════════════════════════════════════
--
-- Fully idempotent:
--   - CREATE TABLE IF NOT EXISTS
--   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--   - DO $$ guards on CHECK / NOT NULL / RLS policies
--   - ON CONFLICT (entity_id, code) DO NOTHING on seeds
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. inventory_locations table (D13/D14) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  code            text NOT NULL,                                                       -- 'MAIN_WH'|'FBA_US'|'FBA_CA'|'WFS_US'
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('warehouse','fba','wfs','3pl','dropship','virtual')),
  country_code    text,                                                                 -- 'US','CA'
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_locations_code_per_entity UNIQUE (entity_id, code)
);

CREATE INDEX IF NOT EXISTS idx_inventory_locations_entity_kind
  ON inventory_locations (entity_id, kind);

COMMENT ON TABLE inventory_locations IS 'P12-0: per-entity inventory location. Every inventory_layer must point to one. kind=warehouse for operator-owned WH; fba/wfs for marketplace-held stock; 3pl/dropship/virtual for non-FBA fulfillment.';
COMMENT ON COLUMN inventory_locations.code IS
  'Per-entity unique code (e.g. MAIN_WH, FBA_US, FBA_CA, WFS_US). Used in UI badges and FIFO queries.';

-- ─── 2. Seed default MAIN_WH location for every existing entity ────────────
--
-- SELECT FROM entities covers ROF + SANDBOX + any other present entities.
-- Idempotent via ON CONFLICT.
INSERT INTO inventory_locations (entity_id, code, name, kind)
  SELECT id, 'MAIN_WH', 'Main Warehouse', 'warehouse' FROM entities
  ON CONFLICT (entity_id, code) DO NOTHING;

-- ─── 3. inventory_layers.location_id column + backfill + NOT NULL ──────────
ALTER TABLE inventory_layers
  ADD COLUMN IF NOT EXISTS location_id uuid
    REFERENCES inventory_locations(id) ON DELETE RESTRICT;

-- Backfill existing rows to the MAIN_WH location for their entity_id.
-- Rows whose entity_id has no MAIN_WH (shouldn't happen — we just seeded
-- one per entity above) will remain NULL and the NOT NULL guard below
-- will RAISE so the operator notices the orphan rather than failing
-- silently mid-migration.
UPDATE inventory_layers
  SET location_id = (
    SELECT id FROM inventory_locations
     WHERE entity_id = inventory_layers.entity_id AND code = 'MAIN_WH'
  )
  WHERE location_id IS NULL;

-- Safety net: only enforce NOT NULL if zero NULL rows remain. If any
-- rows are still NULL (orphan entity_id with no MAIN_WH), abort with
-- a clear message instead of half-failing the migration.
DO $$
DECLARE
  v_null_count bigint;
  v_already_not_null boolean;
BEGIN
  SELECT (is_nullable = 'NO') INTO v_already_not_null
    FROM information_schema.columns
   WHERE table_name = 'inventory_layers' AND column_name = 'location_id';

  IF v_already_not_null THEN
    -- Re-run path: column is already NOT NULL, nothing more to do.
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_null_count
    FROM inventory_layers WHERE location_id IS NULL;

  IF v_null_count > 0 THEN
    RAISE EXCEPTION
      'P12-0 migration safety net: % inventory_layers rows still have NULL location_id after backfill. Likely cause: an inventory_layer entity_id has no MAIN_WH row in inventory_locations. Investigate before re-running.',
      v_null_count;
  END IF;

  ALTER TABLE inventory_layers ALTER COLUMN location_id SET NOT NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_layers_location
  ON inventory_layers (location_id, item_id);

COMMENT ON COLUMN inventory_layers.location_id IS 'P12-0: which inventory_location holds this layer. Required NOT NULL after backfill. FIFO queries must filter or group by this column; pre-P12-0 queries that ignored location implicitly aggregated across all locations — that''s still valid behavior but be explicit so FBA / WFS rows aren''t silently mixed into operator-WH totals.';

-- ─── 4. Extend inventory_layers.source_kind CHECK with marketplace values ──
--
-- Current values (per migrations 20260527070000 + 20260528110000 + 20260620000000):
--   ap_invoice / adjustment / opening_balance / transfer_in /
--   credit_memo_return / xoro_mirror_snapshot
--
-- P12-0 adds FBA + WFS inbound/return values. The 'shopify_refund_restock'
-- value reserved for P11-1 is included so P11 and P12 sub-phases can land
-- in any order without re-fighting this CHECK.

ALTER TABLE inventory_layers
  DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check;

ALTER TABLE inventory_layers
  ADD CONSTRAINT inventory_layers_source_kind_check
  CHECK (source_kind IN (
    'ap_invoice',
    'adjustment',
    'opening_balance',
    'transfer_in',
    'credit_memo_return',
    'xoro_mirror_snapshot',
    'shopify_refund_restock',
    'fba_inbound',
    'wfs_inbound',
    'fba_return_restock',
    'wfs_return_restock'
  ));

COMMENT ON COLUMN inventory_layers.source_kind IS 'P12-0 extended with fba_inbound / wfs_inbound / fba_return_restock / wfs_return_restock plus reserved-for-P11 shopify_refund_restock. Existing values preserved.';

-- ─── 5. customers.marketplace_buyer_refs JSONB ─────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS marketplace_buyer_refs jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_customers_marketplace_buyer_refs
  ON customers USING gin (marketplace_buyer_refs);

COMMENT ON COLUMN customers.marketplace_buyer_refs IS 'P12-0 per-channel buyer-token map. Shape: {"faire":"fb_buyer_xxx","amazon_consumer":"amz_token","walmart":"wmt_buyer_y"}. GIN-indexed for platform-buyer-id → customer_id @> lookups.';

-- ─── 6. Seed 8 new GL accounts (D4, D5, D6, D7) ────────────────────────────
--
-- Only seeded against ROF (rof_entity_id()). Per-entity COA cloning lives in
-- P10 tenancy tooling; this is enough for ROF + SANDBOX uses the same COA in
-- practice today.
INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, status)
SELECT rof_entity_id(), code, name, account_type, normal_balance, 'active'
FROM (VALUES
  ('6520', 'Marketplace Fees',                'expense', 'DEBIT'),
  ('6521', 'Sponsored Ads',                   'expense', 'DEBIT'),
  ('6522', 'Storage Fees',                    'expense', 'DEBIT'),
  ('6523', 'Fulfillment Fees',                'expense', 'DEBIT'),
  ('6524', 'Referral Fees',                   'expense', 'DEBIT'),
  ('6525', 'FBA Removal/Disposal Fees',       'expense', 'DEBIT'),
  ('1115', 'Marketplace Receivable Clearing', 'asset',   'DEBIT'),
  ('1116', 'Marketplace Reserve',             'asset',   'DEBIT')
) AS new_accts(code, name, account_type, normal_balance)
ON CONFLICT (entity_id, code) DO NOTHING;

-- ─── 7. Verify source enum on ar_invoices includes marketplace values ──────
--
-- T10-1 (migration 20260620000000) already added the source column to AR /
-- AP / JE tables with a CHECK enum that INCLUDES 'fba','walmart','faire'.
-- This is a re-assert: if for any reason the constraint is missing the
-- marketplace values, drop + recreate. Idempotent.
DO $$
DECLARE
  v_def text;
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['ar_invoices','ar_invoice_lines','ar_receipts','invoices','journal_entries']
  LOOP
    SELECT pg_get_constraintdef(c.oid) INTO v_def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = v_table
       AND c.conname = v_table || '_source_check';

    IF v_def IS NULL
       OR v_def NOT LIKE '%fba%'
       OR v_def NOT LIKE '%walmart%'
       OR v_def NOT LIKE '%faire%'
    THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
                     v_table, v_table || '_source_check');
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (source IN (%L,%L,%L,%L,%L,%L,%L,%L,%L,%L))',
        v_table, v_table || '_source_check',
        'manual','xoro_mirror','shopify','fba','walmart','faire',
        'edi_3pl','plaid_sync','api','system');
    END IF;
  END LOOP;
END $$;

-- ─── 8. RLS — auth_internal_* template on inventory_locations ──────────────
ALTER TABLE inventory_locations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_all_inventory_locations" ON inventory_locations
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "auth_internal_inventory_locations" ON inventory_locations
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 9. PostgREST schema cache reload ───────────────────────────────────────
NOTIFY pgrst, 'reload schema';
