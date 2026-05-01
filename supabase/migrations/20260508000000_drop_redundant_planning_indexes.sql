-- Drop redundant secondary indexes on the wholesale planning tables.
--
-- Every row INSERT / UPDATE on ip_wholesale_forecast and
-- ip_wholesale_recommendations has to maintain every index on the
-- table. With 16k+ rows per build, the per-row cost compounds and tips
-- Supabase's 8s statement timeout (Postgres error 57014).
--
-- Audit:
--   ip_wholesale_forecast
--     • PK(id)                                          — keep
--     • uq_ip_wholesale_forecast_grain
--         (planning_run_id, customer_id, sku_id, period_start) — keep (ON CONFLICT)
--     • idx_ip_wholesale_forecast_run_id
--         (planning_run_id, id)                         — keep (cursor pagination)
--     • idx_ip_wholesale_forecast_run_lookup
--         (planning_run_id, id)                         — DROP (exact duplicate of run_id)
--     • idx_ip_wf_system_override
--         (planning_run_id, id) WHERE override IS NOT NULL — keep (partial, niche use)
--     • idx_ip_wf_run (planning_run_id)                 — DROP (covered by run_id + grain)
--     • idx_ip_wf_customer (customer_id)                — DROP (no consuming query)
--     • idx_ip_wf_category (category_id)                — DROP (no consuming query)
--     • idx_ip_wf_sku (sku_id)                          — DROP (no consuming query)
--     • idx_ip_wf_period (period_code)                  — DROP (no consuming query)
--
--   ip_wholesale_recommendations
--     • PK(id)                                          — keep
--     • uq_ip_wrec_grain
--         (planning_run_id, customer_id, sku_id, period_start) — keep (data integrity;
--         also serves as the planning_run_id filter index since run_id leads)
--     • idx_ip_wrec_run (planning_run_id)               — DROP (covered by uq_grain)
--     • idx_ip_wrec_action (recommended_action)         — DROP (no consuming query)
--     • idx_ip_wrec_customer (customer_id)              — DROP (no consuming query)
--     • idx_ip_wrec_sku (sku_id)                        — DROP (no consuming query)
--
-- Net effect: forecast goes from 6 secondary indexes to 2, recs goes
-- from 4 to 1. INSERT / UPSERT / DELETE on these tables drops ~60% of
-- the per-row index-maintenance cost. If a future query needs one of
-- these dropped indexes back, add it then — it's much cheaper to add
-- a real index for a real query than to carry write-tax for no reads.
--
-- Drops are non-concurrent (DROP INDEX inside a transaction). Each
-- drop is metadata-only and fast; the brief AccessExclusiveLock is a
-- non-issue for this workload.

BEGIN;

DROP INDEX IF EXISTS idx_ip_wf_run;
DROP INDEX IF EXISTS idx_ip_wf_customer;
DROP INDEX IF EXISTS idx_ip_wf_category;
DROP INDEX IF EXISTS idx_ip_wf_sku;
DROP INDEX IF EXISTS idx_ip_wf_period;
DROP INDEX IF EXISTS idx_ip_wholesale_forecast_run_lookup;

DROP INDEX IF EXISTS idx_ip_wrec_run;
DROP INDEX IF EXISTS idx_ip_wrec_action;
DROP INDEX IF EXISTS idx_ip_wrec_customer;
DROP INDEX IF EXISTS idx_ip_wrec_sku;

COMMIT;
