-- 20262100000000_inventory_cost_backfill_ppk_grain.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Make Tier 2 of inventory_cost_backfill() PPK-GRAIN-AWARE.
--
-- Tier 2 infers an uncosted item's cost from its STYLE's already-costed siblings.
-- The original average pooled ALL of a style's costed layers together, so a style
-- whose PPK-pack sku shares the BASE style_code (a misnumbered prepack — e.g.
-- RBB0185, whose PPK48 pack layer costs $168 while its each-colour layers cost
-- ~$4) would blend a pack cost with each costs into a nonsense ~$16 style average
-- and hand it to any uncosted sibling regardless of grain. Packs are MULTIPLES of
-- eaches — they must never inherit each cost, nor eaches inherit pack cost.
--
-- Live-data audit (2026-07-16) found the corruption DORMANT — the one mixed-grain
-- style (RBB0185) had no uncosted sibling to fill, and all applied PPK Tier-2 rows
-- were self-consistent (RBB1042-PPK $252/pack, RYO0659FP-PPK18 $45/pack). But the
-- nightly cron re-runs this logic, so a future receipt could trigger the blend.
-- This fix segregates the style average by grain so the durable path stays clean.
--
--   is_pack := (sku_code ~* 'PPK' OR style_code ~* 'PPK')  -- canonical PPK marker
--   A pack sibling inherits only the style's PACK-grain average; an each sibling
--   inherits only the EACH-grain average. A grain with no costed sibling stays
--   uncosted (correct — never fabricate a cross-grain cost).
--
-- Writes ONLY ip_item_avg_cost (source 'po_backfill'); no GL / on-hand / layer
-- mutation. Idempotent, never overwrites a real cost. Tier 1 is unchanged.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION inventory_cost_backfill(p_entity_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_entity    uuid;
  v_tier1     integer := 0;
  v_tier2     integer := 0;
  v_remaining numeric := 0;
BEGIN
  v_entity := COALESCE(p_entity_id, (SELECT id FROM entities WHERE code = 'ROF'));
  IF v_entity IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'entity not found');
  END IF;

  -- ── Tier 1 — native PO weighted-average unit cost ──────────────────────────
  WITH uncosted AS (
    SELECT DISTINCT il.item_id, im.sku_code
    FROM inventory_layers il
    JOIN ip_item_master im ON im.id = il.item_id
    WHERE il.entity_id = v_entity
      AND il.remaining_qty > 0
      AND il.unit_cost_cents = 0
      AND (im.unit_cost IS NULL OR im.unit_cost = 0)
      AND NOT EXISTS (SELECT 1 FROM ip_item_avg_cost ac WHERE ac.sku_code = im.sku_code AND ac.avg_cost > 0)
  ),
  po_cost AS (
    SELECT
      u.sku_code,
      SUM(pol.unit_cost_cents * GREATEST(COALESCE(NULLIF(pol.qty_received, 0), pol.qty_ordered, 1), 1))
        / NULLIF(SUM(GREATEST(COALESCE(NULLIF(pol.qty_received, 0), pol.qty_ordered, 1), 1)), 0) AS wavg_cents,
      'native:' || MIN(pol.purchase_order_id::text) AS ref
    FROM uncosted u
    JOIN purchase_order_lines pol ON pol.inventory_item_id = u.item_id AND pol.unit_cost_cents > 0
    GROUP BY u.sku_code
  )
  INSERT INTO ip_item_avg_cost (sku_code, avg_cost, source, source_ref, updated_at)
  SELECT sku_code, round(wavg_cents) / 100.0, 'po_backfill', ref, now()
  FROM po_cost
  WHERE wavg_cents > 0
  ON CONFLICT (sku_code) DO UPDATE
    SET avg_cost = EXCLUDED.avg_cost, source = EXCLUDED.source,
        source_ref = EXCLUDED.source_ref, updated_at = now()
    WHERE ip_item_avg_cost.avg_cost IS NULL OR ip_item_avg_cost.avg_cost = 0;
  GET DIAGNOSTICS v_tier1 = ROW_COUNT;

  -- ── Tier 2 — style-level average from costed siblings, PPK-GRAIN-AWARE ──────
  --   Segregate a style's costed stock into pack- vs each-grain, and fill each
  --   uncosted sibling only from siblings of its OWN grain (packs are multiples).
  WITH uncosted AS (
    SELECT DISTINCT im.sku_code, im.style_code,
      (im.sku_code ~* 'PPK' OR im.style_code ~* 'PPK') AS is_pack
    FROM inventory_layers il
    JOIN ip_item_master im ON im.id = il.item_id
    WHERE il.entity_id = v_entity
      AND il.remaining_qty > 0
      AND il.unit_cost_cents = 0
      AND (im.unit_cost IS NULL OR im.unit_cost = 0)
      AND NOT EXISTS (SELECT 1 FROM ip_item_avg_cost ac WHERE ac.sku_code = im.sku_code AND ac.avg_cost > 0)
  ),
  style_cost AS (
    SELECT style_code, is_pack, avg(cost_c) AS avg_cents
    FROM (
      SELECT im.style_code,
        (im.sku_code ~* 'PPK' OR im.style_code ~* 'PPK') AS is_pack,
        il.unit_cost_cents::numeric AS cost_c
      FROM inventory_layers il JOIN ip_item_master im ON im.id = il.item_id
      WHERE il.entity_id = v_entity AND il.unit_cost_cents > 0
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
    SET avg_cost = EXCLUDED.avg_cost, source = EXCLUDED.source,
        source_ref = EXCLUDED.source_ref, updated_at = now()
    WHERE ip_item_avg_cost.avg_cost IS NULL OR ip_item_avg_cost.avg_cost = 0;
  GET DIAGNOSTICS v_tier2 = ROW_COUNT;

  SELECT uncosted_qty INTO v_remaining FROM inventory_aging_kpis(v_entity);

  RETURN jsonb_build_object(
    'ok', true,
    'tier1_filled', v_tier1,
    'tier2_filled', v_tier2,
    'remaining_uncosted_units', COALESCE(v_remaining, 0)
  );
END;
$$;

COMMENT ON FUNCTION inventory_cost_backfill(uuid)
IS 'Idempotent nightly cost back-fill for the Inventory Aging report: Tier 1 native-PO weighted-avg + Tier 2 PPK-grain-aware style-sibling avg into ip_item_avg_cost (source po_backfill). Packs inherit only pack-grain siblings, eaches only each-grain. Fills only currently-uncosted items, never overwrites a real cost, no GL/on-hand impact. Returns {tier1_filled, tier2_filled, remaining_uncosted_units}.';
