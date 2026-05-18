-- Sales-history grain normalisation + per-row margin
--
-- Background: `ip_sales_history_wholesale.qty` is mixed-grain per row.
-- Xoro records some prepack sales at pack-count (e.g. qty=20 packs at
-- $240/pack) and others at unit-count (qty=1,620 units at $2.96/unit)
-- for the same underlying transaction shape. After
-- `canonStyleColor` strips size variants (including the PPK token),
-- the original Item Number is gone — so the row's grain isn't
-- recoverable from sku_code alone.
--
-- This migration:
--   1. Adds qty_grain ('unit'|'pack') so each row records its grain.
--   2. Adds qty_units — the authoritative unit-grain qty (qty when
--      grain='unit', qty * pack_size when grain='pack'). Export +
--      analysis paths should read qty_units, never qty.
--   3. Adds unit_cost_at_sale, margin_amount, margin_pct so margin is
--      computed once at sync time, not per-export. Cost snapshot uses
--      the master cost AT INGEST TIME so historical margins are stable
--      under future cost-cascade updates.
--   4. Backfills all existing rows using a unit_price-vs-master_cost
--      heuristic — pack grain when the per-row unit_price is closer to
--      the master's per-pack cost than to its per-unit cost. Defaults
--      to 'pack' for prepacks with insufficient info (more common
--      historically) and 'unit' for non-prepacks.

BEGIN;

ALTER TABLE ip_sales_history_wholesale
  ADD COLUMN IF NOT EXISTS qty_grain text
    NOT NULL DEFAULT 'unit'
    CHECK (qty_grain IN ('unit', 'pack')),
  ADD COLUMN IF NOT EXISTS qty_units         numeric(14, 3),
  ADD COLUMN IF NOT EXISTS unit_cost_at_sale numeric(12, 4),
  ADD COLUMN IF NOT EXISTS margin_amount     numeric(14, 4),
  ADD COLUMN IF NOT EXISTS margin_pct        numeric(6, 4);

-- Backfill in one pass. Conditional on qty_units IS NULL so re-running
-- the migration after partial application picks up where it left off.
WITH classified AS (
  SELECT
    s.id,
    s.qty,
    s.unit_price,
    s.net_amount,
    COALESCE(m.pack_size, 1)::numeric AS pack_size,
    m.unit_cost AS master_unit_cost,
    CASE
      -- Non-prepack: always unit grain (qty as-is).
      WHEN COALESCE(m.pack_size, 1) <= 1 THEN 'unit'
      -- Prepack with no usable price/cost: default to 'pack'. Historically
      -- Xoro recorded prepack sales at pack-grain more often than not.
      WHEN s.unit_price IS NULL OR m.unit_cost IS NULL OR s.unit_price = 0 THEN 'pack'
      -- Prepack with both: pick whichever cost the unit_price is closer to.
      WHEN ABS(s.unit_price - m.unit_cost)
         < ABS(s.unit_price - (m.unit_cost / m.pack_size))
        THEN 'pack'
      ELSE 'unit'
    END AS grain
  FROM ip_sales_history_wholesale s
  JOIN ip_item_master m ON m.id = s.sku_id
  WHERE s.qty_units IS NULL
)
UPDATE ip_sales_history_wholesale s
SET
  qty_grain = c.grain,
  qty_units = CASE
    WHEN c.grain = 'pack' THEN s.qty * c.pack_size
    ELSE s.qty
  END,
  unit_cost_at_sale = CASE
    WHEN c.master_unit_cost IS NOT NULL THEN c.master_unit_cost / c.pack_size
    ELSE NULL
  END,
  margin_amount = CASE
    WHEN s.net_amount IS NOT NULL AND c.master_unit_cost IS NOT NULL THEN
      s.net_amount
        - (CASE WHEN c.grain = 'pack' THEN s.qty * c.pack_size ELSE s.qty END)
          * (c.master_unit_cost / c.pack_size)
    ELSE NULL
  END,
  margin_pct = CASE
    WHEN s.net_amount IS NOT NULL AND s.net_amount > 0 AND c.master_unit_cost IS NOT NULL THEN
      (s.net_amount
        - (CASE WHEN c.grain = 'pack' THEN s.qty * c.pack_size ELSE s.qty END)
          * (c.master_unit_cost / c.pack_size))
        / s.net_amount
    ELSE NULL
  END
FROM classified c
WHERE s.id = c.id;

-- Catch any orphans (rows whose FK join didn't return a master — should
-- be zero due to FK constraint, but defensive).
UPDATE ip_sales_history_wholesale
SET qty_units = qty, qty_grain = 'unit'
WHERE qty_units IS NULL;

-- qty_units stays nullable for now. The nightly sync handler
-- (api/_handlers/sales/sync-invoices.js) is the dominant write path and
-- will be updated in the same PR to populate qty_units + margin on every
-- insert. Two other paths (api/_handlers/xoro-sales-sync.js and the
-- browser modal at src/inventory-planning/services/excelIngestService.ts)
-- also write to this table — they'll be updated in a follow-up. Until
-- then, those paths leave qty_units NULL and downstream readers fall
-- back to qty via COALESCE.

CREATE INDEX IF NOT EXISTS idx_ip_sales_wholesale_grain
  ON ip_sales_history_wholesale (qty_grain)
  WHERE qty_grain = 'pack';

COMMENT ON COLUMN ip_sales_history_wholesale.qty IS
  'Raw qty as recorded by Xoro. May be at pack-count or unit-count grain per row — qty_grain disambiguates. Use qty_units for analysis.';
COMMENT ON COLUMN ip_sales_history_wholesale.qty_grain IS
  E'\'unit\' (qty is already at unit grain) or \'pack\' (qty is pack-count; multiply by item_master.pack_size for unit grain). Inferred at ingest from Item Number PPK tokens; backfilled via unit_price-vs-cost heuristic.';
COMMENT ON COLUMN ip_sales_history_wholesale.qty_units IS
  'Authoritative qty at unit grain. = qty when qty_grain=''unit'', = qty * item_master.pack_size when qty_grain=''pack''. Maintained by sync-invoices handler.';
COMMENT ON COLUMN ip_sales_history_wholesale.unit_cost_at_sale IS
  'Per-unit cost snapshot from ip_item_master at sync time. Stored so historical margins stay stable when master cost is updated.';
COMMENT ON COLUMN ip_sales_history_wholesale.margin_amount IS
  '$ margin per row: net_amount - qty_units * unit_cost_at_sale. NULL when net_amount or unit_cost_at_sale is missing.';
COMMENT ON COLUMN ip_sales_history_wholesale.margin_pct IS
  '% margin per row: margin_amount / net_amount, as a fraction (0.25 = 25%). NULL when net_amount<=0.';

COMMIT;
