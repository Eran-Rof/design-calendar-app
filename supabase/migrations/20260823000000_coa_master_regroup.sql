-- COA master re-grouping (447 accounts) for ROF entity.
-- Destructive: parks colliding codes, reuses the 3 posted accounts, inserts new master, deletes unreferenced orphans.
-- Recorded migration mirroring the applied PROD change so a from-scratch rebuild reproduces it.
-- Already applied to PROD on 2026-06-05; its version is pre-seeded in schema_migrations so db-push skips it.
-- Idempotency-guarded: a re-run after the regroup is a no-op. Assertions RAISE -> rollback.
BEGIN;

-- 1. Staging table with all 447 CSV rows.
CREATE TEMP TABLE coa_new(
  code text,
  name text,
  account_type text,
  normal_balance text,
  is_postable boolean,
  is_control boolean,
  parent_code text
) ON COMMIT DROP;

INSERT INTO coa_new(code,name,account_type,normal_balance,is_postable,is_control,parent_code) VALUES
  ('1000','Cash & Bank','asset','DEBIT',FALSE,FALSE,NULL),
  ('1001','Valley Bank  7801 Main','asset','DEBIT',TRUE,FALSE,'1000'),
  ('1002','Valley Bank 1300 Payroll Account','asset','DEBIT',TRUE,FALSE,'1000'),
  ('1003','Valley Bank 1500 Web Account','asset','DEBIT',TRUE,FALSE,'1000'),
  ('1010','Petty Cash','asset','DEBIT',TRUE,FALSE,'1000'),
  ('1011','Paypal Account','asset','DEBIT',TRUE,FALSE,'1000'),
  ('1020','Cash Clearing','asset','DEBIT',TRUE,FALSE,'1000'),
  ('1030','Undeposited Funds','asset','DEBIT',TRUE,FALSE,'1000'),
  ('1050','Factor','asset','DEBIT',FALSE,FALSE,NULL),
  ('1051','Factor Advances - Rosenthal','asset','DEBIT',TRUE,FALSE,'1050'),
  ('1100','A/R','asset','DEBIT',FALSE,FALSE,NULL),
  ('1101','Accounts Receivable','asset','DEBIT',TRUE,TRUE,'1100'),
  ('1102','Accounts Rec - Amazon','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1103','Accounts Rec - Fashion Go','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1104','Accounts Rec - Walmart.com','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1105','Accounts Receivable - Credit Card','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1106','Accounts Receivable (A/R) - Web','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1107','Accounts Receivable - Factor','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1108','Accounts Receivable (house)','asset','DEBIT',FALSE,FALSE,'1100'),
  ('1109','Allowance for doubtful accounts','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1110','Allowance for bad debt','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1111','Allowance for Unprocessed Returns','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1112','Open Credits','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1113','Open Credit Memos','asset','DEBIT',TRUE,FALSE,'1100'),
  ('1200','Inventory','asset','DEBIT',FALSE,TRUE,NULL),
  ('1201','Inventory - ROF','asset','DEBIT',TRUE,FALSE,'1200'),
  ('1202','Inventory -ROF  Ecom','asset','DEBIT',TRUE,FALSE,'1200'),
  ('1203','Inventory - Psycho Tuna','asset','DEBIT',TRUE,FALSE,'1200'),
  ('1204','Inventory markdowns - ROF','asset','DEBIT',TRUE,FALSE,'1200'),
  ('1300','Deposits & Prepaid Expenses','asset','DEBIT',FALSE,FALSE,NULL),
  ('1301','Prepaid Expenses','asset','DEBIT',TRUE,FALSE,'1300'),
  ('1302','Prepaid Liability Insurance','asset','DEBIT',TRUE,FALSE,'1300'),
  ('1303','Prepaid Rent 6320 Canoga','asset','DEBIT',TRUE,FALSE,'1300'),
  ('1304','Deposits','asset','DEBIT',TRUE,FALSE,'1300'),
  ('1305','Deposit Warehouse','asset','DEBIT',TRUE,FALSE,'1300'),
  ('1306','Lease Deposit 6320 Canoga','asset','DEBIT',TRUE,FALSE,'1300'),
  ('1307','Rent Deposit','asset','DEBIT',TRUE,FALSE,'1300'),
  ('1400','Other Current Assets','asset','DEBIT',FALSE,FALSE,NULL),
  ('1401','Disputed Chargebacks - Ross','asset','DEBIT',TRUE,FALSE,'1400'),
  ('1402','Disputed Credit Card Charges','asset','DEBIT',TRUE,FALSE,'1400'),
  ('1403','Employee Retention Credits Receivable','asset','DEBIT',TRUE,FALSE,'1400'),
  ('1405','Repayment','asset','DEBIT',TRUE,FALSE,'1400'),
  ('1406','Uncategorized Asset','asset','DEBIT',TRUE,FALSE,'1400'),
  ('1407','Operating Lease Right of Use','asset','DEBIT',TRUE,FALSE,'1400'),
  ('1408','Payroll Asset','asset','DEBIT',TRUE,FALSE,'1400'),
  ('1409','Payroll Service Customer Asset','asset','DEBIT',TRUE,FALSE,'1400'),
  ('1450','Loan Receivable','asset','DEBIT',FALSE,FALSE,NULL),
  ('1451','Loan Receivable - Ophir','asset','DEBIT',TRUE,FALSE,'1450'),
  ('1452','Loan Receivable - SAG','asset','DEBIT',TRUE,FALSE,'1450'),
  ('1453','Notes Receivable - Isaac Bitton','asset','DEBIT',TRUE,FALSE,'1450'),
  ('1454','Notes Receivable - Josefina Hig','asset','DEBIT',TRUE,FALSE,'1450'),
  ('1455','Notes Receivable Noize (Love Gen)','asset','DEBIT',TRUE,FALSE,'1450'),
  ('1500','Fixed Assets','asset','DEBIT',FALSE,FALSE,NULL),
  ('1501','2014 Range Rover SUV','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1502','Porsche Taycan 2024','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1503','7800 Airport Business Parkway','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1504','Computers','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1505','Computer Equipment - CC Rtechs','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1506','Computer Software (Asset)','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1507','Equipment','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1508','Equip -  Panasonic Phone System','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1509','Equip - Copier Minolta 2510','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1510','Equip - FS-10A SERIAL #1635SC (','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1511','Equip - Wacom Intuos4 Tablet 1','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1512','Equip - Wacom Intuos4 Tablet 2','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1513','Equip-Color Spectrum Sep 2015','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1514','Equipment - Genius PenSketch','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1515','Equipment - HannsG Monitor - 1','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1516','Equipment - HannsG Monitor - 2','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1517','Equipment - MacBook 13','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1518','Equipment - MPro QC2 -1','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1519','Equipment - MPro QC2 -2','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1520','Equipment-4TB WD Sharespace','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1521','Furniture','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1522','Store Fixtures','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1590','Accumulated Depreciation - Equi','asset','DEBIT',TRUE,FALSE,'1500'),
  ('1600','Intangible & Other Assets','asset','DEBIT',FALSE,FALSE,NULL),
  ('1601','PT Trademark','asset','DEBIT',TRUE,FALSE,'1600'),
  ('1602','Ring of Fire Domain','asset','DEBIT',TRUE,FALSE,'1600'),
  ('2000','Accounts Payable (A/P)','liability','CREDIT',TRUE,TRUE,NULL),
  ('2001','Deffered Accounts Payables','liability','CREDIT',TRUE,FALSE,NULL),
  ('2010','Accrued liabilities','liability','CREDIT',TRUE,FALSE,NULL),
  ('2011','Accrued Expense - Bonus','liability','CREDIT',TRUE,FALSE,NULL),
  ('2012','Bonus Expense Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2013','Accrued Legal Settlement','liability','CREDIT',TRUE,FALSE,NULL),
  ('2014','Commisions Payable Molly Levitt','liability','CREDIT',TRUE,FALSE,NULL),
  ('2015','Shipping Accrual','liability','CREDIT',TRUE,FALSE,NULL),
  ('2020','Cash overdraft','liability','CREDIT',TRUE,FALSE,NULL),
  ('2021','Suspense','liability','CREDIT',TRUE,FALSE,NULL),
  ('2100','Credit Cards','liability','CREDIT',FALSE,FALSE,NULL),
  ('2101','Amex - Hilton Honors','liability','CREDIT',TRUE,FALSE,'2100'),
  ('2102','Amex Eran Bitton','liability','CREDIT',TRUE,FALSE,'2100'),
  ('2103','Amex Isaac Bitton','liability','CREDIT',TRUE,FALSE,'2100'),
  ('2104','Amex Platinum - 1007','liability','CREDIT',TRUE,FALSE,'2100'),
  ('2105','Chase Business Card','liability','CREDIT',TRUE,FALSE,'2100'),
  ('2106','Chase Marriott New','liability','CREDIT',TRUE,FALSE,'2100'),
  ('2107','Chase Preferred - Eran Bitton','liability','CREDIT',TRUE,FALSE,'2100'),
  ('2108','Credit Card at Chase United 31','liability','CREDIT',TRUE,FALSE,'2100'),
  ('2200','Customer Deposits','liability','CREDIT',TRUE,FALSE,NULL),
  ('2201','Unearned Revenue','liability','CREDIT',TRUE,FALSE,NULL),
  ('2250','Due to 100 Walnut LLC','liability','CREDIT',TRUE,FALSE,NULL),
  ('2251','Due to Affiliates','liability','CREDIT',TRUE,FALSE,NULL),
  ('2300','Sales Tax Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2301','Sales Tax (Posted to Sales)','liability','CREDIT',TRUE,FALSE,NULL),
  ('2302','New York Tax Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2303','Tax Expense Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2304','DNK Tax Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2305','DNK Tax Suspense','liability','CREDIT',TRUE,FALSE,NULL),
  ('2306','EU Tax Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2307','EU Tax Suspense','liability','CREDIT',TRUE,FALSE,NULL),
  ('2308','GBR Tax Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2309','GBR Tax Suspense','liability','CREDIT',TRUE,FALSE,NULL),
  ('2310','ITA Tax Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2311','ITA Tax Suspense','liability','CREDIT',TRUE,FALSE,NULL),
  ('2312','SWE Tax Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2313','SWE Tax Suspense','liability','CREDIT',TRUE,FALSE,NULL),
  ('2314','US Tax Payable','liability','CREDIT',TRUE,FALSE,NULL),
  ('2315','US Tax Suspense','liability','CREDIT',TRUE,FALSE,NULL),
  ('2400','Payroll Liabilities','liability','CREDIT',FALSE,FALSE,NULL),
  ('2401','Payroll Payable','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2402','Direct Deposit Liabilities','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2403','Direct Deposit Payable','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2404','Accrued vacation','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2405','CA PIT / SDI','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2406','CA SUI / ETT','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2407','Federal Taxes (941/944)','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2408','Federal Unemployment (940)','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2409','Pre-tax Medical','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2410','CArmando CS #0370024521497','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2411','Case#55261647','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2412','Franchise Tax Board Garnishment','liability','CREDIT',TRUE,FALSE,'2400'),
  ('2450','Inventory Offset Account','liability','CREDIT',TRUE,FALSE,NULL),
  ('2451','Current Portion Operating Lease','liability','CREDIT',TRUE,FALSE,NULL),
  ('2452','Automobile Note Payable - Current','liability','CREDIT',TRUE,FALSE,NULL),
  ('2500','Loans','liability','CREDIT',FALSE,FALSE,NULL),
  ('2501','Loan Payable - 100 Walnut LLC','liability','CREDIT',TRUE,FALSE,'2500'),
  ('2502','Loan Payable - EB Parkway LLC.','liability','CREDIT',TRUE,FALSE,'2500'),
  ('2503','Loan Payable - Ophir Bitton','liability','CREDIT',TRUE,FALSE,'2500'),
  ('2504','Loan Payable - Syndicated Appar','liability','CREDIT',TRUE,FALSE,'2500'),
  ('2505','Notes Payable - 2253 Apparel','liability','CREDIT',TRUE,FALSE,'2500'),
  ('2506','Notes Payable - Eran Bitton','liability','CREDIT',TRUE,FALSE,'2500'),
  ('2507','Notes Payable - Isaac Bitton','liability','CREDIT',TRUE,FALSE,'2500'),
  ('2700','Long-Term Liabilities','liability','CREDIT',FALSE,FALSE,NULL),
  ('2701','Automobile Note Payable - Long-Term','liability','CREDIT',TRUE,FALSE,'2700'),
  ('2702','Long Term Operating Lease','liability','CREDIT',TRUE,FALSE,'2700'),
  ('2703','Loan Payable - Olive Tree Ventu','liability','CREDIT',TRUE,FALSE,'2700'),
  ('2800','SBA & Disaster','liability','CREDIT',FALSE,FALSE,NULL),
  ('2801','Payroll Protection Plan Loan','liability','CREDIT',TRUE,FALSE,'2800'),
  ('2802','Payroll Protection Plan Loan 2','liability','CREDIT',TRUE,FALSE,'2800'),
  ('2803','U.S. Small Business Administrat','liability','CREDIT',FALSE,FALSE,'2800'),
  ('2804','Accrued interest - SBA loan','liability','CREDIT',TRUE,FALSE,'2803'),
  ('3000','Eran Bitton - Capital Account','equity','CREDIT',TRUE,FALSE,NULL),
  ('3001','Eran Bitton - Distribution','equity','CREDIT',TRUE,FALSE,NULL),
  ('3002','Isaac Bitton - Capital Account','equity','CREDIT',TRUE,FALSE,NULL),
  ('3003','Isaac Bitton - Distribution Acc','equity','CREDIT',TRUE,FALSE,NULL),
  ('3004','Opening Balance Equity','equity','CREDIT',TRUE,FALSE,NULL),
  ('3900','Retained Earnings','equity','CREDIT',TRUE,FALSE,NULL),
  ('4000','Revenue','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4001','*Uncategorized Income','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4002','Other Income','revenue','CREDIT',FALSE,FALSE,NULL),
  ('4003','Other Income Detail','revenue','CREDIT',TRUE,FALSE,'4002'),
  ('4004','Billable Expense Income','revenue','CREDIT',TRUE,FALSE,'4002'),
  ('4005','Sales Revenue ROF Brands','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4006','Sales Revenue - Boys','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4007','Sales Revenue - Consignment','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4008','Sales Revenue - PT Ecom','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4009','Sales Revenue - PT','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4010','Sales Revenue - Samples','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4011','Sales Revenue - ROF Ecom','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4012','Sales Revenue Private Label','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4015','Shipping income - web','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4016','Shipping income - wholesale','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4017','Unapplied Cash Payment Income','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4018','Uncategorized Income','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4200','Dilution','contra_revenue','DEBIT',FALSE,FALSE,NULL),
  ('4201','Sales Returns Private Label','contra_revenue','DEBIT',TRUE,FALSE,NULL),
  ('4202','Burlington - Defective Allow.','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4203','Chargeback reserve','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4204','Chargebacks  - DDs Discounts','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4205','Chargebacks -  Gabriel Bros','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4206','Chargebacks  - Red Sail Sports','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4207','Chargebacks - Backstage','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4208','Chargebacks - Bealls','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4209','Chargebacks - Belk','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4210','Chargebacks - Buckle Brands','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4211','Chargebacks - Buffalo Exchange','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4212','Chargebacks - Burlington','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4213','Chargebacks - Dds','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4214','Chargebacks - Fashion Nova','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4215','Chargebacks - Heritage Surf','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4217','Chargebacks - Macy''s 491','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4218','Chargebacks - Macy''s Freight','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4219','Chargebacks - Marshalls','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4220','Chargebacks - Navy Exchange','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4221','Chargebacks - Ross','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4222','Chargebacks - Rue 21','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4223','Chargebacks - Tillys','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4224','Chargebacks - TJ Maxx','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4225','Chargebacks - Winner','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4226','Chargebacks Bealls 2% Allow.','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4227','Chargebacks pending (EOY accrua','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4229','Sales Allowances - Boys 491','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4230','Sales Discount','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4231','Sales Discounts - Boys','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4232','Sales Discounts - PT','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4233','Sales Returns Allowance 491','contra_revenue','DEBIT',TRUE,FALSE,'4200'),
  ('4234','Sales Returns Boys','contra_revenue','DEBIT',TRUE,FALSE,NULL),
  ('4235','Sales Returns - PT','contra_revenue','DEBIT',TRUE,FALSE,NULL),
  ('4236','Sales Returns ROF Brands','contra_revenue','DEBIT',TRUE,FALSE,NULL),
  ('4237','Faire Fees','contra_revenue','DEBIT',TRUE,FALSE,NULL),
  ('4238','FashiongoFees','contra_revenue','DEBIT',TRUE,FALSE,NULL),
  ('4239','Sales Discounts - Ecom','contra_revenue','DEBIT',TRUE,FALSE,NULL),
  ('4900','Exchange Rate Gain/Loss','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4901','Forgiveness of Debt','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4902','Gain on debt forgiveness','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4903','Gain/loss-fixed assets dispos.','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4904','Other income/expense','revenue','CREDIT',TRUE,FALSE,NULL),
  ('4905','Shipping Income','revenue','CREDIT',TRUE,FALSE,NULL),
  ('5000','COGS','expense','DEBIT',FALSE,FALSE,NULL),
  ('5001','*Cost of Goods Sold','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5002','COGS Returns Allowance - 491','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5003','Inventory count/perpetual adj','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5004','Inventory markdowns','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5005','Vendor Discount','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5006','Disassemble Offset Account','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5010','Cost of Goods Sold ROF Brands','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5011','Cost of Goods Sold Boys','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5012','Cost of Goods Sold PT','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5013','Cost of Goods Sold - Ecom PT','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5014','Cost of Goods Sold Website','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5015','Cost of Goods Sold Private Label','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5016','Cost of Goods Sold Accessories','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5017','Cost of Goods Sold Wovens','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5018','Cost of Goods Sold Consignment','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5020','Manufacturing Expense Clearing','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5021','Purchases','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5022','Macys Private Label Tickets','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5023','Ross Price Tickets','expense','DEBIT',TRUE,FALSE,'5000'),
  ('5100','Cost of Sales','expense','DEBIT',FALSE,FALSE,NULL),
  ('5101','Amazon FBA fees','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5102','Amazon other fees','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5103','Amazon selling fees','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5104','Commission Expense','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5105','Commissions Expense - Patrica T','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5106','Payroll Expenses{331}','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5107','Walmart Analytics Expense','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5108','Walmart fulfillment fees','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5109','Walmart selling commissions','expense','DEBIT',TRUE,FALSE,'5100'),
  ('5200','Design and Production','expense','DEBIT',FALSE,FALSE,NULL),
  ('5201','Art & Photo Copyright Expense','expense','DEBIT',TRUE,FALSE,'5200'),
  ('5202','Design Expense - Freelance','expense','DEBIT',TRUE,FALSE,'5200'),
  ('5203','Fit Model Expense','expense','DEBIT',TRUE,FALSE,'5200'),
  ('5204','Inspections Expense','expense','DEBIT',TRUE,FALSE,'5200'),
  ('5205','Merchandising Expense - Freelan','expense','DEBIT',TRUE,FALSE,'5200'),
  ('5206','Samples Expense','expense','DEBIT',TRUE,FALSE,'5200'),
  ('5207','Testing (Garment) Expense','expense','DEBIT',TRUE,FALSE,'5200'),
  ('5208','Macys Testing Expense','expense','DEBIT',TRUE,FALSE,'5200'),
  ('5300','Early AR Payment Charges','expense','DEBIT',FALSE,FALSE,NULL),
  ('5301','Bank Financing DISC. Charges-JP','expense','DEBIT',TRUE,FALSE,'5300'),
  ('5302','Macy''s Early Payment - C2FO','expense','DEBIT',TRUE,FALSE,'5300'),
  ('5400','Freight Expenses','expense','DEBIT',FALSE,FALSE,NULL),
  ('5401','Freight Expense','expense','DEBIT',TRUE,FALSE,'5400'),
  ('5402','Freight In Expense','expense','DEBIT',TRUE,FALSE,'5400'),
  ('5403','Freight Out Expense','expense','DEBIT',TRUE,FALSE,'5400'),
  ('5404','Freight Surcharge Expense','expense','DEBIT',TRUE,FALSE,'5400'),
  ('5405','Shipping Expense','expense','DEBIT',TRUE,FALSE,'5400'),
  ('6100','Payroll','expense','DEBIT',FALSE,FALSE,NULL),
  ('6101','Payroll Expenses','expense','DEBIT',FALSE,FALSE,NULL),
  ('6102','Employee Release Payment Expens','expense','DEBIT',TRUE,FALSE,'6101'),
  ('6103','Taxes','expense','DEBIT',TRUE,FALSE,'6101'),
  ('6104','Wages','expense','DEBIT',TRUE,FALSE,'6101'),
  ('6105','Bonus Expense','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6106','Consulting Expense','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6107','Consulting Expense - Planner','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6108','Consulting Fee - CB Specialist','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6109','Covid 19 Hours','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6110','Employee Child Care Expense','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6111','Guaranteed Payments - Eran Bitt','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6112','Payroll Charged to SAG','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6113','Payroll Expense','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6114','Payroll Expense - Double time','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6115','Payroll Expense - Hourly','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6116','Payroll Expense - Overtime','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6117','Payroll Expense - Paid Holidays','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6118','Payroll Expense - Personal Day','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6119','Payroll Expense - Salaries','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6120','Payroll Expense - Sick','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6121','Payroll Expense - Temp Employee','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6122','Payroll Expense - Temps Charged','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6123','Payroll Expense - Vacation','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6124','Payroll Service Expense','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6125','Payroll Tax Expense','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6126','Payroll Tax Expense{90}','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6127','Sales Commissions - Meredith Le','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6128','Severance Pay','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6129','*Payroll Expenses','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6130','Contractors','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6131','New York Unemployment Expense','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6132','Payroll processing fees','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6133','Sales Commission - Right On Surf  Rus Castro','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6134','Sales Commission - Spencer Lem','expense','DEBIT',TRUE,FALSE,'6100'),
  ('6300','General and Administrative','expense','DEBIT',FALSE,FALSE,NULL),
  ('6301','Accounting Service Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6302','Accounting Software Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6303','Air Fare Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6304','Auto Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6305','Bad Debt Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6306','Bank Charges & Fees','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6307','Business License Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6308','Car & Truck','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6309','Charitable Contributions','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6310','Cleaning and Maintenance Expens','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6311','Computer Consulting Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6312','Computer Hardware Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6313','Computer Maintenance Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6314','Computer Software','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6315','Container Rental Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6317','Credit Card Annual Fees Exp','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6318','Credit Card Processing Fees QB','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6319','Depreciation Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6321','Design Supplies','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6322','dues & subscriptions - 365 xch','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6323','Dues & subscriptions - Adobe','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6325','Dues and Subscriptions','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6326','EDI Processing Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6327','Equipment Rental','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6328','Finance Charges','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6329','Fines and Penalties Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6332','Hotel Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6334','Insurance','expense','DEBIT',FALSE,FALSE,'6300'),
  ('6335','Auto Insurance','expense','DEBIT',TRUE,FALSE,'6334'),
  ('6336','E&O','expense','DEBIT',TRUE,FALSE,'6334'),
  ('6337','General Liability Insurance','expense','DEBIT',TRUE,FALSE,'6334'),
  ('6338','Medical Insurance Expense','expense','DEBIT',TRUE,FALSE,'6334'),
  ('6339','Workers'' Comp Insurance','expense','DEBIT',TRUE,FALSE,'6334'),
  ('6340','Interest Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6341','Interest Paid','expense','DEBIT',FALSE,FALSE,'6300'),
  ('6342','Interest expense - SBA loan','expense','DEBIT',TRUE,FALSE,'6341'),
  ('6343','Inventory Adjustments Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6344','Legal & Professional Services','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6345','Legal Settlement Exp.','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6346','Licenses & Fees Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6348','Logistics Warehouse Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6349','Meals & Entertainment','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6350','Miscellaneous Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6351','Miscellaneous Expense - Travel','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6352','Mobile Phone Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6353','Office Equipment','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6354','Office Supplies Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6355','Phone Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6356','Postage Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6357','Promotional Items','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6358','Promotional Items  - Psycho Tun','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6359','Property Tax Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6360','Rent Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6361','Rent Expense - Unit A','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6363','Rent Warehouse','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6364','Repairs & Maintenance','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6367','Software Development Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6368','Storage Container Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6369','Tax Expense ROF LLC','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6370','Travel','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6371','UPC Codes Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6372','Warehouse Equipment Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6374','Warehouse Supplies Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6377','Xoro Development Cost','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6378','Xoro Subscription','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6379','3 PL Fulfillment','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6380','AI Subscription Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6381','Employee Break Room Supplies Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6382','Internet Service Provider','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6384','Merchant deposit fees','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6385','Outsourced Accounting Services  Expense','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6386','Taxes & Licenses','expense','DEBIT',TRUE,FALSE,'6300'),
  ('6600','Advertising and Promotions','expense','DEBIT',FALSE,FALSE,NULL),
  ('6601','Advertising & Marketing','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6603','Photo Equipment Expense','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6604','Promotional Events Expense','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6605','Promotional Items Expense','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6606','Trade Show - Project Mens LV','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6607','Trade Show Booth - Outdoor Reta','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6608','Trade Show Booth - Surf Expo','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6609','Trade Show Booth - Swim Show','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6611','Trade Show Booth Storage SAG','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6614','Meta Platforms Advertising','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6616','Trade Show Personnel Expense','expense','DEBIT',TRUE,FALSE,'6600'),
  ('6700','Website and E-commerce','expense','DEBIT',FALSE,FALSE,NULL),
  ('6701','Amazon fees','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6702','Freight Out Expense Website','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6703','Monthly Fees  - Fashion Go','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6704','Photo Service Expense','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6705','Shopify Transaction Charges','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6706','Walmart WFA storage Fees','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6709','Web Hosting Expense','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6710','Web Photo Expense PT','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6711','Website Advertising Expense','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6712','Website Advertising Facebook','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6713','Website Advertising Google','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6714','Website CC Chargebacks','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6715','Website Credit Card Processing','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6716','Website Design Expense','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6718','Website Hosting Shopfiy','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6719','Website Model Expense','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6720','Website Shipping stamps.com','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6721','Website Shipping USPS','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6723','Website Ad Creation Expense','expense','DEBIT',TRUE,FALSE,'6700'),
  ('6800','Factoring Expenses','expense','DEBIT',FALSE,FALSE,NULL),
  ('6801','Factor Audit Expense','expense','DEBIT',TRUE,FALSE,'6800'),
  ('6802','Factor Commissions Expense','expense','DEBIT',TRUE,FALSE,'6800'),
  ('6803','Factor Exp - Other','expense','DEBIT',TRUE,FALSE,'6800'),
  ('6804','Factor Interest Expense','expense','DEBIT',TRUE,FALSE,'6800'),
  ('6805','Factor OA Interest Expense','expense','DEBIT',TRUE,FALSE,'6800'),
  ('7000','Payroll - Psycho Tuna','expense','DEBIT',FALSE,FALSE,NULL),
  ('7100','Psycho Tuna','expense','DEBIT',FALSE,FALSE,NULL),
  ('7101','PT - contract labor','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7102','PT - Dues','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7103','PT - entertainment','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7104','PT - freight','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7105','PT - lodging','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7106','PT - logistics','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7107','PT - marketing','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7108','PT - meals','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7109','PT - office expenses','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7110','PT - photography','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7111','PT - postage and shipping','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7112','PT - promotional','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7113','PT - repairs and maintenance','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7114','PT - samples','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7115','PT - selling expenses','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7116','PT - software','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7117','PT - sourcing','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7118','PT - Sponsorship','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7119','PT - tradeshow','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7120','PT - travel','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7121','PT - warehouse supplies','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7122','PT Samples Expense','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7124','PT - Trade Show - Outdoor Retailer','expense','DEBIT',TRUE,FALSE,'7100'),
  ('7125','PT - Trade Show Booth - Surf Expo','expense','DEBIT',TRUE,FALSE,'7100'),
  ('8000','Other Miscellaneous Expense','expense','DEBIT',FALSE,FALSE,NULL),
  ('8001','Penny Rounding Adjustments','expense','DEBIT',TRUE,FALSE,'8000'),
  ('8002','Reconciliation Discrepancies','expense','DEBIT',TRUE,FALSE,'8000'),
  ('8003','*Reconciliation Discrepancies','expense','DEBIT',TRUE,FALSE,'8000'),
  ('8004','Ask My Accountant','expense','DEBIT',TRUE,FALSE,'8000'),
  ('8005','Other Business Expenses','expense','DEBIT',TRUE,FALSE,'8000'),
  ('8006','Unapplied Cash Bill Payment Exp','expense','DEBIT',TRUE,FALSE,'8000'),
  ('8007','Uncategorized Expense','expense','DEBIT',TRUE,FALSE,'8000'),
  ('8008','Uncategorized Expenses','expense','DEBIT',TRUE,FALSE,'8000');

DO $regroup$
DECLARE
  v_rof uuid := (SELECT id FROM entities WHERE code='ROF');
  v_checking_updated int;
  v_staged int;
  v_referenced int;
  v_remaining_parked int;
  v_bad_parent int;
  v_final_count int;
  v_dup int;
  v_default_missing int;
BEGIN
  IF v_rof IS NULL THEN
    RAISE EXCEPTION 'ROF entity not found';
  END IF;

  SELECT count(*) INTO v_staged FROM coa_new;
  IF v_staged <> 447 THEN
    RAISE EXCEPTION 'staging expected 447 rows, got %', v_staged;
  END IF;

  -- Idempotency guard for from-scratch rebuilds / accidental re-runs:
  -- if the regroup already ran (no 'Checking 7801' left and reused 1001 exists), skip.
  IF NOT EXISTS (SELECT 1 FROM gl_accounts WHERE entity_id = v_rof AND name = 'Checking 7801')
     AND EXISTS (SELECT 1 FROM gl_accounts WHERE entity_id = v_rof AND code = '1001' AND name = 'Valley Bank  7801 Main') THEN
    RAISE NOTICE 'COA regroup already applied (1001 reused, no Checking 7801) - skipping.';
    RETURN;
  END IF;

  -- 2. Park colliding codes (everything except the 2 kept-as-is + Checking which is reused).
  UPDATE gl_accounts
     SET code = '~OLD~' || id::text
   WHERE entity_id = v_rof
     AND name NOT IN ('Sales Commissions Expense','PO Variance Expense');

  -- 3. Reuse the posted 'Checking 7801' account as the new 1001.
  UPDATE gl_accounts
     SET code = '1001',
         name = 'Valley Bank  7801 Main',
         account_type = 'asset',
         normal_balance = 'DEBIT',
         is_postable = true,
         is_control = false
   WHERE entity_id = v_rof
     AND name = 'Checking 7801';
  GET DIAGNOSTICS v_checking_updated = ROW_COUNT;
  IF v_checking_updated <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 Checking 7801 to reuse as 1001, updated %', v_checking_updated;
  END IF;

  -- 4. Insert every staged row except 1001 (already reused above).
  INSERT INTO gl_accounts(id,entity_id,code,name,account_type,normal_balance,is_postable,is_control,status)
  SELECT gen_random_uuid(), v_rof, code, name, account_type, normal_balance, is_postable, is_control, 'active'
    FROM coa_new
   WHERE code <> '1001';

  -- 5. Hard-delete unreferenced parked orphans (those with no journal_entry_lines).
  DELETE FROM gl_accounts ga
   WHERE ga.entity_id = v_rof
     AND ga.code LIKE '~OLD~%'
     AND NOT EXISTS (SELECT 1 FROM journal_entry_lines jel WHERE jel.account_id = ga.id);

  -- 6. Resolve parents for inserted rows + the reused 1001 (parent 1000).
  UPDATE gl_accounts ga
     SET parent_account_id = p.id
    FROM coa_new cn
    JOIN gl_accounts p ON p.entity_id = v_rof AND p.code = cn.parent_code
   WHERE ga.entity_id = v_rof
     AND ga.code = cn.code
     AND cn.parent_code IS NOT NULL
     AND cn.parent_code <> '';

  -- 7. Repoint entity defaults.
  UPDATE entities e SET
      default_ar_account_id                = (SELECT id FROM gl_accounts WHERE entity_id=v_rof AND code='1101'),
      default_ap_account_id                = (SELECT id FROM gl_accounts WHERE entity_id=v_rof AND code='2000'),
      default_bank_account_id              = (SELECT id FROM gl_accounts WHERE entity_id=v_rof AND code='1001'),
      default_revenue_account_id           = (SELECT id FROM gl_accounts WHERE entity_id=v_rof AND code='4000'),
      default_cogs_account_id              = (SELECT id FROM gl_accounts WHERE entity_id=v_rof AND code='5000'),
      default_inventory_account_id         = (SELECT id FROM gl_accounts WHERE entity_id=v_rof AND code='1201'),
      default_retained_earnings_account_id = (SELECT id FROM gl_accounts WHERE entity_id=v_rof AND code='3900')
   WHERE e.id = v_rof;

  -- 8. ASSERTIONS (any RAISE rolls back the whole transaction).

  -- (a) No remaining parked rows.
  SELECT count(*) INTO v_remaining_parked FROM gl_accounts WHERE entity_id=v_rof AND code LIKE '~OLD~%';
  IF v_remaining_parked <> 0 THEN
    RAISE EXCEPTION 'assertion (a) failed: % parked ~OLD~ rows remain', v_remaining_parked;
  END IF;

  -- (b) All 3 posted accounts still exist and still own their journal_entry_lines (3 distinct referenced accounts).
  SELECT count(DISTINCT jel.account_id) INTO v_referenced
    FROM journal_entry_lines jel
    JOIN gl_accounts ga ON ga.id = jel.account_id
   WHERE ga.entity_id = v_rof;
  IF v_referenced <> 3 THEN
    RAISE EXCEPTION 'assertion (b) failed: distinct referenced accounts = %, expected 3', v_referenced;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_accounts WHERE entity_id=v_rof AND code='1001' AND name='Valley Bank  7801 Main') THEN
    RAISE EXCEPTION 'assertion (b) failed: reused 1001 (Checking 7801) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_accounts WHERE entity_id=v_rof AND code='6210' AND name='Sales Commissions Expense') THEN
    RAISE EXCEPTION 'assertion (b) failed: 6210 Sales Commissions Expense missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl_accounts WHERE entity_id=v_rof AND code='6320' AND name='PO Variance Expense') THEN
    RAISE EXCEPTION 'assertion (b) failed: 6320 PO Variance Expense missing';
  END IF;

  -- (c) No account has a non-resolvable intended parent.
  SELECT count(*) INTO v_bad_parent
    FROM coa_new cn
   WHERE cn.parent_code IS NOT NULL AND cn.parent_code <> ''
     AND NOT EXISTS (SELECT 1 FROM gl_accounts WHERE entity_id=v_rof AND code=cn.parent_code);
  IF v_bad_parent <> 0 THEN
    RAISE EXCEPTION 'assertion (c) failed: % staged rows have non-resolvable parent_code', v_bad_parent;
  END IF;
  SELECT count(*) INTO v_bad_parent
    FROM gl_accounts ga
    JOIN coa_new cn ON cn.code = ga.code
   WHERE ga.entity_id = v_rof
     AND cn.parent_code IS NOT NULL AND cn.parent_code <> ''
     AND ga.parent_account_id IS NULL;
  IF v_bad_parent <> 0 THEN
    RAISE EXCEPTION 'assertion (c) failed: % accounts with intended parent have NULL parent_account_id', v_bad_parent;
  END IF;

  -- (d) All 7 entity defaults non-null and reference existing ROF accounts.
  SELECT
    (CASE WHEN default_ar_account_id IS NULL OR NOT EXISTS(SELECT 1 FROM gl_accounts WHERE id=default_ar_account_id AND entity_id=v_rof) THEN 1 ELSE 0 END) +
    (CASE WHEN default_ap_account_id IS NULL OR NOT EXISTS(SELECT 1 FROM gl_accounts WHERE id=default_ap_account_id AND entity_id=v_rof) THEN 1 ELSE 0 END) +
    (CASE WHEN default_bank_account_id IS NULL OR NOT EXISTS(SELECT 1 FROM gl_accounts WHERE id=default_bank_account_id AND entity_id=v_rof) THEN 1 ELSE 0 END) +
    (CASE WHEN default_revenue_account_id IS NULL OR NOT EXISTS(SELECT 1 FROM gl_accounts WHERE id=default_revenue_account_id AND entity_id=v_rof) THEN 1 ELSE 0 END) +
    (CASE WHEN default_cogs_account_id IS NULL OR NOT EXISTS(SELECT 1 FROM gl_accounts WHERE id=default_cogs_account_id AND entity_id=v_rof) THEN 1 ELSE 0 END) +
    (CASE WHEN default_inventory_account_id IS NULL OR NOT EXISTS(SELECT 1 FROM gl_accounts WHERE id=default_inventory_account_id AND entity_id=v_rof) THEN 1 ELSE 0 END) +
    (CASE WHEN default_retained_earnings_account_id IS NULL OR NOT EXISTS(SELECT 1 FROM gl_accounts WHERE id=default_retained_earnings_account_id AND entity_id=v_rof) THEN 1 ELSE 0 END)
  INTO v_default_missing
  FROM entities WHERE id = v_rof;
  IF v_default_missing <> 0 THEN
    RAISE EXCEPTION 'assertion (d) failed: % entity default(s) null or dangling', v_default_missing;
  END IF;

  -- (e) No duplicate (entity_id, code) for ROF.
  SELECT count(*) INTO v_dup FROM (
    SELECT code FROM gl_accounts WHERE entity_id=v_rof GROUP BY code HAVING count(*) > 1
  ) d;
  IF v_dup <> 0 THEN
    RAISE EXCEPTION 'assertion (e) failed: % duplicate codes under ROF', v_dup;
  END IF;

  -- (f) Final ROF account count in sane range 446..451.
  SELECT count(*) INTO v_final_count FROM gl_accounts WHERE entity_id=v_rof;
  IF v_final_count NOT BETWEEN 446 AND 451 THEN
    RAISE EXCEPTION 'assertion (f) failed: final ROF account count = % (expected 446..451)', v_final_count;
  END IF;

  RAISE NOTICE 'COA regroup OK: final_count=%, referenced=%, checking_updated=%', v_final_count, v_referenced, v_checking_updated;
END
$regroup$;

COMMIT;
