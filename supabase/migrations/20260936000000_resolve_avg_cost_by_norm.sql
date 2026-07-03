-- Normalized-SKU standard-cost / standard-price resolver.
--
-- ip_item_avg_cost is keyed by a sku_code whose punctuation differs from
-- ip_item_master.sku_code (e.g. the color segment is dash-collapsed:
-- item "…MN-DEEP-BLACK-GD-LRG" vs cost "…MN-DEEPBLACKGD-LRG"). Both the PO
-- (enrichPricing) and SO (computeSoMetrics) grids "matched loosely" only among
-- rows already fetched by EXACT sku_code, so the loose fallback was a no-op and
-- standard-cost coverage sat at ~40% instead of the ~89% a real normalized match
-- reaches. This resolver normalizes both sides (upper + strip non-alphanumerics)
-- and returns the standard cost + standard unit (selling) price per input SKU.

create index if not exists ix_ip_item_avg_cost_sku_norm
  on ip_item_avg_cost ((regexp_replace(upper(sku_code), '[^A-Z0-9]', '', 'g')));

create or replace function resolve_avg_cost_by_norm(p_skus text[])
returns table(input_sku text, avg_cost numeric, standard_unit_price numeric)
language sql
stable
as $$
  with inp as (
    select distinct s as input_sku,
           regexp_replace(upper(s), '[^A-Z0-9]', '', 'g') as k
    from unnest(p_skus) as s
    where s is not null and s <> ''
  ),
  norm as (
    select distinct on (k) k, avg_cost, standard_unit_price
    from (
      select regexp_replace(upper(sku_code), '[^A-Z0-9]', '', 'g') as k,
             avg_cost, standard_unit_price, updated_at
      from ip_item_avg_cost
      where avg_cost is not null or standard_unit_price is not null
    ) t
    order by k, updated_at desc nulls last
  )
  select inp.input_sku, norm.avg_cost, norm.standard_unit_price
  from inp
  join norm on norm.k = inp.k;
$$;

comment on function resolve_avg_cost_by_norm(text[]) is 'Resolve standard cost + standard unit price from ip_item_avg_cost by normalized (upper, alphanumeric-only) sku_code. Fixes the exact-match-only coverage gap on the PO/SO grids.';

grant execute on function resolve_avg_cost_by_norm(text[]) to anon, authenticated, service_role;
