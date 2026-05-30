-- ════════════════════════════════════════════════════════════════════════════
-- Style Master — base_fabric FK to fabric_codes (operator ask #13, 2026-05-30)
--
-- Problem: style_master.base_fabric is a free-form text column (added by the
-- P1 chunk + most recently surfaced on the admin panel in PR #589). Operator
-- already has a fully-built Fabric Master at fabric_codes (P3 Chunk 11, 8 seeded
-- ROF fabrics), but Style Master ignores it and accepts arbitrary typed values.
-- This causes drift (free text "100% Cotton" vs canonical code "CTN100"),
-- breaks tech-pack joins, and prevents fabric-keyed analytics.
--
-- Decision summary:
--   • fabric_codes already exists with code+name+composition+gsm+coo+hts — it IS
--     the fabric master operator was asking about. We do NOT create a duplicate
--     `fabric_master` table.
--   • Add nullable uuid FK column `style_master.base_fabric_code_id` referencing
--     fabric_codes(id) with ON DELETE RESTRICT (fabrics in use cannot be deleted).
--   • Rename the legacy text column `base_fabric` to `base_fabric_legacy` and
--     keep it for one release cycle as a safety net. The admin handler stops
--     writing to it; reads continue for display fallback until cleanup migration.
--   • Backfill: distinct non-blank legacy values are upserted into fabric_codes
--     for the row's own entity (with code = upper(legacy) and a derived name)
--     and the new FK column is populated. Existing fabric_codes rows take
--     precedence — backfill uses ON CONFLICT DO NOTHING so we never overwrite
--     a real fabric definition. Rows whose legacy value already matches a
--     fabric_codes.code or fabric_codes.name (case-insensitive) reuse it.
--
-- All DDL is idempotent — re-applying on a partially-applied schema is safe.
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Rename the legacy text column (keep for one release cycle).
--    Only renames if the new column doesn't already exist — keeps re-runs safe.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'style_master' AND column_name = 'base_fabric'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'style_master' AND column_name = 'base_fabric_legacy'
  ) THEN
    ALTER TABLE style_master RENAME COLUMN base_fabric TO base_fabric_legacy;
  END IF;
END$$;

COMMENT ON COLUMN style_master.base_fabric_legacy IS
  'DEPRECATED — free-form fabric text from pre-2026-05-30. Replaced by base_fabric_code_id FK to fabric_codes. Kept for one release cycle as a safety net; do not write to this column.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add the FK column.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS base_fabric_code_id uuid;

-- The FK itself in its own DO block so it can be skipped on re-apply.
DO $$
BEGIN
  ALTER TABLE style_master
    ADD CONSTRAINT style_master_base_fabric_code_id_fkey
    FOREIGN KEY (base_fabric_code_id)
    REFERENCES fabric_codes(id)
    ON DELETE RESTRICT;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table  THEN NULL;
END$$;

COMMENT ON COLUMN style_master.base_fabric_code_id IS
  'FK to fabric_codes.id. The canonical primary fabric for the style. ON DELETE RESTRICT — a fabric_codes row cannot be deleted while any style references it.';

CREATE INDEX IF NOT EXISTS idx_style_master_base_fabric_code_id
  ON style_master (base_fabric_code_id) WHERE base_fabric_code_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill — match legacy text against existing fabric_codes first, then
--    upsert any unmatched distinct values per entity, then set the FK.
-- ─────────────────────────────────────────────────────────────────────────────

-- 3a. First pass: case-insensitive code OR name match against fabric_codes
--     within the same entity.
UPDATE style_master sm
   SET base_fabric_code_id = fc.id
  FROM fabric_codes fc
 WHERE sm.base_fabric_code_id IS NULL
   AND sm.base_fabric_legacy IS NOT NULL
   AND btrim(sm.base_fabric_legacy) <> ''
   AND fc.entity_id = sm.entity_id
   AND (
     upper(btrim(sm.base_fabric_legacy)) = upper(fc.code)
     OR lower(btrim(sm.base_fabric_legacy)) = lower(fc.name)
   );

-- 3b. Second pass: any remaining distinct legacy values become new fabric_codes
--     rows (one per entity / per distinct uppercased legacy code). Skips on
--     conflict so existing codes are never overwritten.
INSERT INTO fabric_codes (entity_id, code, name, composition_text, is_active)
SELECT DISTINCT
  sm.entity_id,
  -- Build a deterministic code from the legacy text: uppercase, strip
  -- characters outside [A-Z0-9_], cap at 32 chars. If the result is empty
  -- (legacy was punctuation only), prefix LEGACY_ + uppercase first 8 chars
  -- of the md5 so the code is always non-blank and unique.
  CASE
    WHEN length(regexp_replace(upper(btrim(sm.base_fabric_legacy)), '[^A-Z0-9_]', '_', 'g')) > 0
      THEN substr(regexp_replace(upper(btrim(sm.base_fabric_legacy)), '[^A-Z0-9_]', '_', 'g'), 1, 32)
    ELSE 'LEGACY_' || upper(substr(md5(sm.base_fabric_legacy), 1, 8))
  END                                  AS code,
  btrim(sm.base_fabric_legacy)         AS name,
  btrim(sm.base_fabric_legacy)         AS composition_text,
  true                                 AS is_active
  FROM style_master sm
 WHERE sm.base_fabric_code_id IS NULL
   AND sm.base_fabric_legacy IS NOT NULL
   AND btrim(sm.base_fabric_legacy) <> ''
ON CONFLICT (entity_id, code) DO NOTHING;

-- 3c. Third pass: now that codes exist for every legacy value, populate FK.
UPDATE style_master sm
   SET base_fabric_code_id = fc.id
  FROM fabric_codes fc
 WHERE sm.base_fabric_code_id IS NULL
   AND sm.base_fabric_legacy IS NOT NULL
   AND btrim(sm.base_fabric_legacy) <> ''
   AND fc.entity_id = sm.entity_id
   AND fc.code = CASE
     WHEN length(regexp_replace(upper(btrim(sm.base_fabric_legacy)), '[^A-Z0-9_]', '_', 'g')) > 0
       THEN substr(regexp_replace(upper(btrim(sm.base_fabric_legacy)), '[^A-Z0-9_]', '_', 'g'), 1, 32)
     ELSE 'LEGACY_' || upper(substr(md5(sm.base_fabric_legacy), 1, 8))
   END;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Reload PostgREST schema cache so the new column + FK are visible.
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
