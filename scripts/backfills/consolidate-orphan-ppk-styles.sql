-- Consolidate orphan PPK style codes on active POs (Defect A + inseam-embedded B).
-- These ip_item_master codes had NO style_master row -> the PO modal showed
-- "Style X not found". Two inseam-embedded fragments consolidate into an existing
-- canonical (RYB0595PPK / RYB1960PPK); the rest get a scaffold style_master row
-- (flagged needs_prepack_def for catalog enrichment). Idempotent. 2026-07-07.
-- Brand d67c1f5d-... = the ROF house brand carried on every one of these item rows.
begin;

-- 1) RYB1960PPK: clone the loose RYB1960 style (pack variant did not exist).
insert into style_master (style_code, description, style_name, brand_id, gender_code,
    category_name, group_name, hts_code, duty_rate_pct, additional_tariff_pct,
    lifecycle_status, is_apparel, attributes)
select 'RYB1960PPK', description, style_name, brand_id, gender_code,
    category_name, group_name, hts_code, duty_rate_pct, additional_tariff_pct,
    'active', true,
    jsonb_build_object('source','orphan-ppk-consolidation-2026-07-07','needs_prepack_def',true,'cloned_from','RYB1960')
from style_master where style_code='RYB1960'
  and not exists (select 1 from style_master where style_code='RYB1960PPK');

-- 2) Scaffold rows for the 8 codes with no sibling in style_master.
insert into style_master (style_code, description, brand_id, gender_code, lifecycle_status, is_apparel, attributes)
select v.code, v.descr, 'd67c1f5d-924c-493e-a2ff-737c01ba6310'::uuid, v.gender, 'active', true,
    jsonb_build_object('source','orphan-ppk-consolidation-2026-07-07','needs_prepack_def',true,'pack_token',v.pack)
from (values
  ('RYB1257PPK',   'TREY Cargo Pant',                 'M', 'PPK24'),
  ('RYB1468OBPPK', 'HILTON Bonded Utility Cargo Pant','M', 'PPK24'),
  ('RYB1469OBPPK', 'GEFEN Bonded Cargo Pant',         'M', 'PPK24'),
  ('RYB1630BDPPK', 'KYAIRE Bonded Cargo Pant',        'M', 'PPK24'),
  ('RYG1865PPK',   'TRUSTED CHERUBS',                 null,'PPK60'),
  ('RYO0811V1PPK', 'REAPER Moto-Biker Jkt wStuds',    'M', 'PPK18'),
  ('RYO0882PPK',   'BRAUN Poly Suede Jkt wSherpa',    'M', 'PPK18'),
  ('RYO0883PPK',   'FAITH FIRST Moto Jkt wEmbroidery','M', 'PPK18')
) as v(code, descr, gender, pack)
where not exists (select 1 from style_master sm where sm.style_code=v.code);

-- 3) Remap the two inseam-embedded fragments onto their canonical (collision-verified 0).
update ip_item_master
   set style_code='RYB0595PPK', style_id='f507faa9-858a-4f94-8c98-20f9021cffa9'
 where style_code='RYB059530PPK';

update ip_item_master im
   set style_code='RYB1960PPK', style_id=(select id from style_master where style_code='RYB1960PPK')
 where style_code='RYB196030PPK';

-- 4) Link the 8 scaffold codes' item rows to their new style_master row.
update ip_item_master im
   set style_id=sm.id
  from style_master sm
 where sm.style_code=im.style_code
   and im.style_code in ('RYB1257PPK','RYB1468OBPPK','RYB1469OBPPK','RYB1630BDPPK','RYG1865PPK','RYO0811V1PPK','RYO0882PPK','RYO0883PPK')
   and im.style_id is distinct from sm.id;

commit;

-- Verify: zero orphan codes remain on active POs.
select im.style_code, count(*) rows
from ip_item_master im
where im.style_code in ('RYB059530PPK','RYB196030PPK','RYB1257PPK','RYB1468OBPPK','RYB1469OBPPK','RYB1630BDPPK','RYG1865PPK','RYO0811V1PPK','RYO0882PPK','RYO0883PPK')
   or not exists (select 1 from style_master sm where sm.style_code=im.style_code)
group by im.style_code order by im.style_code;
