-- 20260992000000_cash_side_subledger_backfill.sql
--
-- Cash-side subledger backfill (2026-07-14). Formal audit gap #2:
--   • ar_receipts had 0 rows → no cash application → no DSO / real AR aging.
--   • AP bill payments existed only inside the Xoro GL mirror, never as
--     invoice_payments rows → AP subledger could not self-prove (tie-out
--     WAIVED as 'pending_payments').
--
-- The cash JEs ALREADY exist in the ledger (journal_type='xoro_gl_mirror',
-- source_id = Xoro payment txn_id). This work derives the SUBLEDGER
-- cash-application records FROM that mirror — posting NOTHING new to the GL.
--
-- This migration is the SCHEMA half (idempotent). The operational data
-- backfill lives in scripts/gl-rebuild/stage5_ar_receipts_backfill.sql and
-- stage6_ap_payments_backfill.sql (run via run-sql-prod, idempotent).
--
-- Single-tenant: entity_id constant is the Ring of Fire entity.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Mirror provenance columns (idempotent). ar_receipts already carries
--    cash_je_id (= the mirror JE) and source; we add the Xoro payment
--    txn_id as the idempotency key. invoice_payments gains both.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE ar_receipts      ADD COLUMN IF NOT EXISTS source_txn_id text;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS source_txn_id text;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN ar_receipts.source_txn_id IS
  'Xoro payment txn_id this mirror-derived receipt was backfilled from (cash-side subledger backfill 2026-07-14). NULL for hand-entered receipts. cash_je_id references the existing mirror JE.';
COMMENT ON COLUMN invoice_payments.source_txn_id IS
  'Xoro Bill Payment txn_id this mirror-derived payment was backfilled from. cash_je_id references the existing mirror JE.';
COMMENT ON COLUMN invoice_payments.source IS
  'Provenance of the payment row: manual | xoro_mirror | plaid_sync | api | system.';

-- Idempotency keys. AR: one receipt per payment txn. AP: one payment per
-- (txn, bill) since a single Bill Payment can relieve several bills.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ar_receipts_source_txn
  ON ar_receipts(entity_id, source_txn_id) WHERE source_txn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_payments_source_txn
  ON invoice_payments(source_txn_id, invoice_id) WHERE source_txn_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Backfill exception ledger — durable, operator-visible record of every
--    thing the deterministic backfill could NOT apply cleanly (unmatched
--    refs, parked over-applications, existing-paid disagreements, missing
--    mirror JEs, unresolvable customers). Populated by the stage5/stage6
--    scripts (DELETE-by-kind then re-INSERT, so re-runs are idempotent).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cashside_backfill_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL DEFAULT '404b8a6b-0d2d-44d2-8539-9064ff0fafee'::uuid,
  side        text NOT NULL,                 -- 'AR' | 'AP'
  kind        text NOT NULL,                 -- see stage5/stage6 headers
  ref         text,                          -- invoice / bill number or txn_id
  amount_cents bigint,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cashside_exc_kind ON cashside_backfill_exceptions(side, kind);

COMMENT ON TABLE cashside_backfill_exceptions IS
  'Parked / unmatched / disagreeing rows from the cash-side subledger backfill. Nothing here was silently dropped — every exception is counted and CEO-reviewable.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. DSO / DPO by month, computed from the now-real application dates.
--    Amount-weighted average days-to-collect (AR) / days-to-pay (AP):
--       weighted_days = Σ(amount × (settle_date − invoice_date)) / Σ(amount)
--    grouped by the month the cash was applied. Voided receipts excluded.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_dso_dpo_monthly AS
WITH base AS (
  SELECT r.entity_id,
         date_trunc('month', r.receipt_date)::date AS month,
         'DSO'::text                                AS metric,
         app.amount_applied_cents::numeric          AS amt,
         (r.receipt_date - i.invoice_date)::numeric AS days
  FROM ar_receipt_applications app
  JOIN ar_receipts r ON r.id = app.ar_receipt_id AND r.is_void = false
  JOIN ar_invoices i ON i.id = app.ar_invoice_id
  WHERE i.invoice_date IS NOT NULL
    AND app.amount_applied_cents > 0
  UNION ALL
  SELECT i.entity_id,
         date_trunc('month', p.payment_date)::date  AS month,
         'DPO'::text                                AS metric,
         p.amount_cents::numeric                    AS amt,
         (p.payment_date - i.invoice_date)::numeric AS days
  FROM invoice_payments p
  JOIN invoices i ON i.id = p.invoice_id
  WHERE i.invoice_date IS NOT NULL
    AND p.amount_cents > 0
)
SELECT entity_id,
       month,
       metric,
       count(*)::bigint AS n_applications,
       sum(amt)::bigint AS total_cents,
       CASE WHEN sum(amt) > 0
            THEN round(sum(amt * days) / sum(amt), 1)
            ELSE 0 END AS weighted_days
FROM base
GROUP BY entity_id, month, metric;

COMMENT ON VIEW v_dso_dpo_monthly IS
  'Monthly amount-weighted DSO (AR receipt applications) and DPO (AP invoice payments), derived from cash-side subledger application dates. Read by /api/internal/recon/dso-dpo.';

COMMIT;
