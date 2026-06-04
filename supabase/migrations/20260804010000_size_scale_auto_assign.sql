-- Support for the bulk "auto-assign size scales" tool (Style Master).
--
-- 1. v_style_scale_candidates — one row per style_master style with its distinct
--    non-PPK size variants (from ip_item_master), gender, and current scale. The
--    handler reads this, runs the JS best-match matcher, and proposes a scale.
-- 2. apply_size_scale_assignments(jsonb, boolean) — one-round-trip bulk writer so
--    the handler doesn't fire ~1,800 individual UPDATEs. Only fills NULL scales
--    unless _overwrite is true.

CREATE OR REPLACE VIEW v_style_scale_candidates AS
SELECT
  sm.id,
  sm.style_code,
  sm.gender_code,
  sm.size_scale_id,
  (SELECT array_agg(DISTINCT i.size)
     FROM ip_item_master i
    WHERE i.style_code = sm.style_code
      AND i.size IS NOT NULL
      AND COALESCE(i.size,'') <> ''
      AND i.size !~* 'PPK') AS variants
FROM style_master sm;

COMMENT ON VIEW v_style_scale_candidates IS 'Per-style non-PPK size variants + gender + current size_scale_id. Backs the bulk auto-assign-size-scales tool.';

CREATE OR REPLACE FUNCTION apply_size_scale_assignments(_assignments jsonb, _overwrite boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
AS $func$
DECLARE
  n integer;
BEGIN
  UPDATE style_master sm
     SET size_scale_id = (a->>'size_scale_id')::uuid
    FROM jsonb_array_elements(COALESCE(_assignments, '[]'::jsonb)) a
   WHERE sm.style_code = (a->>'style_code')
     AND (a->>'size_scale_id') IS NOT NULL
     AND (_overwrite OR sm.size_scale_id IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$func$;

COMMENT ON FUNCTION apply_size_scale_assignments(jsonb, boolean) IS 'Bulk-set style_master.size_scale_id from [{style_code, size_scale_id}]; only fills NULLs unless _overwrite. Returns rows updated.';

NOTIFY pgrst, 'reload schema';
