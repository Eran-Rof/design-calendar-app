-- Extend inventory_layers.source_kind CHECK with 'xoro_rest_size'.
--
-- WHY: the Tangerine Inventory Matrix on-hand is fed by `inventory_layers`
-- (Σ remaining_qty, all source_kinds). The seed layers are source_kind
-- 'opening_balance' (migration P3-3, "Seeded from ip_inventory_snapshot").
-- The size-grain cutover (scripts/ingest-size-onhand.mjs --apply --style …)
-- REPLACES a style's color-grain opening_balance layers with per-SIZE layers
-- sourced from the nightly Xoro REST snapshot. Those replacement layers carry a
-- DISTINCT source_kind so the cutover is reversible (zero the opening_balance
-- layers back to their original remaining_qty, delete the xoro_rest_size rows)
-- and so reporting can tell seed from REST-size on-hand.
--
-- Current values (per 20260527070000 + 20260528110000 + 20260620000000 +
-- 20260629100000 + 20260629200000):
--   ap_invoice / adjustment / opening_balance / transfer_in /
--   credit_memo_return / xoro_mirror_snapshot / shopify_refund_restock /
--   fba_inbound / wfs_inbound / fba_return_restock / wfs_return_restock
--
-- This adds 'xoro_rest_size'. Idempotent: DROP IF EXISTS then re-ADD.

ALTER TABLE inventory_layers
  DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check;

ALTER TABLE inventory_layers
  ADD CONSTRAINT inventory_layers_source_kind_check
  CHECK (source_kind IN (
    'ap_invoice',
    'adjustment',
    'opening_balance',
    'transfer_in',
    'credit_memo_return',
    'xoro_mirror_snapshot',
    'shopify_refund_restock',
    'fba_inbound',
    'wfs_inbound',
    'fba_return_restock',
    'wfs_return_restock',
    'xoro_rest_size'
  ));

COMMENT ON COLUMN inventory_layers.source_kind IS 'Added xoro_rest_size: per-SIZE on-hand layers landed by scripts/ingest-size-onhand.mjs from the nightly Xoro REST snapshot, replacing a style''s color-grain opening_balance seed (reversible). P12-0 added fba/wfs values; P11-1 shopify_refund_restock; T10-1 xoro_mirror_snapshot; P4-2 credit_memo_return; P3-3 original ap_invoice / adjustment / opening_balance / transfer_in.';
