-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 / Chunk 7 / Migration 1
-- M37 Inventory Transfers - SCHEMA ONLY skeleton.
--
-- Per docs/tangerine/P3-acc-core-architecture.md §5.2 (inventory_transfers).
--
-- Scope intentionally minimal: the schema exists for forward compatibility
-- with multi-warehouse. The full transfer UX (create + post + GL impact
-- for cross-entity moves) matures when M37 ships its complete chunk.
--
-- At single-location launch, this table stays empty. Internal transfers
-- between owned locations don't hit GL, so `posted_je_id` is usually NULL.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inventory_transfers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  item_id                uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  qty                    numeric(18,4) NOT NULL,
  from_location          text NOT NULL,
  to_location            text NOT NULL,
  transfer_date          timestamptz NOT NULL DEFAULT now(),
  notes                  text,
  posted_je_id           uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_transfers_qty_positive
    CHECK (qty > 0),
  CONSTRAINT inventory_transfers_locations_differ
    CHECK (to_location <> from_location)
);

CREATE INDEX IF NOT EXISTS idx_inventory_transfers_entity_date
  ON inventory_transfers (entity_id, transfer_date DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_transfers_item
  ON inventory_transfers (item_id);

COMMENT ON TABLE  inventory_transfers IS 'M37 inventory transfers between locations. Skeleton at P3-7 - table stays empty until multi-warehouse UX ships. Internal transfers between owned locations usually do NOT hit GL (posted_je_id NULL); cross-entity transfers would post via gl_post_journal_entry and link the resulting JE here.';
COMMENT ON COLUMN inventory_transfers.from_location IS 'Free-form text for now. Promotes to FK on a future `locations`/`warehouses` table when multi-warehouse lands.';
COMMENT ON COLUMN inventory_transfers.to_location   IS 'Free-form text. Must differ from from_location (enforced via CHECK constraint).';
COMMENT ON COLUMN inventory_transfers.posted_je_id  IS 'Usually NULL - internal transfers between owned locations do not touch GL. Set only when a cross-entity transfer requires a posting.';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS - P1 template
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE inventory_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_inventory_transfers" ON inventory_transfers;
CREATE POLICY "anon_all_inventory_transfers" ON inventory_transfers
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_inventory_transfers" ON inventory_transfers;
CREATE POLICY "auth_internal_inventory_transfers" ON inventory_transfers
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ════════════════════════════════════════════════════════════════════════════
-- Touch trigger
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION inventory_transfers_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_transfers_touch_trg ON inventory_transfers;
CREATE TRIGGER inventory_transfers_touch_trg
  BEFORE UPDATE ON inventory_transfers
  FOR EACH ROW EXECUTE FUNCTION inventory_transfers_touch();
