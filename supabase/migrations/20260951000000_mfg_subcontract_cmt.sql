-- 20260951000000_mfg_subcontract_cmt.sql
--
-- Outsourced-conversion (subcontracting) — best-in-class CMT accounting.
--
-- When a build's conversion is done OUTSIDE (cut-make-trim at a contractor), the
-- vendor's charge is capitalized into the finished good's cost and 3-way matched
-- against the conversion PO + the finished-goods receipt, exactly like goods:
--
--   Issue (material provision)   DR 1305 WIP        / CR 1360 parts + 13xx styles
--   Receive finished goods       DR 1305 WIP        / CR 2160 Accrued CMT   (accrue CMT)
--   Complete                     DR 13xx Fin. Inv.  / CR 1305 WIP           (parts+styles+CMT)
--   Vendor CMT bill (3-way)      DR 2160 Accrued CMT + DR/CR 6320 PPV / CR AP
--
-- 2160 is the CMT analogue of 2050 GR/IR-goods: it accrues "CMT-received-not-
-- invoiced" at receipt and is cleared by the vendor bill, so CMT is never double
-- counted and price variance lands in 6320 (PO Variance Expense, already seeded).
--
-- This migration:
--   1. Seeds 2160 Accrued CMT (liability, CREDIT, postable — mirrors 2050).
--   2. Adds the CMT accrual / invoice tracking columns to mfg_build_orders.
--   3. Asserts 6320 PPV exists (used by the ap_invoice_grir_match clearing rule).
--
-- Idempotent: safe to re-run.

DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping 2160 Accrued CMT seed; rerun once entity exists';
    RETURN;
  END IF;

  -- 2160 Accrued CMT (CMT-received-not-invoiced clearing). NOT a control account
  -- (no subledger enforced) so the clearing DR from ap_invoice_grir_match, which
  -- carries no subledger, posts cleanly — same shape as 2050 GR/IR.
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '2160', 'Accrued CMT', 'liability', 'CREDIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;

  -- 6320 PO Variance Expense is required by the 3-way-match clearing rule. It is
  -- seeded by the P13 legacy bridge + asserted by the COA regroup, so this is a
  -- guard against an unexpectedly-missing account rather than a seed.
  IF NOT EXISTS (SELECT 1 FROM gl_accounts WHERE entity_id = v_rof AND code = '6320' AND is_postable AND status = 'active') THEN
    RAISE NOTICE '6320 PO Variance Expense missing/unpostable — subcontract CMT price-variance postings will fail until it exists.';
  END IF;
END $$;

-- CMT accrual + 3-way-match tracking on the build.
--   cmt_accrued_cents — the CMT value accrued into WIP at receipt (the
--                       received-and-accepted value the vendor bill clears).
--   cmt_accrual_je_id — the DR WIP / CR 2160 accrual JE (reversed on cancel).
--   cmt_invoice_id    — the vendor CMT bill (invoices row) once 3-way matched.
--   cmt_invoice_je_id — the DR 2160 / ±6320 / CR AP clearing JE (idempotency).
ALTER TABLE mfg_build_orders
  ADD COLUMN IF NOT EXISTS cmt_accrued_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cmt_accrual_je_id uuid,
  ADD COLUMN IF NOT EXISTS cmt_invoice_id    uuid,
  ADD COLUMN IF NOT EXISTS cmt_invoice_je_id uuid;

COMMENT ON COLUMN mfg_build_orders.cmt_accrued_cents IS
  'Outsourced CMT capitalized into WIP at finished-goods receipt (capitalize mode); the received value the vendor CMT bill clears from 2160 Accrued CMT.';

NOTIFY pgrst, 'reload schema';
