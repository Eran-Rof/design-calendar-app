-- Backfill: link SKU-less PPK prepack PO lines to their catalog SKU, and set the
-- pack SIZE on the resolved rows so grain is detected (per-each) and they render
-- in the matrix. IDEMPOTENT (only null-linked lines / size-null rows). Applied to
-- prod 2026-07-06 (audit-pos.mjs ALL_UNLINKED/SOME_UNLINKED 6→0). Re-runnable.
--
-- Run:  node scripts/run-sql-prod.mjs scripts/backfills/link-ppk-prepack-lines.sql
--
-- Method: match each unlinked native line to its Xoro item by POSITION (native
-- line order ↔ Xoro Items order, qty>0) — validated exact on qty+description —
-- then to a UNIQUE ip_item_master row by normalized sku_code (Xoro ItemNumber
-- with the trailing -PPKnn stripped). Only inventory_item_id + size are touched.

-- Step 1 — link null-linked lines on active POs to their unique master SKU.
with xoro as (
  select t.po_number, row_number() over (partition by t.po_number order by ord) pos, e.it->>'ItemNumber' item_number
  from tanda_pos t cross join lateral jsonb_array_elements(t.data->'Items') with ordinality e(it,ord)
  where (e.it->>'QtyOrder')::numeric > 0
),
nat as (
  select p.po_number, l.id line_id, row_number() over (partition by p.po_number order by l.line_number) pos
  from purchase_orders p join purchase_order_lines l on l.purchase_order_id=p.id
  where p.status in ('issued','partially_received','in_transit') and l.inventory_item_id is null
),
orphan as (
  select n.line_id, upper(regexp_replace(regexp_replace(x.item_number,'-PPK[0-9]+$','','i'),'[^A-Za-z0-9]','','g')) norm_item
  from nat n join xoro x on x.po_number=n.po_number and x.pos=n.pos
),
cand as (
  select o.line_id, im.id master_id, count(*) over (partition by o.line_id) n
  from orphan o join ip_item_master im on upper(regexp_replace(im.sku_code,'[^A-Za-z0-9]','','g'))=o.norm_item
)
update purchase_order_lines l set inventory_item_id = c.master_id
from cand c where l.id=c.line_id and c.n=1 and l.inventory_item_id is null;

-- Step 2 — set the pack SIZE on rows a PPK line links to but that are size-null
-- (color-only master rows). Size = the Xoro ItemNumber's PPK token. Guard: only
-- where no sibling with that (style,color,size) already exists.
with xoro as (
  select t.po_number, row_number() over (partition by t.po_number order by ord) pos, e.it->>'ItemNumber' item_number
  from tanda_pos t cross join lateral jsonb_array_elements(t.data->'Items') with ordinality e(it,ord)
  where (e.it->>'QtyOrder')::numeric > 0
),
nat as (
  select p.po_number, l.inventory_item_id iid, row_number() over (partition by p.po_number order by l.line_number) pos
  from purchase_orders p join purchase_order_lines l on l.purchase_order_id=p.id
  where p.status in ('issued','partially_received','in_transit')
),
tok as (
  select distinct im.id item_id, upper((regexp_match(x.item_number,'-(PPK[0-9]+)$','i'))[1]) ppk_token
  from nat n join xoro x on x.po_number=n.po_number and x.pos=n.pos
  join ip_item_master im on im.id=n.iid
  where im.size is null and im.style_code ~* 'PPK' and x.item_number ~* '-PPK[0-9]+$'
)
update ip_item_master im set size = tok.ppk_token
from tok
where im.id=tok.item_id and tok.ppk_token is not null
  and not exists (select 1 from ip_item_master s
                  where s.style_id=im.style_id and s.color is not distinct from im.color
                    and s.size=tok.ppk_token and s.id<>im.id);
