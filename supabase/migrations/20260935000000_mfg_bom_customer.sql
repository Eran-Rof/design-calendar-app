-- Manufacturing — customer-specific BOMs (private-label recipes).
--
-- A BOM can be tagged to a customer, so one base style can have a generic BOM
-- (customer_id NULL) plus per-customer variants. Uniqueness / "one active BOM"
-- now key on the finished STYLE + customer (was finished_item_id), matching the
-- style-level model (mig 20260934). mfg_bom is empty in prod, so re-keying is
-- safe. NULL customer collapses to the zero-uuid so there is at most ONE active
-- generic BOM per style.
ALTER TABLE mfg_bom
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS mfg_bom_customer_idx ON mfg_bom(customer_id);

-- Replace the finished_item_id-keyed uniqueness with finished_style_id + customer.
ALTER TABLE mfg_bom DROP CONSTRAINT IF EXISTS mfg_bom_entity_item_version_unique;
DROP INDEX IF EXISTS uq_mfg_bom_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mfg_bom_style_customer_version
  ON mfg_bom (entity_id, finished_style_id, COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), version)
  WHERE finished_style_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mfg_bom_active
  ON mfg_bom (entity_id, finished_style_id, COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'active' AND finished_style_id IS NOT NULL;
