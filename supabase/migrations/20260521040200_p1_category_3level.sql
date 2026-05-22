-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 4 / Migration 12
-- ip_category_master: 3-level taxonomy.
-- Adds parent_category_id self-ref, `level` (1..3), and materialized `path`
-- for fast display + search. Existing rows backfill as level=1 (top-level).
-- The merchandiser does a manual pass later to add level 2/3 categories.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §6.2
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE ip_category_master
  ADD COLUMN IF NOT EXISTS parent_category_id uuid REFERENCES ip_category_master(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS level              smallint,
  ADD COLUMN IF NOT EXISTS path               text;

-- Backfill: every existing row is level 1 (top-level). path = category_code.
UPDATE ip_category_master
   SET level = 1,
       path  = category_code
 WHERE level IS NULL;

ALTER TABLE ip_category_master
  ALTER COLUMN level SET NOT NULL,
  ALTER COLUMN level SET DEFAULT 1,
  ALTER COLUMN path  SET NOT NULL;

ALTER TABLE ip_category_master DROP CONSTRAINT IF EXISTS ip_category_master_level_check;
ALTER TABLE ip_category_master ADD CONSTRAINT ip_category_master_level_check
  CHECK (level BETWEEN 1 AND 3);

ALTER TABLE ip_category_master DROP CONSTRAINT IF EXISTS ip_category_master_level1_no_parent;
ALTER TABLE ip_category_master ADD CONSTRAINT ip_category_master_level1_no_parent
  CHECK ((level = 1 AND parent_category_id IS NULL)
      OR (level > 1 AND parent_category_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_ip_category_master_parent
  ON ip_category_master (parent_category_id) WHERE parent_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_category_master_level
  ON ip_category_master (entity_id, level);
CREATE INDEX IF NOT EXISTS idx_ip_category_master_path
  ON ip_category_master (entity_id, path);

-- ════════════════════════════════════════════════════════════════════════════
-- Parent-level consistency trigger: when a row inserts/updates with a parent,
-- verify parent.level + 1 = child.level. Also maintains the materialized path
-- as "parent.path > child.category_code" (using " > " as the separator since
-- it's unambiguous in apparel category names).
--
-- This is a trigger (not a CHECK constraint with subquery — PG doesn't allow
-- that) and runs BEFORE INSERT OR UPDATE.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ip_category_master_validate_hierarchy() RETURNS trigger AS $$
DECLARE
  parent_level smallint;
  parent_path  text;
  parent_entity uuid;
BEGIN
  IF NEW.parent_category_id IS NULL THEN
    IF NEW.level <> 1 THEN
      RAISE EXCEPTION 'ip_category_master: top-level rows (parent_category_id IS NULL) must have level=1, got %', NEW.level;
    END IF;
    NEW.path := NEW.category_code;
    RETURN NEW;
  END IF;

  IF NEW.parent_category_id = NEW.id THEN
    RAISE EXCEPTION 'ip_category_master: a row cannot be its own parent (id=%)', NEW.id;
  END IF;

  SELECT level, path, entity_id INTO parent_level, parent_path, parent_entity
    FROM ip_category_master WHERE id = NEW.parent_category_id;

  IF parent_level IS NULL THEN
    RAISE EXCEPTION 'ip_category_master: parent_category_id % not found', NEW.parent_category_id;
  END IF;

  IF parent_entity <> NEW.entity_id THEN
    RAISE EXCEPTION 'ip_category_master: parent belongs to a different entity (% vs %)',
      parent_entity, NEW.entity_id;
  END IF;

  IF NEW.level <> parent_level + 1 THEN
    RAISE EXCEPTION 'ip_category_master: child level must be parent.level + 1 (parent=%, child=%)',
      parent_level, NEW.level;
  END IF;

  NEW.path := parent_path || ' > ' || NEW.category_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ip_category_master_hierarchy_trg ON ip_category_master;
CREATE TRIGGER ip_category_master_hierarchy_trg
  BEFORE INSERT OR UPDATE OF parent_category_id, level, category_code, entity_id
  ON ip_category_master
  FOR EACH ROW EXECUTE FUNCTION ip_category_master_validate_hierarchy();

-- ════════════════════════════════════════════════════════════════════════════
-- Cascade path refresh: when a parent's path or category_code changes, all
-- descendants need their path recomputed. Triggered by AFTER UPDATE on the
-- parent rows. Uses recursive CTE to avoid an N+1 trigger storm.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ip_category_master_cascade_path() RETURNS trigger AS $$
BEGIN
  IF NEW.path IS NOT DISTINCT FROM OLD.path
     AND NEW.category_code IS NOT DISTINCT FROM OLD.category_code
  THEN
    RETURN NULL;
  END IF;

  WITH RECURSIVE descendants AS (
    SELECT id, parent_category_id, category_code, NEW.path AS new_path
      FROM ip_category_master
     WHERE parent_category_id = NEW.id
    UNION ALL
    SELECT c.id, c.parent_category_id, c.category_code, d.new_path || ' > ' || c.category_code
      FROM ip_category_master c
      JOIN descendants d ON c.parent_category_id = d.id
  )
  UPDATE ip_category_master c
     SET path = d.new_path || ' > ' || c.category_code
    FROM descendants d
   WHERE c.id = d.id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ip_category_master_cascade_path_trg ON ip_category_master;
CREATE TRIGGER ip_category_master_cascade_path_trg
  AFTER UPDATE OF path, category_code ON ip_category_master
  FOR EACH ROW EXECUTE FUNCTION ip_category_master_cascade_path();

COMMENT ON COLUMN ip_category_master.parent_category_id IS 'Self-ref for 3-level hierarchy. NULL only for level=1 (top-level) rows.';
COMMENT ON COLUMN ip_category_master.level              IS '1=top, 2=mid, 3=leaf. CHECK constraint enforces BETWEEN 1 AND 3 and (level=1 ⇔ parent IS NULL).';
COMMENT ON COLUMN ip_category_master.path               IS 'Materialized full path "Apparel > Bottoms > Jeans" for display/search. Maintained by trigger; never set by hand.';
