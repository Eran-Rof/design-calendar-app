-- Manufacturing module (M2) — Inventory-Parts GL control account.
--
-- Parts inventory value is kept distinct from finished-goods inventory on the
-- balance sheet. 1360 is a control account with subledger_type='part', so every
-- parts JE line carries the part_id and the parts subledger reconciles to the GL
-- (same pattern as 1200 Inventory / 'item', 1101 AR / 'customer', 2000 AP / 'vendor').
DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'mfg_parts_gl_account: ROF entity not found — skipping seed';
    RETURN;
  END IF;

  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_control, status)
  VALUES (v_rof, '1360', 'Inventory - Parts', 'asset', 'DEBIT', true, true, 'active')
  ON CONFLICT (entity_id, code) DO NOTHING;
END;
$$;
