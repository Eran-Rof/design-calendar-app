-- Make v_po_data_quality inseam-aware so composite Xoro style codes stop
-- surfacing as false-positive orphans.
--
-- ROOT CAUSE. Xoro style codes embed the inseam right before an optional PPK
-- suffix: DMB001330 = core style DMB0013 + inseam 30; RYB059530 = RYB0595 + 30;
-- RYB059430PPK = RYB0594PPK + inseam 30. The core styles DO exist in
-- style_master, so these composite codes are NOT orphans -- they just need the
-- inseam-stripped lookup the app already does (api/_lib/styleMatrix.js ppkStem()
-- / matchPrepackMatrix(), the inseam-infix mis-keying tolerated at L620-661).
--
-- FIX (orphan_style_code). A style code is an orphan ONLY IF (a) it does not
-- exist as-is in style_master AND (b) its inseam-stripped candidate does not
-- exist either. The strip removes a 2-digit inseam token that sits immediately
-- before the optional PPK suffix, but ONLY when that token is a plausible inseam
-- (28|30|32|34|36) and the core carries >=4 digits. We CANNOT blindly strip
-- trailing digits: genuine style codes end in digits (ACMB0064 -- the 64 is part
-- of the style, not an inseam; ACMB0064 has only 4 total digits so it can never
-- split). The (b) twin-must-exist test is the real safety net; the inseam-value
-- constraint (28|30|32|34|36) is a second guard. Observed inseams in the catalog
-- are 30/32/34 (ip_item_master.inseam) and the only inseam token in play on the
-- current false positives is 30; 28 and 36 are included as standard, forward-safe
-- apparel inseams. suggested_fix uses the same constrained strip, so its
-- "Remap to <core>" hint stays consistent with the detection rule.
--
-- FIX (ppk_no_prepack_def). The prepack-matrix lookup is now inseam-tolerant like
-- matchPrepackMatrix(): a PPK style has a matrix if an active matrix matches its
-- exact style_code OR their PPK cores align after removing an optional inseam
-- token that sits right before the PPK suffix (matrix RYB059430PPK <-> ordered
-- RYB0594PPK both normalize to RYB0594). Adding the OR branch can only REDUCE
-- findings, so it introduces no new false positives (this class is currently 0).
--
-- AUDIT (other classes, left unchanged):
--   * mismapped_sku       - matches sku_code against its OWN linked style_code;
--                           internally consistent regardless of composite codes.
--   * incomplete_size_coverage - groups by the literal style_code as ordered;
--                           not a composite-code problem.
-- Full CREATE OR REPLACE (preserves the po_dq_suppressions anti-join added later).

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
                 where sm.style_code = regexp_replace(al.style_code,'([A-Za-z]+[0-9]{4,})(28|30|32|34|36)(PPK)?$','\1\3'))
               then 'Remap to ' || regexp_replace(al.style_code,'([A-Za-z]+[0-9]{4,})(28|30|32|34|36)(PPK)?$','\1\3')
               else 'Create this style in the catalog (define a prepack matrix if it is PPK).' end)::text as suggested_fix,
         count(*)::int as item_count
  from active_lines al
  where al.style_code is not null
    -- (a) does not exist as-is ...
    and not exists (select 1 from style_master sm where sm.style_code = al.style_code)
    -- ... AND (b) its inseam-stripped twin does not exist either.
    and not exists (select 1 from style_master sm
          where sm.style_code = regexp_replace(al.style_code,'([A-Za-z]+[0-9]{4,})(28|30|32|34|36)(PPK)?$','\1\3'))
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
         'SKU code carries no colour (a colour is set but the code is STYLE-SIZE) - a legacy import mis-resolution. The PO total is correct, but the size/colour matrix shows phantom single-size colours.',
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
        where pm.is_active
          and (
            lower(pm.ppk_style_code) = lower(al.style_code)
            -- inseam-tolerant: PPK cores align after dropping an optional inseam
            -- token immediately before the PPK suffix (mirrors matchPrepackMatrix).
            or regexp_replace(lower(pm.ppk_style_code),'([a-z]+[0-9]{4,})(28|30|32|34|36)?-?ppk[0-9]*$','\1')
             = regexp_replace(lower(al.style_code),  '([a-z]+[0-9]{4,})(28|30|32|34|36)?-?ppk[0-9]*$','\1')
          ))
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
),
unioned as (
  select * from orphan
  union all select * from unlinked
  union all select * from mismapped
  union all select * from ppk
  union all select * from coverage
)
select u.po_id, u.po_number, u.defect_class, u.severity, u.style_code, u.color,
       u.detail, u.suggested_fix, u.item_count
from unioned u
where not exists (
  select 1 from po_dq_suppressions s
  where s.po_number = u.po_number
    and s.defect_class = u.defect_class
    and coalesce(s.style_code,'') = coalesce(u.style_code,'')
    and coalesce(s.color,'') = coalesce(u.color,''));

grant select on public.v_po_data_quality to anon, authenticated;
