-- P20 / M49 — Drop-ship management.
--
-- A drop-ship order is fulfilled DIRECTLY by the vendor shipping to the
-- customer — the goods never pass through our warehouse, so there is NO
-- inventory movement (no FIFO layer in/out). The economics are simply:
-- customer price (revenue / AR) vs vendor cost (COGS / AP), with the margin
-- captured per line. This migration adds the order-management layer; the
-- AR-invoice + AP-bill generation is a follow-up (and is gated on the COA
-- having standard AR / Revenue / COGS / AP accounts — see OPERATOR-TODO).

CREATE TABLE IF NOT EXISTS drop_ship_orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id            uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vendor_id              uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  sales_order_id         uuid REFERENCES sales_orders(id) ON DELETE SET NULL,
  ds_number              text,                    -- assigned on confirm: DS-YYYY-NNNNN
  status                 text NOT NULL DEFAULT 'requested'
                           CHECK (status IN ('requested','confirmed','shipped','delivered','closed','cancelled')),
  ship_to                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- snapshot of the customer ship-to (editable)
  carrier                text,
  tracking_number        text,
  expected_ship_date     date,
  shipped_at             timestamptz,
  delivered_at           timestamptz,
  purchase_order_id      uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,  -- optional drop-ship PO link
  ar_invoice_id          uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,      -- customer invoice (future)
  ap_invoice_id          uuid REFERENCES invoices(id) ON DELETE SET NULL,         -- vendor bill (future)
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  confirmed_at           timestamptz,
  created_by_user_id     uuid
);
CREATE INDEX IF NOT EXISTS ix_drop_ship_orders_customer ON drop_ship_orders(entity_id, customer_id);
CREATE INDEX IF NOT EXISTS ix_drop_ship_orders_vendor   ON drop_ship_orders(entity_id, vendor_id);
CREATE INDEX IF NOT EXISTS ix_drop_ship_orders_status   ON drop_ship_orders(entity_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_drop_ship_orders_ds_number ON drop_ship_orders(entity_id, ds_number) WHERE ds_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS drop_ship_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_ship_order_id        uuid NOT NULL REFERENCES drop_ship_orders(id) ON DELETE CASCADE,
  line_number               int  NOT NULL,
  inventory_item_id         uuid REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  sales_order_line_id       uuid REFERENCES sales_order_lines(id) ON DELETE SET NULL,
  description               text,
  qty                       numeric(18,4) NOT NULL CHECK (qty > 0),
  customer_unit_price_cents bigint NOT NULL DEFAULT 0,   -- what the customer is billed (revenue)
  vendor_unit_cost_cents    bigint NOT NULL DEFAULT 0,   -- what the vendor charges us (COGS)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_drop_ship_lines_order ON drop_ship_lines(drop_ship_order_id);

-- RLS — anon read-only (writes via the service-role admin API), like other
-- Tangerine operational tables.
ALTER TABLE drop_ship_orders ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='drop_ship_orders' AND policyname='anon_read_drop_ship_orders') THEN
    CREATE POLICY "anon_read_drop_ship_orders" ON drop_ship_orders FOR SELECT TO anon USING (true);
  END IF;
END $$;
ALTER TABLE drop_ship_lines ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='drop_ship_lines' AND policyname='anon_read_drop_ship_lines') THEN
    CREATE POLICY "anon_read_drop_ship_lines" ON drop_ship_lines FOR SELECT TO anon USING (true);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
