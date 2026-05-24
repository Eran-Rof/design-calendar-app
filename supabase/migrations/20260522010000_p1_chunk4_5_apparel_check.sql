-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 4.5 / Migration 13
-- apparel_dims_required CHECK + is_apparel data prep.
--
-- Per arch §12 risk register: enforcing the 5-dim CHECK against legacy rows
-- would reject ~all existing items (most apparel SKUs have inseam/length/fit
-- NULL because they're tops/dresses/etc., not bottoms). The arch strategy:
--   1. Pattern-match category names/codes to identify "bottoms" — the only
--      category that semantically requires all 5 dims.
--   2. Flip is_apparel=true for bottoms items that have ALL 5 dims populated.
--   3. Leave is_apparel=false (default) for everything else AND for bottoms
--      with incomplete dims (they need merchandiser cleanup).
--   4. Add the CHECK. It's now safe because every is_apparel=true row has
--      complete dims.
--   5. Expose a "needs review" view so the merchandiser can finish backfilling
--      bottoms items and flip them to is_apparel=true later via the admin UI.
--
-- Heuristic for "bottoms": category_code OR name contains any of
--   jeans | pants | shorts | denim | bottoms | leggings | trousers | skirt
-- (case-insensitive). Merchandiser overrides via the admin UI later.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §5.3 + §12.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: identify bottoms categories. Wrapped in a CTE-driven UPDATE so we
-- only touch items that match. Logged via a temp NOTICE for the migration
-- runner to surface in CI / supabase db push output.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  bottoms_pattern text := '(jeans|pants|shorts|denim|bottoms|leggings|trousers|skirt)';
  bottoms_count integer;
  apparel_flipped integer;
BEGIN
  -- Count bottoms categories for visibility
  SELECT count(*) INTO bottoms_count
    FROM ip_category_master
   WHERE category_code ~* bottoms_pattern
      OR name           ~* bottoms_pattern;
  RAISE NOTICE 'Tangerine 4.5: identified % bottoms categories', bottoms_count;

  -- Flip is_apparel = true only where the linked category matches the pattern
  -- AND all 5 dims are NOT NULL. Bottoms with missing dims stay at is_apparel
  -- = false (which is the column default).
  UPDATE ip_item_master im
     SET is_apparel = true
    FROM ip_category_master cm
   WHERE im.category_id = cm.id
     AND im.is_apparel IS DISTINCT FROM true
     AND (cm.category_code ~* bottoms_pattern OR cm.name ~* bottoms_pattern)
     AND im.color  IS NOT NULL AND im.color  <> ''
     AND im.size   IS NOT NULL AND im.size   <> ''
     AND im.inseam IS NOT NULL AND im.inseam <> ''
     AND im.length IS NOT NULL AND im.length <> ''
     AND im.fit    IS NOT NULL AND im.fit    <> '';

  GET DIAGNOSTICS apparel_flipped = ROW_COUNT;
  RAISE NOTICE 'Tangerine 4.5: flipped % item rows to is_apparel=true', apparel_flipped;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: add the CHECK constraint. Validate over the whole table; the prep
-- above guarantees it passes.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_item_master DROP CONSTRAINT IF EXISTS apparel_dims_required;
ALTER TABLE ip_item_master ADD CONSTRAINT apparel_dims_required
  CHECK (
    NOT is_apparel
    OR (
      color  IS NOT NULL AND color  <> ''
      AND size   IS NOT NULL AND size   <> ''
      AND inseam IS NOT NULL AND inseam <> ''
      AND length IS NOT NULL AND length <> ''
      AND fit    IS NOT NULL AND fit    <> ''
    )
  );

COMMENT ON CONSTRAINT apparel_dims_required ON ip_item_master IS
  'Tangerine P1 §5.3: apparel-flagged rows (currently bottoms only) require all 5 matrix dims. Non-apparel rows (tops, dresses, accessories, incomplete-bottoms) bypass.';

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: merchandiser-review view. Items linked to a bottoms category but
-- still flagged is_apparel=false because at least one dim is NULL. The admin
-- UI surfaces this list with editable inseam/length/fit cells; once filled,
-- merchandiser flips is_apparel=true (which the CHECK now permits).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW ip_item_master_needs_matrix_review_v AS
SELECT
  im.id,
  im.entity_id,
  im.sku_code,
  im.style_code,
  im.style_id,
  im.color,
  im.size,
  im.inseam,
  im.length,
  im.fit,
  im.is_apparel,
  cm.category_code AS category_code,
  cm.name          AS category_name
FROM ip_item_master im
JOIN ip_category_master cm ON cm.id = im.category_id
WHERE im.is_apparel = false
  AND (cm.category_code ~* '(jeans|pants|shorts|denim|bottoms|leggings|trousers|skirt)'
       OR cm.name           ~* '(jeans|pants|shorts|denim|bottoms|leggings|trousers|skirt)')
  AND (
       im.color  IS NULL OR im.color  = ''
    OR im.size   IS NULL OR im.size   = ''
    OR im.inseam IS NULL OR im.inseam = ''
    OR im.length IS NULL OR im.length = ''
    OR im.fit    IS NULL OR im.fit    = ''
  );

COMMENT ON VIEW ip_item_master_needs_matrix_review_v IS
  'Bottoms-category items with at least one matrix dim NULL. Merchandiser fills in missing dims via the admin UI, then sets is_apparel=true.';
