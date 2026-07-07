-- Consolidate inseam-embedded style-code fragments (Defect B). The same physical
-- style was stored under both a canonical code (RYB1878) and an inseam-suffixed dup
-- (RYB187810 = 10" inseam). Inseam belongs on the SKU (ip_item_master.inseam), not in
-- the style code. Remap the item rows onto the canonical style. None are on active POs;
-- every remap verified collision-free against uq_ip_item_master_logical_sku. 2026-07-07.
--
-- EXCLUDED: RYB141631 -> RYB1416. RYB141631 is a live style (12 images, Shopify link,
-- 2 price-list rows) — merging it is a catalog decision (which images/prices survive),
-- left for the catalog team. See memory project_po_grid_catalog_remediation.
begin;

-- 1) Remap item rows to the canonical style (keep inseam/color/size as-is).
update ip_item_master im
   set style_code=c.canon, style_id=sm.id
  from (values
    ('ACMB000930','ACMB0009'),('ACMB002530','ACMB0025'),('DMB001530','DMB0015'),
    ('RYB059530','RYB0595'),('RYB080230','RYB0802'),('RYB196030','RYB1960'),
    ('RYB187810','RYB1878'),('RYB188010','RYB1880'),('RYB188210','RYB1882'),
    ('RYB189312','RYB1893'),('RYB189410','RYB1894'),('RYB189512','RYB1895')
  ) as c(x,canon)
  join style_master sm on sm.style_code=c.canon
 where im.style_code=c.x;

-- 2) Soft-delete the duplicate style rows that were emptied and carry ZERO aux data.
update style_master sm
   set deleted_at=now(),
       attributes = coalesce(attributes,'{}'::jsonb)
         || jsonb_build_object('superseded_by', d.canon, 'merged_on','2026-07-07')
  from (values ('RYB188010','RYB1880'),('RYB188210','RYB1882'),('RYB189312','RYB1893'),
               ('RYB189410','RYB1894'),('RYB189512','RYB1895')) as d(code,canon)
 where sm.style_code=d.code and sm.deleted_at is null;

-- 3) RYB187810 keeps its row (1 costing_line references it) but is flagged superseded.
update style_master
   set attributes = coalesce(attributes,'{}'::jsonb)
         || jsonb_build_object('superseded_by','RYB1878','merged_on','2026-07-07')
 where style_code='RYB187810' and not (attributes ? 'superseded_by');

commit;

-- Verify: no inseam-embedded fragment (with an existing canonical) has item rows left.
select im.style_code, count(*) rows
from ip_item_master im
where im.style_code in ('ACMB000930','ACMB002530','DMB001530','RYB059530','RYB080230',
  'RYB196030','RYB187810','RYB188010','RYB188210','RYB189312','RYB189410','RYB189512')
group by im.style_code order by im.style_code;
