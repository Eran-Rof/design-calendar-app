-- Style Master: auto-populate missing gender_code from the style-code
-- prefix, per operator rule (2026-07-23):
--   PTY -> M (Men's)   CJB -> W (Women)   RBB -> B (Boys)
--   RCB -> C (Child)   RY  -> M (Men's)
-- (Operator wrote "CBJ" but the catalog prefix is CJB — verified against
-- CJB0005 which already carries W. 'W' matches style_master's live value
-- domain: M 1451 / B 444 / C 65 / G 31 / W 26 at time of writing.)
--
-- Fires on INSERT and UPDATE, only when the incoming gender_code is
-- NULL/blank — an explicit gender always wins. Styles whose prefix has
-- no rule (private-label artifacts like FL*/HS*/PRINT) are left blank.
--
-- The one-time backfill for the 38 existing blank-gender styles was
-- applied directly on 2026-07-23 (25 M / 10 C / 3 W); this trigger keeps
-- future rows conformant.

CREATE OR REPLACE FUNCTION public.style_master_gender_prefix_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.gender_code IS NULL OR TRIM(NEW.gender_code) = '' THEN
    NEW.gender_code := CASE
      WHEN UPPER(NEW.style_code) LIKE 'PTY%' THEN 'M'
      WHEN UPPER(NEW.style_code) LIKE 'CJB%' THEN 'W'
      WHEN UPPER(NEW.style_code) LIKE 'RBB%' THEN 'B'
      WHEN UPPER(NEW.style_code) LIKE 'RCB%' THEN 'C'
      WHEN UPPER(NEW.style_code) LIKE 'RY%'  THEN 'M'
      ELSE NEW.gender_code
    END;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.style_master_gender_prefix_default() IS
  'Fills style_master.gender_code from the style-code prefix when blank (PTY/RY=M, CJB=W, RBB=B, RCB=C). Operator rule 2026-07-23; explicit gender always wins.';

DROP TRIGGER IF EXISTS style_master_gender_prefix_default_trg ON public.style_master;
CREATE TRIGGER style_master_gender_prefix_default_trg
BEFORE INSERT OR UPDATE ON public.style_master
FOR EACH ROW
EXECUTE FUNCTION public.style_master_gender_prefix_default();
