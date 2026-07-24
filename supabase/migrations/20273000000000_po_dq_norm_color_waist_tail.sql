-- #1921 — po_dq_norm_color() drops a leaked WAIST size (29-38) from the colour tail.
--
-- api/_lib/xoroLineMatch.js carries the canonical colour normalisation and this
-- function MIRRORS it. #1920 surfaced (but did not fix) a distinct defect class:
-- a denim WAIST size has leaked into some catalog colour strings — "Pond Medium
-- Wash 34", "Bkb 30", "Veil Dark Wash 29" (48 SKUs / 42 colours / 4 styles,
-- exclusively 29-38). The trailing number is a SIZE, not a colour word, so those
-- colours are really the same colour split across waists. Without this fold,
-- v_po_data_quality's incomplete_size_coverage check groups each waist as its own
-- single-size "colour", masking the very collapse it exists to catch (and the
-- importer would keep the waist in colorMatchKey, so JS and SQL would diverge).
--
-- The JS side strips a SINGLE trailing bare 2-digit token in the waist range
-- (stripColorWaistTail, applied inside expandedColorKey/colorMatchKey). This
-- function does the same by EXCLUDING that trailing token before it aggregates.
-- Guards match the JS exactly:
--   • TRAILING only  — ord = maxord; a leading/interior number is preserved
--                      ("Td26 Black/White" -> the 26 is not last, kept).
--   • RANGE only      — tok ~ '^(29|3[0-8])$'; "Td 26" keeps its 26.
--   • never the ONLY  — n > 1; a colour that is nothing but a number is untouched.
-- token
--
-- ⚠️SEPARATOR ASYMMETRY (unchanged, documented on the JS side): this function
-- joins tokens with '' and so IS the space-free key already; the JS re-joins
-- with a space and colorMatchKey() strips it. Both sides converge.
--
-- Verified before applying: no expression index, generated column, or constraint
-- depends on this function -- only the v_po_data_quality view, which evaluates it
-- at query time -- so CREATE OR REPLACE is safe and needs no reindex. This is a
-- MATCHING-only change: no stored colour is rewritten and no SKU is merged.

CREATE OR REPLACE FUNCTION public.po_dq_norm_color(s text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH toks AS (
    SELECT t.tok, t.ord,
           count(*)   OVER () AS n,
           max(t.ord) OVER () AS maxord
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
    WHERE t.tok <> ''
  )
  SELECT COALESCE(string_agg(
    CASE tok
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
      ELSE tok
    END, '' ORDER BY ord), '')
  FROM toks
  -- Drop a SINGLE trailing WAIST token (29-38): a size that leaked into the
  -- colour. Never when it is the only token (n > 1 guard) -- mirrors
  -- stripColorWaistTail() in api/_lib/xoroLineMatch.js.
  WHERE NOT (ord = maxord AND n > 1 AND tok ~ '^(29|3[0-8])$');
$function$;

COMMENT ON FUNCTION public.po_dq_norm_color(text) IS
  'Colour-abbreviation fold + leaked-waist strip used by v_po_data_quality. MIRRORS COLOR_ABBR + stripColorWaistTail in api/_lib/xoroLineMatch.js -- add a fold there, add it here. Multi-word folds are space-free here because this function joins tokens with an empty separator; a trailing 2-digit waist token (29-38) is dropped unless it is the only token.';
