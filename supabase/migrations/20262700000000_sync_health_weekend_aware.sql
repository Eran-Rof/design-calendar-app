-- Make the Xoro-feed-health staleness calc WEEKEND-AWARE.
--
-- The REST/Xoro feeds (local nightly fetch + the xoro-mirror / ar-payload /
-- ap-sync / receipts / cost-backfill crons + the two alert crons) are now
-- scheduled Mon–Fri only (vercel.json `* * 1-5`, RofXoroDailyFetch weekly),
-- because there are no weekend transactions to move them. That means on a
-- Monday the freshest run is Friday night's — a ~50–84h raw gap — which a flat
-- 30h threshold would false-flag as "stale" every Monday.
--
-- Fix: compute a BUSINESS-hours age = raw hours elapsed minus 24h for each
-- Saturday/Sunday calendar day spanned since the feed last updated, then apply
-- the SAME 30h threshold to that. A normal Fri→Mon gap collapses to a few
-- business-hours (OK), while a genuine weekday miss (e.g. Tue feed dead, seen
-- Wed) still exceeds 30h and alerts. Weekday sensitivity is unchanged.
--
-- Weekend boundaries are evaluated in the DB session tz (UTC); a few-hour skew
-- vs PT is immaterial at day granularity. hours_since (raw) is retained for
-- display; business_hours_since is added for transparency. Thresholds unchanged.
-- ap_paid_watcher's own cron still runs daily (incl. weekends), so its feed is
-- unaffected either way — the weekend-day subtraction is simply 0 for it.

create or replace view v_xoro_feed_health as
with feeds as (
  select 'pos_mirror'::text as feed,
         'Xoro POs → tanda_pos (Mon–Fri nightly post_purchase_orders)'::text as label,
         (select max(synced_at) from tanda_pos) as last_at,
         30 as threshold_hours
  union all
  select 'sos_mirror'::text,
         'Xoro SOs → tanda_sos (Mon–Fri nightly rich push, upload-sos)'::text,
         (select max(synced_at) from tanda_sos), 30
  union all
  select 'onhand_snapshot'::text,
         'Color-grain on-hand → ip_inventory_snapshot (Mon–Fri nightly)'::text,
         (select max(created_at) from ip_inventory_snapshot), 30
  union all
  select 'item_costing'::text,
         'Item costing → ip_item_avg_cost (Mon–Fri nightly)'::text,
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
         'AR/AP/inventory shadow mirror + summary JEs (Mon–Fri 01:30 UTC cron)'::text,
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
),
scored as (
  select
    feed, label, last_at, threshold_hours,
    round(extract(epoch from now() - last_at) / 3600.0, 1) as hours_since,
    -- Saturdays + Sundays spanned since last_at (calendar days in [last_at, today]).
    case when last_at is null then 0 else (
      select count(*)::int
      from generate_series(last_at::date, now()::date, interval '1 day') g(d)
      where extract(isodow from g.d) in (6, 7)
    ) end as weekend_days
  from feeds
)
-- Column order MUST match the existing view (…, status, hours_since) so
-- CREATE OR REPLACE succeeds; business_hours_since is APPENDED last.
select
  feed, label, last_at, threshold_hours,
  case
    when last_at is null then 'never'
    when greatest(0, hours_since - 24 * weekend_days) > threshold_hours then 'stale'
    else 'ok'
  end as status,
  hours_since,
  greatest(0, round(hours_since - 24 * weekend_days, 1)) as business_hours_since
from scored;

comment on view v_xoro_feed_health is
  'Per-feed Xoro-bridge freshness with WEEKEND-AWARE staleness: business_hours_since = raw hours minus 24h per Sat/Sun spanned; status stale when that exceeds threshold_hours (30h). Feeds run Mon–Fri, so a normal Fri→Mon gap reads OK while a weekday miss still alerts. Read by xoro-feed-health-alert, the Sync Health panel, and scripts/sync-health.mjs. #sync-health';

grant select on public.v_xoro_feed_health to anon, authenticated;
