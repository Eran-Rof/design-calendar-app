-- Drop the redundant " — <vendor>" suffix from costing-generated RFQ titles.
--
-- generate-rfqs used to title RFQs "<project_name> — <vendorLabel>". The vendor
-- is already shown in its own column in the internal RFQ list + costing views
-- and is implicit in the vendor portal, so the suffix was noise. New RFQs are
-- titled with just the project name (handler change in the same PR); this
-- backfills the existing ones. Scoped to created_by='costing_module' so any
-- manually-authored RFQ titles (which may legitimately contain " — ") are left
-- untouched.

-- 1. Exact rewrite where the source costing project is linked: title := project name.
UPDATE rfqs r
SET    title = cp.project_name
FROM   costing_projects cp
WHERE  r.source_costing_project_id = cp.id
  AND  r.created_by = 'costing_module'
  AND  cp.project_name IS NOT NULL
  AND  r.title IS DISTINCT FROM cp.project_name;

-- 2. Fallback for costing RFQs with no project link: strip the trailing
--    " — <label>" segment (the vendor label) from the stored title.
UPDATE rfqs r
SET    title = regexp_replace(r.title, ' — [^—]+$', '')
WHERE  r.created_by = 'costing_module'
  AND  r.source_costing_project_id IS NULL
  AND  r.title ~ ' — ';
