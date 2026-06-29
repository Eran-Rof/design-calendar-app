-- Manufacturing module (M1) — Service Item Master.
--
-- Conversion/labor SERVICES performed by an outsourced factory (printing,
-- sewing, packing, washing). Per the operator's CMT model, a service is a
-- VENDOR AP CHARGE, not an internal labor rate — there is no stocked quantity.
-- A service charge is captured against a conversion PO / AP bill and (when
-- applied_to_wip) capitalized into the build's WIP cost (see M4).
--
-- `code` is server-generated read-only (SVC-NNNNN).
CREATE TABLE IF NOT EXISTS service_item_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL DEFAULT rof_entity_id(),
  code text NOT NULL,
  name text NOT NULL,
  service_kind text NOT NULL DEFAULT 'conversion'
    CHECK (service_kind IN ('print', 'sew', 'pack', 'wash', 'conversion', 'other')),
  -- Metadata flag for reporting; CMT labor is still a vendor charge (no rate).
  is_labor boolean NOT NULL DEFAULT true,
  -- Default vendor that performs this service (vendors.id, operational chain).
  default_vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  -- Default per-unit charge in cents (informational seed for the conversion PO).
  default_charge_cents bigint CHECK (default_charge_cents IS NULL OR default_charge_cents >= 0),
  -- Default GL account the charge hits when NOT capitalized to WIP.
  default_expense_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  -- Whether this service's cost is capitalized into the finished good (WIP).
  applied_to_wip boolean NOT NULL DEFAULT true,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_item_master_entity_code_unique UNIQUE (entity_id, code)
);
CREATE INDEX IF NOT EXISTS service_item_master_entity_id_idx ON service_item_master(entity_id);
CREATE INDEX IF NOT EXISTS service_item_master_vendor_idx ON service_item_master(default_vendor_id);
