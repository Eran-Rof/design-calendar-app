-- v_po_data_quality: make the incomplete_size_coverage class spelling-tolerant.
--
-- Problem (root flaw): the cov CTE grouped active PO lines by the RAW
-- ip_item_master.color and counted RAW ip_item_master.size, then flagged any
-- (style,color) with exactly one size when a sibling color had >= 3. Because it
-- used the physical strings verbatim, any split spelling of ONE colorway read as
-- two partial colorways and faked a coverage gap:
--   * color-spelling variants  - "Blk Camo" vs "Black Camo", "Woodland Cam" vs
--                                 "Woodland Camo", "Simple Sage Cbo" vs "...Combo",
--                                 "Lt Brown" vs "Light Brown", squished spacing
--                                 ("Simplesagegd" vs "Simple Sage Gd").
--   * size-label drift          - "SML" vs "SMALL", "XLG" vs "XL", etc. counted
--                                 as distinct sizes.
-- A read-only sweep classified 30/31 live findings as these artifacts; the 31st
-- (ROF ECOM-P001016 / RYB1338 / "Blk Camo", LARGE-only) was a rule artifact: a
-- legitimate single-size colorway with NO variant twin, over-flagged because its
-- solid siblings (Black/Charcoal/Olive) carry full runs.
--
-- Fix:
--   1. Group cov by a NORMALIZED color key (po_dq_norm_color) - space-stripped,
--      upper-cased, abbreviation-folded (BLK->BLACK, CAM->CAMO, LT->LIGHT,
--      CBO->COMBO, ... word-boundary/token-aware so CAMEL never becomes CAMOEL) -
--      and count DISTINCT canonical_size() (the AR #1835 size function), so
--      split spellings and size-label variants collapse to one colorway BEFORE
--      the 1-vs-3 test. This kills all 30 spelling/size-split artifacts.
--   2. Residual guard: only emit the finding when the flagged colorway is
--      actually a COLLAPSE - i.e. more than one raw color mapped into its
--      normalized key (raw_variants > 1). A lone single-size colorway with no
--      twin (the P001016 case) is not "collapsed at import", so it no longer
--      flags. A genuine fragment - two raw spellings of one colorway that
--      together still carry only one canonical size while a sibling carries >= 3
--      - still flags (real "collapsed at import" evidence).
--
-- po_dq_norm_color MIRRORS the JS colorMatchKey in api/_lib/xoroLineMatch.js
-- (expandTokens -> strip separators, same COLOR_ABBR dictionary incl. CAM/CBO).
-- Keep the two in lock-step; a note in that file points back here.
--
-- Everything else in the view is preserved EXACTLY from the LIVE definition
-- (pg_get_viewdef) - the inseam-aware orphan_style_code + ppk_no_prepack_def
-- from #1873, and the po_dq_suppressions anti-join wrapper.

-- Normalized color key - token-based, so folds are word-boundary safe.
CREATE OR REPLACE FUNCTION po_dq_norm_color(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(string_agg(
    CASE t.tok
      WHEN 'LT'   THEN 'LIGHT'   WHEN 'LITE' THEN 'LIGHT'    WHEN 'LGT'  THEN 'LIGHT'
      WHEN 'DK'   THEN 'DARK'    WHEN 'DRK'  THEN 'DARK'
      WHEN 'MD'   THEN 'MEDIUM'  WHEN 'MED'  THEN 'MEDIUM'   WHEN 'MDM'  THEN 'MEDIUM'
      WHEN 'BLK'  THEN 'BLACK'   WHEN 'BLCK' THEN 'BLACK'    WHEN 'BLAK' THEN 'BLACK'
      WHEN 'GRY'  THEN 'GREY'    WHEN 'GRAY' THEN 'GREY'     WHEN 'GRYE' THEN 'GREY'
      WHEN 'HTHR' THEN 'HEATHER' WHEN 'HTR'  THEN 'HEATHER'
      WHEN 'CHRCL' THEN 'CHARCOAL' WHEN 'CHRC' THEN 'CHARCOAL'
      WHEN 'WSH'  THEN 'WASH'    WHEN 'WHT'  THEN 'WHITE'    WHEN 'WHTE' THEN 'WHITE'
      WHEN 'BLU'  THEN 'BLUE'    WHEN 'NVY'  THEN 'NAVY'     WHEN 'BRN'  THEN 'BROWN'
      WHEN 'GRN'  THEN 'GREEN'   WHEN 'W'    THEN 'WITH'     WHEN 'WTINT' THEN 'WITHTINT'
      WHEN 'CAM'  THEN 'CAMO'    WHEN 'CBO'  THEN 'COMBO'
      ELSE t.tok
    END, '' ORDER BY t.ord), '')
  FROM regexp_split_to_table(
         upper(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(COALESCE(s, ''), '([a-z])([A-Z])', '\1 \2', 'g'),
               '([A-Za-z])([0-9])', '\1 \2', 'g'),
             '([0-9])([A-Za-z])', '\1 \2', 'g'),
           '[^A-Za-z0-9]+', ' ', 'g')
         ),
         '\s+'
       ) WITH ORDINALITY AS t(tok, ord)
  WHERE t.tok <> '';
$$;

COMMENT ON FUNCTION po_dq_norm_color(text) IS
  'Normalized color key for v_po_data_quality incomplete_size_coverage. MIRRORS colorMatchKey in api/_lib/xoroLineMatch.js (expandTokens + COLOR_ABBR incl. CAM->CAMO, CBO->COMBO). Token-based so folds are word-boundary safe (CAMEL stays CAMEL). Keep JS and SQL in lock-step.';

CREATE OR REPLACE VIEW v_po_data_quality AS
 WITH active_lines AS (
         SELECT p.id AS po_id,
            p.po_number,
            l.id AS line_id,
            l.inventory_item_id,
            im.style_code,
            im.color,
            im.size,
            im.sku_code
           FROM purchase_orders p
             JOIN purchase_order_lines l ON l.purchase_order_id = p.id
             LEFT JOIN ip_item_master im ON im.id = l.inventory_item_id
          WHERE p.status = ANY (ARRAY['issued'::text, 'partially_received'::text, 'in_transit'::text])
        ), orphan AS (
         SELECT al.po_id,
            al.po_number,
            'orphan_style_code'::text AS defect_class,
            'error'::text AS severity,
            al.style_code,
            NULL::text AS color,
            'Style code is not in the catalog (style_master); the PO modal shows "Style not found".'::text AS detail,
                CASE
                    WHEN (EXISTS ( SELECT 1
                       FROM style_master sm
                      WHERE sm.style_code = regexp_replace(al.style_code, '([A-Za-z]+[0-9]{4,})(28|30|32|34|36)(PPK)?$'::text, '\1\3'::text))) THEN 'Remap to '::text || regexp_replace(al.style_code, '([A-Za-z]+[0-9]{4,})(28|30|32|34|36)(PPK)?$'::text, '\1\3'::text)
                    ELSE 'Create this style in the catalog (define a prepack matrix if it is PPK).'::text
                END AS suggested_fix,
            count(*)::integer AS item_count
           FROM active_lines al
          WHERE al.style_code IS NOT NULL AND NOT (EXISTS ( SELECT 1
                   FROM style_master sm
                  WHERE sm.style_code = al.style_code)) AND NOT (EXISTS ( SELECT 1
                   FROM style_master sm
                  WHERE sm.style_code = regexp_replace(al.style_code, '([A-Za-z]+[0-9]{4,})(28|30|32|34|36)(PPK)?$'::text, '\1\3'::text)))
          GROUP BY al.po_id, al.po_number, al.style_code
        ), unlinked AS (
         SELECT al.po_id,
            al.po_number,
            'unlinked_line'::text AS defect_class,
            'error'::text AS severity,
            NULL::text AS style_code,
            NULL::text AS color,
            'PO line has no linked SKU (inventory item); no cost, sell, or size matrix can be computed.'::text AS detail,
            'Match the line to a SKU, or create the SKU from the PO.'::text AS suggested_fix,
            count(*)::integer AS item_count
           FROM active_lines al
          WHERE al.inventory_item_id IS NULL
          GROUP BY al.po_id, al.po_number
        ), mismapped AS (
         SELECT al.po_id,
            al.po_number,
            'mismapped_sku'::text AS defect_class,
            'warn'::text AS severity,
            al.style_code,
            al.color,
            'SKU code carries no colour (a colour is set but the code is STYLE-SIZE) - a legacy import mis-resolution. The PO total is correct, but the size/colour matrix shows phantom single-size colours.'::text AS detail,
            'Re-import the PO from the Xoro source with the fixed resolver to re-attribute lines to correct colour+size SKUs.'::text AS suggested_fix,
            count(*)::integer AS item_count
           FROM active_lines al
          WHERE al.style_code IS NOT NULL AND al.color IS NOT NULL AND al.sku_code IS NOT NULL AND upper(al.sku_code) ~ (('^'::text || upper(al.style_code)) || '-(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|SML|MED|LRG|XLG|XXL|OS|[0-9]+)$'::text)
          GROUP BY al.po_id, al.po_number, al.style_code, al.color
        ), ppk AS (
         SELECT al.po_id,
            al.po_number,
            'ppk_no_prepack_def'::text AS defect_class,
            'warn'::text AS severity,
            al.style_code,
            NULL::text AS color,
            'PPK (prepack) style has no active prepack matrix; it renders blank or explodes wrong on screen.'::text AS detail,
            'Define the prepack matrix in Style Master (the PPK popup).'::text AS suggested_fix,
            count(*)::integer AS item_count
           FROM active_lines al
          WHERE al.style_code ~* 'PPK'::text AND NOT (EXISTS ( SELECT 1
                   FROM prepack_matrices pm
                  WHERE pm.is_active AND (lower(pm.ppk_style_code) = lower(al.style_code) OR regexp_replace(lower(pm.ppk_style_code), '([a-z]+[0-9]{4,})(28|30|32|34|36)?-?ppk[0-9]*$'::text, '\1'::text) = regexp_replace(lower(al.style_code), '([a-z]+[0-9]{4,})(28|30|32|34|36)?-?ppk[0-9]*$'::text, '\1'::text))))
          GROUP BY al.po_id, al.po_number, al.style_code
        ), cov AS (
         SELECT al.po_id,
            al.po_number,
            al.style_code,
            po_dq_norm_color(al.color) AS color_key,
            min(al.color) AS color,
            count(DISTINCT canonical_size(al.size)) AS sizes,
            count(DISTINCT al.color) AS raw_variants
           FROM active_lines al
          WHERE al.style_code IS NOT NULL AND al.size IS NOT NULL
          GROUP BY al.po_id, al.po_number, al.style_code, po_dq_norm_color(al.color)
        ), coverage AS (
         SELECT c.po_id,
            c.po_number,
            'incomplete_size_coverage'::text AS defect_class,
            'warn'::text AS severity,
            c.style_code,
            c.color,
            'Only one size for this color while other colors of the same style carry several; likely collapsed at import.'::text AS detail,
            'Verify against the source order; add the missing size SKUs.'::text AS suggested_fix,
            1 AS item_count
           FROM cov c
             JOIN ( SELECT cov.po_id,
                    cov.style_code,
                    max(cov.sizes) AS mx
                   FROM cov
                  GROUP BY cov.po_id, cov.style_code) m ON m.po_id = c.po_id AND m.style_code = c.style_code
          WHERE c.sizes = 1 AND m.mx >= 3 AND c.raw_variants > 1
        ), unioned AS (
         SELECT po_id, po_number, defect_class, severity, style_code, color, detail, suggested_fix, item_count FROM orphan
        UNION ALL
         SELECT po_id, po_number, defect_class, severity, style_code, color, detail, suggested_fix, item_count FROM unlinked
        UNION ALL
         SELECT po_id, po_number, defect_class, severity, style_code, color, detail, suggested_fix, item_count FROM mismapped
        UNION ALL
         SELECT po_id, po_number, defect_class, severity, style_code, color, detail, suggested_fix, item_count FROM ppk
        UNION ALL
         SELECT po_id, po_number, defect_class, severity, style_code, color, detail, suggested_fix, item_count FROM coverage
        )
 SELECT po_id,
    po_number,
    defect_class,
    severity,
    style_code,
    color,
    detail,
    suggested_fix,
    item_count
   FROM unioned u
  WHERE NOT (EXISTS ( SELECT 1
           FROM po_dq_suppressions s
          WHERE s.po_number = u.po_number AND s.defect_class = u.defect_class AND COALESCE(s.style_code, ''::text) = COALESCE(u.style_code, ''::text) AND COALESCE(s.color, ''::text) = COALESCE(u.color, ''::text)));
