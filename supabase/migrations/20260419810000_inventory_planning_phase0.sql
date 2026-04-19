-- 20260419800000_inventory_planning_phase0.sql
--
-- Demand & Inventory Planning — Phase 0 foundation.
--
-- Goal: establish the raw-payload stores and normalized master/fact tables
-- that every later phase (wholesale forecasting, ecom forecasting,
-- replenishment, scenarios) will read from. No forecast math lives here.
--
-- Design choices:
--   • Raw payloads are kept verbatim in raw_xoro_payloads / raw_shopify_payloads
--     so we can re-normalize after a contract change without re-hitting the
--     upstream API. These tables are append-only; they carry an
--     `ingested_at` timestamp and a `source_hash` for idempotency.
--   • Master tables (item/customer/category/channel/vendor) are internal
--     system of record. They hold canonical keys plus per-source external
--     refs in a jsonb `external_refs` column: e.g. {"xoro_item_id":"...",
--     "shopify_variant_id":"..."}. This lets normalization join without a
--     heavy mapping schema; tighter mapping tables can come in Phase 1 if
--     needed.
--   • Fact tables (sales_history_*, inventory_snapshot, receipts_history,
--     open_purchase_orders) are partition-friendly by period, but we keep
--     them as regular tables in Phase 0 — partitioning can be added once
--     volume dictates.
--   • All tables follow the Phase 0/1 vendor-portal RLS pattern:
--     anon-permissive for internal apps (they use the anon key) and no
--     authenticated-vendor policies because planning data is internal-only.
--     If a vendor-facing planning surface is added later, we'll add
--     vendor-scoped policies then.
--
-- NOTE on assumptions (flagged here so reviewers can push back):
--   • `sku_id` is an internal uuid; `sku_code` is our canonical text key
--     (the one users type and search). We don't pick a specific external
--     code as the canonical key because both Xoro and Shopify use their
--     own; see src/inventory-planning/README.md for the chosen rule.
--   • `style_code` / `style_id` is the merchandising "base part" one level
--     above SKU. Not all historic items will have one — `style_id` is
--     nullable to tolerate that gap.
--   • Date columns that represent business days (ship dates, on-hand dates)
--     use `date`; timestamps for audit use `timestamptz`.

-- ── helper: updated_at trigger ────────────────────────────────────────────────
-- Re-uses the convention from earlier migrations (e.g. shipments): a plain
-- BEFORE UPDATE trigger that bumps updated_at. Function is idempotent.
CREATE OR REPLACE FUNCTION ip_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── raw_xoro_payloads ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raw_xoro_payloads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which Xoro endpoint this payload came from. Use the same short tags the
  -- /api/xoro/* handlers emit: 'sales-history' | 'inventory-snapshot' |
  -- 'receipts' | 'items' | 'open-pos'. Kept as text (not enum) so new
  -- endpoints don't require a migration.
  endpoint          text NOT NULL,
  -- Logical window the payload represents, if any (date-range pulls).
  period_start      date,
  period_end        date,
  -- Stable hash of (endpoint + params + response body) for idempotency when
  -- replaying a pull. Computed by the ingestor; may be null for ad-hoc pulls.
  source_hash       text,
  payload           jsonb NOT NULL,
  record_count      integer,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  ingested_by       text,
  -- Normalization bookkeeping. NULL = not yet normalized.
  normalized_at     timestamptz,
  normalization_error text
);

CREATE INDEX IF NOT EXISTS idx_raw_xoro_endpoint     ON raw_xoro_payloads (endpoint);
CREATE INDEX IF NOT EXISTS idx_raw_xoro_ingested_at  ON raw_xoro_payloads (ingested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_xoro_source_hash
  ON raw_xoro_payloads (source_hash) WHERE source_hash IS NOT NULL;

-- ── raw_shopify_payloads ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raw_shopify_payloads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'orders' | 'products' | 'collections' | 'returns' | 'inventory'
  endpoint          text NOT NULL,
  -- Multi-store Shopify: which storefront this pull is scoped to.
  -- Matches channel_master.code.
  storefront_code   text,
  period_start      date,
  period_end        date,
  source_hash       text,
  payload           jsonb NOT NULL,
  record_count      integer,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  ingested_by       text,
  normalized_at     timestamptz,
  normalization_error text
);

CREATE INDEX IF NOT EXISTS idx_raw_shopify_endpoint    ON raw_shopify_payloads (endpoint);
CREATE INDEX IF NOT EXISTS idx_raw_shopify_storefront  ON raw_shopify_payloads (storefront_code);
CREATE INDEX IF NOT EXISTS idx_raw_shopify_ingested_at ON raw_shopify_payloads (ingested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_shopify_source_hash
  ON raw_shopify_payloads (source_hash) WHERE source_hash IS NOT NULL;

-- ── vendor_master ────────────────────────────────────────────────────────────
-- Planning-side vendor master. Separate from the Phase 0 portal `vendors`
-- table on purpose: portal vendors are strictly the ones that get accounts
-- and POs in tanda_pos; planning vendors include factories that only appear
-- in sourcing history. We link the two via `portal_vendor_id`.
CREATE TABLE IF NOT EXISTS ip_vendor_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_code        text NOT NULL UNIQUE,
  name               text NOT NULL,
  country            text,
  default_lead_time_days integer,
  moq_units          integer,
  active             boolean NOT NULL DEFAULT true,
  portal_vendor_id   uuid REFERENCES vendors(id) ON DELETE SET NULL,
  external_refs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_vendor_master_name  ON ip_vendor_master (lower(name));
CREATE INDEX IF NOT EXISTS idx_ip_vendor_master_portal ON ip_vendor_master (portal_vendor_id) WHERE portal_vendor_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ip_vendor_master_updated ON ip_vendor_master;
CREATE TRIGGER trg_ip_vendor_master_updated BEFORE UPDATE ON ip_vendor_master
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── category_master ──────────────────────────────────────────────────────────
-- Flat categories for Phase 0. Phase 1 may add a parent_id for hierarchy;
-- we leave it out now because none of the forecasting inputs need it yet.
CREATE TABLE IF NOT EXISTS ip_category_master (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_code  text NOT NULL UNIQUE,
  name           text NOT NULL,
  -- Free-form channel hint: 'wholesale' | 'ecom' | 'both'. Stays text so
  -- merchandising can introduce new segments without a migration.
  segment        text,
  active         boolean NOT NULL DEFAULT true,
  external_refs  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_ip_category_master_updated ON ip_category_master;
CREATE TRIGGER trg_ip_category_master_updated BEFORE UPDATE ON ip_category_master
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── channel_master ───────────────────────────────────────────────────────────
-- Represents a sales channel or storefront. Wholesale has one row
-- (channel_type='wholesale'); ecom has one row per Shopify storefront.
CREATE TABLE IF NOT EXISTS ip_channel_master (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_code    text NOT NULL UNIQUE,
  name            text NOT NULL,
  channel_type    text NOT NULL CHECK (channel_type IN ('wholesale', 'ecom', 'marketplace', 'retail', 'other')),
  -- For ecom/marketplace channels, the external storefront id (Shopify
  -- shop domain, Amazon marketplace id, etc.)
  storefront_key  text,
  currency        text,
  timezone        text,
  active          boolean NOT NULL DEFAULT true,
  external_refs   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_ip_channel_master_updated ON ip_channel_master;
CREATE TRIGGER trg_ip_channel_master_updated BEFORE UPDATE ON ip_channel_master
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── customer_master ──────────────────────────────────────────────────────────
-- Wholesale-oriented. Ecom orders are attributed to a channel, not a
-- customer, so channel_id is nullable. `customer_tier` is a free-text
-- merchandising label ('major', 'boutique', etc.) — no enforced vocab.
CREATE TABLE IF NOT EXISTS ip_customer_master (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code  text NOT NULL UNIQUE,
  name           text NOT NULL,
  parent_customer_id uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  customer_tier  text,
  country        text,
  channel_id     uuid REFERENCES ip_channel_master(id) ON DELETE SET NULL,
  active         boolean NOT NULL DEFAULT true,
  external_refs  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_customer_master_name     ON ip_customer_master (lower(name));
CREATE INDEX IF NOT EXISTS idx_ip_customer_master_parent   ON ip_customer_master (parent_customer_id) WHERE parent_customer_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ip_customer_master_updated ON ip_customer_master;
CREATE TRIGGER trg_ip_customer_master_updated BEFORE UPDATE ON ip_customer_master
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── item_master ──────────────────────────────────────────────────────────────
-- One row per SKU. `style_code` is the merchandising base-part — multiple
-- SKUs (size/color variants) roll up to the same style. Kept as text (not
-- an FK) so items can arrive before a style row exists; a style_master
-- table can be added later if we need attributes on the style itself.
CREATE TABLE IF NOT EXISTS ip_item_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_code           text NOT NULL UNIQUE,
  style_code         text,
  description        text,
  category_id        uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  vendor_id          uuid REFERENCES ip_vendor_master(id)   ON DELETE SET NULL,
  color              text,
  size               text,
  -- Measured in the base unit (typically 'each'). Left text so pack/case
  -- units can be introduced without a migration.
  uom                text NOT NULL DEFAULT 'each',
  unit_cost          numeric(12, 4),
  unit_price         numeric(12, 4),
  lead_time_days     integer,
  moq_units          integer,
  -- 'active' | 'phased_out' | 'discontinued' | 'core' — free text, we just
  -- surface whatever merchandising assigns.
  lifecycle_status   text,
  -- Internal classification: 'core' | 'seasonal' | 'fashion' | null.
  planning_class     text,
  active             boolean NOT NULL DEFAULT true,
  external_refs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_item_master_style    ON ip_item_master (style_code) WHERE style_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_item_master_category ON ip_item_master (category_id);
CREATE INDEX IF NOT EXISTS idx_ip_item_master_vendor   ON ip_item_master (vendor_id);
CREATE INDEX IF NOT EXISTS idx_ip_item_master_active   ON ip_item_master (active);

DROP TRIGGER IF EXISTS trg_ip_item_master_updated ON ip_item_master;
CREATE TRIGGER trg_ip_item_master_updated BEFORE UPDATE ON ip_item_master
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── inventory_snapshot ───────────────────────────────────────────────────────
-- Point-in-time on-hand by SKU (+ optional warehouse). One row per
-- (sku_id, warehouse_code, snapshot_date). We keep snapshots forever;
-- Phase 1 will decide retention.
CREATE TABLE IF NOT EXISTS ip_inventory_snapshot (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id          uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE CASCADE,
  warehouse_code  text NOT NULL DEFAULT 'DEFAULT',
  snapshot_date   date NOT NULL,
  qty_on_hand     numeric(14, 3) NOT NULL,
  qty_available   numeric(14, 3),
  qty_committed   numeric(14, 3),
  qty_on_order    numeric(14, 3),
  qty_in_transit  numeric(14, 3),
  source          text NOT NULL CHECK (source IN ('xoro', 'shopify', 'manual')),
  raw_payload_id  uuid REFERENCES raw_xoro_payloads(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_inventory_snapshot
  ON ip_inventory_snapshot (sku_id, warehouse_code, snapshot_date, source);
CREATE INDEX IF NOT EXISTS idx_ip_inventory_snapshot_date ON ip_inventory_snapshot (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_ip_inventory_snapshot_sku  ON ip_inventory_snapshot (sku_id);

-- ── sales_history_wholesale ──────────────────────────────────────────────────
-- Fact table: one row per shipped/invoiced line from Xoro. The planning
-- period (e.g. weekly bucket) is computed downstream; we store the raw
-- transaction date so re-bucketing is cheap.
CREATE TABLE IF NOT EXISTS ip_sales_history_wholesale (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id          uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  customer_id     uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  category_id     uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  channel_id      uuid REFERENCES ip_channel_master(id) ON DELETE SET NULL,
  order_number    text,
  invoice_number  text,
  -- 'order' | 'ship' | 'invoice' — which date the row represents. Downstream
  -- forecasting picks the one it needs.
  txn_type        text NOT NULL,
  txn_date        date NOT NULL,
  qty             numeric(14, 3) NOT NULL,
  unit_price      numeric(12, 4),
  gross_amount    numeric(14, 4),
  discount_amount numeric(14, 4),
  net_amount      numeric(14, 4),
  currency        text,
  source          text NOT NULL DEFAULT 'xoro',
  raw_payload_id  uuid REFERENCES raw_xoro_payloads(id) ON DELETE SET NULL,
  -- Idempotency key so re-ingesting the same Xoro payload is safe.
  source_line_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_sales_wholesale_source_line
  ON ip_sales_history_wholesale (source, source_line_key);
CREATE INDEX IF NOT EXISTS idx_ip_sales_wholesale_sku_date
  ON ip_sales_history_wholesale (sku_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_ip_sales_wholesale_customer
  ON ip_sales_history_wholesale (customer_id);
CREATE INDEX IF NOT EXISTS idx_ip_sales_wholesale_date
  ON ip_sales_history_wholesale (txn_date);

-- ── sales_history_ecom ───────────────────────────────────────────────────────
-- Fact table: one row per Shopify order line (gross) with net_qty =
-- qty - returned_qty so forecasts can use sell-through directly.
CREATE TABLE IF NOT EXISTS ip_sales_history_ecom (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id          uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  channel_id      uuid NOT NULL REFERENCES ip_channel_master(id) ON DELETE RESTRICT,
  category_id     uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  order_number    text,
  order_date      date NOT NULL,
  qty             numeric(14, 3) NOT NULL,
  returned_qty    numeric(14, 3) NOT NULL DEFAULT 0,
  net_qty         numeric(14, 3) NOT NULL,
  gross_amount    numeric(14, 4),
  discount_amount numeric(14, 4),
  refund_amount   numeric(14, 4),
  net_amount      numeric(14, 4),
  currency        text,
  source          text NOT NULL DEFAULT 'shopify',
  raw_payload_id  uuid REFERENCES raw_shopify_payloads(id) ON DELETE SET NULL,
  source_line_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_sales_ecom_source_line
  ON ip_sales_history_ecom (source, source_line_key);
CREATE INDEX IF NOT EXISTS idx_ip_sales_ecom_sku_date
  ON ip_sales_history_ecom (sku_id, order_date);
CREATE INDEX IF NOT EXISTS idx_ip_sales_ecom_channel_date
  ON ip_sales_history_ecom (channel_id, order_date);

-- ── receipts_history ─────────────────────────────────────────────────────────
-- Factory / PO receipts. Separate from the portal `receipts` table on
-- purpose: that one tracks vendor-submitted proof; this one is the
-- authoritative Xoro-side record feeding planning.
CREATE TABLE IF NOT EXISTS ip_receipts_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id            uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  vendor_id         uuid REFERENCES ip_vendor_master(id) ON DELETE SET NULL,
  po_number         text,
  receipt_number    text,
  received_date     date NOT NULL,
  qty               numeric(14, 3) NOT NULL,
  warehouse_code    text,
  source            text NOT NULL DEFAULT 'xoro',
  raw_payload_id    uuid REFERENCES raw_xoro_payloads(id) ON DELETE SET NULL,
  source_line_key   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_receipts_source_line
  ON ip_receipts_history (source, source_line_key);
CREATE INDEX IF NOT EXISTS idx_ip_receipts_sku_date
  ON ip_receipts_history (sku_id, received_date);
CREATE INDEX IF NOT EXISTS idx_ip_receipts_vendor_date
  ON ip_receipts_history (vendor_id, received_date);

-- ── open_purchase_orders ─────────────────────────────────────────────────────
-- Mirror of the Xoro-side open PO book at the SKU/line level. Different
-- from tanda_pos, which is header+lines shaped for the internal WIP app;
-- here we flatten to one row per open line for fast join into planning.
CREATE TABLE IF NOT EXISTS ip_open_purchase_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id            uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  vendor_id         uuid REFERENCES ip_vendor_master(id) ON DELETE SET NULL,
  po_number         text NOT NULL,
  po_line_number    text,
  order_date        date,
  expected_date     date,
  qty_ordered       numeric(14, 3) NOT NULL,
  qty_received      numeric(14, 3) NOT NULL DEFAULT 0,
  qty_open          numeric(14, 3) NOT NULL,
  unit_cost         numeric(12, 4),
  currency          text,
  status            text,
  source            text NOT NULL DEFAULT 'xoro',
  raw_payload_id    uuid REFERENCES raw_xoro_payloads(id) ON DELETE SET NULL,
  source_line_key   text NOT NULL,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_open_pos_source_line
  ON ip_open_purchase_orders (source, source_line_key);
CREATE INDEX IF NOT EXISTS idx_ip_open_pos_sku_expected
  ON ip_open_purchase_orders (sku_id, expected_date);
CREATE INDEX IF NOT EXISTS idx_ip_open_pos_vendor
  ON ip_open_purchase_orders (vendor_id);

DROP TRIGGER IF EXISTS trg_ip_open_pos_updated ON ip_open_purchase_orders;
CREATE TRIGGER trg_ip_open_pos_updated BEFORE UPDATE ON ip_open_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── product_channel_status ───────────────────────────────────────────────────
-- Per-storefront merchandising status for a SKU: is it published, what's
-- its storefront price, etc. One row per (sku, channel) pair.
CREATE TABLE IF NOT EXISTS ip_product_channel_status (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id          uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES ip_channel_master(id) ON DELETE CASCADE,
  -- 'active' | 'draft' | 'archived' | 'unpublished' — upstream wording
  -- varies (Shopify uses 'active'/'draft'/'archived') so this is text.
  status          text,
  listed          boolean NOT NULL DEFAULT false,
  price           numeric(12, 4),
  compare_at_price numeric(12, 4),
  currency        text,
  published_at    timestamptz,
  unpublished_at  timestamptz,
  source          text NOT NULL,
  raw_payload_id  uuid,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_product_channel_status
  ON ip_product_channel_status (sku_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_ip_product_channel_status_channel
  ON ip_product_channel_status (channel_id);

DROP TRIGGER IF EXISTS trg_ip_product_channel_status_updated ON ip_product_channel_status;
CREATE TRIGGER trg_ip_product_channel_status_updated BEFORE UPDATE ON ip_product_channel_status
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── data_quality_issues ──────────────────────────────────────────────────────
-- Append-mostly: the data-quality scanner writes issues here, operators
-- resolve/dismiss them. `entity_*` is a loose pointer (table name + id) so
-- this one table can host issues across all planning entities.
CREATE TABLE IF NOT EXISTS ip_data_quality_issues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  category      text NOT NULL,
  message       text NOT NULL,
  entity_type   text,
  entity_id     uuid,
  entity_key    text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   text,
  resolution_notes text
);

CREATE INDEX IF NOT EXISTS idx_ip_dq_severity ON ip_data_quality_issues (severity);
CREATE INDEX IF NOT EXISTS idx_ip_dq_category ON ip_data_quality_issues (category);
CREATE INDEX IF NOT EXISTS idx_ip_dq_entity   ON ip_data_quality_issues (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_ip_dq_open     ON ip_data_quality_issues (resolved_at) WHERE resolved_at IS NULL;
-- Unique key per (category + entity_key) lets the scanner upsert the same
-- issue rather than creating duplicates on each run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_dq_open_key
  ON ip_data_quality_issues (category, entity_key)
  WHERE entity_key IS NOT NULL AND resolved_at IS NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Same convention as the vendor-portal tables: anon key (used by the
-- internal SPA) has full access. No authenticated-role policies because
-- none of this is exposed to the vendor portal in Phase 0.
ALTER TABLE raw_xoro_payloads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_shopify_payloads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_vendor_master          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_category_master        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_channel_master         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_customer_master        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_item_master            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_inventory_snapshot     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_sales_history_wholesale ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_sales_history_ecom     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_receipts_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_open_purchase_orders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_product_channel_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_data_quality_issues    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'raw_xoro_payloads', 'raw_shopify_payloads',
    'ip_vendor_master', 'ip_category_master', 'ip_channel_master',
    'ip_customer_master', 'ip_item_master',
    'ip_inventory_snapshot', 'ip_sales_history_wholesale',
    'ip_sales_history_ecom', 'ip_receipts_history',
    'ip_open_purchase_orders', 'ip_product_channel_status',
    'ip_data_quality_issues'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
