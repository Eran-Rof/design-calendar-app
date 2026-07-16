-- scripts/backfills/shopify_d2c_ar_reconcile.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Shopify D2C AR reconciliation  —  CEO-RUN, OPT-IN.  DO NOT run automatically.
--
-- WHY THIS EXISTS
--   The AR aging read $9.6M. ~$0.74M of that is an ARTIFACT: Shopify D2C ecom
--   orders were backfilled into ar_invoices (from ip_sales_history) as OPEN AR,
--   but D2C is card-paid AT CHECKOUT — the payment was never applied to the
--   invoice, so paid_amount_cents stayed 0 and the invoices age forever. This
--   is a reconciliation gap, NOT collectable AR.
--
-- WHY IT IS NOT AUTO-APPLIED
--   There is NO per-invoice payment record to match deterministically:
--     • shopify_orders has 769 rows, none linked (ar_invoice_id all NULL);
--     • ar_xoro_payment_state covers ~0 of these 13k invoices.
--   The only deterministic fact is "these are the Shopify D2C pseudo-customers,
--   and D2C is paid at checkout." That's a business judgement, so it's left for
--   the CEO to trigger — hence this explicit script rather than a migration.
--
-- WHAT IT DOES  (mirrors the #1754 cash-side pattern, scripts/gl-rebuild/stage5)
--   For every OPEN, paid=0 invoice of the "Shopify …" customers it creates:
--     • one ar_receipts row  — receipt_date = invoice_date (NOT today), amount =
--       the open balance, bank_account_id = 1110 Payment Processor Clearing,
--       method 'credit_card', source 'shopify', source_txn_id =
--       invoice_number, cash_je_id = NULL.
--     • one ar_receipt_applications row applying the full amount. The existing
--       ar_receipt_apps_paid_trg trigger sets paid_amount_cents → invoice PAID.
--   POSTS NOTHING TO THE GL. The Xoro GL mirror already holds the cash; this is
--   purely the AR subledger (receipt + application) so aging stops counting it.
--
-- SAFETY
--   • Deterministic md5 ids + ON CONFLICT DO NOTHING  → idempotent, re-runnable.
--   • Only touches invoices with paid_amount_cents = 0 (never clobbers a real
--     partial payment) whose customer name matches 'Shopify %'.
--   • Wrapped in a single transaction.
--
-- RUN:  node scripts/run-sql-prod.mjs scripts/backfills/shopify_d2c_ar_reconcile.sql
-- To PREVIEW first, run just the SELECT in the "DRY-RUN PREVIEW" block below.
-- ════════════════════════════════════════════════════════════════════════════

-- ── DRY-RUN PREVIEW (safe; run this SELECT alone to see the magnitude) ───────
-- SELECT COUNT(*) AS invoices, SUM(i.total_amount_cents - i.paid_amount_cents) AS clears_cents
-- FROM ar_invoices i JOIN customers c ON c.id = i.customer_id
-- WHERE c.name ILIKE 'Shopify %'
--   AND i.gl_status IN ('posted','posted_historical','partial_paid','sent')
--   AND i.paid_amount_cents = 0
--   AND (i.total_amount_cents - i.paid_amount_cents) > 0
--   -- Xoro-open exclusion: today's full payment-state walk (invoice/getinvoice)
  -- returned Xoro's CURRENT open-invoice universe. Anything it lists as Open
  -- is genuinely open in Xoro — keep it open here too.
--   AND NOT EXISTS (
--     SELECT 1 FROM ar_xoro_payment_state x
--     WHERE x.invoice_number = i.invoice_number
--       AND x.payment_status <> 'Paid'
--       AND x.synced_at > now() - interval '12 hours');

BEGIN;

-- Target set: open, unpaid Shopify D2C invoices.
CREATE TEMP TABLE _shopify_open ON COMMIT DROP AS
SELECT i.id            AS ar_invoice_id,
       i.entity_id,
       i.customer_id,
       i.invoice_number,
       i.invoice_date,
       i.total_amount_cents AS open_cents
FROM ar_invoices i
JOIN customers c ON c.id = i.customer_id
WHERE c.name ILIKE 'Shopify %'
  AND i.gl_status IN ('posted','posted_historical','partial_paid','sent')
  AND i.paid_amount_cents = 0
  AND (i.total_amount_cents - i.paid_amount_cents) > 0
  -- Xoro-open exclusion: today's full payment-state walk (invoice/getinvoice)
  -- returned Xoro's CURRENT open-invoice universe. Anything it lists as Open
  -- is genuinely open in Xoro — keep it open here too.
  AND NOT EXISTS (
    SELECT 1 FROM ar_xoro_payment_state x
    WHERE x.invoice_number = i.invoice_number
      AND x.payment_status <> 'Paid'
      AND x.synced_at > now() - interval '12 hours');

-- Receipts — one per invoice, dated to the invoice (source payment) date.
INSERT INTO ar_receipts
  (id, entity_id, customer_id, receipt_date, amount_cents, bank_account_id,
   customer_payment_method, reference, notes, cash_je_id, source, source_txn_id)
SELECT md5('shopd2c:' || s.ar_invoice_id)::uuid,
       s.entity_id,
       s.customer_id,
       s.invoice_date,
       s.open_cents,
       (SELECT id FROM gl_accounts WHERE code = '1110' ORDER BY id LIMIT 1),  -- Payment Processor Clearing
       'credit_card',
       s.invoice_number,
       'Shopify D2C card payment (checkout) — AR-subledger reconciliation, no GL post',
       NULL,
       'shopify',
       s.invoice_number
FROM _shopify_open s
ON CONFLICT (id) DO NOTHING;

-- Applications — full open amount; trigger maintains ar_invoices.paid_amount_cents.
INSERT INTO ar_receipt_applications
  (id, ar_receipt_id, ar_invoice_id, amount_applied_cents, notes)
SELECT md5('shopd2capp:' || s.ar_invoice_id)::uuid,
       md5('shopd2c:'    || s.ar_invoice_id)::uuid,
       s.ar_invoice_id,
       s.open_cents,
       'Shopify D2C checkout payment reconciliation'
FROM _shopify_open s
JOIN ar_receipts rc ON rc.id = md5('shopd2c:' || s.ar_invoice_id)::uuid
ON CONFLICT (ar_receipt_id, ar_invoice_id) DO NOTHING;

COMMIT;

-- Report (last statement returns via run-sql-prod; uses permanent tables only,
-- since the temp table is dropped at COMMIT).
SELECT COUNT(*)                            AS receipts,
       COALESCE(SUM(amount_cents), 0)      AS reconciled_cents
FROM ar_receipts
WHERE source = 'shopify' AND notes LIKE 'Shopify D2C card payment%';
