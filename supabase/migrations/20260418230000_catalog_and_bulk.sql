-- 20260418230000_catalog_and_bulk.sql
--
-- Phase 5 part B — vendor catalog + price history + bulk operations.
-- Plus Storage bucket 'bulk-operations' for uploaded CSVs and generated
-- result files.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. catalog_items
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS catalog_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  sku                   text NOT NULL,
  name                  text NOT NULL,
  description           text,
  unit_price            numeric,
  currency              text NOT NULL DEFAULT 'USD',
  unit_of_measure       text,
  lead_time_days        integer,
  min_order_quantity    integer,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'discontinued')),
  category              text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_items_vendor_sku ON catalog_items (vendor_id, sku);
CREATE INDEX IF NOT EXISTS idx_catalog_items_vendor_id ON catalog_items (vendor_id);
CREATE INDEX IF NOT EXISTS idx_catalog_items_status   ON catalog_items (status);
CREATE INDEX IF NOT EXISTS idx_catalog_items_category ON catalog_items (category);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. catalog_price_history
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS catalog_price_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id     uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  old_price           numeric,
  new_price           numeric NOT NULL,
  effective_date      date NOT NULL,
  changed_by          uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_price_history_item_id        ON catalog_price_history (catalog_item_id);
CREATE INDEX IF NOT EXISTS idx_catalog_price_history_effective_date ON catalog_price_history (effective_date DESC);

-- Auto-insert a price history row when catalog_items.unit_price changes.
CREATE OR REPLACE FUNCTION log_catalog_price_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unit_price IS DISTINCT FROM OLD.unit_price THEN
    INSERT INTO catalog_price_history (catalog_item_id, old_price, new_price, effective_date)
    VALUES (NEW.id, OLD.unit_price, NEW.unit_price, CURRENT_DATE);
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS catalog_items_price_history ON catalog_items;
CREATE TRIGGER catalog_items_price_history
  BEFORE UPDATE ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION log_catalog_price_change();

-- ══════════════════════════════════════════════════════════════════════════
-- 3. bulk_operations
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bulk_operations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  type                text NOT NULL CHECK (type IN ('po_acknowledge', 'invoice_submit', 'catalog_update')),
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'complete', 'failed')),
  input_file_url      text,
  result_file_url     text,
  total_rows          integer NOT NULL DEFAULT 0,
  success_count       integer NOT NULL DEFAULT 0,
  failure_count       integer NOT NULL DEFAULT 0,
  error_summary       jsonb,
  created_by          uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_bulk_operations_vendor_id ON bulk_operations (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_operations_status    ON bulk_operations (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE catalog_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_price_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_operations        ENABLE ROW LEVEL SECURITY;

-- catalog_items: vendors manage their own catalog; internal reads all
DROP POLICY IF EXISTS "anon_all_catalog_items" ON catalog_items;
CREATE POLICY "anon_all_catalog_items" ON catalog_items FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_catalog_items_select" ON catalog_items;
CREATE POLICY "vendor_own_catalog_items_select" ON catalog_items FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_catalog_items_insert" ON catalog_items;
CREATE POLICY "vendor_own_catalog_items_insert" ON catalog_items FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_catalog_items_update" ON catalog_items;
CREATE POLICY "vendor_own_catalog_items_update" ON catalog_items FOR UPDATE TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_catalog_items_delete" ON catalog_items;
CREATE POLICY "vendor_own_catalog_items_delete" ON catalog_items FOR DELETE TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- catalog_price_history: vendors read their own, writes go through trigger
DROP POLICY IF EXISTS "anon_all_catalog_price_history" ON catalog_price_history;
CREATE POLICY "anon_all_catalog_price_history" ON catalog_price_history FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_catalog_price_history_select" ON catalog_price_history;
CREATE POLICY "vendor_own_catalog_price_history_select" ON catalog_price_history FOR SELECT TO authenticated
  USING (catalog_item_id IN (SELECT ci.id FROM catalog_items ci
    WHERE ci.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));

-- bulk_operations
DROP POLICY IF EXISTS "anon_all_bulk_operations" ON bulk_operations;
CREATE POLICY "anon_all_bulk_operations" ON bulk_operations FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_bulk_operations_select" ON bulk_operations;
CREATE POLICY "vendor_own_bulk_operations_select" ON bulk_operations FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_bulk_operations_insert" ON bulk_operations;
CREATE POLICY "vendor_own_bulk_operations_insert" ON bulk_operations FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ══════════════════════════════════════════════════════════════════════════
-- 5. Storage bucket for bulk CSV uploads + result files
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public) VALUES ('bulk-operations', 'bulk-operations', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_all_bulk_operations_objects" ON storage.objects;
CREATE POLICY "anon_all_bulk_operations_objects" ON storage.objects FOR ALL TO anon
  USING (bucket_id = 'bulk-operations') WITH CHECK (bucket_id = 'bulk-operations');

DROP POLICY IF EXISTS "vendor_own_bulk_operations_objects_select" ON storage.objects;
CREATE POLICY "vendor_own_bulk_operations_objects_select" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'bulk-operations'
    AND (storage.foldername(name))[1] IN (SELECT vu.vendor_id::text FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "vendor_own_bulk_operations_objects_insert" ON storage.objects;
CREATE POLICY "vendor_own_bulk_operations_objects_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'bulk-operations'
    AND (storage.foldername(name))[1] IN (SELECT vu.vendor_id::text FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );
