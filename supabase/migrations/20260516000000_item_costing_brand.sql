-- 20260516000000_item_costing_brand.sql
--
-- Extends ip_item_avg_cost so it can carry the full payload of Xoro's
-- "Item Costing Report (Average Cost) 5" — not just the avg unit cost but
-- also the brand name and the Standard Unit Price. The new Xoro nightly
-- (post_item_costing.py → /api/xoro/sync-item-costing) writes all three
-- with source='xoro'.
--
-- Why these columns live on ip_item_avg_cost rather than ip_item_master:
--   - The costing report is the canonical Xoro-authoritative source.
--     ip_item_master.unit_cost is poisoned in places by historical Excel
--     uploads that wrote (StandardUnitCost × MasterCaseQty) — multiple
--     SKUs show as $160.80 when the real unit cost is $6.70. Keeping the
--     trusted values in a separate table insulates them from that bad
--     data and lets the cost-resolution helper prefer them explicitly.
--   - brand_name is co-located here because the same Xoro report is the
--     source of record for both fields. Consumers that need brand can
--     join ip_item_avg_cost without an extra ip_item_master fetch.

ALTER TABLE ip_item_avg_cost
  ADD COLUMN IF NOT EXISTS brand_name          text,
  ADD COLUMN IF NOT EXISTS standard_unit_price numeric(12, 4);

-- The CHECK on avg_cost > 0 was tight enough to reject the legitimate
-- pattern where a SKU has brand+price but no avg_cost yet (Xoro emits
-- blank Average Cost for items that haven't moved). Relax to allow
-- null avg_cost so the costing handler can upsert brand-only rows.
ALTER TABLE ip_item_avg_cost
  ALTER COLUMN avg_cost DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'ip_item_avg_cost_avg_cost_check'
  ) THEN
    EXECUTE 'ALTER TABLE ip_item_avg_cost DROP CONSTRAINT ip_item_avg_cost_avg_cost_check';
  END IF;
END $$;

ALTER TABLE ip_item_avg_cost
  ADD CONSTRAINT ip_item_avg_cost_avg_cost_nonneg
    CHECK (avg_cost IS NULL OR avg_cost >= 0);

CREATE INDEX IF NOT EXISTS ip_item_avg_cost_brand_idx
  ON ip_item_avg_cost (brand_name)
  WHERE brand_name IS NOT NULL;
