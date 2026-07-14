-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Maker/Checker (segregation-of-duties) approvals
--
-- Closes the audit's #1 internal-controls gap: "no maker-checker on journal
-- entries or payments". This reuses the EXISTING M27 approvals engine
-- (approval_rules / approval_requests / approval_request_steps /
-- approval_decisions from 20260527020000) — it does NOT introduce a second
-- engine. All this migration does is:
--
--   1. Seed two active approval_rules for the ROF entity so that HUMAN-initiated
--      manual journal entries and AP payments at/above a dollar threshold require
--      an independent approver before they post:
--        • kind='je_manual_post'  — manual JE  ≥ $5,000  → 1 admin approval
--        • kind='ap_payment'      — AP payment ≥ $5,000  → 1 admin approval
--      These are the CEO-changeable knobs. To change a threshold, edit the
--      rule's match->>'min_amount_cents' (cents). To require a different role,
--      edit steps[].role_required (must be an entity_users.role value:
--      admin | accountant | staff | readonly). Set is_active=false to disable a
--      rule without deleting it.
--
--      The role_required='admin' step, combined with the server-side rule that
--      an approver may not be the request's creator (created_by ≠ approver),
--      IS the segregation of duties: the maker cannot also be the checker.
--
--   2. Drop the two stray anon_read RLS policies on fixed_assets /
--      fixed_asset_depreciation left over from 20260803 (pre security-sprint).
--      The formal audit flagged these.
--
-- Idempotent: safe to run repeatedly (guarded seeds + DROP ... IF EXISTS).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Seed maker/checker rules (per ROF entity) ────────────────────────────
DO $$
DECLARE
  v_entity uuid;
BEGIN
  SELECT id INTO v_entity FROM entities WHERE code = 'ROF' LIMIT 1;

  IF v_entity IS NULL THEN
    RAISE NOTICE 'maker-checker: ROF entity not found — skipping approval_rules seed';
    RETURN;
  END IF;

  -- Manual journal entry >= $5,000 requires one admin approval.
  IF NOT EXISTS (
    SELECT 1 FROM approval_rules WHERE entity_id = v_entity AND kind = 'je_manual_post'
  ) THEN
    INSERT INTO approval_rules (entity_id, kind, name, match, steps, is_active)
    VALUES (
      v_entity,
      'je_manual_post',
      'Manual journal entry >= $5,000',
      '{"min_amount_cents": 500000}'::jsonb,
      '[{"step_order": 1, "mode": "any", "role_required": "admin"}]'::jsonb,
      true
    );
  END IF;

  -- AP payment >= $5,000 requires one admin approval.
  IF NOT EXISTS (
    SELECT 1 FROM approval_rules WHERE entity_id = v_entity AND kind = 'ap_payment'
  ) THEN
    INSERT INTO approval_rules (entity_id, kind, name, match, steps, is_active)
    VALUES (
      v_entity,
      'ap_payment',
      'AP payment >= $5,000',
      '{"min_amount_cents": 500000}'::jsonb,
      '[{"step_order": 1, "mode": "any", "role_required": "admin"}]'::jsonb,
      true
    );
  END IF;
END $$;

-- ── 2. Drop stray anon_read policies flagged by the audit ───────────────────
-- Left over from 20260803_p25_finance.sql, before the security sprint dropped
-- anon read access on financial tables. Guarded so this is a no-op if already
-- removed (or if a future migration renames them).
DROP POLICY IF EXISTS "anon_read_fixed_assets" ON fixed_assets;
DROP POLICY IF EXISTS "anon_read_fa_deprec"    ON fixed_asset_depreciation;
