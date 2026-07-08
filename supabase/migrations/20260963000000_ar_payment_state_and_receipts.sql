-- Revenue→GL Phase 4: AR payment state from Xoro + receipts reconciliation.
--
-- Xoro's invoice feed carries per-invoice payment status + FullPaymentDate.
-- The nightly rest_invoice_sync.py now pushes that state here; the daily
-- ar-receipts-reconcile cron posts receipt JEs (DR 1051 Factor Advances -
-- Rosenthal for factored customers / DR 1030 Undeposited Funds otherwise /
-- CR the invoice's AR account, customer subledger) for invoices Xoro says are
-- PAID — so Tangerine's AR tracks Xoro's state daily instead of ballooning.
create table if not exists public.ar_xoro_payment_state (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references public.entities(id) on delete restrict
                      default coalesce(current_entity_id(), rof_entity_id()),
  invoice_number    text not null,
  payment_status    text,
  full_payment_date date,
  synced_at         timestamptz not null default now(),
  unique (entity_id, invoice_number)
);
create index if not exists idx_ar_xoro_payment_state_date on public.ar_xoro_payment_state (full_payment_date);
alter table public.ar_xoro_payment_state enable row level security;
-- Service-role only (no anon policies): written by the nightly push endpoint,
-- read by the reconcile cron.
comment on table public.ar_xoro_payment_state is
  'Per-invoice Xoro payment state (StatusName + FullPaymentDate) from the nightly invoice walk. Drives ar-receipts-reconcile.';

-- Sync Health: the payment-state feed joins the watched set.
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
  union all
  select 'ar_payment_state',
         'Invoice payment state (Xoro FullPaymentDate → ar_xoro_payment_state, drives receipts)',
         (select max(synced_at) from ar_xoro_payment_state), 26
)
select feed, label, last_at, threshold_hours,
       case when last_at is null then 'never'
            when last_at < now() - make_interval(hours => threshold_hours) then 'stale'
            else 'ok' end as status,
       round((extract(epoch from (now() - last_at)) / 3600.0)::numeric, 1) as hours_since
from feeds;

grant select on public.v_xoro_feed_health to anon, authenticated;
