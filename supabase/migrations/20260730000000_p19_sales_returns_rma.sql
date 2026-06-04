-- P19 / M23 — Customer Returns & RMA.
--
-- The reverse of the sales flow. A customer return (RMA) is received, each
-- line is dispositioned (restock → goods go back on the books; scrap → goods
-- are written off), then a customer **credit memo** is issued. The credit memo
-- reuses the existing `arCreditMemo` posting rule (reverses revenue + reduces
-- AR; restock lines auto-restock FIFO via source_kind='credit_memo_return' and
-- reverse COGS). This migration adds only the RMA workflow tables + the Sales
-- Returns contra-revenue account; all GL machinery already exists (P4).

-- 1. Sales Returns & Allowances (contra-revenue) — so returns show separately
--    from gross sales on the P&L instead of just netting into 4000-revenue.
DO $$
DECLARE v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping 4100 seed; rerun once entity exists';
    RETURN;
  END IF;
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '4100', 'Sales Returns & Allowances', 'contra_revenue', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

-- 2. RMA header.
CREATE TABLE IF NOT EXISTS sales_returns (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id              uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  rma_number               text,                      -- assigned on approve: RMA-YYYY-NNNNN
  original_sales_order_id  uuid REFERENCES sales_orders(id) ON DELETE SET NULL,
  original_ar_invoice_id   uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'requested'
                             CHECK (status IN ('requested','approved','received','credited','closed','cancelled')),
  reason                   text,
  restocking_fee_cents     bigint NOT NULL DEFAULT 0 CHECK (restocking_fee_cents >= 0),
  credit_memo_id           uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,  -- set when credit memo issued
  notes                    text,
  requested_at             timestamptz NOT NULL DEFAULT now(),
  approved_at              timestamptz,
  received_at              timestamptz,
  credited_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid
);
CREATE INDEX IF NOT EXISTS ix_sales_returns_customer ON sales_returns(entity_id, customer_id);
CREATE INDEX IF NOT EXISTS ix_sales_returns_status   ON sales_returns(entity_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_returns_rma_number ON sales_returns(entity_id, rma_number) WHERE rma_number IS NOT NULL;

-- 3. RMA lines.
CREATE TABLE IF NOT EXISTS sales_return_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_return_id       uuid NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  line_number           int  NOT NULL,
  inventory_item_id     uuid REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  sales_order_line_id   uuid REFERENCES sales_order_lines(id) ON DELETE SET NULL,
  description           text,
  qty_returned          numeric(18,4) NOT NULL CHECK (qty_returned > 0),
  unit_price_cents      bigint NOT NULL DEFAULT 0,   -- original sale price → credit amount per unit
  disposition           text NOT NULL DEFAULT 'pending'
                          CHECK (disposition IN ('pending','restock','scrap')),
  restock_location_id   uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  reason                text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_sales_return_lines_return ON sales_return_lines(sales_return_id);

-- 4. RLS — anon read-only (writes go through the service-role admin API), as
--    every other Tangerine operational table (SaaS isolation deferred).
ALTER TABLE sales_returns ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='sales_returns' AND policyname='anon_read_sales_returns') THEN
    CREATE POLICY "anon_read_sales_returns" ON sales_returns FOR SELECT TO anon USING (true);
  END IF;
END $$;
ALTER TABLE sales_return_lines ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='sales_return_lines' AND policyname='anon_read_sales_return_lines') THEN
    CREATE POLICY "anon_read_sales_return_lines" ON sales_return_lines FOR SELECT TO anon USING (true);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
