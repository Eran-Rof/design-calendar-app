-- 20260710040000_p15_c1e_ip_avg_cost_brand.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P15 Brand Master — ip_item_avg_cost gets a REAL brand_id, mapped from its
-- existing brand_name text (NOT a blind ROF backfill — this table already holds
-- per-brand cost data). Mapping confirmed by the operator 2026-05-31 against the
-- live DISTINCT brand_name distribution.
--
-- Also seeds two brands the costing data surfaced (append-only, under ROF):
--   • PL   = "Private Label"  — the RYB…PL surf-shop private-label program
--            (Jack's Surfboards / River & Roads / Thalia / …). NOT Macy's PL.
--   • ROHM = "ROHM"           — a brand not previously in the seed.
--
-- brand_name → brand_id mapping (operator-approved):
--   Ring of Fire→ROF · (null)→ROF · Psycho Tuna→PT · Axe n Crown→AXECROWN ·
--   Epic Threads→MPLEPIC · BLUE RISE→BLUERISE · Sun + Stone→MPLSUNSTONE ·
--   FORT KNOX→FORTKNOX · Departed→DEPARTED · Private Label→PL · ROHM→ROHM
--   Axel → LEFT NULL (deferred: it belongs to a SEPARATE entity, to be stood up
--          on its own; we do not mis-tag it to ROF).
--
-- brand_name is KEPT as a denormalized column (Xoro costing-report parity).
-- partition_id is intentionally NOT added here: avg cost is per-(sku, brand),
-- while inventory partitions ("stores") are a per-stock-pool concept that lives
-- on the on-hand/quantity tables — a separate later chunk.
--
-- Idempotent. Adds brand_id WITHOUT a default first (so existing rows stay NULL
-- and the brand_name backfill controls every value, keeping Axel NULL), then
-- sets DEFAULT rof_default_brand_id() for FUTURE inserts.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Seed the two brands the costing data revealed (append-only). ─────────
INSERT INTO brand_master (entity_id, code, name, is_default, sort_order) VALUES
  (rof_entity_id(), 'PL',   'Private Label', false, 90),
  (rof_entity_id(), 'ROHM', 'ROHM',          false, 100)
ON CONFLICT (entity_id, code) DO NOTHING;

-- Standard non-PT inventory pools (WS + EC) + channel map for the 2 new brands.
INSERT INTO inventory_partition (brand_id, code, name)
SELECT b.id, b.code || '-WS', b.name || ' — Wholesale'
FROM brand_master b WHERE b.entity_id = rof_entity_id() AND b.code IN ('PL', 'ROHM')
ON CONFLICT (code) DO NOTHING;
INSERT INTO inventory_partition (brand_id, code, name)
SELECT b.id, b.code || '-EC', b.name || ' — Ecom'
FROM brand_master b WHERE b.entity_id = rof_entity_id() AND b.code IN ('PL', 'ROHM')
ON CONFLICT (code) DO NOTHING;

INSERT INTO brand_channel_partition (brand_id, channel_id, partition_id)
SELECT b.id, c.id, p.id
FROM brand_master b
JOIN channel_master c ON c.code = 'WHOLESALE'
JOIN inventory_partition p ON p.code = b.code || '-WS'
WHERE b.entity_id = rof_entity_id() AND b.code IN ('PL', 'ROHM')
ON CONFLICT (brand_id, channel_id) DO NOTHING;
INSERT INTO brand_channel_partition (brand_id, channel_id, partition_id)
SELECT b.id, c.id, p.id
FROM brand_master b
JOIN channel_master c ON c.code IN ('DTC', 'FBA', 'WALMART', 'FAIRE')
JOIN inventory_partition p ON p.code = b.code || '-EC'
WHERE b.entity_id = rof_entity_id() AND b.code IN ('PL', 'ROHM')
ON CONFLICT (brand_id, channel_id) DO NOTHING;

-- ─── 2. Add brand_id to ip_item_avg_cost (NO default → existing rows NULL). ──
ALTER TABLE ip_item_avg_cost
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brand_master(id) ON DELETE RESTRICT;

-- ─── 3. Backfill brand_id from brand_name (operator-approved mapping). ───────
-- Axel + any unrecognised brand_name fall through (CASE → NULL → no join match)
-- and stay NULL on purpose. null brand_name → ROF is handled in step 4.
UPDATE ip_item_avg_cost c
SET brand_id = b.id
FROM brand_master b
WHERE b.entity_id = rof_entity_id()
  AND b.code = CASE c.brand_name
        WHEN 'Ring of Fire' THEN 'ROF'
        WHEN 'Psycho Tuna'  THEN 'PT'
        WHEN 'Axe n Crown'  THEN 'AXECROWN'
        WHEN 'Epic Threads' THEN 'MPLEPIC'
        WHEN 'BLUE RISE'    THEN 'BLUERISE'
        WHEN 'Sun + Stone'  THEN 'MPLSUNSTONE'
        WHEN 'FORT KNOX'    THEN 'FORTKNOX'
        WHEN 'Departed'     THEN 'DEPARTED'
        WHEN 'Private Label' THEN 'PL'
        WHEN 'ROHM'         THEN 'ROHM'
        ELSE NULL   -- 'Axel' (separate entity) + any future label → stay NULL
      END
  AND c.brand_id IS NULL;

-- ─── 4. Unbranded (null brand_name) rows → ROF default brand. ────────────────
UPDATE ip_item_avg_cost
SET brand_id = rof_default_brand_id()
WHERE brand_name IS NULL AND brand_id IS NULL;

-- ─── 5. Default for FUTURE inserts + index. ──────────────────────────────────
ALTER TABLE ip_item_avg_cost ALTER COLUMN brand_id SET DEFAULT rof_default_brand_id();
CREATE INDEX IF NOT EXISTS idx_ip_item_avg_cost_brand ON ip_item_avg_cost (brand_id);

NOTIFY pgrst, 'reload schema';
