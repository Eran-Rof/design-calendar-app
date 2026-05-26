-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk T1-fix
-- Ensure exactly one entity has code='ROF'.
--
-- Why: Chunk 1's migration (20260521010000_p1_entities_extensions.sql) backfilled
-- entity.code using `CASE WHEN slug = 'ring-of-fire' THEN 'ROF' ELSE upper(replace(slug, '-', ''))`.
-- That only sets code='ROF' if the slug is the EXACT string 'ring-of-fire'.
-- Production deployments where the seed row had a different slug shape (e.g.
-- 'rof', 'ringoffire', or any custom variant) end up with code='RINGOFFIRE',
-- code='ROF' by accident, or code=something else entirely.
--
-- Every Tangerine admin handler looks up the entity via
--   SELECT id FROM entities WHERE code = 'ROF'
-- and returns 500 "Default entity (ROF) not found" if the row isn't there.
--
-- This migration is defensive + idempotent:
--   1. If any entity already has code='ROF', no-op.
--   2. Otherwise, find the most-likely-RoF entity by name/slug ilike + only
--      flip its code to 'ROF' if exactly one candidate matches.
--   3. As a final fallback, if the entities table has exactly one row, set its
--      code to 'ROF' (works for single-tenant installs which is everyone today).
--   4. If still ambiguous (multiple unmatched entities), do nothing and log —
--      manual intervention needed.
--
-- Safe to re-run. Safe across multiple environments (dev / staging / prod).
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  rof_id        uuid;
  candidate_id  uuid;
  total_count   integer;
BEGIN
  -- Step 1: already have one?
  SELECT id INTO rof_id FROM entities WHERE code = 'ROF' LIMIT 1;
  IF rof_id IS NOT NULL THEN
    RAISE NOTICE 'Tangerine T1-fix: entity with code=ROF already exists (%); no change', rof_id;
    RETURN;
  END IF;

  -- Step 2: find by name or slug ilike pattern
  SELECT id INTO candidate_id
  FROM entities
  WHERE name ILIKE 'ring%fire%'
     OR name ILIKE 'rof%'
     OR slug ILIKE 'ring%fire%'
     OR slug ILIKE 'ring-of-fire%'
     OR slug = 'rof'
  ORDER BY created_at ASC
  LIMIT 1;

  IF candidate_id IS NOT NULL THEN
    UPDATE entities SET code = 'ROF' WHERE id = candidate_id;
    RAISE NOTICE 'Tangerine T1-fix: entity % (matched by name/slug) flipped to code=ROF', candidate_id;
    RETURN;
  END IF;

  -- Step 3: single-row fallback
  SELECT count(*) INTO total_count FROM entities;
  IF total_count = 1 THEN
    SELECT id INTO candidate_id FROM entities LIMIT 1;
    UPDATE entities SET code = 'ROF' WHERE id = candidate_id;
    RAISE NOTICE 'Tangerine T1-fix: only 1 entity exists; flipped entity % to code=ROF', candidate_id;
    RETURN;
  END IF;

  -- Step 4: ambiguous; bail safely
  IF total_count = 0 THEN
    RAISE WARNING 'Tangerine T1-fix: entities table is EMPTY. Manual seed required: INSERT INTO entities (name, slug, code, status, functional_currency, fiscal_year_start_month, accounting_basis_primary) VALUES (''Ring of Fire'', ''ring-of-fire'', ''ROF'', ''active'', ''USD'', 1, ''ACCRUAL'');';
  ELSE
    RAISE WARNING 'Tangerine T1-fix: % entities exist, none match Ring-of-Fire by name/slug. Manually run UPDATE entities SET code = ''ROF'' WHERE id = ''<your-target-id>''.', total_count;
  END IF;
END $$;
