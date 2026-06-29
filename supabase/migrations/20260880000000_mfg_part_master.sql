-- Manufacturing module (M1) — Part Master.
--
-- Purchased COMPONENTS that get assembled into a finished style (blank
-- garments, labels, trims, packaging, fabric-as-part). Parts are deliberately
-- kept SEPARATE from style inventory (ip_item_master): they have their own
-- master here and their own FIFO inventory pool (added in M2). There is NO FK
-- from part_master to ip_item_master — parts live in their own namespace.
--
-- `code` is server-generated read-only (PART-NNNNN), mirroring the fabric mill
-- / customer / vendor auto-coded masters.
CREATE TABLE IF NOT EXISTS part_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL DEFAULT rof_entity_id(),
  code text NOT NULL,
  name text NOT NULL,
  -- What kind of component this is. Drives reporting + default handling.
  part_type text NOT NULL DEFAULT 'generic'
    CHECK (part_type IN ('blank_garment', 'label', 'trim', 'packaging', 'fabric', 'generic')),
  uom text NOT NULL DEFAULT 'each',
  -- Default sourcing vendor (operational vendors table, vendors.id).
  default_vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  -- Default purchase cost in cents; informational seed for AP receiving.
  default_unit_cost_cents bigint CHECK (default_unit_cost_cents IS NULL OR default_unit_cost_cents >= 0),
  -- Size-scaled parts (e.g. blank tees) are tracked per-size in the UI matrix.
  is_size_scaled boolean NOT NULL DEFAULT false,
  -- Optional link to the existing fabric_codes master when part_type='fabric'.
  fabric_code_id uuid REFERENCES fabric_codes(id) ON DELETE SET NULL,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT part_master_entity_code_unique UNIQUE (entity_id, code)
);
CREATE INDEX IF NOT EXISTS part_master_entity_id_idx ON part_master(entity_id);
CREATE INDEX IF NOT EXISTS part_master_vendor_idx ON part_master(default_vendor_id);
