-- AP AmountPaid delta-watcher: keep GL 2000 tied to the Xoro Bills register
-- AFTER the #1668 history backfill.
--
-- Why: register-backfilled bills (invoices.source='xoro_bills_register') are
-- FROZEN from the nightly Xoro AP sync by design, and the live bill/getbill
-- feed carries only a derived Paid/Partial/Unpaid status — no AmountPaid
-- amounts, no payment dates, no payment accounts. Paid-state truth arrives
-- only via the manual Bills-register + Payments exports (re-imported at
-- cutover, ~2026-07-28). Without a watcher, every Xoro payment after the
-- export silently drifts GL 2000 away from the register.
--
-- The watcher (api/_lib/ap-paid-watcher.js, nightly 06:30 UTC cron
-- /api/cron/ap-paid-delta-watcher) compares the LATEST imported register
-- state (ap_bill_register_import) + payments staging (ap_payment_import)
-- against what is posted, posts the increments exactly the way #1668 did
-- (same accounts, same journal_types, SOURCE dates), and alerts on
-- anomalies (AmountPaid decreased, bill total changed, unknown bill,
-- per-vendor cash drift) via app_errors(source='cron') + notifications.
--
-- This migration is fully idempotent — it may be applied manually before
-- merge (run-sql-prod) and re-applied harmlessly by CI db-push.

-- ── 1. Watcher baselines on the register staging table ──────────────────────
-- "processed" = the register state the GL already reflects. The import
-- upsert never touches these columns (they are not in its payload), so a
-- fresh register lands as raw deltas against them.
ALTER TABLE ap_bill_register_import
  ADD COLUMN IF NOT EXISTS paid_processed_cents        bigint,
  ADD COLUMN IF NOT EXISTS relief_5005_processed_cents bigint,
  ADD COLUMN IF NOT EXISTS relief_1308_processed_cents bigint;

COMMENT ON COLUMN ap_bill_register_import.paid_processed_cents IS
  'AP paid-delta watcher: register Amount Paid (cents) last reconciled to the GL. NULL = row never baselined (new bill from a fresh register import).';
COMMENT ON COLUMN ap_bill_register_import.relief_5005_processed_cents IS
  'AP paid-delta watcher: discounts + vendor credits (cents) already posted to 5005 via relief JEs.';
COMMENT ON COLUMN ap_bill_register_import.relief_1308_processed_cents IS
  'AP paid-delta watcher: prepayments applied (cents) already posted to 1308 via relief JEs.';

-- Baseline backfill: #1668 verified GL 2000 = register Sigma Amount Due to the
-- cent against EXACTLY this staging state, so current values ARE processed.
-- Only NULL rows are touched (idempotent; future imports insert new rows
-- with NULL baselines, which the watcher flags as new bills).
UPDATE ap_bill_register_import SET
  paid_processed_cents        = paid_cents,
  relief_5005_processed_cents = CASE WHEN relief_je_id IS NOT NULL THEN discounts_cents + vendor_credits_cents ELSE 0 END,
  relief_1308_processed_cents = CASE WHEN relief_je_id IS NOT NULL THEN prepayments_cents ELSE 0 END
WHERE paid_processed_cents IS NULL;

-- ── 2. Run log (drives the Sync Health tile) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS ap_paid_watcher_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT
                          DEFAULT coalesce(current_entity_id(), rof_entity_id()),
  ran_at                timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'ok',   -- ok | anomalies | error
  bills_checked         int    NOT NULL DEFAULT 0,
  payments_posted       int    NOT NULL DEFAULT 0,
  payments_posted_cents bigint NOT NULL DEFAULT 0,
  relief_posted         int    NOT NULL DEFAULT 0,
  relief_posted_cents   bigint NOT NULL DEFAULT 0,
  paid_delta_bills      int    NOT NULL DEFAULT 0,
  paid_delta_cents      bigint NOT NULL DEFAULT 0,
  anomalies             int    NOT NULL DEFAULT 0,
  details               jsonb
);

CREATE INDEX IF NOT EXISTS idx_ap_paid_watcher_runs_ran_at ON ap_paid_watcher_runs (ran_at DESC);

ALTER TABLE ap_paid_watcher_runs ENABLE ROW LEVEL SECURITY;
-- No policies: service-role writes only (20260964 financial-table posture);
-- the Sync Health panel reads freshness through v_xoro_feed_health below.

COMMENT ON TABLE ap_paid_watcher_runs IS
  'AP AmountPaid delta-watcher run log (nightly 06:30 UTC cron). One row per run; details jsonb carries per-run postings + anomalies. Feeds the ap_paid_watcher row of v_xoro_feed_health.';

-- ── 3. Sync Health: the watcher joins the watched feed set ───────────────────
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
  union all
  select 'ap_paid_watcher',
         'AP AmountPaid delta watcher (06:30 UTC cron; register/payments staging → payment + relief JEs, GL 2000 guard)'
           || coalesce((select ' — last run: ' || r.payments_posted || ' payment + ' || r.relief_posted || ' relief JE(s), '
                               || r.paid_delta_bills || ' paid delta(s), ' || r.anomalies || ' anomaly(ies)'
                        from ap_paid_watcher_runs r order by r.ran_at desc limit 1), ''),
         (select max(ran_at) from ap_paid_watcher_runs), 26
)
select feed, label, last_at, threshold_hours,
       case when last_at is null then 'never'
            when last_at < now() - make_interval(hours => threshold_hours) then 'stale'
            else 'ok' end as status,
       round((extract(epoch from (now() - last_at)) / 3600.0)::numeric, 1) as hours_since
from feeds;

grant select on public.v_xoro_feed_health to anon, authenticated;
