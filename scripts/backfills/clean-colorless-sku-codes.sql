-- Clean the colourless sku_codes left by the legacy Xoro SKU mis-resolution
-- (Defect C). After re-importing the affected POs from source, these rows carry
-- the CORRECT colour + size FIELDS (so the PO matrix already renders right) but a
-- colourless sku_code STRING (e.g. RYB1157-LRG, colour "Dark Slate"). Rename each
-- to STYLE-COLOUR-SIZE from its own (correct) fields so the catalog is clean and
-- the `mismapped_sku` data-quality signal reads true. Collision-guarded: skip any
-- row whose target sku_code already exists (there are none on active POs — verified
-- 178/178 clean). Idempotent. 2026-07-07.
update ip_item_master im
   set sku_code = im.style_code
     || '-' || regexp_replace(upper(im.color), '[^A-Z0-9]', '', 'g')
     || '-' || regexp_replace(upper(im.size),  '[^A-Z0-9]', '', 'g')
 where im.color is not null and im.size is not null and im.style_code is not null
   and upper(im.sku_code) ~ ('^' || upper(im.style_code) || '-(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|SML|MED|LRG|XLG|XXL|OS|[0-9]+)$')
   and exists (select 1 from purchase_order_lines l join purchase_orders p on p.id = l.purchase_order_id
               where l.inventory_item_id = im.id and p.status in ('issued','partially_received','in_transit'))
   and not exists (select 1 from ip_item_master o
                   where o.sku_code = im.style_code
                     || '-' || regexp_replace(upper(im.color), '[^A-Z0-9]', '', 'g')
                     || '-' || regexp_replace(upper(im.size),  '[^A-Z0-9]', '', 'g')
                     and o.id <> im.id);

-- Verify: zero colourless sku_codes left on active POs.
select count(*) remaining_colorless
from purchase_orders p
join purchase_order_lines l on l.purchase_order_id = p.id
join ip_item_master im on im.id = l.inventory_item_id
where p.status in ('issued','partially_received','in_transit')
  and im.color is not null and im.style_code is not null
  and upper(im.sku_code) ~ ('^' || upper(im.style_code) || '-(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|SML|MED|LRG|XLG|XXL|OS|[0-9]+)$');
