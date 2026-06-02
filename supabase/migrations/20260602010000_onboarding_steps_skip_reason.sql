-- ════════════════════════════════════════════════════════════════════════════
-- Onboarding steps: skip_reason column
--
-- Some vendors don't have compliance documents ready at the time they
-- start onboarding (insurance COI, W-9, audits, etc.). Before this
-- change the only way past the Compliance Docs step was to upload every
-- required document type — vendors without docs got stuck on step 4.
--
-- We now allow the Compliance Docs step (only) to be skipped via the
-- "I currently do not have any" affordance in the vendor onboarding UI.
-- When skipped, the step row carries:
--   status      = 'skipped'                  (already supported by CHECK)
--   skip_reason = 'no_docs' (or any short tag the client sends)
--
-- The reason is surfaced to admin in the internal onboarding review
-- screen so admin can decide whether to approve, push back, or follow
-- up with the vendor before invoice gating kicks in. Vendors still
-- cannot submit invoices until the workflow is approved (unchanged).
--
-- Nullable column, no default — existing rows stay NULL. No backfill
-- needed (no historical skips carried a reason).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE onboarding_steps
  ADD COLUMN IF NOT EXISTS skip_reason text;

COMMENT ON COLUMN onboarding_steps.skip_reason IS
  'Short tag describing why a step was skipped (e.g. "no_docs" for Compliance Docs). Surfaced to admin reviewers.';
