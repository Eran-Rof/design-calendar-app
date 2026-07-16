-- ════════════════════════════════════════════════════════════════════════════
-- v_style_scale_missing — styles that GENUINELY need a size scale but lack one
-- (#fix-scales-missing-count, 2026-07-16)
--
-- WHY. The Today "styles missing a size scale" to-do (assistant master_data
-- pack) counted v_style_scale_candidates, which by design has ONE ROW PER STYLE
-- (FROM style_master sm) — it is the raw candidate feed for the bulk auto-assign
-- tool, NOT a "missing" list. So the count equalled the TOTAL style count
-- (2,119) and never moved no matter how many scales were assigned — the exact
-- "it's still 2,119, nothing changes" bug the operator reported.
--
-- This view is the real "missing" set: a style needs a scale only when it has a
-- genuine MULTI-SIZE run (≥2 distinct non-PPK size labels) AND no size_scale_id.
-- One-size styles (0 or 1 size variant) do NOT need a scale and are excluded.
-- As scales get assigned the count actually decreases. The auto-assign tool
-- still reads v_style_scale_candidates (unchanged); this view only backs the
-- to-do's count.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_style_scale_missing AS
SELECT id, style_code, gender_code, variants
FROM v_style_scale_candidates
WHERE size_scale_id IS NULL
  AND variants IS NOT NULL
  AND array_length(variants, 1) >= 2;

COMMENT ON VIEW v_style_scale_missing IS
  'Styles genuinely missing a size scale: no size_scale_id AND a real multi-size run (>=2 distinct non-PPK sizes). One-size / no-variant styles are excluded. Backs the Today "styles missing a size scale" to-do (count decreases as scales are assigned, unlike the raw v_style_scale_candidates which is one-row-per-style).';
