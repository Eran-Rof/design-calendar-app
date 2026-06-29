-- Costing — backfill project status from line-level progress (auto-advance).
--
-- Problem: costing_projects.status is a manual field. When a line is awarded
-- (selected_vendor_quote_id set) the project status never moved, so the
-- Projects list (buckets by project.status) showed a project under Active while
-- the in-project Plan Flow strip (buckets lines by stage) showed it Awarded.
--
-- Fix: advance each project's stored status to match its highest line stage —
-- ANY awarded line => 'awarded', else any live vendor quote => 'quoted', else
-- any style chosen => 'in_progress'. FORWARD-ONLY: only advance, never
-- downgrade, and never touch the manual terminal states (closed/cancelled).
-- Idempotent: re-running is a no-op once a project has advanced.

WITH derived AS (
  SELECT
    p.id,
    p.status AS cur_status,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM costing_lines l
        WHERE l.project_id = p.id AND l.selected_vendor_quote_id IS NOT NULL
      ) THEN 'awarded'
      WHEN EXISTS (
        SELECT 1 FROM costing_lines l
        JOIN costing_line_vendors v ON v.costing_line_id = l.id
        WHERE l.project_id = p.id AND v.status IN ('pending', 'received', 'selected')
      ) THEN 'quoted'
      WHEN EXISTS (
        SELECT 1 FROM costing_lines l
        WHERE l.project_id = p.id AND l.style_master_id IS NOT NULL
      ) THEN 'in_progress'
      ELSE 'draft'
    END AS derived_status
  FROM costing_projects p
  WHERE p.status NOT IN ('closed', 'cancelled')
)
UPDATE costing_projects p
SET status = d.derived_status
FROM derived d
WHERE p.id = d.id
  AND (CASE d.derived_status
         WHEN 'awarded' THEN 3 WHEN 'quoted' THEN 2 WHEN 'in_progress' THEN 1 ELSE 0 END)
    > (CASE d.cur_status
         WHEN 'awarded' THEN 3 WHEN 'quoted' THEN 2 WHEN 'in_progress' THEN 1 ELSE 0 END);
