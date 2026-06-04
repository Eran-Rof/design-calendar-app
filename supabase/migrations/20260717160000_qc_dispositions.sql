-- P13 GL Chunk 3 — QC failure dispositions.
--
-- The QC tables (tanda_po_qc_inspections / _findings) recorded inspections only,
-- with no disposition model. This adds the disposition lifecycle so a QC fail
-- can be acted on with its GL effect:
--   write_off          DR Inventory Write-off (6420) / CR Inventory (FIFO consume)
--   vendor_credit_only DR AP (vendor) / CR Inventory (FIFO consume) + AP credit memo
--   vendor_rma         record only (goods returned; AP credit handled when the
--                      vendor processes the RMA — no GL here)
--   rework_inhouse     move units to a rework location (no GL value change)

-- Counter account for QC write-offs (no inventory write-off / shrinkage account
-- exists yet). 6420 sits in the operating-expense range. Idempotent.
DO $$
DECLARE v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NOT NULL THEN
    INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
      VALUES (v_rof, '6420', 'Inventory Write-off', 'expense', 'DEBIT', true, 'active')
      ON CONFLICT (entity_id, code) DO NOTHING;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tanda_po_qc_dispositions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                        REFERENCES entities(id) ON DELETE RESTRICT,
  inspection_id       uuid NOT NULL REFERENCES tanda_po_qc_inspections(id) ON DELETE CASCADE,
  receipt_line_id     uuid REFERENCES tanda_po_receipt_lines(id) ON DELETE SET NULL,
  item_id             uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  disposition         text NOT NULL CHECK (disposition IN ('write_off','vendor_credit_only','vendor_rma','rework_inhouse')),
  qty                 numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_cost_cents     bigint,              -- snapshot of the receipt-line landed unit cost
  reason              text NOT NULL CHECK (length(btrim(reason)) > 0),
  -- GL / side-effect links (set as each disposition is executed):
  adjustment_id       uuid REFERENCES inventory_adjustments(id) ON DELETE SET NULL,  -- write_off
  credit_invoice_id   uuid REFERENCES invoices(id) ON DELETE SET NULL,               -- vendor_credit_only
  je_id               uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  rework_location_id  uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,     -- rework_inhouse
  status              text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','recorded')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_qc_dispositions_inspection ON tanda_po_qc_dispositions (inspection_id);

COMMENT ON TABLE tanda_po_qc_dispositions IS 'QC failure dispositions (P13 GL-C3): write_off / vendor_credit_only / vendor_rma / rework_inhouse, with their GL + side-effect links.';

NOTIFY pgrst, 'reload schema';
