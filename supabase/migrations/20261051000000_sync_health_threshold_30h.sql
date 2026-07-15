-- Standardize every Xoro-feed-health staleness threshold to 30 hours.
--
-- The feeds run in an overnight window (~21:00 + a few crons through ~06:30),
-- so a 26h threshold false-flags a normally-timed-but-slightly-late run, and
-- the accounting mirror's 50h was inconsistently loose. One uniform 30h gives
-- every daily feed a sane on-time buffer without hiding a genuine miss.
--
-- View body is otherwise identical to the prior definition (only the
-- threshold_hours literals change: 26→30 and 50→30).

create or replace view v_xoro_feed_health as
with feeds as (
  select 'pos_mirror'::text as feed,
         'Xoro POs → tanda_pos (21:00 nightly post_purchase_orders)'::text as label,
         (select max(synced_at) from tanda_pos) as last_at,
         30 as threshold_hours
  union all
  select 'sos_mirror'::text,
         'Xoro SOs → tanda_sos (21:00 nightly rich push, upload-sos)'::text,
         (select max(synced_at) from tanda_sos), 30
  union all
  select 'onhand_snapshot'::text,
         'Color-grain on-hand → ip_inventory_snapshot (21:00 nightly)'::text,
         (select max(created_at) from ip_inventory_snapshot), 30
  union all
  select 'item_costing'::text,
         'Item costing → ip_item_avg_cost (21:00 nightly)'::text,
         (select max(updated_at) from ip_item_avg_cost), 30
  union all
  select 'open_sos_planning'::text,
         'Open SOs → ip_open_sales_orders (ATS / planning demand)'::text,
         (select max(last_seen_at) from ip_open_sales_orders), 30
  union all
  select 'open_pos_planning'::text,
         'Open POs → ip_open_purchase_orders (planning supply)'::text,
         (select max(last_seen_at) from ip_open_purchase_orders), 30
  union all
  select 'fetch_log'::text,
         'Nightly fetch completion log (xoro_sync_logs — gates the accounting mirror)'::text,
         (select max(completed_at) from xoro_sync_logs where status = 'complete'), 30
  union all
  select 'accounting_mirror'::text,
         'AR/AP/inventory shadow mirror + summary JEs (01:30 UTC cron)'::text,
         (select max(completed_at) from xoro_mirror_runs where status = 'complete'), 30
  union all
  select 'ar_payment_state'::text,
         'Invoice payment state (Xoro FullPaymentDate → ar_xoro_payment_state, drives receipts)'::text,
         (select max(synced_at) from ar_xoro_payment_state), 30
  union all
  select 'ap_paid_watcher'::text,
         'AP AmountPaid delta watcher (06:30 UTC cron; register/payments staging → payment + relief JEs, GL 2000 guard)'::text
           || coalesce((select ' — last run: ' || r.payments_posted || ' payment + ' || r.relief_posted
                        || ' relief JE(s), ' || r.paid_delta_bills || ' paid delta(s), ' || r.anomalies || ' anomaly(ies)'
                        from ap_paid_watcher_runs r order by r.ran_at desc limit 1), ''),
         (select max(ran_at) from ap_paid_watcher_runs), 30
)
select feed, label, last_at, threshold_hours,
  case
    when last_at is null then 'never'
    when last_at < (now() - make_interval(hours => threshold_hours)) then 'stale'
    else 'ok'
  end as status,
  round(extract(epoch from now() - last_at) / 3600.0, 1) as hours_since
from feeds;
