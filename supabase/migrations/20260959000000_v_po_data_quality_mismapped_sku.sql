-- Add the `mismapped_sku` defect class to v_po_data_quality (Defect C root class).
-- A legacy Xoro import mis-resolution bound sized order lines to COLOURLESS SKUs
-- (sku_code = STYLE-SIZE, e.g. RYB1157-LRG) while a colour is set on the row — so
-- the PO's size/colour matrix shows phantom single-size "colours" even though the
-- PO TOTAL is correct (units/money tie; only attribution is wrong). This surfaces
-- the whole class (≈499 lines / 35 POs) instead of only the coverage symptom.
-- The importer's sku-create bug behind it is fixed in scripts/import-xoro-orders.mjs.
-- Full redefinition (adds sku_code to active_lines + the new UNION branch).
create or replace view public.v_po_data_quality as
with active_lines as (
  select p.id as po_id, p.po_number, l.id as line_id, l.inventory_item_id,
         im.style_code, im.color, im.size, im.sku_code
  from purchase_orders p
  join purchase_order_lines l on l.purchase_order_id = p.id
  left join ip_item_master im on im.id = l.inventory_item_id
  where p.status in ('issued','partially_received','in_transit')
),
orphan as (
  select al.po_id, al.po_number,
         'orphan_style_code'::text as defect_class, 'error'::text as severity,
         al.style_code, null::text as color,
         'Style code is not in the catalog (style_master); the PO modal shows "Style not found".'::text as detail,
         (case when exists (select 1 from style_master sm
                 where sm.style_code = regexp_replace(al.style_code,'([A-Za-z]+[0-9]{4,})([0-9]{2})(PPK)?$','\1\3'))
               then 'Remap to ' || regexp_replace(al.style_code,'([A-Za-z]+[0-9]{4,})([0-9]{2})(PPK)?$','\1\3')
               else 'Create this style in the catalog (define a prepack matrix if it is PPK).' end)::text as suggested_fix,
         count(*)::int as item_count
  from active_lines al
  where al.style_code is not null
    and not exists (select 1 from style_master sm where sm.style_code = al.style_code)
  group by al.po_id, al.po_number, al.style_code
),
unlinked as (
  select al.po_id, al.po_number, 'unlinked_line', 'error',
         null::text, null::text,
         'PO line has no linked SKU (inventory item); no cost, sell, or size matrix can be computed.',
         'Match the line to a SKU, or create the SKU from the PO.',
         count(*)::int
  from active_lines al
  where al.inventory_item_id is null
  group by al.po_id, al.po_number
),
mismapped as (
  select al.po_id, al.po_number, 'mismapped_sku', 'warn',
         al.style_code, al.color,
         'SKU code carries no colour (a colour is set but the code is STYLE-SIZE) — a legacy import mis-resolution. The PO total is correct, but the size/colour matrix shows phantom single-size colours.',
         'Re-import the PO from the Xoro source with the fixed resolver to re-attribute lines to correct colour+size SKUs.',
         count(*)::int
  from active_lines al
  where al.style_code is not null and al.color is not null and al.sku_code is not null
    and upper(al.sku_code) ~ ('^'||upper(al.style_code)||'-(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|SML|MED|LRG|XLG|XXL|OS|[0-9]+)$')
  group by al.po_id, al.po_number, al.style_code, al.color
),
ppk as (
  select al.po_id, al.po_number, 'ppk_no_prepack_def', 'warn',
         al.style_code, null::text,
         'PPK (prepack) style has no active prepack matrix; it renders blank or explodes wrong on screen.',
         'Define the prepack matrix in Style Master (the PPK popup).',
         count(*)::int
  from active_lines al
  where al.style_code ~* 'PPK'
    and not exists (select 1 from prepack_matrices pm
        where lower(pm.ppk_style_code) = lower(al.style_code) and pm.is_active)
  group by al.po_id, al.po_number, al.style_code
),
cov as (
  select al.po_id, al.po_number, al.style_code, al.color, count(distinct al.size) as sizes
  from active_lines al
  where al.style_code is not null and al.size is not null
  group by al.po_id, al.po_number, al.style_code, al.color
),
coverage as (
  select c.po_id, c.po_number, 'incomplete_size_coverage', 'warn',
         c.style_code, c.color,
         'Only one size for this color while other colors of the same style carry several; likely collapsed at import.',
         'Verify against the source order; add the missing size SKUs.',
         1
  from cov c
  join (select po_id, style_code, max(sizes) as mx from cov group by po_id, style_code) m
    on m.po_id = c.po_id and m.style_code = c.style_code
  where c.sizes = 1 and m.mx >= 3
)
select * from orphan
union all select * from unlinked
union all select * from mismapped
union all select * from ppk
union all select * from coverage;

grant select on public.v_po_data_quality to anon, authenticated;
