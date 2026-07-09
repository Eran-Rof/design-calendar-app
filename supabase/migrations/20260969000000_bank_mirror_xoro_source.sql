-- ════════════════════════════════════════════════════════════════════════════
-- Bank reconciliation mirror — allow 'xoro_mirror' as a bank feed source.
--
-- Context: all ROF bank accounts are reconciled IN XORO through 2026-05-31;
-- Plaid is configured but not live. Until the Plaid feed turns on, Tangerine
-- mirrors Xoro's reconciled bank activity (the Payments register staged in
-- ap_payment_import — Xoro's REST API exposes no bank-transaction, deposit,
-- or reconciliation endpoint under any private-app scope we hold; probed
-- 2026-07-08, see scripts/import-xoro-bank-history.mjs header) into the P6
-- bank tables so the recon panel + tie-outs have a bank side to work with.
--
--   1. bank_transactions.source        += 'xoro_mirror'
--   2. bank_accounts.feed_source       += 'xoro_mirror'
--   3. bank_recon_runs.source          NEW — 'manual' (operator-typed runs,
--      the P6 default) vs 'xoro_mirror' (derived by the mirror sync; months
--      through 2026-05-31 are marked reconciled because XORO reconciled
--      them, not because an operator retyped statement balances).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_source_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_source_check
  CHECK (source IN ('plaid','csv_upload','manual','xoro_mirror'));

ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_feed_source_check;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_feed_source_check
  CHECK (feed_source IN ('plaid','csv_upload','manual','xoro_mirror'));

ALTER TABLE bank_recon_runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE bank_recon_runs DROP CONSTRAINT IF EXISTS bank_recon_runs_source_check;
ALTER TABLE bank_recon_runs ADD CONSTRAINT bank_recon_runs_source_check
  CHECK (source IN ('manual','xoro_mirror'));

COMMENT ON COLUMN bank_transactions.source IS 'plaid | csv_upload | manual | xoro_mirror (Xoro Payments-register mirror; Plaid pending go-live)';
COMMENT ON COLUMN bank_recon_runs.source IS 'manual = operator-typed statement balance (P6 flow); xoro_mirror = derived nightly from the Xoro register mirror — months <= 2026-05-31 are Xoro-reconciled';

NOTIFY pgrst, 'reload schema';
