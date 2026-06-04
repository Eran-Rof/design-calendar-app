-- P21 / M13 — Third-Party Logistics (3PL).
--
-- A 3PL is an external warehouse/fulfillment partner that holds our inventory
-- and ships on our behalf (a *contract* 3PL — distinct from marketplace-owned
-- FBA/WFS, which P12 already covers). This adds the 3PL provider master + the
-- inbound/outbound shipment tracking layer. Each provider links to an
-- `inventory_locations` row (kind='3pl') where its stock lives. The actual
-- FIFO-layer relocation + 3PL fee posting are follow-ups (FIFO layers are not
-- yet location-scoped; see M52 multi-warehouse).

CREATE TABLE IF NOT EXISTS tpl_providers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  code               text,                          -- e.g. TPL-001 (operator-set or auto)
  name               text NOT NULL,
  kind               text NOT NULL DEFAULT 'contract_3pl'
                       CHECK (kind IN ('contract_3pl','fba','wfs','other')),
  location_id        uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,  -- the 3PL's stock location
  contact_name       text,
  email              text,
  phone              text,
  account_ref        text,                          -- our account number with the 3PL
  billing_notes      text,                          -- storage/pick-pack fee terms (free text)
  is_active          boolean NOT NULL DEFAULT true,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tpl_providers_code ON tpl_providers(entity_id, code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS tpl_shipments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  tpl_provider_id    uuid NOT NULL REFERENCES tpl_providers(id) ON DELETE RESTRICT,
  shipment_number    text,                          -- assigned on confirm: TPL-YYYY-NNNNN
  direction          text NOT NULL DEFAULT 'inbound'
                       CHECK (direction IN ('inbound','outbound','return')),  -- to 3PL / from 3PL / back to us
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','in_transit','received','closed','cancelled')),
  reference          text,                          -- our internal ref / their ASN
  carrier            text,
  tracking_number    text,
  ship_date          date,
  expected_date      date,
  received_at        timestamptz,
  sales_order_id     uuid REFERENCES sales_orders(id) ON DELETE SET NULL,
  purchase_order_id  uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz,
  created_by_user_id uuid
);
CREATE INDEX IF NOT EXISTS ix_tpl_shipments_provider ON tpl_shipments(entity_id, tpl_provider_id);
CREATE INDEX IF NOT EXISTS ix_tpl_shipments_status   ON tpl_shipments(entity_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tpl_shipments_number ON tpl_shipments(entity_id, shipment_number) WHERE shipment_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS tpl_shipment_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tpl_shipment_id    uuid NOT NULL REFERENCES tpl_shipments(id) ON DELETE CASCADE,
  line_number        int  NOT NULL,
  inventory_item_id  uuid REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  description        text,
  qty                numeric(18,4) NOT NULL CHECK (qty > 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_tpl_shipment_lines_shipment ON tpl_shipment_lines(tpl_shipment_id);

-- RLS — anon read-only (writes via service-role admin API), like other tables.
DO $$ BEGIN
  ALTER TABLE tpl_providers       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tpl_shipments       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tpl_shipment_lines  ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tpl_providers' AND policyname='anon_read_tpl_providers') THEN
    CREATE POLICY "anon_read_tpl_providers" ON tpl_providers FOR SELECT TO anon USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tpl_shipments' AND policyname='anon_read_tpl_shipments') THEN
    CREATE POLICY "anon_read_tpl_shipments" ON tpl_shipments FOR SELECT TO anon USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tpl_shipment_lines' AND policyname='anon_read_tpl_shipment_lines') THEN
    CREATE POLICY "anon_read_tpl_shipment_lines" ON tpl_shipment_lines FOR SELECT TO anon USING (true); END IF;
END $$;

NOTIFY pgrst, 'reload schema';
