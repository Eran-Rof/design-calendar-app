-- Sales-history: suppress unit_cost_at_sale / cogs_amount / margin_*
-- when master.unit_cost is zero, null, or negative.
--
-- Background: spot-check on prod surfaced 197 rows with margin_pct >
-- 0.85, mostly clustered on a few prepack master rows (RCB0975N-* etc.)
-- whose master.unit_cost is $0.00 — a data-quality gap, not a real
-- free-cost good. The previous migration's smart-cost rule still
-- emitted cogs=0 / margin_pct=1.0 for these, polluting the average
-- margin (which jumped to 38% vs. the operator's stated 19-25% band).
--
-- Mirrors the corresponding api/_lib/sales-grain.js change:
--   resolvePerUnitCost now returns null when master.unit_cost <= 0,
--   which propagates to null cogs/margin in deriveSalesGrainFields.
--
-- Effect: the export renders blank margin cells for these rows
-- (operator reads "unknown", not "100%"). Same change drops the
-- ~38% average margin down toward the true band once the polluting
-- rows are excluded from aggregates.

BEGIN;

WITH derived AS (
  SELECT
    s.id,
    s.qty_grain,
    s.qty_units,
    s.net_amount,
    m.unit_cost AS master_cost,
    GREATEST(COALESCE(m.pack_size, 1), 1)::numeric AS pack_size,
    CASE
      -- NEW: master cost missing OR <=0 → suppress (data quality gap).
      WHEN m.unit_cost IS NULL OR m.unit_cost <= 0 THEN NULL
      -- Pack-grain sale: master cost is per-pack, divide.
      WHEN s.qty_grain = 'pack' THEN m.unit_cost / GREATEST(COALESCE(m.pack_size, 1), 1)::numeric
      -- Unit-grain sale: sanity-check master cost against per-unit price.
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

COMMIT;
