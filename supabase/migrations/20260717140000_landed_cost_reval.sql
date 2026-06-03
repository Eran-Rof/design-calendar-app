-- P13 GL Chunk 4 — landed-cost revaluation support.
--
-- Late landed costs (customs duty / broker freight) arrive AFTER a goods
-- receipt has posted. When the broker invoice is posted, its cost is spread
-- across the receipt's accepted units (by value): the share on units STILL in
-- stock revalues those FIFO layers up (DR Inventory); the share on units
-- ALREADY sold is expensed to a COGS landed-cost variance account (DR 5150) —
-- consumed units stay at their original receipt cost (no retroactive COGS
-- restatement). The credit is the broker AP bill (CR AP).
--
-- 1. Seed 5150 'Landed Cost Variance' (COGS-range expense; 5100-5130 are the
--    sibling landed-cost accounts). 5140 is taken (Trade Shows).
-- 2. Link a broker invoice to the NATIVE receipt it lands costs onto. The
--    legacy customs_entry_lines.receipt_line_item_id FK points at the legacy
--    receipt_line_items table, not the native tanda_po_receipt_lines that hold
--    inventory_layer_id, so allocation targets the native receipt directly.

DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping 5150 seed; rerun once entity exists';
    RETURN;
  END IF;
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '5150', 'Landed Cost Variance', 'expense', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

ALTER TABLE broker_invoices
  ADD COLUMN IF NOT EXISTS tanda_po_receipt_id uuid REFERENCES tanda_po_receipts(id) ON DELETE SET NULL;

COMMENT ON COLUMN broker_invoices.tanda_po_receipt_id IS 'Native goods receipt this broker/customs cost is allocated onto (P13 GL-C4 landed-cost revaluation).';

NOTIFY pgrst, 'reload schema';
