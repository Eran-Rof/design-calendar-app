-- Style code aliases — mirror of vendors.aliases / customers.aliases.
-- When an operator renumbers a style (e.g. drop a legacy Xoro inseam infix:
-- RYB147730 -> RYB1477PPK), the OLD style_code is captured here so style-grain
-- lookups still resolve the renamed style. Transactional history is FK'd by
-- UUID (ip_item_master.style_id, *_lines.inventory_item_id, inventory_layers
-- .item_id, ip_sales_history_wholesale.sku_id) so it stays wired automatically;
-- aliases cover the string-keyed style-grain resolvers (Xoro importer loadStyles,
-- prepack matrix, any "find style by code"). SKU-level joins survive because
-- sku_code is kept stable on rename.
alter table style_master add column if not exists aliases text[] not null default '{}';

-- GIN index so `aliases @> array['CODE']` / `'CODE' = any(aliases)` lookups are cheap.
create index if not exists idx_style_master_aliases on style_master using gin (aliases);
