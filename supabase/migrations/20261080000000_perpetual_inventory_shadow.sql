-- 20261080000000_perpetual_inventory_shadow.sql
--
-- PERPETUAL BY-SIZE INVENTORY LEDGER — SHADOW / PRE-CUTOVER (Cutover Phase 2).
--
-- Builds an append-only, event-sourced by-(sku x location x size) movement
-- ledger that computes a PERPETUAL on-hand ALONGSIDE the live system, WITHOUT
-- replacing it. It does NOT mutate inventory_layers / on-hand feeds / snapshots,
-- does NOT re-enable the disabled nightly syncs, and does NOT change how the
-- Inventory Matrix reads on-hand. Its value today is (a) the architecture,
-- (b) a trustworthy by-size OPENING baseline seeded from the Xoro REST truth,
-- and (c) a daily reconciliation that quantifies drift + a cutover-readiness %.
--
-- Truth source (reused from the #1763 monitor, migration 20260997000000):
--   tangerine_size_onhand (source='xoro_rest') is the authoritative by-size
--   on-hand. inventory_layers (Σ remaining_qty) is the LIVE app feed that drifts.
--
-- What is deterministically event-sourceable TODAY (probed 2026-07-15):
--   * opening baseline  — xoro_rest latest snapshot, 100% size-grain          ✓
--   * receipts          — ip_receipts_history AFTER the baseline date          ✓
--   * transfers         — inventory_transfers (two legs)                       ✓ (0 rows now)
--   * adjustments       — inventory_adjustments                               ✓ (0 rows now)
--   * sale/depletion    — inventory_consumption (FIFO)                        ✓ (0 rows now)
-- The sale-depletion source is EMPTY because Xoro still owns orders and the
-- nightly sync is off — that is precisely the cutover gap the readiness meter
-- measures: as event-sourced sale depletion comes online, drift -> 0.
--
-- The ONLY tables written are the new shadow objects below. Idempotent.

-- ── 1. Append-only movement ledger ──────────────────────────────────────────
create table if not exists inv_ledger_movements (
  movement_id      uuid primary key default gen_random_uuid(),
  entity_id        uuid not null default rof_entity_id(),
  occurred_at      timestamptz not null,
  item_id          uuid references ip_item_master(id),
  sku_code         text,
  size             text,
  location_id      uuid references inventory_locations(id),
  qty_delta        numeric not null,
  movement_type    text not null check (movement_type in
                     ('opening','receipt','sale','transfer_in','transfer_out','adjustment','return')),
  source_table     text not null,
  source_id        text not null,
  unit_cost_cents  bigint,
  size_grain_known boolean not null default true,
  notes            text,
  created_at       timestamptz not null default now(),
  unique (source_table, source_id, movement_type)
);

create index if not exists inv_ledger_movements_item_idx     on inv_ledger_movements (item_id);
create index if not exists inv_ledger_movements_item_loc_idx on inv_ledger_movements (item_id, location_id);
create index if not exists inv_ledger_movements_occurred_idx on inv_ledger_movements (occurred_at);
create index if not exists inv_ledger_movements_type_idx     on inv_ledger_movements (movement_type);

comment on table inv_ledger_movements is
  'SHADOW / pre-cutover perpetual inventory ledger. Append-only, event-sourced by-(sku x location x size) signed movements (opening/receipt/sale/transfer/adjustment/return). Σ qty_delta = perpetual on-hand. Parallel to the live feed — NOT the authoritative on-hand until the Xoro cutover. Idempotent on (source_table, source_id, movement_type). #perpetual-shadow';

-- ── 2. Append-only enforcement (no UPDATE / DELETE / TRUNCATE of history) ────
create or replace function inv_ledger_movements_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'inv_ledger_movements is append-only (attempted % — history is immutable)', tg_op;
  return null;
end;
$$;

drop trigger if exists inv_ledger_movements_no_mutate on inv_ledger_movements;
create trigger inv_ledger_movements_no_mutate
  before update or delete on inv_ledger_movements
  for each row execute function inv_ledger_movements_append_only();

drop trigger if exists inv_ledger_movements_no_truncate on inv_ledger_movements;
create trigger inv_ledger_movements_no_truncate
  before truncate on inv_ledger_movements
  for each statement execute function inv_ledger_movements_append_only();

-- ── 3. Perpetual on-hand (as-of now, and an as-of-date function) ─────────────
create or replace view v_inv_perpetual_onhand as
select
  item_id,
  location_id,
  size,
  max(sku_code)                                   as sku_code,
  sum(qty_delta)                                  as onhand_qty,
  bool_and(size_grain_known)                      as size_grain_known,
  count(*)                                        as movement_count,
  max(occurred_at)                                as last_movement_at
from inv_ledger_movements
group by item_id, location_id, size;

comment on view v_inv_perpetual_onhand is
  'SHADOW perpetual on-hand as-of now = Σ inv_ledger_movements.qty_delta per (item_id, location_id, size). Parallel/pre-cutover — not the live on-hand. #perpetual-shadow';

create or replace function inv_perpetual_onhand_asof(p_asof timestamptz)
returns table (item_id uuid, location_id uuid, size text, sku_code text, onhand_qty numeric)
language sql
stable
as $$
  select item_id, location_id, size, max(sku_code) as sku_code, sum(qty_delta) as onhand_qty
  from inv_ledger_movements
  where occurred_at <= p_asof
  group by item_id, location_id, size;
$$;

comment on function inv_perpetual_onhand_asof(timestamptz) is
  'SHADOW perpetual on-hand as of an arbitrary timestamp = Σ qty_delta up to p_asof, per (item_id, location_id, size). #perpetual-shadow';

-- ── 4. Backfill (READ-ONLY of sources; WRITES ONLY the shadow ledger) ────────
-- Seeds the opening baseline from the xoro_rest truth at its latest snapshot,
-- then ingests the deterministic incremental movements that post-date it.
-- Idempotent: every insert is ON CONFLICT DO NOTHING on the natural source key,
-- so re-running only adds newly-available movements. Returns a coverage report.
create or replace function inv_ledger_backfill()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_baseline date;
  v_inserted_opening   int := 0;
  v_inserted_receipt   int := 0;
  v_inserted_transfer  int := 0;
  v_inserted_adjust    int := 0;
  v_inserted_sale      int := 0;
begin
  select max(snapshot_date) into v_baseline
    from tangerine_size_onhand where source = 'xoro_rest';
  if v_baseline is null then
    return jsonb_build_object('ok', false, 'reason', 'no xoro_rest snapshot to seed opening baseline');
  end if;

  -- Warehouse-name -> location bridge (xoro_rest uses display names, layers use
  -- location_id). Best-effort; unmatched names store a NULL location.
  -- 4a. OPENING baseline from the xoro_rest truth (latest snapshot per item x wh).
  with rest_latest as (
    select t.id, t.item_id, t.warehouse_code, t.qty_on_hand, t.snapshot_date,
           row_number() over (partition by t.item_id, t.warehouse_code
                              order by t.snapshot_date desc, t.updated_at desc nulls last) rn
    from tangerine_size_onhand t
    where t.source = 'xoro_rest' and t.snapshot_date = v_baseline
  ),
  -- Resolve warehouse -> location. The current REST feed uses location NAMES
  -- ('Main Warehouse','ROF Ecom','Psycho Tuna',...); older snapshots used
  -- display aliases ('ROF Main','ROF - ECOM',...). Match by name first, then
  -- fall back to the alias->code bridge. Unmatched -> NULL location (flagged).
  bridge as (
    select * from (values
      ('ROF Main','WH-00000'),
      ('ROF - ECOM','WH-00001'),
      ('Psycho Tuna','WH-00002'),
      ('Psycho Tuna Ecom','WH-00003')
    ) as b(wh_name, loc_code)
  ),
  seed as (
    select rl.id, rl.item_id, rl.qty_on_hand, rl.snapshot_date,
           im.sku_code, im.size, im.unit_cost,
           coalesce(loc_by_name.id, loc_by_alias.id) as location_id
    from rest_latest rl
    join ip_item_master im on im.id = rl.item_id
    left join inventory_locations loc_by_name
           on loc_by_name.entity_id = im.entity_id and loc_by_name.name = rl.warehouse_code
    left join bridge b on b.wh_name = rl.warehouse_code
    left join inventory_locations loc_by_alias
           on loc_by_alias.entity_id = im.entity_id and loc_by_alias.code = b.loc_code
    where rl.rn = 1 and rl.qty_on_hand <> 0
  ),
  ins as (
    insert into inv_ledger_movements
      (entity_id, occurred_at, item_id, sku_code, size, location_id, qty_delta,
       movement_type, source_table, source_id, unit_cost_cents, size_grain_known, notes)
    select rof_entity_id(), s.snapshot_date::timestamptz, s.item_id, s.sku_code, s.size,
           s.location_id, s.qty_on_hand, 'opening', 'tangerine_size_onhand', s.id::text,
           round(coalesce(s.unit_cost,0) * 100), (s.size is not null),
           'opening baseline @ ' || s.snapshot_date
    from seed s
    on conflict (source_table, source_id, movement_type) do nothing
    returning 1
  )
  select count(*) into v_inserted_opening from ins;

  -- 4b. RECEIPTS strictly AFTER the baseline (earlier ones are baked into opening).
  with ins as (
    insert into inv_ledger_movements
      (entity_id, occurred_at, item_id, sku_code, size, location_id, qty_delta,
       movement_type, source_table, source_id, unit_cost_cents, size_grain_known, notes)
    select rof_entity_id(), r.received_date::timestamptz, r.sku_id, im.sku_code, im.size,
           null, r.qty, 'receipt', 'ip_receipts_history', r.id::text,
           round(coalesce(im.unit_cost,0) * 100), (im.size is not null),
           coalesce('PO ' || r.po_number, 'receipt')
    from ip_receipts_history r
    join ip_item_master im on im.id = r.sku_id
    where r.received_date > v_baseline and coalesce(r.qty,0) <> 0
    on conflict (source_table, source_id, movement_type) do nothing
    returning 1
  )
  select count(*) into v_inserted_receipt from ins;

  -- 4c. TRANSFERS after baseline — two signed legs (out of from, into to).
  with legs as (
    select tr.id, tr.item_id, tr.qty, tr.transfer_date, tr.from_location, tr.to_location,
           im.sku_code, im.size, im.unit_cost, im.entity_id
    from inventory_transfers tr
    join ip_item_master im on im.id = tr.item_id
    where tr.transfer_date > v_baseline and coalesce(tr.qty,0) <> 0
  ),
  ins as (
    insert into inv_ledger_movements
      (entity_id, occurred_at, item_id, sku_code, size, location_id, qty_delta,
       movement_type, source_table, source_id, unit_cost_cents, size_grain_known, notes)
    select rof_entity_id(), l.transfer_date::timestamptz, l.item_id, l.sku_code, l.size,
           fl.id, -l.qty, 'transfer_out', 'inventory_transfers', l.id::text || '#out',
           round(coalesce(l.unit_cost,0) * 100), (l.size is not null), 'transfer out'
    from legs l
    left join inventory_locations fl on fl.code = l.from_location and fl.entity_id = l.entity_id
    union all
    select rof_entity_id(), l.transfer_date::timestamptz, l.item_id, l.sku_code, l.size,
           tl.id, l.qty, 'transfer_in', 'inventory_transfers', l.id::text || '#in',
           round(coalesce(l.unit_cost,0) * 100), (l.size is not null), 'transfer in'
    from legs l
    left join inventory_locations tl on tl.code = l.to_location and tl.entity_id = l.entity_id
    on conflict (source_table, source_id, movement_type) do nothing
    returning 1
  )
  select count(*) into v_inserted_transfer from ins;

  -- 4d. ADJUSTMENTS after baseline (signed qty_delta).
  with ins as (
    insert into inv_ledger_movements
      (entity_id, occurred_at, item_id, sku_code, size, location_id, qty_delta,
       movement_type, source_table, source_id, unit_cost_cents, size_grain_known, notes)
    select rof_entity_id(), coalesce(a.posted_at, a.created_at), a.item_id, im.sku_code, im.size,
           null, a.qty_delta, 'adjustment', 'inventory_adjustments', a.id::text,
           coalesce(a.unit_cost_cents, round(coalesce(im.unit_cost,0) * 100)),
           (im.size is not null), coalesce(a.reason, a.adjustment_type)
    from inventory_adjustments a
    join ip_item_master im on im.id = a.item_id
    where coalesce(a.posted_at, a.created_at) > v_baseline::timestamptz and coalesce(a.qty_delta,0) <> 0
    on conflict (source_table, source_id, movement_type) do nothing
    returning 1
  )
  select count(*) into v_inserted_adjust from ins;

  -- 4e. SALE depletion from FIFO consumption after baseline (active only —
  -- reversed rows netted out). This is the cutover-gated feed (empty today
  -- because Xoro owns orders and the nightly sync is disabled).
  with ins as (
    insert into inv_ledger_movements
      (entity_id, occurred_at, item_id, sku_code, size, location_id, qty_delta,
       movement_type, source_table, source_id, unit_cost_cents, size_grain_known, notes)
    select rof_entity_id(), c.consumed_at, l.item_id, im.sku_code, im.size,
           l.location_id, -c.qty_consumed, 'sale', 'inventory_consumption', c.id::text,
           case when c.qty_consumed <> 0 then round(c.cogs_cents / nullif(c.qty_consumed,0)) end,
           (im.size is not null), coalesce(c.consumer_kind, 'consumption')
    from inventory_consumption c
    join inventory_layers l on l.id = c.layer_id
    join ip_item_master im on im.id = l.item_id
    where c.reversed_at is null and c.consumed_at > v_baseline::timestamptz and coalesce(c.qty_consumed,0) <> 0
    on conflict (source_table, source_id, movement_type) do nothing
    returning 1
  )
  select count(*) into v_inserted_sale from ins;

  return jsonb_build_object(
    'ok', true,
    'baseline_date', v_baseline,
    'inserted', jsonb_build_object(
      'opening', v_inserted_opening,
      'receipt', v_inserted_receipt,
      'transfer', v_inserted_transfer,
      'adjustment', v_inserted_adjust,
      'sale', v_inserted_sale
    ),
    'ledger_total_rows', (select count(*) from inv_ledger_movements)
  );
end;
$$;

comment on function inv_ledger_backfill() is
  'Seeds/updates the SHADOW perpetual ledger: opening baseline from xoro_rest truth + deterministic post-baseline receipts/transfers/adjustments/sales. Reads live sources; writes ONLY inv_ledger_movements; idempotent. Returns a coverage report. #perpetual-shadow';

-- ── 5. Reconciliation: perpetual vs live layers vs xoro_rest truth ───────────
-- Per item_id (size-grain SKU); location-collapsed to stay apples-to-apples
-- with the #1763 monitor (whose warehouse mapping is intentionally collapsed).
create or replace view v_inv_perpetual_reconcile as
with perp as (
  select item_id,
         sum(qty_delta)                                          as perp_qty,
         bool_and(size_grain_known)                              as size_grain_known,
         count(*)                                                as movement_count,
         sum(qty_delta) filter (where movement_type = 'opening') as opening_qty,
         count(*) filter (where movement_type <> 'opening')      as incremental_moves,
         max(occurred_at)                                        as last_movement_at
  from inv_ledger_movements
  group by item_id
),
lay as (
  select item_id, sum(remaining_qty) as layers_qty,
         case when sum(remaining_qty) > 0
              then round(sum(remaining_qty * unit_cost_cents) / nullif(sum(remaining_qty),0)) end as layer_avg_cost_cents
  from inventory_layers
  group by item_id
),
rest as (
  select item_id, sum(qty_on_hand) as rest_qty
  from (
    select item_id, warehouse_code, qty_on_hand,
           row_number() over (partition by item_id, warehouse_code
                              order by snapshot_date desc, updated_at desc nulls last) rn
    from tangerine_size_onhand where source = 'xoro_rest'
  ) s
  where rn = 1
  group by item_id
),
keys as (
  select item_id from perp
  union select item_id from rest
)
select
  k.item_id,
  im.sku_code, im.style_code, im.color, im.size, im.description,
  coalesce(p.perp_qty, 0)                                       as perp_qty,
  coalesce(l.layers_qty, 0)                                     as layers_qty,
  r.rest_qty,
  (r.item_id is not null)                                       as rest_covered,
  coalesce(p.opening_qty, 0)                                    as opening_qty,
  coalesce(p.incremental_moves, 0)                              as incremental_moves,
  coalesce(p.movement_count, 0)                                 as movement_count,
  coalesce(p.size_grain_known, true)                            as size_grain_known,
  p.last_movement_at,
  (coalesce(p.perp_qty,0) - coalesce(r.rest_qty,0))             as drift_vs_truth,
  abs(coalesce(p.perp_qty,0) - coalesce(r.rest_qty,0))          as abs_drift_vs_truth,
  (coalesce(p.perp_qty,0) - coalesce(l.layers_qty,0))           as drift_vs_layers,
  abs(coalesce(p.perp_qty,0) - coalesce(l.layers_qty,0))        as abs_drift_vs_layers,
  coalesce(l.layer_avg_cost_cents, round(im.unit_cost * 100), 0) as unit_cost_cents,
  round(abs(coalesce(p.perp_qty,0) - coalesce(r.rest_qty,0))
        * coalesce(l.layer_avg_cost_cents, im.unit_cost * 100, 0)) as drift_value_cents,
  (r.item_id is not null and abs(coalesce(p.perp_qty,0) - coalesce(r.rest_qty,0)) < 0.5) as tracks_truth
from keys k
left join perp p on p.item_id = k.item_id
left join lay  l on l.item_id = k.item_id
left join rest r on r.item_id = k.item_id
join ip_item_master im on im.id = k.item_id;

comment on view v_inv_perpetual_reconcile is
  'SHADOW readiness meter: per-SKU perpetual on-hand vs the live layers feed vs the xoro_rest truth, with signed drift and a tracks_truth flag (|perp-truth|<0.5). As event-sourced movement capture improves, drift -> 0. #perpetual-shadow';

-- ── 6. Readiness + coverage summary RPC (panel scorecard) ────────────────────
create or replace function inv_perpetual_readiness_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with rec as (select * from v_inv_perpetual_reconcile)
  select jsonb_build_object(
    'generated_at',          now(),
    'baseline_date',         (select max(snapshot_date) from tangerine_size_onhand where source='xoro_rest'),
    'skus_total',            (select count(*) from rec),
    'skus_tracking_truth',   (select count(*) from rec where tracks_truth),
    'skus_covered_truth',    (select count(*) from rec where rest_covered),
    'readiness_pct',         (select case when count(*) filter (where rest_covered) > 0
                                     then round(100.0 * count(*) filter (where tracks_truth)
                                                / count(*) filter (where rest_covered), 1) else 0 end
                              from rec),
    'perp_total_units',      (select coalesce(sum(perp_qty),0) from rec),
    'rest_total_units',      (select coalesce(sum(rest_qty),0) from rec),
    'layers_total_units',    (select coalesce(sum(layers_qty),0) from rec),
    'sum_abs_drift_vs_truth',  (select coalesce(sum(abs_drift_vs_truth),0) from rec),
    'sum_abs_drift_vs_layers', (select coalesce(sum(abs_drift_vs_layers),0) from rec),
    'drift_value_cents',     (select coalesce(sum(drift_value_cents),0) from rec),
    'movements_total',       (select count(*) from inv_ledger_movements),
    'movements_opening',     (select count(*) from inv_ledger_movements where movement_type='opening'),
    'movements_incremental', (select count(*) from inv_ledger_movements where movement_type<>'opening'),
    'movements_size_flagged',(select count(*) from inv_ledger_movements where not size_grain_known),
    'movements_by_type',     (select coalesce(jsonb_object_agg(movement_type, c),'{}'::jsonb)
                              from (select movement_type, count(*) c from inv_ledger_movements group by movement_type) t),
    'skus_size_flagged',     (select count(*) from rec where not size_grain_known)
  );
$$;

comment on function inv_perpetual_readiness_summary() is
  'SHADOW rollup of v_inv_perpetual_reconcile: readiness_pct (share of REST-covered SKUs the perpetual tracks to truth), perp/rest/layers totals, Σ|drift|, and ledger coverage by movement type. #perpetual-shadow';

-- ── 7. RLS + grants (read-only to authenticated; writes via service_role RPC) ─
alter table inv_ledger_movements enable row level security;
drop policy if exists inv_ledger_movements_read on inv_ledger_movements;
create policy inv_ledger_movements_read on inv_ledger_movements
  for select to authenticated using (true);

grant select on inv_ledger_movements to authenticated, service_role;
grant select on v_inv_perpetual_onhand to authenticated, service_role;
grant select on v_inv_perpetual_reconcile to authenticated, service_role;
grant execute on function inv_perpetual_onhand_asof(timestamptz)   to authenticated, service_role;
grant execute on function inv_perpetual_readiness_summary()        to authenticated, service_role;
grant execute on function inv_ledger_backfill()                    to service_role;
