-- Phantom on-hand recurrence fix (Option A): the nightly on-hand sync rebuilds
-- Tangerine's synced on-hand inventory_layers from the authoritative ATS/Xoro
-- snapshot. It owns a dedicated source_kind, 'xoro_onhand_sync', so it can
-- drop-and-rebuild its own layers without ever touching the opening_balance
-- seed, the by-size cutover layers (xoro_rest_size), or native FIFO layers
-- (ap_invoice / po_receipt / adjustment / manufacture / transfer_in / ...).
--
-- Idempotent: drop + re-add the CHECK with the extra allowed value.
alter table inventory_layers drop constraint if exists inventory_layers_source_kind_check;
alter table inventory_layers add constraint inventory_layers_source_kind_check
  check (source_kind = any (array[
    'ap_invoice','adjustment','opening_balance','transfer_in','credit_memo_return',
    'xoro_mirror_snapshot','shopify_refund_restock','fba_inbound','wfs_inbound',
    'fba_return_restock','wfs_return_restock','xoro_rest_size','po_receipt','manufacture',
    'xoro_onhand_sync'
  ]));
