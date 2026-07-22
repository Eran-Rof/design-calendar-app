-- v_po_data_quality: the inseam composite-code strip set learns the SHORTS inseams.
--
-- CEO (2026-07-21): shorts embed inseams 10/12 in the style code the same way
-- denim embeds 28-36 (RYB187810 = RYB1878 + 10" inseam); 14/16 are future
-- inseams. The orphan_style_code remap/twin checks and the ppk prepack-def
-- stem match only knew (28|30|32|34|36), so shorts composites mis-classified
-- (and empty composite alias style rows could not be deleted without the DQ
-- report flagging their PO lines as orphans). Set extended to
-- (10|12|14|16|28|30|32|34|36) in all five regexes.
--
-- Recreated from the LIVE pg_get_viewdef (2026-07-21) - the live view carries
-- the po_dq_suppressions wrapper; never CREATE OR REPLACE from the repo copy.

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
                      WHERE sm.style_code = regexp_replace(al.style_code, '([A-Za-z]+[0-9]{4,})(10|12|14|16|28|30|32|34|36)(PPK)?$'::text, '\1\3'::text))) THEN 'Remap to '::text || regexp_replace(al.style_code, '([A-Za-z]+[0-9]{4,})(10|12|14|16|28|30|32|34|36)(PPK)?$'::text, '\1\3'::text)
                    ELSE 'Create this style in the catalog (define a prepack matrix if it is PPK).'::text
                END AS suggested_fix,
            count(*)::integer AS item_count
           FROM active_lines al
          WHERE al.style_code IS NOT NULL AND NOT (EXISTS ( SELECT 1
                   FROM style_master sm
                  WHERE sm.style_code = al.style_code)) AND NOT (EXISTS ( SELECT 1
                   FROM style_master sm
                  WHERE sm.style_code = regexp_replace(al.style_code, '([A-Za-z]+[0-9]{4,})(10|12|14|16|28|30|32|34|36)(PPK)?$'::text, '\1\3'::text)))
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
                  WHERE pm.is_active AND (lower(pm.ppk_style_code) = lower(al.style_code) OR regexp_replace(lower(pm.ppk_style_code), '([a-z]+[0-9]{4,})(10|12|14|16|28|30|32|34|36)?-?ppk[0-9]*$'::text, '\1'::text) = regexp_replace(lower(al.style_code), '([a-z]+[0-9]{4,})(10|12|14|16|28|30|32|34|36)?-?ppk[0-9]*$'::text, '\1'::text))))
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
          GROUP BY al.po_id, al.po_number, al.style_code, (po_dq_norm_color(al.color))
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
         SELECT orphan.po_id,
            orphan.po_number,
            orphan.defect_class,
            orphan.severity,
            orphan.style_code,
            orphan.color,
            orphan.detail,
            orphan.suggested_fix,
            orphan.item_count
           FROM orphan
        UNION ALL
         SELECT unlinked.po_id,
            unlinked.po_number,
            unlinked.defect_class,
            unlinked.severity,
            unlinked.style_code,
            unlinked.color,
            unlinked.detail,
            unlinked.suggested_fix,
            unlinked.item_count
           FROM unlinked
        UNION ALL
         SELECT mismapped.po_id,
            mismapped.po_number,
            mismapped.defect_class,
            mismapped.severity,
            mismapped.style_code,
            mismapped.color,
            mismapped.detail,
            mismapped.suggested_fix,
            mismapped.item_count
           FROM mismapped
        UNION ALL
         SELECT ppk.po_id,
            ppk.po_number,
            ppk.defect_class,
            ppk.severity,
            ppk.style_code,
            ppk.color,
            ppk.detail,
            ppk.suggested_fix,
            ppk.item_count
           FROM ppk
        UNION ALL
         SELECT coverage.po_id,
            coverage.po_number,
            coverage.defect_class,
            coverage.severity,
            coverage.style_code,
            coverage.color,
            coverage.detail,
            coverage.suggested_fix,
            coverage.item_count
           FROM coverage
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
