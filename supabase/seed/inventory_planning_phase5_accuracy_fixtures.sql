-- inventory_planning_phase5_accuracy_fixtures.sql
--
-- Forecast accuracy seed data — exercises ip_forecast_actuals and
-- ip_forecast_accuracy with four deliberate error-pattern stories:
--
--   1. Steady item (TEE-BLK-M × MAJOR): system close; planner sometimes
--      helps, sometimes hurts — tests abs/pct/bias across six periods.
--   2. Lumpy item (HOOD-BLK-M × MAJOR): system under-calls a sparse period;
--      planner partial-corrects — tests weighted-error vs MAPE tradeoff.
--   3. New-item ramp (JEAN-28 × BOUTIQUE): system has zero signal in 2025-11,
--      planner crucial — tests pct_error approaching -100% and recovery.
--   4. Zero-actual period (JEAN-30): actual=0 → pct_error IS NULL;
--      tests NULL-safe rollups.
--
-- Depends on: inventory_planning_phase1_fixtures.sql (DEMO- masters must exist).
-- Safe to re-run — all inserts guard on the unique constraint.
--
-- Cleanup:
--   DELETE FROM ip_forecast_accuracy WHERE planning_run_id IN
--     (SELECT id FROM ip_planning_runs WHERE name = 'Demo — Accuracy 2025-H2');
--   DELETE FROM ip_planning_runs WHERE name = 'Demo — Accuracy 2025-H2';
--   DELETE FROM ip_forecast_actuals WHERE period_start BETWEEN '2025-07-01' AND '2025-12-01'
--     AND sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%');

-- ── Planning run ────────────────────────────────────────────────────────────
INSERT INTO ip_planning_runs
  (name, planning_scope, status, source_snapshot_date, horizon_start, horizon_end, note, created_by)
VALUES
  ('Demo — Accuracy 2025-H2', 'wholesale', 'archived',
   '2025-07-01', '2025-07-01', '2025-12-31',
   'Seed run for forecast accuracy fixtures — DO NOT use for live planning',
   'seed')
ON CONFLICT DO NOTHING;

-- ── Actuals (2025-07 through 2025-12, wholesale grain) ─────────────────────
WITH
  run    AS (SELECT id FROM ip_planning_runs WHERE name = 'Demo — Accuracy 2025-H2'),
  tee_m  AS (SELECT id FROM ip_item_master   WHERE sku_code  = 'DEMO-TEE-BLK-M'),
  hood_m AS (SELECT id FROM ip_item_master   WHERE sku_code  = 'DEMO-HOOD-BLK-M'),
  jean28 AS (SELECT id FROM ip_item_master   WHERE sku_code  = 'DEMO-JEAN-28'),
  jean30 AS (SELECT id FROM ip_item_master   WHERE sku_code  = 'DEMO-JEAN-30'),
  major  AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-MAJOR'),
  boutiq AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-BOUTIQUE')
INSERT INTO ip_forecast_actuals
  (forecast_type, sku_id, customer_id, period_start, period_end, period_code,
   actual_qty, actual_net_sales)
-- Pattern 1: TEE-BLK-M × MAJOR — six months of actual wholesale orders.
SELECT 'wholesale', tee_m.id, major.id, ps, pe, pc, aq, ns
FROM (VALUES
  ('2025-07-01'::date,'2025-07-31'::date,'2025-07', 114::numeric, 2279.86::numeric),
  ('2025-08-01'::date,'2025-08-31'::date,'2025-08', 116::numeric, 2318.84::numeric),
  ('2025-09-01'::date,'2025-09-30'::date,'2025-09', 118::numeric, 2357.82::numeric),
  ('2025-10-01'::date,'2025-10-31'::date,'2025-10', 120::numeric, 2398.80::numeric),
  ('2025-11-01'::date,'2025-11-30'::date,'2025-11', 122::numeric, 2438.78::numeric),
  ('2025-12-01'::date,'2025-12-31'::date,'2025-12', 124::numeric, 2478.76::numeric)
) AS v(ps,pe,pc,aq,ns), tee_m, major
UNION ALL
-- Pattern 2: HOOD-BLK-M × MAJOR — sparse; only one period ships in H2.
SELECT 'wholesale', hood_m.id, major.id, ps, pe, pc, aq, ns
FROM (VALUES
  ('2025-10-01'::date,'2025-10-31'::date,'2025-10', 80::numeric, 3999.20::numeric)
) AS v(ps,pe,pc,aq,ns), hood_m, major
UNION ALL
-- Pattern 3: JEAN-28 × BOUTIQUE — new item; only 2025-11 and 2025-12.
SELECT 'wholesale', jean28.id, boutiq.id, ps, pe, pc, aq, ns
FROM (VALUES
  ('2025-11-01'::date,'2025-11-30'::date,'2025-11', 30::numeric, 1799.70::numeric),
  ('2025-12-01'::date,'2025-12-31'::date,'2025-12', 30::numeric, 1799.70::numeric)
) AS v(ps,pe,pc,aq,ns), jean28, boutiq
UNION ALL
-- Pattern 4: JEAN-30 × MAJOR — actual=0 (phantom demand in one period).
SELECT 'wholesale', jean30.id, major.id, ps, pe, pc, aq, ns
FROM (VALUES
  ('2025-11-01'::date,'2025-11-30'::date,'2025-11', 0::numeric, 0::numeric)
) AS v(ps,pe,pc,aq,ns), jean30, major
ON CONFLICT DO NOTHING;

-- ── Accuracy rows ───────────────────────────────────────────────────────────
-- Error formulas:
--   abs_error     = |forecast - actual|
--   pct_error     = (forecast - actual) / actual  (NULL when actual = 0)
--   bias          = forecast - actual             (positive = overforecast)
--   weighted_error = abs_error * actual           (for WAPE rollups)

WITH
  run    AS (SELECT id FROM ip_planning_runs WHERE name = 'Demo — Accuracy 2025-H2'),
  tee_m  AS (SELECT id FROM ip_item_master     WHERE sku_code     = 'DEMO-TEE-BLK-M'),
  hood_m AS (SELECT id FROM ip_item_master     WHERE sku_code     = 'DEMO-HOOD-BLK-M'),
  jean28 AS (SELECT id FROM ip_item_master     WHERE sku_code     = 'DEMO-JEAN-28'),
  jean30 AS (SELECT id FROM ip_item_master     WHERE sku_code     = 'DEMO-JEAN-30'),
  major  AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-MAJOR'),
  boutiq AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-BOUTIQUE'),
  cat_t  AS (SELECT id FROM ip_category_master WHERE category_code = 'DEMO-TOPS'),
  cat_b  AS (SELECT id FROM ip_category_master WHERE category_code = 'DEMO-BTMS')

INSERT INTO ip_forecast_accuracy
  (planning_run_id,
   forecast_type, sku_id, customer_id, category_id,
   period_start, period_end, period_code,
   system_forecast_qty, final_forecast_qty, actual_qty,
   abs_error_system, abs_error_final,
   pct_error_system, pct_error_final,
   bias_system, bias_final,
   weighted_error_system, weighted_error_final)

-- ── Story 1: DEMO-TEE-BLK-M × DEMO-MAJOR (steady item, 6 months) ──────────
-- Month  | system | final | actual | Story
-- 2025-07 |  105  |  105  |  114   | Both underforecast; system = final
-- 2025-08 |  130  |  140  |  116   | Both overforecast; planner made it worse
-- 2025-09 |  115  |  110  |  118   | Both underforecast; system was closer
-- 2025-10 |  100  |  120  |  120   | Planner nails it; system under by 20
-- 2025-11 |  110  |  125  |  122   | Planner much closer; system under by 12
-- 2025-12 |  124  |  124  |  124   | Perfect match both ways

SELECT
  run.id,
  'wholesale', tee_m.id, major.id, cat_t.id,
  ps, pe, pc,
  sf, ff, aq,
  abs(sf - aq),            -- abs_error_system
  abs(ff - aq),            -- abs_error_final
  CASE WHEN aq = 0 THEN NULL ELSE (sf - aq) / aq END,  -- pct_error_system
  CASE WHEN aq = 0 THEN NULL ELSE (ff - aq) / aq END,  -- pct_error_final
  sf - aq,                  -- bias_system
  ff - aq,                  -- bias_final
  abs(sf - aq) * aq,        -- weighted_error_system
  abs(ff - aq) * aq         -- weighted_error_final
FROM (VALUES
  ('2025-07-01'::date,'2025-07-31'::date,'2025-07', 105::numeric, 105::numeric, 114::numeric),
  ('2025-08-01'::date,'2025-08-31'::date,'2025-08', 130::numeric, 140::numeric, 116::numeric),
  ('2025-09-01'::date,'2025-09-30'::date,'2025-09', 115::numeric, 110::numeric, 118::numeric),
  ('2025-10-01'::date,'2025-10-31'::date,'2025-10', 100::numeric, 120::numeric, 120::numeric),
  ('2025-11-01'::date,'2025-11-30'::date,'2025-11', 110::numeric, 125::numeric, 122::numeric),
  ('2025-12-01'::date,'2025-12-31'::date,'2025-12', 124::numeric, 124::numeric, 124::numeric)
) AS v(ps, pe, pc, sf, ff, aq),
run, tee_m, major, cat_t

UNION ALL

-- ── Story 2: DEMO-HOOD-BLK-M × DEMO-MAJOR (lumpy/sparse, 1 active month) ──
-- 2025-10: system undershoots, planner partial-corrects
-- Weighted error is large (high-volume miss); MAPE is 25% / 12.5%.

SELECT
  run.id,
  'wholesale', hood_m.id, major.id, cat_t.id,
  ps, pe, pc, sf, ff, aq,
  abs(sf - aq), abs(ff - aq),
  (sf - aq) / aq, (ff - aq) / aq,
  sf - aq, ff - aq,
  abs(sf - aq) * aq, abs(ff - aq) * aq
FROM (VALUES
  ('2025-10-01'::date,'2025-10-31'::date,'2025-10', 60::numeric, 70::numeric, 80::numeric)
) AS v(ps, pe, pc, sf, ff, aq),
run, hood_m, major, cat_t

UNION ALL

-- ── Story 3: DEMO-JEAN-28 × DEMO-BOUTIQUE (new item ramp) ──────────────────
-- 2025-11: system=0 (no signal), planner=20, actual=30 → planner crucial but still −33%
-- 2025-12: system=25 (first signal), planner=35 → system closer; planner over by +5

SELECT
  run.id,
  'wholesale', jean28.id, boutiq.id, cat_b.id,
  ps, pe, pc, sf, ff, aq,
  abs(sf - aq), abs(ff - aq),
  (sf - aq) / aq, (ff - aq) / aq,
  sf - aq, ff - aq,
  abs(sf - aq) * aq, abs(ff - aq) * aq
FROM (VALUES
  ('2025-11-01'::date,'2025-11-30'::date,'2025-11',  0::numeric, 20::numeric, 30::numeric),
  ('2025-12-01'::date,'2025-12-31'::date,'2025-12', 25::numeric, 35::numeric, 30::numeric)
) AS v(ps, pe, pc, sf, ff, aq),
run, jean28, boutiq, cat_b

UNION ALL

-- ── Story 4: DEMO-JEAN-30 × DEMO-MAJOR (zero-actual, pct_error IS NULL) ───
-- 2025-11: system projected 15, planner trimmed to 10; actual=0.
-- pct_error_system and pct_error_final must both be NULL.
-- weighted_error = 0 (actual=0) despite non-zero abs_error.

SELECT
  run.id,
  'wholesale', jean30.id, major.id, cat_b.id,
  ps, pe, pc, sf, ff, aq,
  abs(sf - aq),   abs(ff - aq),
  NULL::numeric,  NULL::numeric,    -- pct_error NULL when actual=0
  sf - aq, ff - aq,
  0::numeric,     0::numeric        -- weighted_error = abs * 0 = 0
FROM (VALUES
  ('2025-11-01'::date,'2025-11-30'::date,'2025-11', 15::numeric, 10::numeric, 0::numeric)
) AS v(ps, pe, pc, sf, ff, aq),
run, jean30, major, cat_b

ON CONFLICT DO NOTHING;
