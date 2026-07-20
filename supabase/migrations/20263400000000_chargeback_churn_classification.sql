-- ============================================================================
-- Chargeback "factor churn" classification -- persisted annotations
-- (2026-07-20, CEO-approved; extends #1832 recourse-610 exclusion)
--
-- #1832 excluded Rosenthal code-610 "Manual Charge Back" (full-invoice recourse)
-- from dilution analytics. This migration widens the "factor receivable churn"
-- concept (things the FACTOR moves that are NOT customer deductions) and PERSISTS
-- the classification so the worklist, the dilution endpoint and auto-disposition
-- all read one governed flag instead of re-deriving a predicate.
--
-- Three churn kinds (see api/_lib/chargebackMatch.js classifyChurn):
--   * recourse_610      -- reason_code 610 / "Manual Charge Back" (unchanged)
--   * offset_pair       -- a chargeback and a creditback with the SAME normalized
--                          item token (upper, strip non-alnum, strip leading
--                          zeros on all-numeric tokens) and EXACTLY opposite
--                          amount_cents; greedy 1:1. Both legs are churn. This
--                          deliberately pairs leading-zero variants of one
--                          receivable (e.g. "150100" vs "00000150100"), which the
--                          #1848 net-open-by-document metric keeps distinct.
--   * factor_admin_code -- reason_code in (200,202,204): "Against previous
--                          chargeback" / "Non-factored Invoice (credit)" / factor
--                          admin credits -- verified on prod to have no counted
--                          opposite deduction (not real recoveries).
--
-- These are ANNOTATION columns only. The imported amount / reason / raw fields
-- are NEVER modified. Classification + auto-disposition run in a shared sweep
-- (api/_lib/chargebackChurnSweep.js) from the importer and a one-time backfill.
--
-- Idempotent (IF NOT EXISTS + guarded constraint). Safe no-op on db-push merge.
-- ============================================================================

ALTER TABLE factor_chargebacks
  ADD COLUMN IF NOT EXISTS is_factor_churn boolean,
  ADD COLUMN IF NOT EXISTS churn_kind      text,
  ADD COLUMN IF NOT EXISTS churn_pair_id   uuid;

-- churn_kind CHECK (idempotent add)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'factor_chargebacks_churn_kind_chk'
  ) THEN
    ALTER TABLE factor_chargebacks
      ADD CONSTRAINT factor_chargebacks_churn_kind_chk
      CHECK (churn_kind IS NULL OR churn_kind IN ('recourse_610','offset_pair','factor_admin_code'));
  END IF;
END $$;

COMMENT ON COLUMN factor_chargebacks.is_factor_churn IS
  'TRUE when this row is factor receivable churn (NOT a customer deduction) and is excluded from dilution analytics. NULL = not yet swept. Set by api/_lib/chargebackChurnSweep.js.';
COMMENT ON COLUMN factor_chargebacks.churn_kind IS
  'Kind of factor churn: recourse_610 | offset_pair | factor_admin_code. NULL when is_factor_churn is not TRUE.';
COMMENT ON COLUMN factor_chargebacks.churn_pair_id IS
  'For churn_kind=offset_pair: a deterministic id shared by the two legs (chargeback + reversing creditback). NULL otherwise.';

CREATE INDEX IF NOT EXISTS idx_fc_is_factor_churn ON factor_chargebacks (is_factor_churn);
CREATE INDEX IF NOT EXISTS idx_fc_churn_kind      ON factor_chargebacks (churn_kind);
CREATE INDEX IF NOT EXISTS idx_fc_churn_pair      ON factor_chargebacks (churn_pair_id);
