-- #1926 — collapse the SIZE-ONLY planning groups to one line (CEO 2026-07-24).
--
-- Follow-up to #1925. #1925 collapsed (customer, style, colour) groups that had
-- a rolled-up (size-NULL) SKU; it did NOT touch groups that are size/PPK-ONLY
-- (no rolled-up), so those still rendered as N lines — the family number is
-- REPLICATED across sizes (e.g. RYB1505 GRAYWOLF: six sizes all 882, no
-- rolled-up). The CEO invariant is ONE line per (customer, style, colour, period).
--
-- Mirrors collapseToRolledUpGrain()'s size-only branch: within each
-- (run, customer, style_id, colour) group that has NO rolled-up row, keep the
-- representative sized SKU (greatest total system_forecast, tie → lowest sku_id —
-- and because the sizes are replicated, that equals the family number; summing
-- would over-count) and delete the rest, from BOTH forecast and recommendations.
--
-- Pre-image archived to
--   rof_xoro_project/.launchd-logs/planning-sizeonly-preimage-2026-07-24.json
-- The build fix prevents recurrence. Applied to PROD 2026-07-24: 720 forecast
-- rows across 31 style/colours (+ matching recommendations). After #1925+#1926
-- every (customer, style, colour, period) in the run has exactly one line.

begin;

with cand as (
  select f.id, f.planning_run_id, f.customer_id, im.style_id, im.color, f.sku_id,
         sum(f.system_forecast_qty) over (
           partition by f.planning_run_id, f.customer_id, im.style_id, im.color, f.sku_id) as sku_total
    from ip_wholesale_forecast f
    join ip_item_master im on im.id = f.sku_id
   where im.size is not null and im.style_id is not null
     and not exists (
       select 1 from ip_item_master r2
        join ip_wholesale_forecast f3 on f3.sku_id = r2.id
         and f3.planning_run_id = f.planning_run_id and f3.customer_id = f.customer_id
       where r2.style_id = im.style_id and r2.size is null
         and lower(btrim(coalesce(r2.color, ''))) = lower(btrim(coalesce(im.color, ''))))
), ranked as (
  select *, dense_rank() over (
    partition by planning_run_id, customer_id, style_id, color
    order by sku_total desc, sku_id) as rnk
  from cand
), losers as (select distinct planning_run_id, customer_id, sku_id from ranked where rnk > 1)
delete from ip_wholesale_recommendations w using losers l
 where w.planning_run_id = l.planning_run_id and w.customer_id = l.customer_id and w.sku_id = l.sku_id;

with cand as (
  select f.id, f.planning_run_id, f.customer_id, im.style_id, im.color, f.sku_id,
         sum(f.system_forecast_qty) over (
           partition by f.planning_run_id, f.customer_id, im.style_id, im.color, f.sku_id) as sku_total
    from ip_wholesale_forecast f
    join ip_item_master im on im.id = f.sku_id
   where im.size is not null and im.style_id is not null
     and not exists (
       select 1 from ip_item_master r2
        join ip_wholesale_forecast f3 on f3.sku_id = r2.id
         and f3.planning_run_id = f.planning_run_id and f3.customer_id = f.customer_id
       where r2.style_id = im.style_id and r2.size is null
         and lower(btrim(coalesce(r2.color, ''))) = lower(btrim(coalesce(im.color, ''))))
), ranked as (
  select *, dense_rank() over (
    partition by planning_run_id, customer_id, style_id, color
    order by sku_total desc, sku_id) as rnk
  from cand
)
delete from ip_wholesale_forecast f using ranked rk where f.id = rk.id and rk.rnk > 1;

commit;
