-- 20260997000000_inventory_onhand_monitor.sql
--
-- INVENTORY ON-HAND ACCURACY MONITOR (read-only diagnostics / observability).
--
-- Background (see memory HANDOVER_2026_07_02_inventory_onhand +
-- project_phantom_opening_balance_onhand): Tangerine's live on-hand lives on
-- inventory_layers (Σ remaining_qty, the number the Inventory Matrix reads).
-- The AUTHORITATIVE by-size on-hand is the Xoro REST feed, snapshotted into
-- tangerine_size_onhand (source='xoro_rest'). Both nightly syncs are currently
-- DISABLED, so the live layers drift from REST as Xoro keeps selling. A prior
-- audit scored inventory 4/10 for exactly this: phantom stock, two feeds that
-- disagree by thousands of units, no perpetual by-size ledger.
--
-- This migration adds READ-ONLY reconciliation views + a summary RPC + a tiny
-- daily trend table so the divergence is MEASURED, VISIBLE and TRACKED. It
-- MUTATES NO inventory data. The only writable object is the diagnostic trend
-- table inventory_onhand_accuracy_snapshot, appended one row/day by the cron.
--
-- Feeds compared, per SKU (item_id = a size-grain ip_item_master row):
--   * layers_qty   — Σ inventory_layers.remaining_qty         (LIVE app on-hand)
--   * rest_qty     — tangerine_size_onhand latest per wh      (REST = TRUTH)
--   * ats_qty      — ip_inventory_snapshot source='manual'    (ATS feed, info)
--   * phantom_qty  — ip_inventory_snapshot source='tangerine' (known phantom)
--
-- Signed divergence = layers_qty - rest_qty (positive = app OVERSTATES vs REST).
-- Severity: tie / minor / material / phantom_suspect. Plus detectors for
-- negative on-hand and on-hand carried on a zero-cost layer.
-- Idempotent.

-- ── 1. Per-SKU reconciliation view ──────────────────────────────────────────
create or replace view v_inventory_onhand_reconcile as
with lay as (
  select
    item_id,
    sum(remaining_qty)                                                as layers_qty,
    sum(remaining_qty * unit_cost_cents)                             as layers_val_cents,
    case when sum(remaining_qty) > 0
         then round(sum(remaining_qty * unit_cost_cents) / nullif(sum(remaining_qty), 0))
         end                                                          as layer_avg_cost_cents,
    bool_or(source_kind = 'opening_balance' and remaining_qty > 0)   as has_opening_residual,
    coalesce(sum(remaining_qty) filter (where source_kind = 'opening_balance'), 0) as opening_qty,
    bool_or(remaining_qty > 0 and coalesce(unit_cost_cents, 0) = 0)  as has_zero_cost_layer,
    count(*) filter (where source_kind = 'xoro_rest_size')           as rest_layer_ct
  from inventory_layers
  group by item_id
),
rest as (
  select item_id, sum(qty_on_hand) as rest_qty
  from (
    select item_id, warehouse_code, qty_on_hand,
           row_number() over (partition by item_id, warehouse_code
                              order by snapshot_date desc, updated_at desc nulls last) rn
    from tangerine_size_onhand
  ) s
  where rn = 1
  group by item_id
),
ats as (
  select sku_id as item_id, sum(qty_on_hand) as ats_qty
  from (
    select sku_id, warehouse_code, qty_on_hand,
           row_number() over (partition by sku_id, warehouse_code
                              order by snapshot_date desc, created_at desc nulls last) rn
    from ip_inventory_snapshot
    where source = 'manual'
  ) s
  where rn = 1
  group by sku_id
),
tang as (
  select sku_id as item_id, sum(qty_on_hand) as phantom_qty
  from (
    select sku_id, warehouse_code, qty_on_hand,
           row_number() over (partition by sku_id, warehouse_code
                              order by snapshot_date desc, created_at desc nulls last) rn
    from ip_inventory_snapshot
    where source = 'tangerine'
  ) s
  where rn = 1
  group by sku_id
),
keys as (
  select item_id from lay
  union select item_id from rest
),
base as (
  select
    k.item_id,
    coalesce(lay.layers_qty, 0)                    as layers_qty,
    coalesce(lay.layers_val_cents, 0)              as layers_val_cents,
    lay.layer_avg_cost_cents,
    coalesce(lay.has_opening_residual, false)      as has_opening_residual,
    coalesce(lay.opening_qty, 0)                   as opening_qty,
    coalesce(lay.has_zero_cost_layer, false)       as has_zero_cost_layer,
    coalesce(lay.rest_layer_ct, 0)                 as rest_layer_ct,
    rest.rest_qty,
    (rest.item_id is not null)                     as rest_covered,
    ats.ats_qty,
    tang.phantom_qty
  from keys k
  left join lay  on lay.item_id  = k.item_id
  left join rest on rest.item_id = k.item_id
  left join ats  on ats.item_id  = k.item_id
  left join tang on tang.item_id = k.item_id
)
select
  b.item_id,
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
  (b.layers_qty - coalesce(b.rest_qty, 0))                          as divergence,
  abs(b.layers_qty - coalesce(b.rest_qty, 0))                       as abs_divergence,
  coalesce(b.layer_avg_cost_cents, round(im.unit_cost * 100), 0)    as unit_cost_cents,
  round(abs(b.layers_qty - coalesce(b.rest_qty, 0))
        * coalesce(b.layer_avg_cost_cents, im.unit_cost * 100, 0))  as divergence_value_cents,
  -- flags
  (b.layers_qty < 0)                                               as is_negative,
  b.has_zero_cost_layer                                            as is_zero_cost,
  (b.has_opening_residual
     or (b.layers_qty > 0 and b.rest_covered and coalesce(b.rest_qty, 0) = 0)) as is_phantom_suspect,
  b.has_opening_residual,
  b.opening_qty,
  -- severity: phantom_suspect > material > minor > tie
  case
    when b.has_opening_residual
      or (b.layers_qty > 0 and b.rest_covered and coalesce(b.rest_qty, 0) = 0)
                                              then 'phantom_suspect'
    when abs(b.layers_qty - coalesce(b.rest_qty, 0)) < 0.5   then 'tie'
    when abs(b.layers_qty - coalesce(b.rest_qty, 0)) <= 25   then 'minor'
    else 'material'
  end                                                              as severity
from base b
join ip_item_master im on im.id = b.item_id;

comment on view v_inventory_onhand_reconcile is
  'Read-only: per-SKU on-hand reconciliation of the LIVE layers feed vs the REST by-size truth (tangerine_size_onhand), with signed divergence, severity (tie/minor/material/phantom_suspect) and negative/zero-cost flags. Fixing requires the Xoro cutover; this only MEASURES. #inventory-monitor';

-- ── 2. Summary RPC (cheap SQL aggregate; used by cron + panel scorecard) ─────
create or replace function inventory_onhand_accuracy_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'generated_at',          now(),
    'rest_snapshot_date',    (select max(snapshot_date) from tangerine_size_onhand where source = 'xoro_rest'),
    'skus_total',            count(*),
    'skus_tie',              count(*) filter (where severity = 'tie'),
    'skus_minor',            count(*) filter (where severity = 'minor'),
    'skus_material',         count(*) filter (where severity = 'material'),
    'skus_phantom',          count(*) filter (where severity = 'phantom_suspect'),
    'skus_divergent',        count(*) filter (where severity <> 'tie'),
    'sum_abs_units',         coalesce(sum(abs_divergence), 0),
    'exposure_cents',        coalesce(sum(divergence_value_cents), 0),
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
    'phantom_feed_units',    coalesce(sum(phantom_qty), 0)
  )
  from v_inventory_onhand_reconcile;
$$;

comment on function inventory_onhand_accuracy_summary() is
  'Read-only rollup of v_inventory_onhand_reconcile as jsonb (SKU counts by severity, Σ|units|, $ exposure at cost, negative/zero-cost/phantom detectors). #inventory-monitor';

-- ── 3. Daily trend table (the only writable object; diagnostic only) ─────────
create table if not exists inventory_onhand_accuracy_snapshot (
  snapshot_date          date primary key,
  skus_total             integer,
  skus_divergent         integer,
  skus_minor             integer,
  skus_material          integer,
  skus_phantom           integer,
  sum_abs_units          numeric,
  exposure_cents         bigint,
  negative_skus          integer,
  zero_cost_skus         integer,
  zero_cost_units        numeric,
  opening_residual_skus  integer,
  opening_residual_units numeric,
  layers_total_units     numeric,
  rest_total_units       numeric,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table inventory_onhand_accuracy_snapshot is
  'Diagnostic trend: one row/day of the on-hand accuracy summary, appended by /api/cron/inventory-onhand-check so the panel can show whether divergence is improving or worsening. Holds only aggregate counts. #inventory-monitor';

alter table inventory_onhand_accuracy_snapshot enable row level security;
drop policy if exists inv_onhand_acc_snap_read on inventory_onhand_accuracy_snapshot;
create policy inv_onhand_acc_snap_read on inventory_onhand_accuracy_snapshot
  for select to authenticated using (true);

-- ── 4. Snapshot-write RPC (appends today's trend row from the summary) ───────
create or replace function inventory_onhand_accuracy_snapshot_write()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s jsonb;
begin
  s := inventory_onhand_accuracy_summary();
  insert into inventory_onhand_accuracy_snapshot as t (
    snapshot_date, skus_total, skus_divergent, skus_minor, skus_material, skus_phantom,
    sum_abs_units, exposure_cents, negative_skus, zero_cost_skus, zero_cost_units,
    opening_residual_skus, opening_residual_units, layers_total_units, rest_total_units, updated_at
  ) values (
    current_date,
    (s->>'skus_total')::int, (s->>'skus_divergent')::int, (s->>'skus_minor')::int,
    (s->>'skus_material')::int, (s->>'skus_phantom')::int,
    (s->>'sum_abs_units')::numeric, (s->>'exposure_cents')::bigint,
    (s->>'negative_skus')::int, (s->>'zero_cost_skus')::int, (s->>'zero_cost_units')::numeric,
    (s->>'opening_residual_skus')::int, (s->>'opening_residual_units')::numeric,
    (s->>'layers_total_units')::numeric, (s->>'rest_total_units')::numeric, now()
  )
  on conflict (snapshot_date) do update set
    skus_total = excluded.skus_total, skus_divergent = excluded.skus_divergent,
    skus_minor = excluded.skus_minor, skus_material = excluded.skus_material,
    skus_phantom = excluded.skus_phantom, sum_abs_units = excluded.sum_abs_units,
    exposure_cents = excluded.exposure_cents, negative_skus = excluded.negative_skus,
    zero_cost_skus = excluded.zero_cost_skus, zero_cost_units = excluded.zero_cost_units,
    opening_residual_skus = excluded.opening_residual_skus,
    opening_residual_units = excluded.opening_residual_units,
    layers_total_units = excluded.layers_total_units, rest_total_units = excluded.rest_total_units,
    updated_at = now();
  return s;
end;
$$;

comment on function inventory_onhand_accuracy_snapshot_write() is
  'Upserts today''s row into inventory_onhand_accuracy_snapshot from inventory_onhand_accuracy_summary(); returns the summary jsonb. Diagnostic write only — touches NO inventory data. #inventory-monitor';

grant execute on function inventory_onhand_accuracy_summary()        to authenticated, service_role;
grant execute on function inventory_onhand_accuracy_snapshot_write() to service_role;
grant select on inventory_onhand_accuracy_snapshot to authenticated, service_role;
