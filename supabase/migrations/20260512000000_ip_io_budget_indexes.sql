-- Indexes for the planning grid's hot read path.
--
-- Symptom: Supabase IO-budget warning + 57014 statement timeouts on
-- listOpenPos / listItems / listReceipts / listInventorySnapshots
-- during grid builds. Audit confirmed those queries do unfiltered
-- ORDER BY on a date column (or a sinceIso = filter + sort), which
-- without a single-column date index forces a full sequential scan
-- on every fetch. Existing indexes on these tables are compound
-- (sku_id, date) — useful only when sku_id is filtered, which the
-- grid build never does.
--
-- All adds are partial / lean (planner builds only care about open
-- lines or active items), so the index payload stays small. Each
-- CREATE INDEX is IF NOT EXISTS so the migration is idempotent.
--
-- CONCURRENTLY can't run inside a transaction block; Supabase's
-- migration runner wraps everything in a transaction, so this file
-- uses standard CREATE INDEX. Each takes a brief AccessShareLock —
-- safe at our row counts (low tens of thousands).

BEGIN;

-- ip_open_purchase_orders.expected_date
-- listOpenPos: select=...&order=expected_date.asc (no WHERE filter).
-- Existing idx_ip_open_pos_sku_expected (sku_id, expected_date) does
-- NOT serve this query (sku_id leads). Adding a single-column index
-- on expected_date lets the planner stream rows in date order
-- straight from the index instead of full-scanning + sorting in
-- memory. Partial WHERE qty_open > 0 keeps the index lean — closed
-- POs aren't read by the planner.
CREATE INDEX IF NOT EXISTS idx_ip_open_pos_expected_date
  ON ip_open_purchase_orders (expected_date)
  WHERE qty_open > 0;

-- ip_open_sales_orders.ship_date
-- listOpenSos: select=...&order=ship_date.asc (no WHERE filter).
-- Same shape as the PO case — existing compound index leads with
-- sku_id, useless for the unfiltered scan.
CREATE INDEX IF NOT EXISTS idx_ip_open_sos_ship_date
  ON ip_open_sales_orders (ship_date)
  WHERE qty_open > 0;

-- ip_receipts_history.received_date
-- listReceipts: select=...&received_date=gte.<sinceIso>&order=received_date.asc.
-- Both the WHERE filter and the ORDER BY benefit from a single-
-- column index on received_date. Existing idx_ip_receipts_sku_date
-- (sku_id, received_date) does not serve range queries on the
-- second column.
CREATE INDEX IF NOT EXISTS idx_ip_receipts_received_date
  ON ip_receipts_history (received_date);

-- ip_item_master active partial index
-- listMasterColors / listColorsByStyleLower / listMasterStyles all
-- filter active=eq.true. The existing idx_ip_item_master_active
-- on (active boolean) has poor selectivity (only two values) — the
-- planner usually full-scans instead of using it. A partial index
-- on the "active=true" subset is much smaller, faster to load, and
-- matches the queries' WHERE clause exactly.
CREATE INDEX IF NOT EXISTS idx_ip_item_master_active_partial
  ON ip_item_master (sku_code)
  WHERE active = true;
DROP INDEX IF EXISTS idx_ip_item_master_active;

-- ip_inventory_snapshot.snapshot_date already has an index
-- (idx_ip_inventory_snapshot_date DESC). No add needed.
-- ip_sales_history_wholesale.txn_date already has idx_ip_sales_wholesale_date.

COMMIT;

-- Run ANALYZE to refresh planner stats so the new indexes are
-- preferred immediately. ANALYZE is safe to run live; it takes a
-- brief read lock and returns within seconds on these table sizes.
ANALYZE ip_open_purchase_orders;
ANALYZE ip_open_sales_orders;
ANALYZE ip_receipts_history;
ANALYZE ip_item_master;
