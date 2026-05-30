-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P13-5 — QC inspection ↔ case link (M26 + P7-9)
--
-- Adds an optional case_id FK on tanda_po_qc_inspections so a failed
-- inspection with one or more critical findings can be auto-linked to a
-- case (M47/P7-9). The case is created by the QC inspection PATCH handler
-- when status moves to 'failed' AND any finding has severity='critical'.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- No COMMENT-concat — the migrations-comment-concat lint catches concatenated
-- COMMENT ON ... IS string-literal pairs; this migration sticks to ALTER and
-- CREATE INDEX only.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE tanda_po_qc_inspections ADD COLUMN IF NOT EXISTS case_id uuid REFERENCES cases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tanda_po_qc_inspections_case_idx ON tanda_po_qc_inspections (case_id) WHERE case_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
