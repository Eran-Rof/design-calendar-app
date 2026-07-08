-- v_xoro_feed_health: one row per Xoro→Tangerine bridge feed with its freshness
-- signal, threshold, and derived status. The bridge is the operational source
-- of record until go-live, and its failure mode is SILENCE (found 2026-07-07:
-- tanda_sos stale 19 days; accounting mirror skipped 37/40 nights because
-- xoro_sync_logs was never written). This view is the single truth the alert
-- cron (xoro-feed-health-alert), the Sync Health panel, and the CLI
-- (npm run sync-health) all read.
create or replace view public.v_xoro_feed_health as
with feeds as (
  select 'pos_mirror' as feed,
         'Xoro POs → tanda_pos (21:00 nightly post_purchase_orders)' as label,
         (select max(synced_at) from tanda_pos) as last_at,
         26 as threshold_hours
  union all
  select 'sos_mirror',
         'Xoro SOs → tanda_sos (21:00 nightly rich push, upload-sos)',
         (select max(synced_at) from tanda_sos), 26
  union all
  select 'onhand_snapshot',
         'Color-grain on-hand → ip_inventory_snapshot (21:00 nightly)',
         (select max(created_at) from ip_inventory_snapshot), 26
  union all
  select 'item_costing',
         'Item costing → ip_item_avg_cost (21:00 nightly)',
         (select max(updated_at) from ip_item_avg_cost), 26
  union all
  select 'open_sos_planning',
         'Open SOs → ip_open_sales_orders (ATS / planning demand)',
         (select max(last_seen_at) from ip_open_sales_orders), 26
  union all
  select 'open_pos_planning',
         'Open POs → ip_open_purchase_orders (planning supply)',
         (select max(last_seen_at) from ip_open_purchase_orders), 26
  union all
  select 'fetch_log',
         'Nightly fetch completion log (xoro_sync_logs — gates the accounting mirror)',
         (select max(completed_at) from xoro_sync_logs where status = 'complete'), 26
  union all
  select 'accounting_mirror',
         'AR/AP/inventory shadow mirror + summary JEs (01:30 UTC cron)',
         (select max(completed_at) from xoro_mirror_runs where status = 'complete'), 50
)
select feed, label, last_at, threshold_hours,
       case when last_at is null then 'never'
            when last_at < now() - make_interval(hours => threshold_hours) then 'stale'
            else 'ok' end as status,
       round((extract(epoch from (now() - last_at)) / 3600.0)::numeric, 1) as hours_since
from feeds;

grant select on public.v_xoro_feed_health to anon, authenticated;

comment on view public.v_xoro_feed_health is
  'Per-feed Xoro-bridge freshness: ok / stale (past threshold) / never. Read by the xoro-feed-health-alert cron (daily email+bell on any non-ok), the Sync Health panel, and scripts/sync-health.mjs.';
