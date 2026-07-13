-- AP paid-delta watcher hardening (2026-07-12 follow-up to 20260971000000).
--
-- Incident: between 07-11 06:30 and 07-12 06:30 UTC, invoices.total_amount_cents
-- on 2,679 posted register-frozen bills (source 'xoro_bills_register') was
-- rewritten to REST bill-feed line-sums (header-only bills -> 0) during the
-- #1689/#1695 "Xoro account truth" enrichment window. The GL accruals were
-- untouched (GL 2000 stayed correct at $10,061,433.54 CR) but the AP
-- SUBLEDGER open collapsed from tying-to-the-cent to -$67,951.57 — a net
-- $10,129,385.11 header hole. The watcher alerted (2,543 total_changed
-- anomalies) but could not distinguish register-side change (needs a true-up
-- JE) from invoice-side corruption (needs a header restore, NO JE).
-- Headers were restored from ap_bill_register_import.total_cents on
-- 2026-07-12 (data repair, no JEs; paid_amount_cents was verified intact) —
-- GL = subledger again to the cent.
--
-- This migration adds the register-total baseline that lets the watcher
-- tell the two cases apart and AUTO-REPAIR invoice-side header drift.
-- Idempotent: may be applied manually before merge and re-applied by CI.

ALTER TABLE ap_bill_register_import
  ADD COLUMN IF NOT EXISTS total_processed_cents bigint;

COMMENT ON COLUMN ap_bill_register_import.total_processed_cents IS
  'AP paid-delta watcher: register Total Amount (cents) the GL accrual reflects. Register total <> this = register-side change (alert, deltas phase); register total = this but invoices.total_amount_cents differs = invoice-side header corruption (watcher auto-repairs from the register, no JE).';

-- Baseline = current register totals: as of this migration GL 2000
-- ($10,061,433.54 CR) ties the posted-bill subledger to the cent against
-- exactly these values (verified 2026-07-12 after the header restore).
UPDATE ap_bill_register_import
   SET total_processed_cents = total_cents
 WHERE total_processed_cents IS NULL;
