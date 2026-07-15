-- ════════════════════════════════════════════════════════════════════════════
-- Global search — pg_trgm GIN indexes
--
-- Backs the always-visible top-bar universal search
-- (GET /api/internal/global-search), which does per-keystroke substring ILIKE
-- ('%term%') across the major business entities. Plain btree indexes do NOT
-- accelerate case-insensitive substring ILIKE; pg_trgm GIN indexes do, keeping
-- each parallel per-entity lookup cheap and well within the service-role
-- timeout.
--
-- Additive + idempotent: CREATE EXTENSION IF NOT EXISTS + a guarded loop that
-- only builds an index when the column actually exists, and CREATE INDEX IF NOT
-- EXISTS so re-running is a no-op.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
DECLARE
  rec       record;
  idx_name  text;
BEGIN
  FOR rec IN
    SELECT tbl, col FROM (VALUES
      ('customers','code'), ('customers','customer_code'), ('customers','name'),
      ('vendors','code'), ('vendors','name'), ('vendors','legal_name'),
      ('style_master','style_code'), ('style_master','style_name'), ('style_master','description'),
      ('ip_item_master','sku_code'), ('ip_item_master','style_code'), ('ip_item_master','description'),
      ('sales_orders','so_number'),
      ('purchase_orders','po_number'),
      ('tanda_pos','po_number'), ('tanda_pos','vendor'),
      ('ar_invoices','invoice_number'), ('ar_invoices','description'),
      ('invoices','invoice_number'), ('invoices','notes'),
      ('journal_entries','je_number'), ('journal_entries','description'),
      ('part_master','code'), ('part_master','name'),
      ('service_item_master','code'), ('service_item_master','name'),
      ('mfg_build_orders','build_number'), ('mfg_build_orders','notes'),
      ('fabric_codes','code'), ('fabric_codes','name'), ('fabric_codes','composition_text'),
      ('employees','code'), ('employees','display_name'), ('employees','email')
    ) AS t(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = rec.tbl AND column_name = rec.col
    ) THEN
      idx_name := 'idx_gs_' || rec.tbl || '_' || rec.col || '_trgm';
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I USING gin (%I gin_trgm_ops)',
        idx_name, rec.tbl, rec.col
      );
    END IF;
  END LOOP;
END $$;
