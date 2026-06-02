-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P4-2 follow-up: extend inventory_layers.source_kind CHECK
--
-- P4-2's arCreditMemo posting rule emits inventoryLayers[] entries with
-- source_kind='credit_memo_return' when an AR credit memo line returns
-- inventory (DR inventory_asset / CR cogs + a new layer at the resolved
-- return cost). The original P3-3 CHECK constraint only permitted
-- {ap_invoice, adjustment, opening_balance, transfer_in}, so the postEvent
-- layer-creation drain would have failed at INSERT time with a CHECK
-- violation.
--
-- Drop + recreate the constraint with the new value included. Also bump
-- the column COMMENT so the schema documents the new value.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE inventory_layers
  DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check;

ALTER TABLE inventory_layers
  ADD CONSTRAINT inventory_layers_source_kind_check
  CHECK (source_kind IN (
    'ap_invoice',
    'adjustment',
    'opening_balance',
    'transfer_in',
    'credit_memo_return'
  ));

COMMENT ON COLUMN inventory_layers.source_kind IS
  'ap_invoice | adjustment | opening_balance | transfer_in | credit_memo_return. source_invoice_id is set when source_kind=ap_invoice; source_adjustment_id when source_kind=adjustment. credit_memo_return layers carry the credit memo id in notes (FK column added in a later chunk).';

NOTIFY pgrst, 'reload schema';
