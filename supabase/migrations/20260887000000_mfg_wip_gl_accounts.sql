-- Manufacturing module (M4) — WIP + CMT clearing GL accounts.
--
-- 1305 Work In Process — asset control account, subledger by build_order, so the
--   per-build WIP balance reconciles to the GL (mirrors AR/AP/Inventory control).
-- 2160 Accrued CMT / Conversion Clearing — liability (reserved; used only when a
--   conversion service is billed before the build completes; the default flow
--   capitalizes the vendor charge straight to WIP).
DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'mfg_wip_gl_accounts: ROF entity not found — skipping seed';
    RETURN;
  END IF;

  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_control, status)
  VALUES (v_rof, '1305', 'Work In Process (WIP)', 'asset', 'DEBIT', true, true, 'active')
  ON CONFLICT (entity_id, code) DO NOTHING;

  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_control, status)
  VALUES (v_rof, '2160', 'Accrued CMT / Conversion Clearing', 'liability', 'CREDIT', true, false, 'active')
  ON CONFLICT (entity_id, code) DO NOTHING;
END;
$$;
