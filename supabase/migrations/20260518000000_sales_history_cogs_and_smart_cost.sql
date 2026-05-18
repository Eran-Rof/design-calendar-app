-- Sales-history: add cogs_amount + re-derive cost/margin with the
-- smart cost-grain rule.
--
-- Background: migration 20260517230000 added unit_cost_at_sale by
-- unconditionally dividing master.unit_cost by pack_size. That's
-- correct for pack-grain sales of true prepacks (Xoro records master
-- cost per-pack for those), but produces implausibly low per-unit
-- costs — and impossibly high margin % — for:
--   (a) variant SKUs whose master.unit_cost is already stored
--       per-unit, AND pack_size > 1 (mis-tagged by the earlier
--       regex backfill in 20260517220000).
--   (b) any unit-grain sale of a prepack family where the variant's
--       master cost is already per-unit.
--
-- Smart rule (mirrors api/_lib/sales-grain.js::resolvePerUnitCost):
--   1. Pack-grain sale -> cost is per-pack (Xoro convention) -> divide.
--   2. Unit-grain sale where master cost > 2 x per-unit sale price
--      -> cost is implausibly high vs price, almost certainly stored
--        at per-pack grain -> divide.
--   3. Otherwise -> master cost is per-unit, use as-is.
--
-- Also adds the cogs_amount column requested for analytics. Identity:
-- cogs_amount + margin_amount = net_amount whenever both are set.

BEGIN;

ALTER TABLE ip_sales_history_wholesale
  ADD COLUMN IF NOT EXISTS cogs_amount numeric(14, 4);

-- Re-derive unit_cost_at_sale + cogs_amount + margin_amount +
-- margin_pct for EVERY row (not just NULLs) — the earlier migration
-- populated these with the wrong-grain divider on the anomaly cases.
WITH derived AS (
  SELECT
    s.id,
    s.qty_grain,
    s.qty_units,
    s.net_amount,
    m.unit_cost AS master_cost,
    GREATEST(COALESCE(m.pack_size, 1), 1)::numeric AS pack_size,
    CASE
      WHEN m.unit_cost IS NULL THEN NULL
      WHEN s.qty_grain = 'pack' THEN m.unit_cost / GREATEST(COALESCE(m.pack_size, 1), 1)::numeric
      WHEN s.net_amount IS NOT NULL AND s.net_amount > 0
           AND s.qty_units IS NOT NULL AND s.qty_units > 0
           AND m.unit_cost > 2 * (s.net_amount / s.qty_units)
        THEN m.unit_cost / GREATEST(COALESCE(m.pack_size, 1), 1)::numeric
      ELSE m.unit_cost
    END AS new_unit_cost_at_sale
  FROM ip_sales_history_wholesale s
  JOIN ip_item_master m ON m.id = s.sku_id
)
UPDATE ip_sales_history_wholesale s
SET
  unit_cost_at_sale = d.new_unit_cost_at_sale,
  cogs_amount = CASE
    WHEN d.new_unit_cost_at_sale IS NOT NULL AND s.qty_units IS NOT NULL
      THEN s.qty_units * d.new_unit_cost_at_sale
    ELSE NULL
  END,
  margin_amount = CASE
    WHEN s.net_amount IS NOT NULL AND s.net_amount > 0
         AND d.new_unit_cost_at_sale IS NOT NULL AND s.qty_units IS NOT NULL
      THEN s.net_amount - (s.qty_units * d.new_unit_cost_at_sale)
    ELSE NULL
  END,
  margin_pct = CASE
    WHEN s.net_amount IS NOT NULL AND s.net_amount > 0
         AND d.new_unit_cost_at_sale IS NOT NULL AND s.qty_units IS NOT NULL
      THEN (s.net_amount - (s.qty_units * d.new_unit_cost_at_sale)) / s.net_amount
    ELSE NULL
  END
FROM derived d
WHERE s.id = d.id;

COMMENT ON COLUMN ip_sales_history_wholesale.cogs_amount IS
  'Cost of goods sold per row: qty_units * unit_cost_at_sale. Identity: cogs_amount + margin_amount = net_amount. Snapshot at sync time — cost-at-shipping-time accuracy ships in a follow-up via ip_item_avg_cost_history.';
COMMENT ON COLUMN ip_sales_history_wholesale.unit_cost_at_sale IS
  'Per-unit cost. Resolved at sync via the smart cost-grain rule: pack-grain sale -> master.unit_cost / pack_size; unit-grain sale -> master.unit_cost (or master.unit_cost / pack_size when master cost > 2x unit sale price, indicating it is stored at per-pack grain). Snapshot stable under future master.unit_cost updates.';

COMMIT;
