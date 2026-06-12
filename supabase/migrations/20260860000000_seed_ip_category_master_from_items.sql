-- Seed ip_category_master from the merchandising groups already present
-- on ip_item_master (Xoro GroupName, stored in attributes->>'group_name').
--
-- WHY: the table shipped empty in prod. No production code path ever wrote
-- it (the ip-normalize pipeline only READS it to reconcile category_id, and
-- the demo fixtures only seed DEMO-* rows). So listCategories() returned [],
-- the planning "Category" filter + the Future Demand Requests category picker
-- had nothing to show, and the master looked broken.
--
-- The planning grid's top-level "Category" dimension IS group_name (18 clean
-- values in prod: DENIM, PANTS, TEE, SHORTS, JOGGERS, …). The finer
-- attributes.category_name (~112 values) is the grid's "Sub Cat" level, so it
-- is intentionally NOT seeded here.
--
-- Idempotent: ON CONFLICT (category_code) DO NOTHING preserves the demo rows
-- and makes re-runs / fresh deploys safe. The xoro-items-missing-sync handler
-- registers any NEW groups going forward, so this is the one-time backfill of
-- everything already in the item master.

insert into ip_category_master (category_code, name, segment, external_refs)
select
  upper(trim(g))                                            as category_code,
  max(trim(g))                                              as name,
  'wholesale'                                               as segment,
  jsonb_build_object('source', 'ip_item_master.group_name') as external_refs
from (
  select attributes->>'group_name' as g
  from ip_item_master
  where active
) s
where nullif(trim(g), '') is not null
group by upper(trim(g))
on conflict (category_code) do nothing;
