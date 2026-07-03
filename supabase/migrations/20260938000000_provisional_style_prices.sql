-- Provisional style selling prices (PO grid Sell fallback of last resort).
--
-- For PO styles with NO selling history we seed a provisional selling price at a
-- 21% MARGIN off the PO's own line cost (sell = cost / (1 - 0.21)), so the PO
-- grid's Sell / Margin columns aren't blank for never-sold styles. This lives in
-- a DEDICATED table read ONLY by the PO/SO grid Sell fallback — the M43 pricing
-- engine never sees it, so a placeholder price can never leak into a real
-- customer quote. Once an actual SO / invoice / Xoro sale exists for the style,
-- recent_sell_by_style() below resolves the real price, which the grid ranks
-- ABOVE the provisional (and the seeder deactivates the provisional row).

create table if not exists provisional_style_prices (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null default rof_entity_id(),
  style_id     uuid not null references style_master(id) on delete cascade,
  price_cents  integer not null check (price_cents >= 0),
  margin_pct   numeric not null default 21,
  basis        text not null default 'po_line_cost',
  source_po_id uuid,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists ux_provisional_style
  on provisional_style_prices (entity_id, style_id);
create index if not exists ix_provisional_style_active
  on provisional_style_prices (style_id) where is_active;

-- Internal-only table: enable RLS with no policy so anon/authenticated cannot
-- read it; the service-role API key (used by the internal handlers) bypasses RLS.
alter table provisional_style_prices enable row level security;

comment on table provisional_style_prices is 'Placeholder 21%-margin selling prices for PO styles with no selling history. Read only by the PO/SO grid Sell fallback, never by the M43 quote engine. Superseded by recent_sell_by_style once a real sale exists.';

-- Most-recent actual selling price per style, across historical/Xoro wholesale
-- sales and native sales orders. Returns cents. Used by the grid Sell fallback so
-- a style's real price shows the moment it has an SO/invoice/Xoro sale — ranked
-- above the provisional placeholder.
create or replace function recent_sell_by_style(p_style_ids uuid[])
returns table(style_id uuid, unit_price_cents integer)
language sql
stable
as $$
  with sales as (
    select im.style_id,
           round(w.unit_price * 100)::int as cents,
           w.txn_date::timestamptz as ts
    from ip_sales_history_wholesale w
    join ip_item_master im on im.id = w.sku_id
    where im.style_id = any(p_style_ids)
      and w.unit_price is not null and w.unit_price > 0
    union all
    select im.style_id,
           sol.unit_price_cents as cents,
           so.order_date::timestamptz as ts
    from sales_order_lines sol
    join ip_item_master im on im.id = sol.inventory_item_id
    join sales_orders so on so.id = sol.sales_order_id
    where im.style_id = any(p_style_ids)
      and sol.unit_price_cents is not null and sol.unit_price_cents > 0
  )
  select distinct on (style_id) style_id, cents
  from sales
  order by style_id, ts desc nulls last;
$$;

comment on function recent_sell_by_style(uuid[]) is 'Most-recent actual selling price (cents) per style from wholesale sales history + native sales orders. Backs the PO/SO grid Sell fallback and supersedes provisional_style_prices.';

grant execute on function recent_sell_by_style(uuid[]) to anon, authenticated, service_role;
