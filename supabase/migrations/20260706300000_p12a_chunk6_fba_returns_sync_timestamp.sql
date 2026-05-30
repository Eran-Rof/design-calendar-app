-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P12a-6 — FBA returns sync timestamp.
--
-- P12a-1 added last_orders_sync_at / last_settlement_sync_at /
-- last_inventory_sync_at to fba_seller_accounts. The returns sync cron
-- needs an analogous column so each account remembers its last successful
-- listReturnRequests window. This chunk adds it (idempotent IF NOT EXISTS).
--
-- Used by api/_lib/marketplaces/fba/sync-returns.js to compute createdAfter
-- = max(last_returns_sync_at, now - 30 days).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE fba_seller_accounts
  ADD COLUMN IF NOT EXISTS last_returns_sync_at timestamptz;

COMMENT ON COLUMN fba_seller_accounts.last_returns_sync_at IS 'P12a-6: most recent listReturnRequests sync window end. NULL on first run → cron clamps to now - 30 days.';

NOTIFY pgrst, 'reload schema';
