-- inventory_cost_backfill_tier2_style_sibling.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Inventory Aging cost back-fill — TIER 2: style-level average from costed
-- siblings. For items STILL uncosted after Tier 1, apply the average cost of
-- their STYLE — computed from that style's own already-costed stock (realized
-- FIFO layer costs + the Tier-1/manual ip_item_avg_cost). Apparel styles share
-- one cost across colors/washes/sizes, so a same-style average is a sound
-- estimate for the fragmented rows that exact matching can't reach (their color
-- fields carry size fragments, so ItemNumber↔sku matching fails on exactly these).
--
-- Writes ONLY ip_item_avg_cost (source='po_backfill', source_ref='style_sibling_avg:<style>')
-- for items with NO cost today — no GL / on-hand / layer mutation, idempotent,
-- never overwrites a real cost. Coverage: ~1,841 of 1,860 remaining items (99%);
-- ~19 items in styles with no costed sibling stay flagged uncosted (not fabricated).
--
-- PPK-GRAIN-AWARE: a PPK pack is a MULTIPLE of the base each, so the style average
-- is computed PER GRAIN — pack siblings inherit only pack-grain costs, each siblings
-- only each-grain costs. A misnumbered prepack (PPK sku sharing the base style_code,
-- e.g. RBB0185) would otherwise blend a $168 pack with ~$4 eaches into a nonsense
-- ~$16 style avg. Kept in sync with inventory_cost_backfill() (mig 20262100000000).
--
-- ⚠ Run ONLY after Tier 1 (native PO), and after CEO review of the coverage
--   report. Estimate, not a receipt: flagged by source for later refinement.
-- ════════════════════════════════════════════════════════════════════════════

WITH ent AS (SELECT id FROM entities WHERE code = 'ROF'),
uncosted AS (
  SELECT DISTINCT im.sku_code, im.style_code,
    (im.sku_code ~* 'PPK' OR im.style_code ~* 'PPK') AS is_pack
  FROM inventory_layers il
  JOIN ip_item_master im ON im.id = il.item_id
  WHERE il.entity_id = (SELECT id FROM ent)
    AND il.remaining_qty > 0
    AND il.unit_cost_cents = 0
    AND (im.unit_cost IS NULL OR im.unit_cost = 0)
    AND NOT EXISTS (SELECT 1 FROM ip_item_avg_cost ac WHERE ac.sku_code = im.sku_code AND ac.avg_cost > 0)
),
style_cost AS (
  -- per-grain style average from that style's OWN costed stock (realized layer
  -- costs + the avg-cost table, which by now includes Tier 1)
  SELECT style_code, is_pack, avg(cost_c) AS avg_cents
  FROM (
    SELECT im.style_code,
      (im.sku_code ~* 'PPK' OR im.style_code ~* 'PPK') AS is_pack,
      il.unit_cost_cents::numeric AS cost_c
    FROM inventory_layers il JOIN ip_item_master im ON im.id = il.item_id
    WHERE il.entity_id = (SELECT id FROM ent) AND il.unit_cost_cents > 0
    UNION ALL
    SELECT im.style_code,
      (im.sku_code ~* 'PPK' OR im.style_code ~* 'PPK') AS is_pack,
      ac.avg_cost * 100
    FROM ip_item_avg_cost ac JOIN ip_item_master im ON im.sku_code = ac.sku_code
    WHERE ac.avg_cost > 0
  ) s
  GROUP BY style_code, is_pack
)
INSERT INTO ip_item_avg_cost (sku_code, avg_cost, source, source_ref, updated_at)
SELECT u.sku_code, round(sc.avg_cents) / 100.0, 'po_backfill',
       'style_sibling_avg:' || u.style_code || CASE WHEN u.is_pack THEN ':pack' ELSE '' END, now()
FROM uncosted u
JOIN style_cost sc ON sc.style_code = u.style_code AND sc.is_pack = u.is_pack
WHERE sc.avg_cents > 0
ON CONFLICT (sku_code) DO UPDATE
  SET avg_cost = EXCLUDED.avg_cost,
      source = EXCLUDED.source,
      source_ref = EXCLUDED.source_ref,
      updated_at = now()
  WHERE ip_item_avg_cost.avg_cost IS NULL OR ip_item_avg_cost.avg_cost = 0;
