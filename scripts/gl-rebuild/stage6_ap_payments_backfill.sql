-- Stage 6 — AP cash-payment subledger backfill (2026-07-14).
-- Derive invoice_payments FROM the Xoro GL mirror "Bill Payment" txns. Posts
-- NOTHING new to the GL: every payment references the EXISTING mirror JE.
--
--   node scripts/run-sql-prod.mjs scripts/gl-rebuild/stage6_ap_payments_backfill.sql
--
-- CRITICAL — paid_amount is PRESERVED, not overwritten:
--   invoices.paid_amount_cents already carries BOTH cash bill-payments AND
--   non-cash relief (credit memos, factor settlements, 8007/1308 reclasses).
--   The mirror Bill-Payment legs are the CASH slice only ($34.9M) — LESS than
--   the booked paid ($41.1M). Letting invoice_payments_maintain_paid() recompute
--   paid = Σ(invoice_payments) would DESTROY the non-cash relief and worsen the
--   GL-2000 tie. So the maintain_paid + overpay_guard USER triggers are
--   DISABLED for the insert (RI/FK triggers stay active), and paid_amount is
--   left exactly as booked. invoice_payments becomes a CASH PROVENANCE layer
--   that feeds DPO; it is NOT asserted to equal paid_amount.
--
-- Only legs whose txn HAS a mirror JE are applied (a payment with no mirror JE
-- did NOT relieve GL 2000, so counting it would break the tie). Unmatched
-- bills, missing-JE txns, and the non-cash-relief gap are parked in
-- cashside_backfill_exceptions (side='AP'). Idempotent (deterministic ids +
-- ON CONFLICT DO NOTHING; exceptions DELETE-by-side then re-INSERT).

BEGIN;

-- One payment row per (txn, bill), matched to a vendor bill, with a mirror JE.
CREATE TEMP TABLE _ap_apps ON COMMIT DROP AS
WITH raw AS (
  SELECT txn_id,
         trim(substring(memo from 'Bill#\s*(.+?)\s+Amount Paid')) AS bill_num,
         round(abs(amount_home) * 100)::bigint                    AS amt_cents,
         txn_date
  FROM xoro_gl_transactions
  WHERE txn_type_name = 'Bill Payment' AND memo LIKE '%Bill#%'
),
g AS (
  SELECT txn_id, bill_num, sum(amt_cents) AS amt_cents, min(txn_date) AS txn_date
  FROM raw WHERE bill_num IS NOT NULL AND bill_num <> ''
  GROUP BY txn_id, bill_num
)
SELECT g.txn_id, g.bill_num, g.amt_cents, g.txn_date, i.id AS invoice_id,
       (SELECT je.id FROM journal_entries je
         WHERE je.source_id = g.txn_id AND je.journal_type = 'xoro_gl_mirror'
         ORDER BY je.id LIMIT 1) AS mirror_je_id
FROM g
JOIN invoices i ON i.invoice_number = g.bill_num;

-- Disable the paid-maintenance + overpay USER triggers so existing
-- paid_amount_cents is preserved (FK/RI triggers remain enforced).
ALTER TABLE invoice_payments DISABLE TRIGGER USER;

INSERT INTO invoice_payments
  (id, entity_id, invoice_id, payment_date, amount_cents, bank_account_id,
   method, reference, cash_je_id, notes, source, source_txn_id)
SELECT md5('appay:' || a.txn_id || ':' || a.bill_num)::uuid,
       '404b8a6b-0d2d-44d2-8539-9064ff0fafee'::uuid,
       a.invoice_id, a.txn_date, a.amt_cents,
       '6af4f048-dda4-4ea0-b69e-8551e998218d'::uuid,   -- Cash Clearing (1020) GL acct; true cash posting is cash_je_id
       'wire',
       'Xoro txn ' || a.txn_id,
       a.mirror_je_id,
       'Mirror-derived AP cash payment (cash-side subledger backfill 2026-07-14); paid_amount preserved',
       'xoro_mirror', a.txn_id
FROM _ap_apps a
WHERE a.mirror_je_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

ALTER TABLE invoice_payments ENABLE TRIGGER USER;

-- ── Exception ledger (idempotent). ─────────────────────────────────────────
DELETE FROM cashside_backfill_exceptions WHERE side = 'AP';

INSERT INTO cashside_backfill_exceptions (side, kind, ref, amount_cents, detail)
SELECT 'AP', 'ap_unmatched_bill', r.bill_num, sum(r.amt_cents),
       jsonb_build_object('n_txn', count(DISTINCT r.txn_id))
FROM (
  SELECT txn_id, trim(substring(memo from 'Bill#\s*(.+?)\s+Amount Paid')) AS bill_num,
         round(abs(amount_home) * 100)::bigint AS amt_cents
  FROM xoro_gl_transactions
  WHERE txn_type_name = 'Bill Payment' AND memo LIKE '%Bill#%'
) r
LEFT JOIN invoices i ON i.invoice_number = r.bill_num
WHERE r.bill_num IS NOT NULL AND r.bill_num <> '' AND i.id IS NULL
GROUP BY r.bill_num;

INSERT INTO cashside_backfill_exceptions (side, kind, ref, amount_cents, detail)
SELECT 'AP', 'ap_missing_mirror_je', a.txn_id, sum(a.amt_cents),
       jsonb_build_object('bills', array_agg(DISTINCT a.bill_num))
FROM _ap_apps a
WHERE a.mirror_je_id IS NULL
GROUP BY a.txn_id;

-- Non-cash relief gap: booked paid_amount that the mirror cash legs cannot
-- explain (credit memos / factor / reclasses) — the reason AP 2000 cannot tie
-- by cash application alone. One summary row for CEO review.
INSERT INTO cashside_backfill_exceptions (side, kind, ref, amount_cents, detail)
SELECT 'AP', 'ap_noncash_relief_gap', 'SUMMARY',
       (SELECT COALESCE(sum(paid_amount_cents),0) FROM invoices WHERE gl_status='posted')
         - (SELECT COALESCE(sum(amount_cents),0) FROM invoice_payments WHERE source='xoro_mirror'),
       jsonb_build_object(
         'booked_paid_posted_cents', (SELECT COALESCE(sum(paid_amount_cents),0) FROM invoices WHERE gl_status='posted'),
         'mirror_cash_payments_cents', (SELECT COALESCE(sum(amount_cents),0) FROM invoice_payments WHERE source='xoro_mirror'),
         'note', 'Booked paid exceeds mirrored cash payments by this non-cash relief; AP 2000 residual stays waived pending accountant review.');

COMMIT;

-- ── Report + live AP tie-out numbers (last statement returns). ─────────────
SELECT jsonb_build_object(
  'ap_payments',            (SELECT count(*) FROM invoice_payments WHERE source = 'xoro_mirror'),
  'ap_payments_cents',      (SELECT COALESCE(sum(amount_cents),0) FROM invoice_payments WHERE source = 'xoro_mirror'),
  'ap_bills_with_payment',  (SELECT count(DISTINCT invoice_id) FROM invoice_payments WHERE source = 'xoro_mirror'),
  'gl_2000_net_credit_cents', (SELECT credit_cents - debit_cents FROM v_trial_balance WHERE code='2000' AND basis='ACCRUAL' AND entity_id='404b8a6b-0d2d-44d2-8539-9064ff0fafee'::uuid),
  'ap_subledger_open_cents', (SELECT COALESCE(sum(total_amount_cents - paid_amount_cents),0) FROM invoices WHERE gl_status='posted'),
  'ap_booked_paid_cents',   (SELECT COALESCE(sum(paid_amount_cents),0) FROM invoices WHERE gl_status='posted'),
  'exceptions',             (SELECT COALESCE(jsonb_object_agg(kind, jsonb_build_object('n', n, 'amount_cents', amt)), '{}'::jsonb)
                               FROM (SELECT kind, count(*) n, sum(amount_cents) amt
                                       FROM cashside_backfill_exceptions WHERE side = 'AP' GROUP BY kind) s)
) AS v;
