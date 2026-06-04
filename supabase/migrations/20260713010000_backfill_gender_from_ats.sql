-- Backfill gender EVERYWHERE from the ATS app's authoritative gender signal.
--
-- The ATS app sources gender from ip_item_master.attributes->>'gender', which
-- mirrors Xoro's GenderCode (populated nightly by /api/master/sync). That JSONB
-- value is the canonical ATS gender; the dedicated gender_code COLUMN on
-- ip_item_master, and style_master.gender_code, were both left entirely empty.
--
-- IMPORTANT: the two destination columns intentionally allow DIFFERENT value
-- sets (verified from their CHECK constraints in prod):
--   * ip_item_master_gender_check allows {M, WMS, B, C, G, U}  (raw Xoro codes,
--     womens = "WMS")
--   * style_master_gender_check   allows {M, B, C, G, W, U, T} (canonical UI set
--     from InternalStyleMaster GENDER_OPTIONS, womens = "W")
-- So ip_item_master keeps the raw ATS code verbatim, while style_master gets the
-- canonical single-letter normalization (WMS -> W). Both are clamped to their
-- own allowed sets so a stray value can never trip the constraint.
--
-- ADDITIVE + IDEMPOTENT: only fills rows whose current gender_code is
-- NULL/blank/outside that column's allowed set. Existing valid codes are never
-- overwritten. Re-running is a safe no-op.

-- Raw ATS gender -> ip_item_master allowed set {M,WMS,B,C,G,U} or NULL.
CREATE OR REPLACE FUNCTION pg_temp.ats_gender_raw(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE upper(btrim(coalesce(raw,'')))
    WHEN 'WMS' THEN 'WMS' WHEN 'W' THEN 'WMS' WHEN 'WOMENS' THEN 'WMS'
      WHEN 'WOMEN' THEN 'WMS' WHEN 'WOMAN' THEN 'WMS' WHEN 'LADIES' THEN 'WMS'
    WHEN 'M' THEN 'M' WHEN 'MENS' THEN 'M' WHEN 'MEN' THEN 'M' WHEN 'MAN' THEN 'M'
    WHEN 'B' THEN 'B' WHEN 'BOYS' THEN 'B' WHEN 'BOY' THEN 'B'
    WHEN 'G' THEN 'G' WHEN 'GIRLS' THEN 'G' WHEN 'GIRL' THEN 'G'
    WHEN 'C' THEN 'C' WHEN 'CHILD' THEN 'C' WHEN 'CHILDREN' THEN 'C'
      WHEN 'KIDS' THEN 'C' WHEN 'KID' THEN 'C' WHEN 'YOUTH' THEN 'C'
    WHEN 'U' THEN 'U' WHEN 'UNISEX' THEN 'U' WHEN 'UNI' THEN 'U'
    ELSE NULL
  END;
$$;

-- Raw ATS gender -> style_master canonical set {M,B,C,G,W,U} or NULL (WMS -> W).
CREATE OR REPLACE FUNCTION pg_temp.ats_gender_canon(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE pg_temp.ats_gender_raw(raw) WHEN 'WMS' THEN 'W' ELSE pg_temp.ats_gender_raw(raw) END;
$$;

-- 1) ip_item_master.gender_code <- raw attributes->>'gender' (per-row, no join).
UPDATE public.ip_item_master iim
SET gender_code = pg_temp.ats_gender_raw(iim.attributes->>'gender'),
    updated_at  = now()
WHERE (iim.gender_code IS NULL
       OR upper(btrim(iim.gender_code)) NOT IN ('M','WMS','B','C','G','U'))
  AND pg_temp.ats_gender_raw(iim.attributes->>'gender') IS NOT NULL
  AND iim.gender_code IS DISTINCT FROM pg_temp.ats_gender_raw(iim.attributes->>'gender');

-- 2) style_master.gender_code <- canonical ATS gender of its SKUs, via style_id
--    FK. Only when ALL valued variants of the style agree on a single gender
--    (count(distinct) = 1). Styles whose variants disagree are left untouched
--    rather than guessed.
UPDATE public.style_master sm
SET gender_code = src.g,
    updated_at  = now()
FROM (
  SELECT iim.style_id,
         max(pg_temp.ats_gender_canon(iim.attributes->>'gender')) AS g
  FROM public.ip_item_master iim
  WHERE iim.style_id IS NOT NULL
    AND pg_temp.ats_gender_canon(iim.attributes->>'gender') IS NOT NULL
  GROUP BY iim.style_id
  HAVING count(DISTINCT pg_temp.ats_gender_canon(iim.attributes->>'gender')) = 1
) src
WHERE sm.id = src.style_id
  AND (sm.gender_code IS NULL
       OR upper(btrim(sm.gender_code)) NOT IN ('M','B','C','G','W','U','T'))
  AND sm.gender_code IS DISTINCT FROM src.g;

DROP FUNCTION IF EXISTS pg_temp.ats_gender_canon(text);
DROP FUNCTION IF EXISTS pg_temp.ats_gender_raw(text);
