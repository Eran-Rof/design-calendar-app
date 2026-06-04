-- ════════════════════════════════════════════════════════════════════════════
-- Costing grid batch — multi-fabric storage + project-level payment terms
-- ════════════════════════════════════════════════════════════════════════════
--
-- Two independent, idempotent column additions:
--
--   1. costing_lines.fabric_codes (text[]) — multi-fabric per line.
--      The single-fabric `fabric_code` text column is KEPT for back-compat
--      (RFQ generation + legacy readers still mirror it); the new array is the
--      authoritative multi-select store written by the grid's FabricPickerCell.
--      Backfill: any existing single fabric_code is seeded into the array so no
--      line loses its current fabric on rollout.
--
--   2. costing_projects.payment_terms_id (uuid FK → payment_terms) +
--      payment_terms_name (text snapshot). The grid reads the name to detect
--      DDP terms (/DDP/i) and hide cost-component columns. Snapshot avoids a
--      join on every grid render and survives a payment-terms rename.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; backfill only touches NULL/empty arrays.
-- No || concat in COMMENT statements.
-- Bundle source: iCloud/Producton Orders/sql/2026_07_14_costing_fabric_payment_terms.sql

-- ─── 1. costing_lines.fabric_codes ─────────────────────────────────────────
ALTER TABLE costing_lines
  ADD COLUMN IF NOT EXISTS fabric_codes text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN costing_lines.fabric_codes IS 'Multi-select fabric codes (Tangerine fabric_codes.code). Authoritative multi-fabric store. The legacy single fabric_code column is kept in sync (first element) for RFQ generation + back-compat readers.';

-- Backfill: seed the array from the legacy single column for rows that have a
-- fabric_code but an empty array (rollout only — idempotent on re-run).
UPDATE costing_lines
   SET fabric_codes = ARRAY[fabric_code]
 WHERE fabric_code IS NOT NULL
   AND btrim(fabric_code) <> ''
   AND (fabric_codes IS NULL OR cardinality(fabric_codes) = 0);

-- ─── 2. costing_projects payment terms ─────────────────────────────────────
ALTER TABLE costing_projects
  ADD COLUMN IF NOT EXISTS payment_terms_id uuid REFERENCES payment_terms(id) ON DELETE SET NULL;

ALTER TABLE costing_projects
  ADD COLUMN IF NOT EXISTS payment_terms_name text;

COMMENT ON COLUMN costing_projects.payment_terms_id IS 'FK to payment_terms(id) — Tangerine Payment Terms master. NULL until the operator picks a term in the project header.';
COMMENT ON COLUMN costing_projects.payment_terms_name IS 'Denormalized snapshot of the selected payment term name (e.g. "DDP 30"). The costing grid matches this against /DDP/i to hide FOB/Duty/Freight/Insurance/Landed/Other and rename Trgt Cost to Trgt DDP.';
