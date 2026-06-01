-- P16 / M44 — Carrier / fulfilment (outbound sales-order shipments + tracking).
--
-- NOTE: `shipments`/`shipment_lines` already exist for INBOUND vendor/PO freight
-- (sealine/BL/containers). These OUTBOUND sales-order shipments use distinct
-- names: sales_order_shipments / sales_order_shipment_lines.
--
-- Shipping an allocated SO records carrier + tracking, bumps each line's
-- qty_shipped, flips lines/header toward 'shipped', and feeds M10-C invoicing.
-- Physical/logistics record only — COGS/FIFO consumption still happens at
-- invoice post. The factored-customer ship-gate is enforced in the handler.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS sales_order_shipments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  sales_order_id     uuid NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  carrier            text,
  service_level      text,
  tracking_number    text,
  ship_date          date NOT NULL DEFAULT current_date,
  status             text NOT NULL DEFAULT 'shipped'
                       CHECK (status IN ('pending','shipped','delivered','cancelled')),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_so_shipments_so ON sales_order_shipments (sales_order_id);
CREATE INDEX IF NOT EXISTS idx_so_shipments_tracking ON sales_order_shipments (tracking_number) WHERE tracking_number IS NOT NULL;
COMMENT ON TABLE sales_order_shipments IS 'P16/M44 — outbound carrier shipment against a sales order (carrier/tracking/ship_date). Lines in sales_order_shipment_lines bump sales_order_lines.qty_shipped.';

CREATE TABLE IF NOT EXISTS sales_order_shipment_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id         uuid NOT NULL REFERENCES sales_order_shipments(id) ON DELETE CASCADE,
  sales_order_line_id uuid NOT NULL REFERENCES sales_order_lines(id) ON DELETE RESTRICT,
  qty                 numeric(18,4) NOT NULL CHECK (qty > 0),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_so_shipment_lines_shipment ON sales_order_shipment_lines (shipment_id);
CREATE INDEX IF NOT EXISTS idx_so_shipment_lines_so_line ON sales_order_shipment_lines (sales_order_line_id);
COMMENT ON TABLE sales_order_shipment_lines IS 'P16/M44 — per-line shipped quantity within an outbound sales-order shipment.';

-- T11 audit + anon-read RLS (writes via service-role handler), matching sales_orders.
DROP TRIGGER IF EXISTS trg_so_shipments_audit ON sales_order_shipments;
CREATE TRIGGER trg_so_shipments_audit AFTER INSERT OR UPDATE OR DELETE ON sales_order_shipments
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

ALTER TABLE sales_order_shipments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_so_shipments" ON sales_order_shipments;
CREATE POLICY "anon_read_so_shipments" ON sales_order_shipments FOR SELECT TO anon USING (true);
ALTER TABLE sales_order_shipment_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_so_shipment_lines" ON sales_order_shipment_lines;
CREATE POLICY "anon_read_so_shipment_lines" ON sales_order_shipment_lines FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
