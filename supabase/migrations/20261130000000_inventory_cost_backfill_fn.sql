-- 20261130000000_inventory_cost_backfill_fn.sql
-- ════════════════════════════════════════════════════════════════════════════
-- inventory_cost_backfill() — the nightly cost back-fill, centralizing the two
-- one-time scripts (Tier 1 native PO + Tier 2 style-sibling avg) into a single
-- idempotent, re-runnable function so NEW receipts don't slowly re-accumulate as
-- Uncosted in the Inventory Aging report.
--
-- Writes ONLY ip_item_avg_cost (the report's cost fallback), source
-- 'po_backfill' — NO GL, on-hand, or inventory-layer mutation. Fills only items
-- that are uncosted right now (no layer cost, no avg_cost, no item unit_cost) and
-- NEVER overwrites a real cost. Returns a jsonb summary for the cron log.
--
--   Tier 1 — weighted-avg unit_cost_cents per item from native purchase_order_lines
--   Tier 2 — for the fragmented remainder, the style's average cost from its own
--            already-costed siblings (realized layer costs + avg_cost incl. Tier 1)
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

  -- ── Tier 2 — style-level average from costed siblings ──────────────────────
  WITH uncosted AS (
    SELECT DISTINCT im.sku_code, im.style_code
    FROM inventory_layers il
    JOIN ip_item_master im ON im.id = il.item_id
    WHERE il.entity_id = v_entity
      AND il.remaining_qty > 0
      AND il.unit_cost_cents = 0
      AND (im.unit_cost IS NULL OR im.unit_cost = 0)
      AND NOT EXISTS (SELECT 1 FROM ip_item_avg_cost ac WHERE ac.sku_code = im.sku_code AND ac.avg_cost > 0)
  ),
  style_cost AS (
    SELECT style_code, avg(cost_c) AS avg_cents
    FROM (
      SELECT im.style_code, il.unit_cost_cents::numeric AS cost_c
      FROM inventory_layers il JOIN ip_item_master im ON im.id = il.item_id
      WHERE il.entity_id = v_entity AND il.unit_cost_cents > 0
      UNION ALL
      SELECT im.style_code, ac.avg_cost * 100
      FROM ip_item_avg_cost ac JOIN ip_item_master im ON im.sku_code = ac.sku_code
      WHERE ac.avg_cost > 0
    ) s
    GROUP BY style_code
  )
  INSERT INTO ip_item_avg_cost (sku_code, avg_cost, source, source_ref, updated_at)
  SELECT u.sku_code, round(sc.avg_cents) / 100.0, 'po_backfill', 'style_sibling_avg:' || u.style_code, now()
  FROM uncosted u
  JOIN style_cost sc ON sc.style_code = u.style_code
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
IS 'Idempotent nightly cost back-fill for the Inventory Aging report: Tier 1 native-PO weighted-avg + Tier 2 style-sibling avg into ip_item_avg_cost (source po_backfill). Fills only currently-uncosted items, never overwrites a real cost, no GL/on-hand impact. Returns {tier1_filled, tier2_filled, remaining_uncosted_units}.';
