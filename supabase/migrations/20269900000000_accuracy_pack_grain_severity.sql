-- Accuracy monitor: PPK pack-grain stock is its own bucket, not divergence.
--
-- PPK (prepack) styles hold REAL color-grain pack stock that the by-size REST
-- world deliberately excludes (pack-grain CANONICAL rule; the feed reports
-- them under inseam-embedded BPs the ingest/spine skip). The reconcile view
-- classed such SKUs as material divergence and priced the gap at PACK costs
-- (~USD 237k of fake exposure on 2026-07-22). New severity pack_grain: PPK
-- style_code + layers > 0 + NO by-size coverage. The summary excludes
-- pack_grain from exposure_cents / sum_abs_units / skus_divergent and reports
-- pack_grain_skus / _units / _value_cents alongside. Trend-table columns and
-- the cron handler keys are unchanged (compatible superset).
--
-- Regenerated from the LIVE pg_get_viewdef/pg_get_functiondef (2026-07-22) --
-- never CREATE OR REPLACE from the repo copy.

CREATE OR REPLACE VIEW v_inventory_onhand_reconcile AS
WITH lay AS (
         SELECT inventory_layers.item_id,
            sum(inventory_layers.remaining_qty) AS layers_qty,
            sum(inventory_layers.remaining_qty * inventory_layers.unit_cost_cents::numeric) AS layers_val_cents,
                CASE
                    WHEN sum(inventory_layers.remaining_qty) > 0::numeric THEN round(sum(inventory_layers.remaining_qty * inventory_layers.unit_cost_cents::numeric) / NULLIF(sum(inventory_layers.remaining_qty), 0::numeric))
                    ELSE NULL::numeric
                END AS layer_avg_cost_cents,
            bool_or(inventory_layers.source_kind = 'opening_balance'::text AND inventory_layers.remaining_qty > 0::numeric) AS has_opening_residual,
            COALESCE(sum(inventory_layers.remaining_qty) FILTER (WHERE inventory_layers.source_kind = 'opening_balance'::text), 0::numeric) AS opening_qty,
            bool_or(inventory_layers.remaining_qty > 0::numeric AND COALESCE(inventory_layers.unit_cost_cents, 0::bigint) = 0) AS has_zero_cost_layer,
            count(*) FILTER (WHERE inventory_layers.source_kind = 'xoro_rest_size'::text) AS rest_layer_ct
           FROM inventory_layers
          GROUP BY inventory_layers.item_id
        ), rest AS (
         SELECT s.item_id,
            sum(s.qty_on_hand) AS rest_qty
           FROM ( SELECT tangerine_size_onhand.item_id,
                    tangerine_size_onhand.warehouse_code,
                    tangerine_size_onhand.qty_on_hand,
                    row_number() OVER (PARTITION BY tangerine_size_onhand.item_id, tangerine_size_onhand.warehouse_code ORDER BY tangerine_size_onhand.snapshot_date DESC, tangerine_size_onhand.updated_at DESC NULLS LAST) AS rn
                   FROM tangerine_size_onhand) s
          WHERE s.rn = 1
          GROUP BY s.item_id
        ), ats AS (
         SELECT s.sku_id AS item_id,
            sum(s.qty_on_hand) AS ats_qty
           FROM ( SELECT ip_inventory_snapshot.sku_id,
                    ip_inventory_snapshot.warehouse_code,
                    ip_inventory_snapshot.qty_on_hand,
                    row_number() OVER (PARTITION BY ip_inventory_snapshot.sku_id, ip_inventory_snapshot.warehouse_code ORDER BY ip_inventory_snapshot.snapshot_date DESC, ip_inventory_snapshot.created_at DESC NULLS LAST) AS rn
                   FROM ip_inventory_snapshot
                  WHERE ip_inventory_snapshot.source = 'manual'::text) s
          WHERE s.rn = 1
          GROUP BY s.sku_id
        ), tang AS (
         SELECT s.sku_id AS item_id,
            sum(s.qty_on_hand) AS phantom_qty
           FROM ( SELECT ip_inventory_snapshot.sku_id,
                    ip_inventory_snapshot.warehouse_code,
                    ip_inventory_snapshot.qty_on_hand,
                    row_number() OVER (PARTITION BY ip_inventory_snapshot.sku_id, ip_inventory_snapshot.warehouse_code ORDER BY ip_inventory_snapshot.snapshot_date DESC, ip_inventory_snapshot.created_at DESC NULLS LAST) AS rn
                   FROM ip_inventory_snapshot
                  WHERE ip_inventory_snapshot.source = 'tangerine'::text) s
          WHERE s.rn = 1
          GROUP BY s.sku_id
        ), keys AS (
         SELECT lay.item_id
           FROM lay
        UNION
         SELECT rest.item_id
           FROM rest
        ), base AS (
         SELECT k.item_id,
            COALESCE(lay.layers_qty, 0::numeric) AS layers_qty,
            COALESCE(lay.layers_val_cents, 0::numeric) AS layers_val_cents,
            lay.layer_avg_cost_cents,
            COALESCE(lay.has_opening_residual, false) AS has_opening_residual,
            COALESCE(lay.opening_qty, 0::numeric) AS opening_qty,
            COALESCE(lay.has_zero_cost_layer, false) AS has_zero_cost_layer,
            COALESCE(lay.rest_layer_ct, 0::bigint) AS rest_layer_ct,
            rest.rest_qty,
            rest.item_id IS NOT NULL AS rest_covered,
            ats.ats_qty,
            tang.phantom_qty
           FROM keys k
             LEFT JOIN lay ON lay.item_id = k.item_id
             LEFT JOIN rest ON rest.item_id = k.item_id
             LEFT JOIN ats ON ats.item_id = k.item_id
             LEFT JOIN tang ON tang.item_id = k.item_id
        )
 SELECT b.item_id,
    im.entity_id,
    im.sku_code,
    im.style_code,
    im.color,
    im.size,
    im.description,
    im.category_id,
    b.layers_qty,
    b.rest_qty,
    b.rest_covered,
    b.ats_qty,
    b.phantom_qty,
    b.layers_qty - COALESCE(b.rest_qty, 0::numeric) AS divergence,
    abs(b.layers_qty - COALESCE(b.rest_qty, 0::numeric)) AS abs_divergence,
    COALESCE(b.layer_avg_cost_cents, round(im.unit_cost * 100::numeric), 0::numeric) AS unit_cost_cents,
    round(abs(b.layers_qty - COALESCE(b.rest_qty, 0::numeric)) * COALESCE(b.layer_avg_cost_cents, im.unit_cost * 100::numeric, 0::numeric)) AS divergence_value_cents,
    b.layers_qty < 0::numeric AS is_negative,
    b.has_zero_cost_layer AS is_zero_cost,
    b.has_opening_residual OR b.layers_qty > 0::numeric AND b.rest_covered AND COALESCE(b.rest_qty, 0::numeric) = 0::numeric AS is_phantom_suspect,
    b.has_opening_residual,
    b.opening_qty,
        CASE
            WHEN im.style_code ~* 'PPK'::text AND NOT b.rest_covered AND b.layers_qty > 0::numeric THEN 'pack_grain'::text
            WHEN b.has_opening_residual OR b.layers_qty > 0::numeric AND b.rest_covered AND COALESCE(b.rest_qty, 0::numeric) = 0::numeric THEN 'phantom_suspect'::text
            WHEN abs(b.layers_qty - COALESCE(b.rest_qty, 0::numeric)) < 0.5 THEN 'tie'::text
            WHEN abs(b.layers_qty - COALESCE(b.rest_qty, 0::numeric)) <= 25::numeric THEN 'minor'::text
            ELSE 'material'::text
        END AS severity
   FROM base b
     JOIN ip_item_master im ON im.id = b.item_id;

CREATE OR REPLACE FUNCTION public.inventory_onhand_accuracy_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'generated_at',          now(),
    'rest_snapshot_date',    (select max(snapshot_date) from tangerine_size_onhand where source = 'xoro_rest'),
    'skus_total',            count(*),
    'skus_tie',              count(*) filter (where severity = 'tie'),
    'skus_minor',            count(*) filter (where severity = 'minor'),
    'skus_material',         count(*) filter (where severity = 'material'),
    'skus_phantom',          count(*) filter (where severity = 'phantom_suspect'),
    'skus_divergent',        count(*) filter (where severity not in ('tie','pack_grain')),
    'sum_abs_units',         coalesce(sum(abs_divergence) filter (where severity <> 'pack_grain'), 0),
    'exposure_cents',        coalesce(sum(divergence_value_cents) filter (where severity <> 'pack_grain'), 0),
    'negative_skus',         count(*) filter (where is_negative),
    'negative_units',        coalesce(sum(layers_qty) filter (where is_negative), 0),
    'zero_cost_skus',        count(*) filter (where is_zero_cost),
    'zero_cost_units',       coalesce(sum(layers_qty) filter (where is_zero_cost and layers_qty > 0), 0),
    'phantom_units',         coalesce(sum(layers_qty) filter (where severity = 'phantom_suspect'), 0),
    'opening_residual_skus', count(*) filter (where has_opening_residual),
    'opening_residual_units',coalesce(sum(opening_qty) filter (where has_opening_residual), 0),
    'layers_total_units',    coalesce(sum(layers_qty), 0),
    'rest_total_units',      coalesce(sum(rest_qty), 0),
    'ats_total_units',       coalesce(sum(ats_qty), 0),
    'phantom_feed_units',    coalesce(sum(phantom_qty), 0),
    'pack_grain_skus',       count(*) filter (where severity = 'pack_grain'),
    'pack_grain_units',      coalesce(sum(layers_qty) filter (where severity = 'pack_grain'), 0),
    'pack_grain_value_cents',coalesce(sum(divergence_value_cents) filter (where severity = 'pack_grain'), 0)
  )
  from v_inventory_onhand_reconcile;
$function$;

COMMENT ON VIEW v_inventory_onhand_reconcile IS 'Read-only: per-SKU on-hand reconciliation of the LIVE layers feed vs the REST by-size truth, severity tie/minor/material/phantom_suspect/pack_grain (pack_grain = PPK stock outside the by-size world - real inventory, not divergence). #inventory-monitor';
