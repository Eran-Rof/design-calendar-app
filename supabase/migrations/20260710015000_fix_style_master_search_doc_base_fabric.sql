-- Fix: style_master_search_doc_refresh() referenced a dropped column.
--
-- The FTS trigger (20260623000000) indexed NEW.base_fabric. PR #596
-- (20260630020000_style_master_base_fabric_fk.sql) renamed that column
-- base_fabric → base_fabric_legacy (adding the base_fabric_code_id FK) but never
-- updated this trigger function. Result: the BEFORE INSERT/UPDATE trigger throws
--   record "new" has no field "base_fabric" (SQLSTATE 42703)
-- on EVERY insert/update to style_master — silently breaking style edits and, in
-- particular, the P15 brand_id backfill UPDATE in 20260710020000.
--
-- Timestamped 20260710015000 so it applies AFTER the rename (20260630020000) and
-- BEFORE the brand_id backfill (20260710020000) on both prod and fresh rebuilds.
-- Idempotent CREATE OR REPLACE; index base_fabric_legacy (the human-readable
-- fabric text) where base_fabric used to be.

CREATE OR REPLACE FUNCTION style_master_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.style_code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.style_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.planning_class, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.base_fabric_legacy, '')), 'D');
  RETURN NEW;
END $$;
