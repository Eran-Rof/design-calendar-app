-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 6 / Migration 14
-- entity_vendors.vendor_code — per-entity vendor code override. Lets one
-- vendor row carry different codes in different entities (e.g. V0042 for
-- RoF, XV-42 for another entity in future multi-entity ops).
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §7.2 (bottom)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE entity_vendors
  ADD COLUMN IF NOT EXISTS vendor_code text;

-- Backfill: for any entity_vendors row where the linked vendor already has a
-- code populated, default the per-entity code to match. Where vendors.code is
-- still NULL (most rows at this point), leave NULL.
UPDATE entity_vendors ev
   SET vendor_code = v.code
  FROM vendors v
 WHERE ev.vendor_code IS NULL
   AND ev.vendor_id = v.id
   AND v.code IS NOT NULL;

-- Unique per (entity_id, vendor_code) when set. Allows multiple NULL rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_vendors_vendor_code
  ON entity_vendors (entity_id, vendor_code)
  WHERE vendor_code IS NOT NULL;

COMMENT ON COLUMN entity_vendors.vendor_code IS
  'Per-entity vendor code override. Unique per entity when set. Falls back to vendors.code if NULL.';
