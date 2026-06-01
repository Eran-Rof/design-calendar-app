-- P16 / M11 — native Purchase Orders (origination).
CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  brand_id uuid REFERENCES brand_master(id) ON DELETE SET NULL DEFAULT rof_default_brand_id(),
  po_number text,
  order_date date NOT NULL DEFAULT current_date,
  expected_date date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','in_transit','received','cancelled')),
  currency text NOT NULL DEFAULT 'USD',
  payment_terms_id uuid REFERENCES payment_terms(id) ON DELETE SET NULL,
  notes text, subtotal_cents bigint NOT NULL DEFAULT 0, total_cents bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_number ON purchase_orders (entity_id, po_number) WHERE po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor ON purchase_orders (vendor_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders (status);
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  inventory_item_id uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  description text, qty_ordered numeric(18,4) NOT NULL DEFAULT 0, qty_received numeric(18,4) NOT NULL DEFAULT 0,
  unit_cost_cents bigint NOT NULL DEFAULT 0, line_total_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','received','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_lines_po ON purchase_order_lines (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_po_lines_item ON purchase_order_lines (inventory_item_id);
DROP TRIGGER IF EXISTS trg_purchase_orders_audit ON purchase_orders;
CREATE TRIGGER trg_purchase_orders_audit AFTER INSERT OR UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();
DROP TRIGGER IF EXISTS trg_purchase_order_lines_audit ON purchase_order_lines;
CREATE TRIGGER trg_purchase_order_lines_audit AFTER INSERT OR UPDATE OR DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_purchase_orders" ON purchase_orders;
CREATE POLICY "anon_read_purchase_orders" ON purchase_orders FOR SELECT TO anon USING (true);
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_purchase_order_lines" ON purchase_order_lines;
CREATE POLICY "anon_read_purchase_order_lines" ON purchase_order_lines FOR SELECT TO anon USING (true);
NOTIFY pgrst, 'reload schema';
