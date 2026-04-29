-- 20260504000000_ip_po_customer_and_open_sos.sql
--
-- Two related schema changes for the wholesale planning workbench:
--
-- 1. ip_open_purchase_orders gets a customer_id + buyer_name. The PO WIP
--    (TandA) app stores a BuyerName per PO that is either a real
--    customer ("Some Wholesale Co.") or a stock label
--    ("ROF Stock" / "PT Stock"). Customer-specific POs land on that
--    customer's grid row; stock POs land on the (Supply Only)
--    placeholder customer so the planner can see them as
--    customer-agnostic incoming supply.
--
-- 2. New ip_open_sales_orders table — per-line open SO data with a
--    ship_date so the grid's "On SO" column can finally bucket by
--    period. Source is the ATS app's parsed Excel SOs (ats_excel_data
--    JSON blob), copied here by ats-supply-sync. Mirrors the
--    ip_open_purchase_orders shape so buildGridRows can reuse the
--    period-filter pattern.

-- ── 1. customer_id on open POs ───────────────────────────────────────────────

ALTER TABLE ip_open_purchase_orders
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS buyer_name  text;

CREATE INDEX IF NOT EXISTS idx_ip_open_pos_customer
  ON ip_open_purchase_orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_ip_open_pos_customer_sku_expected
  ON ip_open_purchase_orders (customer_id, sku_id, expected_date);

-- ── 2. ip_open_sales_orders ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ip_open_sales_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id            uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  customer_id       uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  customer_name     text,
  so_number         text,
  ship_date         date,
  cancel_date       date,
  qty_ordered       numeric(14, 3) NOT NULL DEFAULT 0,
  qty_shipped       numeric(14, 3) NOT NULL DEFAULT 0,
  qty_open          numeric(14, 3) NOT NULL,
  unit_price        numeric(12, 4),
  currency          text,
  status            text,
  store             text,
  source            text NOT NULL DEFAULT 'ats',
  source_line_key   text NOT NULL,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_open_sos_source_line
  ON ip_open_sales_orders (source, source_line_key);
CREATE INDEX IF NOT EXISTS idx_ip_open_sos_sku_ship
  ON ip_open_sales_orders (sku_id, ship_date);
CREATE INDEX IF NOT EXISTS idx_ip_open_sos_customer_sku_ship
  ON ip_open_sales_orders (customer_id, sku_id, ship_date);

DROP TRIGGER IF EXISTS trg_ip_open_sos_updated ON ip_open_sales_orders;
CREATE TRIGGER trg_ip_open_sos_updated BEFORE UPDATE ON ip_open_sales_orders
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- Mirror the phase 0 anon-permissive policy used by every other planning
-- table — browser-side ATS sync writes through the anon key.
ALTER TABLE ip_open_sales_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_ip_open_sales_orders" ON ip_open_sales_orders;
CREATE POLICY "anon_all_ip_open_sales_orders" ON ip_open_sales_orders
  FOR ALL TO anon
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ip_open_sales_orders TO anon;
