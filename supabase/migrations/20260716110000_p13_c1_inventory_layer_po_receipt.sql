-- P13 / C1 — allow inventory_layers.source_kind = 'po_receipt'.
-- Receiving (M38) creates FIFO layers directly from a PO goods-receipt at landed
-- unit cost (distinct from the AP-invoice path). Adds the new kind to the CHECK
-- (keeping all existing values). Idempotent.

ALTER TABLE inventory_layers DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check;
ALTER TABLE inventory_layers ADD CONSTRAINT inventory_layers_source_kind_check
  CHECK (source_kind = ANY (ARRAY[
    'ap_invoice','adjustment','opening_balance','transfer_in','credit_memo_return',
    'xoro_mirror_snapshot','shopify_refund_restock','fba_inbound','wfs_inbound',
    'fba_return_restock','wfs_return_restock','xoro_rest_size',
    'po_receipt'
  ]::text[]));

NOTIFY pgrst, 'reload schema';
