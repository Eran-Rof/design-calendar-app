-- P16 / M10-A — native Sales Orders schema (header + lines).
--
-- Today ip_open_sales_orders is a read-only Xoro feed; this adds first-class SO
-- entry. Inert until the M10-B entry panel ships. Brand/channel/entity scoped +
-- T11 audited + anon-read-only RLS (writes go through the service-role handler),
-- matching the AR/AP invoice tables.

-- ─── 1. sales_orders (header) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  brand_id            uuid REFERENCES brand_master(id) ON DELETE RESTRICT DEFAULT rof_default_brand_id(),
  channel_id          uuid REFERENCES channel_master(id) ON DELETE RESTRICT,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  ship_to_location_id uuid REFERENCES customer_locations(id) ON DELETE SET NULL,
  so_number           text,                       -- system-assigned on confirm; immutable
  order_date          date NOT NULL DEFAULT current_date,
  requested_ship_date date,
  cancel_date         date,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','confirmed','allocated','fulfilling','shipped','invoiced','closed','cancelled')),
  currency            text NOT NULL DEFAULT 'USD',
  payment_terms_id    uuid REFERENCES payment_terms(id) ON DELETE SET NULL,
  ar_account_id       uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  revenue_account_id  uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  notes               text,
  subtotal_cents      bigint NOT NULL DEFAULT 0,
  total_cents         bigint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_orders_number ON sales_orders (entity_id, so_number) WHERE so_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_customer ON sales_orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_entity   ON sales_orders (entity_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_status   ON sales_orders (status);
CREATE INDEX IF NOT EXISTS idx_sales_orders_brand    ON sales_orders (brand_id);

COMMENT ON TABLE sales_orders IS 'P16/M10 native sales order header. so_number system-assigned on confirm (immutable). Status: draft→confirmed→allocated→fulfilling→shipped→invoiced→closed (+cancelled).';

-- ─── 2. sales_order_lines ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id     uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  line_number        integer NOT NULL,
  inventory_item_id  uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  description        text,
  qty_ordered        numeric(18,4) NOT NULL DEFAULT 0,
  qty_allocated      numeric(18,4) NOT NULL DEFAULT 0,
  qty_shipped        numeric(18,4) NOT NULL DEFAULT 0,
  qty_invoiced       numeric(18,4) NOT NULL DEFAULT 0,
  unit_price_cents   bigint NOT NULL DEFAULT 0,
  line_total_cents   bigint NOT NULL DEFAULT 0,
  revenue_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','allocated','shipped','invoiced','cancelled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sol_order ON sales_order_lines (sales_order_id);
CREATE INDEX IF NOT EXISTS idx_sol_item  ON sales_order_lines (inventory_item_id);

COMMENT ON TABLE sales_order_lines IS 'P16/M10 sales order line. qty_allocated/shipped/invoiced track downstream fulfillment (M18 allocation, M44 carrier, M10-C invoicing).';

-- ─── 3. T11 audit + RLS (anon read-only; writes via service-role handler) ─────
DROP TRIGGER IF EXISTS trg_sales_orders_audit ON sales_orders;
CREATE TRIGGER trg_sales_orders_audit
  AFTER INSERT OR UPDATE OR DELETE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();
DROP TRIGGER IF EXISTS trg_sales_order_lines_audit ON sales_order_lines;
CREATE TRIGGER trg_sales_order_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_sales_orders" ON sales_orders;
CREATE POLICY "anon_read_sales_orders" ON sales_orders FOR SELECT TO anon USING (true);
ALTER TABLE sales_order_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_sales_order_lines" ON sales_order_lines;
CREATE POLICY "anon_read_sales_order_lines" ON sales_order_lines FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
