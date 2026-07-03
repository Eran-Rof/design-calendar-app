-- 20260952000000_mfg_wip_account_1205.sql
--
-- Fix: the manufacturing WIP account was never created in the live COA.
--
-- The M4 migration 20260887000000 tried to seed 1305 'Work In Process (WIP)',
-- but the COA regroup (20260823000000) had already claimed code 1305 for
-- 'Deposit Warehouse' — so `ON CONFLICT (entity_id, code) DO NOTHING` silently
-- dropped the WIP insert. As a result the build-order handler resolved
-- accountByCode('1305') to *Deposit Warehouse* and every build's WIP (and the
-- new subcontract CMT accrual) would have posted there. Latent only because no
-- build has ever run in prod (mfg_build_orders is empty).
--
-- Fix: create a real WIP account under a FREE code — 1205 'Work in Process' —
-- as a postable ASSET control account (subledger by build_order, mirroring
-- AR/AP/Inventory controls) nested under the 1200 'Inventory' parent. The
-- build-order handler is repointed to resolve 1205 (see build-orders/index.js).
--
-- 2160 'Accrued CMT / Conversion Clearing' already exists (correctly created by
-- 20260887000000) and is unaffected.
--
-- Idempotent: safe to re-run.

DO $$
DECLARE
  v_rof uuid;
  v_inv_parent uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'mfg_wip_account_1205: ROF entity not found — skipping seed';
    RETURN;
  END IF;

  -- Nest under 1200 'Inventory' (WIP is inventory-in-process) when it exists.
  SELECT id INTO v_inv_parent FROM gl_accounts WHERE entity_id = v_rof AND code = '1200';

  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_control, status, parent_account_id)
  VALUES (v_rof, '1205', 'Work in Process (WIP)', 'asset', 'DEBIT', true, true, 'active', v_inv_parent)
  ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
