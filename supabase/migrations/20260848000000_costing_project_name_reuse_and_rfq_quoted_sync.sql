-- Consolidated, idempotent recovery of three costing/RFQ fixes that were
-- stranded as duplicate-versioned files in a stale local checkout (orphaned
-- PRs #1030 / #1090). Their original version numbers (20260825/26/27) already
-- belong to unrelated migrations on main, so they are re-issued here as one
-- safe migration. Probed against prod 2026-06-09 — only the parts with a real
-- effect are kept; the no-op data corrections are recorded for history only.
--
-- Prod state at authoring time:
--   • rfqs_status_check ALREADY includes 'quoted' (direct-applied during the
--     orphaned PR work → file/prod drift). Re-asserted here so migration
--     history matches prod.
--   • costing_projects still has the FULL unique constraint → the partial
--     index swap below is the real, unshipped fix.
--   • 2 published RFQs still need the → 'quoted' data backfill.
--   • 0 costing_lines are wrongly 'awarded' and 0 are stuck 'draft' → those
--     corrections are no-ops, included only as guarded statements.

-- ─── 1. rfqs.status: ensure 'quoted' is allowed (idempotent; syncs drift) ────
ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_status_check;
ALTER TABLE rfqs
  ADD CONSTRAINT rfqs_status_check
  CHECK (status IN ('draft', 'published', 'quoted', 'closed', 'awarded'));

-- Backfill published RFQs that already have a submitted invitation → 'quoted'.
UPDATE rfqs r
SET status = 'quoted', updated_at = now()
WHERE r.status = 'published'
  AND EXISTS (
    SELECT 1 FROM rfq_invitations inv
    WHERE inv.rfq_id = r.id AND inv.status = 'submitted'
  );

-- ─── 2. costing_projects: name reuse for closed/cancelled projects ───────────
-- Replace the full unique constraint with a partial unique index so a closed
-- or cancelled project no longer blocks a new project reusing its name.
ALTER TABLE costing_projects
  DROP CONSTRAINT IF EXISTS costing_projects_name_per_entity_unique;

CREATE UNIQUE INDEX IF NOT EXISTS costing_projects_active_name_unique
  ON costing_projects (entity_id, project_name)
  WHERE status NOT IN ('closed', 'cancelled');

-- ─── 3. costing_lines status hygiene (no-ops on current prod; guarded) ───────
-- 3a. Reset any line wrongly left 'awarded' without a real rfq_awarded history
--     entry (vendor selection ≠ award). 0 rows on prod at authoring time.
WITH real_awarded AS (
  SELECT DISTINCT costing_line_id
  FROM costing_line_status_history
  WHERE status = 'awarded' AND note = 'rfq_awarded' AND costing_line_id IS NOT NULL
),
published_lines AS (
  SELECT DISTINCT rli.costing_line_id
  FROM rfq_line_items rli
  JOIN rfq_invitations inv ON inv.rfq_id = rli.rfq_id
  WHERE rli.costing_line_id IS NOT NULL
),
corrected AS (
  UPDATE costing_lines
  SET status = CASE
        WHEN id IN (SELECT costing_line_id FROM published_lines) THEN 'sent'
        ELSE 'draft'
      END,
      updated_at = now()
  WHERE status = 'awarded'
    AND id NOT IN (SELECT costing_line_id FROM real_awarded)
  RETURNING id, status
)
INSERT INTO costing_line_status_history (costing_line_id, status, changed_by, note)
SELECT id, status, 'system', 'corrective_vendor_select_not_award'
FROM corrected;

-- 3b. Advance lines still 'draft' that belong to a published/quoted/awarded/
--     closed RFQ → 'sent'. 0 rows on prod at authoring time.
UPDATE costing_lines cl
SET status = 'sent', updated_at = now()
WHERE cl.status = 'draft'
  AND cl.id IN (
    SELECT DISTINCT rli.costing_line_id
    FROM rfq_line_items rli
    JOIN rfqs r ON r.id = rli.rfq_id
    WHERE rli.costing_line_id IS NOT NULL
      AND r.status IN ('published', 'quoted', 'awarded', 'closed')
  );

INSERT INTO costing_line_status_history (costing_line_id, status, changed_by, note)
SELECT cl.id, 'sent', 'system', 'backfill_draft_to_sent'
FROM costing_lines cl
WHERE cl.status = 'sent'
  AND NOT EXISTS (
    SELECT 1 FROM costing_line_status_history h
    WHERE h.costing_line_id = cl.id AND h.note = 'backfill_draft_to_sent'
  );

NOTIFY pgrst, 'reload schema';
