-- Stage 5 — AR cash-application subledger backfill (2026-07-14).
-- Derive ar_receipts + ar_receipt_applications FROM the Xoro GL mirror.
-- Posts NOTHING new to the GL: every receipt references the EXISTING mirror
-- JE (journal_entries.source_id = payment txn_id, journal_type='xoro_gl_mirror').
--
--   node scripts/run-sql-prod.mjs scripts/gl-rebuild/stage5_ar_receipts_backfill.sql
--
-- Idempotent: deterministic ids (md5-derived) + ON CONFLICT DO NOTHING, and
-- the exception ledger is DELETE-by-side then re-INSERT. Safe to re-run.
--
-- Rules (mirror src/lib/cashApplication.ts):
--   • Receipt = one Xoro "Invoice Payment" txn. amount = Σ of that txn's
--     'Invoice Ref # <n>' leg magnitudes (all invoice-directed cash).
--   • Application = one 'Invoice Ref # <n>' leg per matched ar_invoice, EXACT
--     invoice-number match only. Per-invoice Σ applied is CLAMPED to the
--     invoice total (ordered by receipt date); excess is PARKED + reported.
--   • Existing NON-ZERO paid_amount that disagrees with the mirror-derived
--     figure is NOT overwritten — those invoices are EXCLUDED and flagged.
--   • Unmatched invoice refs / unresolvable customers / missing mirror JE are
--     parked in cashside_backfill_exceptions (side='AR'), never dropped.
--   • customer_payment_method='other', source='xoro_mirror', bank = Cash
--     Clearing (1020) provenance bucket (the true cash posting is cash_je_id).

BEGIN;

-- ── All invoice-ref legs, collapsed per (txn, invoice_number). ──────────────
CREATE TEMP TABLE _ar_legs ON COMMIT DROP AS
WITH raw AS (
  SELECT txn_id,
         trim(regexp_replace(memo, '^Invoice Ref # ', '')) AS inv_num,
         round(abs(amount_home) * 100)::bigint            AS amt_cents,
         txn_date
  FROM xoro_gl_transactions
  WHERE txn_type_name = 'Invoice Payment'
    AND memo LIKE 'Invoice Ref # %'
    AND trim(regexp_replace(memo, '^Invoice Ref # ', '')) <> ''
)
SELECT txn_id, inv_num, sum(amt_cents) AS amt_cents, min(txn_date) AS txn_date
FROM raw
GROUP BY txn_id, inv_num;

-- ── Per matched invoice: total mirror-applied, invoice total, existing paid. ─
CREATE TEMP TABLE _ar_inv_tot ON COMMIT DROP AS
SELECT i.id                    AS ar_invoice_id,
       i.invoice_number,
       sum(l.amt_cents)        AS applied_sum,
       max(i.total_amount_cents) AS total_cents,
       max(i.paid_amount_cents)  AS existing_paid
FROM _ar_legs l
JOIN ar_invoices i ON i.invoice_number = l.inv_num
GROUP BY i.id, i.invoice_number;

-- Invoices whose existing NON-ZERO paid disagrees with the mirror figure —
-- protected (excluded so the trigger cannot overwrite them). Reported below.
CREATE TEMP TABLE _ar_disagree ON COMMIT DROP AS
SELECT ar_invoice_id, invoice_number, existing_paid, applied_sum, total_cents
FROM _ar_inv_tot
WHERE existing_paid <> 0
  AND existing_paid <> least(applied_sum, total_cents);

-- ── Per-txn receipt header: amount, date, payer, resolved customer, JE. ─────
CREATE TEMP TABLE _ar_receipt ON COMMIT DROP AS
WITH payer AS (
  SELECT txn_id, min(NULLIF(entity_full_name, '')) AS payer_name
  FROM xoro_gl_transactions
  WHERE txn_type_name = 'Invoice Payment'
  GROUP BY txn_id
),
hdr AS (
  SELECT l.txn_id,
         min(l.txn_date)   AS receipt_date,
         sum(l.amt_cents)  AS amount_cents
  FROM _ar_legs l
  GROUP BY l.txn_id
)
SELECT h.txn_id,
       h.receipt_date,
       h.amount_cents,
       COALESCE(
         (SELECT i.customer_id
            FROM _ar_legs l2
            JOIN ar_invoices i ON i.invoice_number = l2.inv_num
           WHERE l2.txn_id = h.txn_id AND i.customer_id IS NOT NULL
           ORDER BY l2.inv_num LIMIT 1),
         (SELECT c.id FROM customers c
           WHERE lower(c.name) = lower(p.payer_name)
             AND c.entity_id = '404b8a6b-0d2d-44d2-8539-9064ff0fafee'::uuid
           LIMIT 1)
       ) AS customer_id,
       (SELECT je.id FROM journal_entries je
         WHERE je.source_id = h.txn_id AND je.journal_type = 'xoro_gl_mirror'
         ORDER BY je.id LIMIT 1) AS mirror_je_id
FROM hdr h
JOIN payer p ON p.txn_id = h.txn_id;

-- ── Clamped applications (excluding protected disagreements). ───────────────
CREATE TEMP TABLE _ar_apps ON COMMIT DROP AS
WITH matched AS (
  SELECT l.txn_id, l.inv_num, l.amt_cents, l.txn_date,
         t.ar_invoice_id, t.total_cents
  FROM _ar_legs l
  JOIN _ar_inv_tot t ON t.invoice_number = l.inv_num
  WHERE t.ar_invoice_id NOT IN (SELECT ar_invoice_id FROM _ar_disagree)
),
alloc AS (
  SELECT m.*,
         COALESCE(sum(m.amt_cents) OVER (
           PARTITION BY m.ar_invoice_id
           ORDER BY m.txn_date, m.txn_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior_sum
  FROM matched m
)
SELECT txn_id, inv_num, ar_invoice_id, amt_cents, total_cents,
       greatest(0, least(amt_cents, total_cents - prior_sum))                 AS applied_cents,
       amt_cents - greatest(0, least(amt_cents, total_cents - prior_sum))     AS parked_cents
FROM alloc;

-- ── INSERT receipts (skip unresolved customer / missing mirror JE). ─────────
INSERT INTO ar_receipts
  (id, entity_id, customer_id, receipt_date, amount_cents, bank_account_id,
   customer_payment_method, reference, notes, cash_je_id, source, source_txn_id)
SELECT md5('arrcpt:' || r.txn_id)::uuid,
       '404b8a6b-0d2d-44d2-8539-9064ff0fafee'::uuid,
       r.customer_id, r.receipt_date, r.amount_cents,
       '4cc82013-fe79-4dbf-adff-dcc39e0869cb'::uuid,   -- Undeposited Funds (1030) GL acct; true cash posting is cash_je_id
       'other',
       'Xoro txn ' || r.txn_id,
       'Mirror-derived AR receipt (cash-side subledger backfill 2026-07-14)',
       r.mirror_je_id, 'xoro_mirror', r.txn_id
FROM _ar_receipt r
WHERE r.customer_id IS NOT NULL AND r.mirror_je_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- ── INSERT applications (only where the parent receipt exists). ─────────────
INSERT INTO ar_receipt_applications
  (id, ar_receipt_id, ar_invoice_id, amount_applied_cents, notes)
SELECT md5('arapp:' || a.txn_id || ':' || a.inv_num)::uuid,
       md5('arrcpt:' || a.txn_id)::uuid,
       a.ar_invoice_id, a.applied_cents,
       'Mirror-derived; leg ' || a.amt_cents || 'c, parked ' || a.parked_cents || 'c'
FROM _ar_apps a
JOIN ar_receipts rc ON rc.id = md5('arrcpt:' || a.txn_id)::uuid
WHERE a.applied_cents > 0
ON CONFLICT (ar_receipt_id, ar_invoice_id) DO NOTHING;

-- ── Exception ledger (idempotent: clear this side, re-insert). ──────────────
DELETE FROM cashside_backfill_exceptions WHERE side = 'AR';

INSERT INTO cashside_backfill_exceptions (side, kind, ref, amount_cents, detail)
SELECT 'AR', 'ar_unmatched_invoice', l.inv_num, sum(l.amt_cents),
       jsonb_build_object('n_txn', count(DISTINCT l.txn_id))
FROM _ar_legs l
LEFT JOIN ar_invoices i ON i.invoice_number = l.inv_num
WHERE i.id IS NULL
GROUP BY l.inv_num;

INSERT INTO cashside_backfill_exceptions (side, kind, ref, amount_cents, detail)
SELECT 'AR', 'ar_over_application', a.inv_num, sum(a.parked_cents),
       jsonb_build_object('invoice_total_cents', max(a.total_cents))
FROM _ar_apps a
WHERE a.parked_cents > 0
GROUP BY a.inv_num;

INSERT INTO cashside_backfill_exceptions (side, kind, ref, amount_cents, detail)
SELECT 'AR', 'ar_paid_disagreement', d.invoice_number, d.existing_paid,
       jsonb_build_object('mirror_applied_cents', d.applied_sum, 'invoice_total_cents', d.total_cents)
FROM _ar_disagree d;

INSERT INTO cashside_backfill_exceptions (side, kind, ref, amount_cents, detail)
SELECT 'AR', 'ar_unresolvable_customer', r.txn_id, r.amount_cents, NULL
FROM _ar_receipt r WHERE r.customer_id IS NULL;

INSERT INTO cashside_backfill_exceptions (side, kind, ref, amount_cents, detail)
SELECT 'AR', 'ar_missing_mirror_je', r.txn_id, r.amount_cents, NULL
FROM _ar_receipt r WHERE r.mirror_je_id IS NULL;

COMMIT;

-- ── Report (last statement returns via run-sql-prod). ──────────────────────
SELECT jsonb_build_object(
  'ar_receipts',            (SELECT count(*) FROM ar_receipts WHERE source = 'xoro_mirror'),
  'ar_receipts_amount_cents', (SELECT COALESCE(sum(amount_cents),0) FROM ar_receipts WHERE source = 'xoro_mirror'),
  'ar_applications',        (SELECT count(*) FROM ar_receipt_applications app JOIN ar_receipts r ON r.id = app.ar_receipt_id WHERE r.source = 'xoro_mirror'),
  'ar_applied_cents',       (SELECT COALESCE(sum(app.amount_applied_cents),0) FROM ar_receipt_applications app JOIN ar_receipts r ON r.id = app.ar_receipt_id WHERE r.source = 'xoro_mirror'),
  'ar_invoices_now_paid',   (SELECT count(*) FROM ar_invoices WHERE paid_amount_cents <> 0),
  'exceptions',             (SELECT COALESCE(jsonb_object_agg(kind, jsonb_build_object('n', n, 'amount_cents', amt)), '{}'::jsonb)
                               FROM (SELECT kind, count(*) n, sum(amount_cents) amt
                                       FROM cashside_backfill_exceptions WHERE side = 'AR' GROUP BY kind) s)
) AS v;
