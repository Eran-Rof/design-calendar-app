-- #1925 — collapse wholesale planning to the rolled-up grain (CEO 2026-07-24).
--
-- One-off data cleanup that mirrors collapseToRolledUpGrain() in the build
-- (src/inventory-planning/compute/rolledUpGrain.ts). Deletes the sized-SKU
-- forecast + recommendation rows whose (planning_run, customer, style, color)
-- ALSO has a rolled-up (size-NULL) row — the both-grains duplication that made a
-- style/color render as ~7 lines with the family number replicated per size.
--
-- Customer-scoped and style_id-scoped so it never drops a customer's ONLY line
-- for a style/color (the ~1,012 size-only groups keep their sized rows). A
-- pre-image of the deleted forecast rows was archived to
--   rof_xoro_project/.launchd-logs/planning-rolledup-preimage-2026-07-24.json
-- before running. The build fix prevents recurrence, so this is not a migration.
-- Applied to PROD 2026-07-24: 1,900 forecast rows (+ matching recommendations).

begin;

delete from ip_wholesale_recommendations w
using ip_item_master im
where im.id = w.sku_id and im.size is not null and im.style_id is not null
  and exists (
    select 1 from ip_item_master r
     join ip_wholesale_recommendations w2 on w2.sku_id = r.id
      and w2.planning_run_id = w.planning_run_id and w2.customer_id = w.customer_id
    where r.size is null and r.style_id = im.style_id
      and lower(btrim(coalesce(r.color, ''))) = lower(btrim(coalesce(im.color, ''))));

delete from ip_wholesale_forecast f
using ip_item_master im
where im.id = f.sku_id and im.size is not null and im.style_id is not null
  and exists (
    select 1 from ip_item_master r
     join ip_wholesale_forecast f2 on f2.sku_id = r.id
      and f2.planning_run_id = f.planning_run_id and f2.customer_id = f.customer_id
    where r.size is null and r.style_id = im.style_id
      and lower(btrim(coalesce(r.color, ''))) = lower(btrim(coalesce(im.color, ''))));

commit;
