-- ════════════════════════════════════════════════════════════════════════════
-- Manufacturing module (M4) — Build orders + WIP accounting.
--
-- A build order assembles a finished style from a BOM. Lifecycle:
--   draft → released (BOM snapshotted to mfg_build_components)
--         → issued   (parts + consumed styles drawn into WIP; mfg_build_issue JE)
--         → completed (WIP → finished-goods inventory; mfg_build_complete JE)
-- Conversion/labor SERVICE charges are captured against the build (vendor AP)
-- and capitalized to WIP (mfg_service_capitalized JE) any time before complete.
-- Costing is ACTUAL: finished unit cost = accumulated WIP / completed qty.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mfg_build_orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  build_number             text NOT NULL,
  finished_item_id         uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  bom_id                   uuid REFERENCES mfg_bom(id) ON DELETE SET NULL,
  target_qty               numeric(18,4) NOT NULL CHECK (target_qty > 0),
  completed_qty            numeric(18,4) NOT NULL DEFAULT 0,
  status                   text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','released','issued','in_progress','completed','cancelled')),
  wip_account_id           uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  -- Conversion/subcontract PO that, when received, completes the build (M5
  -- wires the receiving hook + the real FK to purchase_orders). FK-less here.
  conversion_po_id         uuid,
  conversion_po_line_id    uuid,
  accumulated_cost_cents   bigint NOT NULL DEFAULT 0,
  finished_unit_cost_cents bigint,
  location_id              uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  issue_je_id              uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  complete_je_id           uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT mfg_build_orders_entity_number_unique UNIQUE (entity_id, build_number)
);
CREATE INDEX IF NOT EXISTS mfg_build_orders_entity_idx ON mfg_build_orders(entity_id);
CREATE INDEX IF NOT EXISTS mfg_build_orders_status_idx ON mfg_build_orders(entity_id, status);
CREATE INDEX IF NOT EXISTS mfg_build_orders_conversion_po_idx ON mfg_build_orders(conversion_po_id);

CREATE TABLE IF NOT EXISTS mfg_build_components (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_order_id      uuid NOT NULL REFERENCES mfg_build_orders(id) ON DELETE CASCADE,
  component_kind      text NOT NULL CHECK (component_kind IN ('part','service','finished_style')),
  part_id             uuid REFERENCES part_master(id) ON DELETE RESTRICT,
  service_item_id     uuid REFERENCES service_item_master(id) ON DELETE RESTRICT,
  component_item_id   uuid REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  qty_required        numeric(18,4) NOT NULL DEFAULT 0,
  qty_consumed        numeric(18,4) NOT NULL DEFAULT 0,
  actual_cost_cents   bigint NOT NULL DEFAULT 0,
  -- Service rows: the agreed conversion charge + the vendor + the AP bill that
  -- booked it (when capitalized to WIP).
  service_charge_cents bigint,
  service_vendor_id   uuid REFERENCES vendors(id) ON DELETE SET NULL,
  service_invoice_id  uuid REFERENCES invoices(id) ON DELETE SET NULL,
  service_capitalized boolean NOT NULL DEFAULT false,
  line_number         int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfg_build_components_one_of CHECK (
    (component_kind = 'part'           AND part_id IS NOT NULL AND service_item_id IS NULL AND component_item_id IS NULL)
    OR (component_kind = 'service'        AND service_item_id IS NOT NULL AND part_id IS NULL AND component_item_id IS NULL)
    OR (component_kind = 'finished_style' AND component_item_id IS NOT NULL AND part_id IS NULL AND service_item_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS mfg_build_components_build_idx ON mfg_build_components(build_order_id);

-- Tag finished goods that came off a manufacturing build (vs. an AP receipt or
-- adjustment). Extends the inventory_layers source_kind whitelist.
-- Preserves the full P13 list (incl. xoro_rest_size) + adds 'manufacture'.
ALTER TABLE inventory_layers DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check;
ALTER TABLE inventory_layers ADD CONSTRAINT inventory_layers_source_kind_check
  CHECK (source_kind = ANY (ARRAY[
    'ap_invoice','adjustment','opening_balance','transfer_in','credit_memo_return',
    'xoro_mirror_snapshot','shopify_refund_restock','fba_inbound','wfs_inbound',
    'fba_return_restock','wfs_return_restock','xoro_rest_size',
    'po_receipt','manufacture'
  ]::text[]));

-- RLS — anon_all + auth_internal.
ALTER TABLE mfg_build_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfg_build_components ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_mfg_build_orders" ON mfg_build_orders;
CREATE POLICY "anon_all_mfg_build_orders" ON mfg_build_orders FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_all_mfg_build_components" ON mfg_build_components;
CREATE POLICY "anon_all_mfg_build_components" ON mfg_build_components FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_internal_mfg_build_orders" ON mfg_build_orders;
CREATE POLICY "auth_internal_mfg_build_orders" ON mfg_build_orders
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "auth_internal_mfg_build_components" ON mfg_build_components;
CREATE POLICY "auth_internal_mfg_build_components" ON mfg_build_components
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
