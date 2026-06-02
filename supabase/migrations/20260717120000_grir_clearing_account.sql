-- P13 GL Chunk 1 — seed the GR/IR (Goods-Received-Not-Invoiced) clearing account.
--
-- A goods receipt now posts a JE: DR Inventory (1300, at landed cost) /
-- CR GR/IR-goods (2050, vendor PO cost) / CR Accrued Landed (2150, capitalized
-- freight/duty rollups). The vendor AP invoice later clears 2050 (DR 2050 /
-- CR AP) and the rollup AP invoices clear 2150 — neither re-debits inventory,
-- so goods are never double-counted. 2150 (Accrued Customs / Duty) already
-- exists (P13-2); 2050 is new.
--
-- Liability, normal CREDIT, postable. Idempotent via ON CONFLICT.

DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping GR/IR account seed; rerun once entity exists';
    RETURN;
  END IF;

  -- 2050 GR/IR Clearing (Goods Received Not Invoiced)
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '2050', 'GR/IR Clearing', 'liability', 'CREDIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
