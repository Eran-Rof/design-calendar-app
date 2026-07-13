-- ════════════════════════════════════════════════════════════════════════════
-- Xoro GL FULL rebuild — COA additions, account-map completion, indexes
-- (#xoro-gl-full-rebuild, 2026-07-13, CEO-approved)
--
-- The full-ledger rebuild makes Tangerine's GL a faithful 1:1 double-entry
-- mirror of the complete Xoro GL: every Xoro txn (xoro_gl_transactions) is
-- posted as one journal_entry (journal_type='xoro_gl_mirror', source_id=Xoro
-- TxnId, amount_home +=DR/-=CR), and the bottom-up reconstructions
-- (ar_invoice_historical, ap_*_historical, vendor_*_reclass, ar_receipt_xoro,
-- ar_xoro_mirror_daily, ap_adjustment_historical) were retired. That bulk
-- data operation is OPERATIONAL (applied once to prod via
-- scripts/gl-rebuild/*); it is NOT re-runnable as a migration.
--
-- THIS migration codifies only the SCHEMA / REFERENCE-DATA prerequisites the
-- rebuild depended on, all idempotent so a re-apply on merge is a no-op:
--   1. Four structural gl_accounts mirroring Xoro accounts that had no ROF
--      equivalent (consignment AR/inventory, factor loan, SBA/EIDL loan).
--   2. Completion of xoro_account_map to 100% of distinct Xoro account names
--      (previously 35 unmapped + 13 mapped to non-postable parents). Every
--      posting target is now postable / active / ROF-entity.
--   3. Performance indexes used by the rebuild + go-forward re-link (self-ref
--      JE FK columns; subledger accrual/cash je + invoice_number columns).
-- ════════════════════════════════════════════════════════════════════════════
DO $mig$
DECLARE
  v_rof uuid := rof_entity_id();
BEGIN
  -- 1) Structural accounts (Xoro accounts with no prior ROF equivalent) ────────
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_control, status, description)
  VALUES
    (v_rof,'1106','Accounts Receivable - Consignment','asset','DEBIT',true,false,'active','Mirror of Xoro "Maycs Consignment AR"'),
    (v_rof,'1210','Inventory - Consignment 2023','asset','DEBIT',true,false,'active','Mirror of Xoro "Inventory Consignment 2023"'),
    (v_rof,'2460','Factor Loan - Rosenthal','liability','CREDIT',true,false,'active','Mirror of Xoro "Factor loan - Rosenthal" (OtherCurrentLiability)'),
    (v_rof,'2805','Loan Payable - SBA EIDL','liability','CREDIT',true,false,'active','Mirror of Xoro "U.S. Small Business Administration" SBA/EIDL loan')
  ON CONFLICT (entity_id, code) DO NOTHING;

  -- 2) Complete xoro_account_map (guarded: table exists in prod) ───────────────
  IF to_regclass('public.xoro_account_map') IS NOT NULL THEN
    WITH m(xoro_name, code) AS (VALUES
      ('9999 - Opening Balance Equity','3004'),
      ('Accounts Receivable','1108'),
      ('Accounts Receivable (A/R) - Web','1108'),
      ('Maycs Consignment AR','1106'),
      ('Inventory Consignment 2023','1210'),
      ('Factor loan - Rosenthal','2460'),
      ('Payroll:Payroll Expense - Executive Salary','6135'),
      ('2011 - Undeposited Funds','1030'),
      ('5006 General and Administrative:Water & Power','6350'),
      ('5006 General and Administrative:Tax Expense, ROF LLC','6369'),
      ('5006 General and Administrative:Warehouse Supplies Exp Charged','6374'),
      ('5006 General and Administrative:HR Software Expense','6314'),
      ('5006 General and Administrative:Security Expense','6350'),
      ('5006 General and Administrative:Rubbish Removal Expense','6310'),
      ('5006 General and Administrative:Gas (Heating) Expense','6350'),
      ('5008 Website and E-commerce:Web Design Expense','6716'),
      ('5008 Website and E-commerce:Website Software Expense','6314'),
      ('5008 Website and E-commerce:Website Development Expense','6367'),
      ('Payroll - Psycho Tuna:Commission - Raul Ruiz','6210'),
      ('Payroll - Psycho Tuna:Commission - Reggie B. Pooley','6210'),
      ('Payroll - Psycho Tuna:Commission - J. S. Weir','6210'),
      ('Payroll - Psycho Tuna:Commission - Jason Roberson','6210'),
      ('Payroll - Psycho Tuna:Commission - Kylie Yoshida','6210'),
      ('Payroll - Psycho Tuna:Commissions - Helene Nicole','6210'),
      ('Payroll - Psycho Tuna:Action Sports LLC (Mike Freih)','6210'),
      ('Payroll Liabilities:AFLAC','2401'),
      ('Payroll Liabilities:*Payroll Liabilities','2401'),
      ('Disputed Returns Maycs 491','1112'),
      ('Disputed PayPal Charges','1402'),
      ('Disputed Freight & Hand. - 491','1112'),
      ('Sales Revenue Accessories','4005'),
      ('Sales Revenue Wovens','4005'),
      ('Cost of Goods Sold Accessories','5001'),
      ('Cost of Goods Sold Wovens','5001'),
      ('Credit Card at Chase Business','2108'),
      ('','8007'),
      -- 13 names previously mapped to NON-POSTABLE parent accounts -> postable children
      ('Deposits & Prepaid Expenses','1301'),
      ('U.S. Small Business Administrat','2805'),
      ('4200 Other Income','4003'),
      ('4200 Other Income:Other Income','4003'),
      ('5008 Website and E-commerce','6716'),
      ('4100 Dilution','4230'),
      ('5006 General and Administrative:Insurance','6337'),
      ('5006 General and Administrative:Interest Paid','6340'),
      ('5006 General and Administrative','6350'),
      ('Psycho Tuna','7109'),
      ('5001 Advertising and Promotions','6601'),
      ('5005 Freight Expenses','5401'),
      ('Payroll Liabilities','2401')
    )
    INSERT INTO xoro_account_map (xoro_accounting_name, gl_account_id, gl_code, gl_name, via, xoro_type_name, updated_at)
    SELECT m.xoro_name, a.id, a.code, a.name, 'glrebuild-map',
           COALESCE((SELECT xoro_type_name FROM xoro_account_map x WHERE x.xoro_accounting_name=m.xoro_name),
                    (SELECT accounting_type_name FROM xoro_gl_transactions t WHERE t.accounting_name=m.xoro_name LIMIT 1)),
           now()
    FROM m JOIN gl_accounts a ON a.entity_id=v_rof AND a.code=m.code
    ON CONFLICT (xoro_accounting_name) DO UPDATE
      SET gl_account_id=excluded.gl_account_id, gl_code=excluded.gl_code, gl_name=excluded.gl_name,
          via=excluded.via, updated_at=excluded.updated_at;
  END IF;
END $mig$;

-- 3) Performance indexes (self-ref JE FKs + subledger re-link columns) ─────────
CREATE INDEX IF NOT EXISTS idx_je_reversed_by       ON journal_entries(reversed_by_je_id) WHERE reversed_by_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_je_reverses          ON journal_entries(reverses_je_id)    WHERE reverses_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jel_je_id            ON journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_ar_invoices_accrual_je ON ar_invoices(accrual_je_id) WHERE accrual_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ar_invoices_cash_je    ON ar_invoices(cash_je_id)    WHERE cash_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ar_receipts_accrual_je ON ar_receipts(accrual_je_id) WHERE accrual_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ar_receipts_cash_je    ON ar_receipts(cash_je_id)    WHERE cash_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_accrual_je    ON invoices(accrual_je_id)    WHERE accrual_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_cash_je       ON invoices(cash_je_id)       WHERE cash_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_payments_cash_je ON invoice_payments(cash_je_id) WHERE cash_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ar_invoices_invnum     ON ar_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_invnum        ON invoices(invoice_number);

NOTIFY pgrst, 'reload schema';
