-- Stage 4 — re-link subledger cash_je_id to the paying Xoro-mirror JE.
-- One-time PROD data op (FK-only on ar_invoices / invoices; NO GL change).
-- Run from MAIN checkout: node scripts/run-sql-prod.mjs scripts/gl-rebuild/stage4_cash_relink.sql
--
-- KEY (probed 2026-07-13):
--   AR  Invoice Payment txns: each AR-relieving leg carries
--        memo = 'Invoice Ref # <invoice_number>'  (row_seq 0 is the cash leg).
--   AP  Bill Payment txns:    each AP-relieving leg carries
--        memo LIKE '...Bill# <invoice_number> Amount Paid <amt>'.
--   The paying JE is the mirror JE whose source_id = the payment txn_id.
--   Deterministic only: an invoice/bill paid by exactly ONE payment txn is
--   linked; anything paid across >1 txn (single FK can't represent it) is left
--   null and counted.
-- Idempotent (re-run safe): only writes when the value differs.

-- ---- AR ------------------------------------------------------------------
WITH ar_pay AS (
  SELECT trim(regexp_replace(memo,'^Invoice Ref # ','')) AS inv_num, txn_id
  FROM xoro_gl_transactions
  WHERE txn_type_name='Invoice Payment' AND memo LIKE 'Invoice Ref # %'
),
ar_single AS (
  SELECT inv_num, min(txn_id) AS txn_id
  FROM ar_pay GROUP BY inv_num HAVING count(DISTINCT txn_id)=1
),
ar_je AS (
  SELECT s.inv_num, (array_agg(je.id))[1] AS je_id
  FROM ar_single s
  JOIN journal_entries je ON je.source_id=s.txn_id AND je.journal_type='xoro_gl_mirror'
  GROUP BY s.inv_num
)
UPDATE ar_invoices ai
SET cash_je_id = j.je_id
FROM ar_je j
WHERE ai.invoice_number = j.inv_num
  AND ai.cash_je_id IS DISTINCT FROM j.je_id;

-- ---- AP ------------------------------------------------------------------
WITH ap_pay AS (
  SELECT trim(substring(memo from 'Bill#\s*(.+?)\s+Amount Paid')) AS bill_num, txn_id
  FROM xoro_gl_transactions
  WHERE txn_type_name='Bill Payment' AND memo LIKE '%Bill#%'
),
ap_single AS (
  SELECT bill_num, min(txn_id) AS txn_id
  FROM ap_pay WHERE bill_num IS NOT NULL GROUP BY bill_num HAVING count(DISTINCT txn_id)=1
),
ap_je AS (
  SELECT s.bill_num, (array_agg(je.id))[1] AS je_id
  FROM ap_single s
  JOIN journal_entries je ON je.source_id=s.txn_id AND je.journal_type='xoro_gl_mirror'
  GROUP BY s.bill_num
)
UPDATE invoices ap
SET cash_je_id = j.je_id
FROM ap_je j
WHERE ap.invoice_number = j.bill_num
  AND ap.cash_je_id IS DISTINCT FROM j.je_id;

-- ---- Report --------------------------------------------------------------
SELECT jsonb_build_object(
  'ar_total',        (SELECT count(*) FROM ar_invoices),
  'ar_cash_linked',  (SELECT count(*) FROM ar_invoices WHERE cash_je_id IS NOT NULL),
  'ar_cash_null',    (SELECT count(*) FROM ar_invoices WHERE cash_je_id IS NULL),
  'ap_total',        (SELECT count(*) FROM invoices),
  'ap_cash_linked',  (SELECT count(*) FROM invoices WHERE cash_je_id IS NOT NULL),
  'ap_cash_null',    (SELECT count(*) FROM invoices WHERE cash_je_id IS NULL)
) AS v;
