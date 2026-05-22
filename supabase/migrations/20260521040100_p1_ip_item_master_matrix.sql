-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 4 / Migration 11
-- ip_item_master: matrix dimensions + style FK + is_apparel flag.
--
-- All new columns are NULLABLE for now. The `apparel_dims_required` CHECK
-- constraint (which makes color/size/inseam/length/fit NOT NULL for apparel
-- rows) is INTENTIONALLY DEFERRED to a follow-up data-prep migration:
--   1. Merchandiser supplies the non-apparel category list.
--   2. We flip is_apparel=false for accessory SKUs.
--   3. Backfill apparel rows' missing dims (Bottoms category gets attention).
--   4. THEN add the CHECK constraint.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §5.2 + §5.3.
-- The deferred step is documented in §12 (Risk register) and arch §11 (Sub-decisions).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE ip_item_master
  ADD COLUMN IF NOT EXISTS gender_code  text,
  ADD COLUMN IF NOT EXISTS inseam       text,
  ADD COLUMN IF NOT EXISTS length       text,
  ADD COLUMN IF NOT EXISTS fit          text,
  ADD COLUMN IF NOT EXISTS style_id     uuid REFERENCES style_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_apparel   boolean NOT NULL DEFAULT true;

-- Gender code CHECK (nullable allows legacy rows to lift through without forcing
-- merchandiser intervention. Where set, must match the rof_xoro conformance set).
ALTER TABLE ip_item_master DROP CONSTRAINT IF EXISTS ip_item_master_gender_check;
ALTER TABLE ip_item_master ADD CONSTRAINT ip_item_master_gender_check
  CHECK (gender_code IS NULL OR gender_code IN ('M', 'WMS', 'B', 'C', 'G', 'U'));

-- Indexes per arch §5.2
CREATE INDEX IF NOT EXISTS idx_ip_item_master_entity_style
  ON ip_item_master (entity_id, style_id);
CREATE INDEX IF NOT EXISTS idx_ip_item_master_entity_gender
  ON ip_item_master (entity_id, gender_code);
CREATE INDEX IF NOT EXISTS idx_ip_item_master_matrix_lookup
  ON ip_item_master (entity_id, style_id, color, size);
CREATE INDEX IF NOT EXISTS idx_ip_item_master_is_apparel
  ON ip_item_master (entity_id, is_apparel);

-- ════════════════════════════════════════════════════════════════════════════
-- Backfill: link existing items to their newly-created style_master row.
-- Matches on UPPER(TRIM(style_code)) per entity since the style_master backfill
-- canonicalized style codes the same way.
-- ════════════════════════════════════════════════════════════════════════════
UPDATE ip_item_master im
SET style_id = sm.id
FROM style_master sm
WHERE im.style_id IS NULL
  AND im.style_code IS NOT NULL
  AND TRIM(im.style_code) <> ''
  AND sm.entity_id = im.entity_id
  AND sm.style_code = TRIM(UPPER(im.style_code))
  AND sm.deleted_at IS NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- Bidirectional sync trigger: when ip_item_master.style_code is changed, look
-- up (or fail) the style_master row and update style_id; when a row inserts
-- with style_code but no style_id, resolve it. Keeps rof_xoro's nightly post
-- (which writes style_code text) compatible without script changes.
--
-- The trigger DOES NOT auto-create style_master rows on unknown style_codes.
-- Unknown codes leave style_id NULL and surface in a "needs style_master row"
-- report (TBD). This is intentional — auto-creating styles would let typos
-- proliferate without merchandiser review.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ip_item_master_sync_style_id() RETURNS trigger AS $$
DECLARE
  v_style_id uuid;
  v_canon    text;
BEGIN
  -- Only fire when style_code is set and either style_id is unset OR style_code is changing.
  IF NEW.style_code IS NULL OR TRIM(NEW.style_code) = '' THEN
    NEW.style_id := NULL;
    RETURN NEW;
  END IF;

  -- For UPDATE, only re-resolve when style_code actually changed.
  IF TG_OP = 'UPDATE'
     AND NEW.style_code IS NOT DISTINCT FROM OLD.style_code
     AND NEW.style_id   IS NOT DISTINCT FROM OLD.style_id
  THEN
    RETURN NEW;
  END IF;

  v_canon := TRIM(UPPER(NEW.style_code));

  SELECT id INTO v_style_id
    FROM style_master
   WHERE entity_id = NEW.entity_id
     AND style_code = v_canon
     AND deleted_at IS NULL
   LIMIT 1;

  -- Unknown style → leave style_id NULL; explicit FK lookups (allocation
  -- grid, matrix UI) filter on style_id IS NOT NULL.
  NEW.style_id := v_style_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ip_item_master_sync_style_trg ON ip_item_master;
CREATE TRIGGER ip_item_master_sync_style_trg
  BEFORE INSERT OR UPDATE OF style_code, style_id ON ip_item_master
  FOR EACH ROW EXECUTE FUNCTION ip_item_master_sync_style_id();

COMMENT ON COLUMN ip_item_master.gender_code IS 'M|WMS|B|C|G|U — explicit gender. NULL allowed at launch; rof_xoro daily_check conformance is canonical source.';
COMMENT ON COLUMN ip_item_master.inseam      IS 'Apparel dim 3. Required (NOT NULL) for apparel rows after the data-prep follow-up migration adds the CHECK.';
COMMENT ON COLUMN ip_item_master.length      IS 'Apparel dim 4. REGULAR|LONG|PETITE|TALL. Required for apparel rows post-CHECK.';
COMMENT ON COLUMN ip_item_master.fit         IS 'Apparel dim 5. SKINNY|SLIM|STRAIGHT|RELAXED|CURVY|... Required for apparel rows post-CHECK.';
COMMENT ON COLUMN ip_item_master.style_id    IS 'FK to style_master. Resolved by trigger from style_code (UPPER TRIM). NULL when style_code matches no style_master row.';
COMMENT ON COLUMN ip_item_master.is_apparel  IS 'Default true. When false, apparel CHECK (added in a later migration) does not apply.';
