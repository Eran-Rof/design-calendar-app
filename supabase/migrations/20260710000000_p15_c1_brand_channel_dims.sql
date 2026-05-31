-- 20260710000000_p15_c1_brand_channel_dims.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P15 Brand Master — Chunk 1: the dimension tables + seed.
--
-- Per docs/tangerine/P15-brand-master-architecture.md (v2). Establishes the two
-- new reporting axes + the Xoro-"store" inventory model, as pure NEW tables —
-- ZERO changes to existing tables, so no behavior change anywhere. The nullable
-- brand_id/channel_id/partition_id FKs on transactional tables + the backfill
-- land in a follow-up (C1b) after each target table's schema is verified.
--
-- Model (CEO-confirmed 2026-05-31):
--   • 6 brands under the ROF entity, sharing ROF's COA (append-only set).
--   • 5 channels (global).
--   • Inventory PARTITIONS ("stores"): brand keeps separate Wholesale vs Ecom
--     stock — EXCEPT Psycho Tuna, which shares one pool across all channels.
--     Marketplaces (FBA/Walmart/Faire) currently draw from the brand's Ecom
--     pool; FBA can be split to its own pool LATER by just editing the map
--     rows (no schema change).
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING) — safe to re-apply under
-- supabase-db-push. rof_entity_id() (STABLE) supplies the ROF entity uuid.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. brand_master — 1:N child of entities (append-only, super-admin) ──────
CREATE TABLE IF NOT EXISTS brand_master (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT DEFAULT rof_entity_id(),
  code        text NOT NULL,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, code)
);
-- At most one default brand per entity (the backfill target).
CREATE UNIQUE INDEX IF NOT EXISTS uq_brand_default_per_entity
  ON brand_master (entity_id) WHERE is_default;

-- ─── 2. channel_master — sales route (entity-agnostic global) ────────────────
CREATE TABLE IF NOT EXISTS channel_master (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ─── 3. inventory_partition — a stock pool ("store") owned by a brand ────────
CREATE TABLE IF NOT EXISTS inventory_partition (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brand_master(id) ON DELETE RESTRICT,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_partition_brand ON inventory_partition (brand_id);

-- ─── 4. brand_channel_partition — which (brand, channel) draws which pool ────
CREATE TABLE IF NOT EXISTS brand_channel_partition (
  brand_id     uuid NOT NULL REFERENCES brand_master(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES channel_master(id) ON DELETE CASCADE,
  partition_id uuid NOT NULL REFERENCES inventory_partition(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, channel_id)
);

-- ─── 5. T11 audit on the privileged brand table ─────────────────────────────
DROP TRIGGER IF EXISTS trg_brand_master_audit ON brand_master;
CREATE TRIGGER trg_brand_master_audit
  AFTER INSERT OR UPDATE OR DELETE ON brand_master
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

-- ─── 6. RLS — anon READ-ONLY. The internal apps (anon key) read these for the
--        switchers; brand/channel/partition mutations are migration- /
--        service-role-managed only (append-only, super-admin). ──────────────
ALTER TABLE brand_master            ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_master          ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_partition     ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_channel_partition ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_brand_master" ON brand_master;
CREATE POLICY "anon_read_brand_master" ON brand_master FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "anon_read_channel_master" ON channel_master;
CREATE POLICY "anon_read_channel_master" ON channel_master FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "anon_read_inventory_partition" ON inventory_partition;
CREATE POLICY "anon_read_inventory_partition" ON inventory_partition FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "anon_read_brand_channel_partition" ON brand_channel_partition;
CREATE POLICY "anon_read_brand_channel_partition" ON brand_channel_partition FOR SELECT TO anon USING (true);

-- ════════════════════════════════════════════════════════════════════════════
-- SEED
-- ════════════════════════════════════════════════════════════════════════════

-- 6 brands under ROF (PLM removed per CEO; append-only set). ROF = default.
INSERT INTO brand_master (entity_id, code, name, is_default, sort_order) VALUES
  (rof_entity_id(), 'ROF',      'Ring of Fire', true,  10),
  (rof_entity_id(), 'PT',       'Psycho Tuna',  false, 20),
  (rof_entity_id(), 'DEPARTED', 'Departed',     false, 30),
  (rof_entity_id(), 'FORTKNOX', 'Fort Knox',    false, 40),
  (rof_entity_id(), 'BLUERISE', 'Blue Rise',    false, 50),
  (rof_entity_id(), 'AXECROWN', 'Axe Crown',    false, 60)
ON CONFLICT (entity_id, code) DO NOTHING;

-- 5 channels.
INSERT INTO channel_master (code, name, sort_order) VALUES
  ('DTC',       'DTC / Shopify',   10),
  ('WHOLESALE', 'Wholesale / EDI', 20),
  ('FBA',       'Amazon FBA',      30),
  ('WALMART',   'Walmart',         40),
  ('FAIRE',     'Faire',           50)
ON CONFLICT (code) DO NOTHING;

-- Partitions. Non-PT brands: separate Wholesale + Ecom pools (same styles,
-- distinct stock). PT: one shared pool.
INSERT INTO inventory_partition (brand_id, code, name)
SELECT b.id, b.code || '-WS', b.name || ' — Wholesale'
FROM brand_master b
WHERE b.entity_id = rof_entity_id() AND b.code <> 'PT'
ON CONFLICT (code) DO NOTHING;

INSERT INTO inventory_partition (brand_id, code, name)
SELECT b.id, b.code || '-EC', b.name || ' — Ecom'
FROM brand_master b
WHERE b.entity_id = rof_entity_id() AND b.code <> 'PT'
ON CONFLICT (code) DO NOTHING;

INSERT INTO inventory_partition (brand_id, code, name)
SELECT b.id, 'PT', 'Psycho Tuna — Shared'
FROM brand_master b
WHERE b.entity_id = rof_entity_id() AND b.code = 'PT'
ON CONFLICT (code) DO NOTHING;

-- Map. Non-PT: Wholesale → {brand}-WS; DTC/FBA/Walmart/Faire → {brand}-EC
-- (FBA currently shares Ecom; split to its own pool later via a map edit).
INSERT INTO brand_channel_partition (brand_id, channel_id, partition_id)
SELECT b.id, c.id, p.id
FROM brand_master b
JOIN channel_master c ON c.code = 'WHOLESALE'
JOIN inventory_partition p ON p.code = b.code || '-WS'
WHERE b.entity_id = rof_entity_id() AND b.code <> 'PT'
ON CONFLICT (brand_id, channel_id) DO NOTHING;

INSERT INTO brand_channel_partition (brand_id, channel_id, partition_id)
SELECT b.id, c.id, p.id
FROM brand_master b
JOIN channel_master c ON c.code IN ('DTC','FBA','WALMART','FAIRE')
JOIN inventory_partition p ON p.code = b.code || '-EC'
WHERE b.entity_id = rof_entity_id() AND b.code <> 'PT'
ON CONFLICT (brand_id, channel_id) DO NOTHING;

-- PT: every channel → the single shared PT pool.
INSERT INTO brand_channel_partition (brand_id, channel_id, partition_id)
SELECT b.id, c.id, p.id
FROM brand_master b
CROSS JOIN channel_master c
JOIN inventory_partition p ON p.code = 'PT'
WHERE b.entity_id = rof_entity_id() AND b.code = 'PT'
ON CONFLICT (brand_id, channel_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
