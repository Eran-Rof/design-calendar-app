-- #1920 — sync po_dq_norm_color() with the JS COLOR_ABBR dictionary.
--
-- api/_lib/xoroLineMatch.js carries the canonical colour-abbreviation fold list
-- and this function MIRRORS it (see the note above COLOR_ABBR there). The JS
-- side gained CEO-confirmed abbreviations and a set of GLUED COMPOUND folds on
-- 2026-07-23; without the matching folds here, v_po_data_quality's
-- incomplete_size_coverage check would group PO colours differently from the
-- way the importer groups catalog colours, and start reporting phantom defects.
--
-- ⚠️SEPARATOR ASYMMETRY (deliberate, documented on the JS side too):
-- expandTokens() re-joins folded tokens with a SPACE and colorMatchKey() then
-- strips it; this function joins with '' and so IS the space-stripped key
-- already. A multi-word fold is therefore written 'MEDIUM BLUE' in JS but
-- 'MEDIUMBLUE' here. Both sides converge on the same key. Single-word folds are
-- byte-identical. Keep that rule in mind when adding entries to either list.
--
-- Verified before applying: no expression index, generated column, or
-- constraint depends on this function -- only the v_po_data_quality view, which
-- evaluates it at query time, so CREATE OR REPLACE is safe and needs no reindex.

CREATE OR REPLACE FUNCTION public.po_dq_norm_color(s text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT COALESCE(string_agg(
    CASE t.tok
      WHEN 'LT'   THEN 'LIGHT'   WHEN 'LITE' THEN 'LIGHT'    WHEN 'LGT'  THEN 'LIGHT'
      WHEN 'DK'   THEN 'DARK'    WHEN 'DRK'  THEN 'DARK'
      WHEN 'MD'   THEN 'MEDIUM'  WHEN 'MED'  THEN 'MEDIUM'   WHEN 'MDM'  THEN 'MEDIUM'
      WHEN 'MEDM' THEN 'MEDIUM'
      WHEN 'BLK'  THEN 'BLACK'   WHEN 'BLCK' THEN 'BLACK'    WHEN 'BLAK' THEN 'BLACK'
      WHEN 'GRY'  THEN 'GREY'    WHEN 'GRAY' THEN 'GREY'     WHEN 'GRYE' THEN 'GREY'
      WHEN 'HTHR' THEN 'HEATHER' WHEN 'HTR'  THEN 'HEATHER'
      WHEN 'CHRCL' THEN 'CHARCOAL' WHEN 'CHRC' THEN 'CHARCOAL'
      WHEN 'WSH'  THEN 'WASH'    WHEN 'WHT'  THEN 'WHITE'    WHEN 'WHTE' THEN 'WHITE'
      WHEN 'BLU'  THEN 'BLUE'    WHEN 'NVY'  THEN 'NAVY'     WHEN 'BRN'  THEN 'BROWN'
      WHEN 'GRN'  THEN 'GREEN'   WHEN 'W'    THEN 'WITH'     WHEN 'WTINT' THEN 'WITHTINT'
      WHEN 'CAM'  THEN 'CAMO'    WHEN 'CBO'  THEN 'COMBO'
      -- CEO-confirmed 2026-07-23. Each pairing is attested in the live catalog:
      -- the short and long spelling both occur on the SAME style.
      -- SLT has no standalone occurrence in the catalog today; it is folded to
      -- guard the ingest path against a future abbreviated feed.
      WHEN 'OYST' THEN 'OYSTER'  WHEN 'VTG'  THEN 'VINTAGE'
      WHEN 'MSTY' THEN 'MISTY'   WHEN 'PLMS' THEN 'PALMS'
      WHEN 'SLT'  THEN 'SLATE'
      -- GD = garment-dye finish; BKB = the doubled-black colourway.
      -- DELIBERATELY NOT FOLDED: TD. It does mean "tie dyed", but it is mirrored
      -- in the style code (PTBG0094TD) so it marks a product line, not a colour;
      -- "Tie Dye" is spelled out nowhere, so folding buys no merges and would
      -- mangle "Td26 Black/White". CEO confirmed 2026-07-23: keep TD verbatim.
      WHEN 'GD'   THEN 'GARMENTDYED'  WHEN 'BKB' THEN 'BLACKBLACK'
      -- GLUED COMPOUNDS: one ingest path strips every separator, so "Medium
      -- Blue" arrives as the single token "Mdblue". Token folding cannot split
      -- these, so every attested spelling gets an explicit fold. Values are
      -- space-free here per the asymmetry note above.
      WHEN 'DKBLUE'    THEN 'DARKBLUE'
      WHEN 'MDBLUE'    THEN 'MEDIUMBLUE'  WHEN 'MEDBLUE' THEN 'MEDIUMBLUE'
      WHEN 'MDBLU'     THEN 'MEDIUMBLUE'  WHEN 'MEDBLU'  THEN 'MEDIUMBLUE'
      WHEN 'LTBLUE'    THEN 'LIGHTBLUE'
      WHEN 'LTWASH'    THEN 'LIGHTWASH'
      WHEN 'MDWASH'    THEN 'MEDIUMWASH'  WHEN 'MEDWASH' THEN 'MEDIUMWASH'
      WHEN 'MDLTWASH'  THEN 'MEDIUMLIGHTWASH'
      WHEN 'MEDLTWASH' THEN 'MEDIUMLIGHTWASH'
      WHEN 'LTGRAY'    THEN 'LIGHTGREY'   WHEN 'LTGREY'  THEN 'LIGHTGREY'
      WHEN 'LTBROWN'   THEN 'LIGHTBROWN'
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
$function$;

COMMENT ON FUNCTION public.po_dq_norm_color(text) IS
  'Colour-abbreviation fold used by v_po_data_quality. MIRRORS COLOR_ABBR in api/_lib/xoroLineMatch.js -- add a fold there, add it here. Multi-word folds are space-free here because this function joins tokens with an empty separator.';
