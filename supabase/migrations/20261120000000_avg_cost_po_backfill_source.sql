-- 20261120000000_avg_cost_po_backfill_source.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Allow a 'po_backfill' source on ip_item_avg_cost so the Inventory Aging cost
-- back-fill (weighted-avg unit cost derived from native + Xoro PO lines, for
-- items with no cost on file) can be stored WITH provenance — distinct from the
-- real feed sources ('xoro' / 'excel' / 'manual'), so it is filterable and
-- reversible. Back-fill writes only this table (a report cost fallback); no GL,
-- on-hand, or inventory-layer impact.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE ip_item_avg_cost DROP CONSTRAINT IF EXISTS ip_item_avg_cost_source_check;

ALTER TABLE ip_item_avg_cost
  ADD CONSTRAINT ip_item_avg_cost_source_check
  CHECK (source = ANY (ARRAY['xoro'::text, 'excel'::text, 'manual'::text, 'po_backfill'::text]));
