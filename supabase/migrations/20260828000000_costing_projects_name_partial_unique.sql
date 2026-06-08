-- Replace the full unique constraint on (entity_id, project_name) with a
-- partial unique index that excludes closed / cancelled projects.
--
-- Problem: a project set to 'closed' or 'cancelled' (or hard-deleted from
-- the UI but the row remained due to an error) was blocking creation of a
-- new project with the same name, with a cryptic DB error.
--
-- Fix: only ACTIVE projects (draft, in_progress, quoted, awarded) enforce
-- name uniqueness. Closed and cancelled projects are considered archived;
-- their names can be freely reused by a new project.

ALTER TABLE costing_projects
  DROP CONSTRAINT IF EXISTS costing_projects_name_per_entity_unique;

CREATE UNIQUE INDEX IF NOT EXISTS costing_projects_active_name_unique
  ON costing_projects (entity_id, project_name)
  WHERE status NOT IN ('closed', 'cancelled');
