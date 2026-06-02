-- Prepack Matrix Driver master.
--
-- Prepacks (PPK) hold inventory in PACKS: in ip_item_master a pack row has
-- style_code ending in PPK (e.g. RYB059430PPK / RJO0639-PPK / ACMB0016PPK) and
-- size = the pack token (PPK24 / PPK18 / PPK48 / PPK60). A pack of N garments
-- has no per-garment-size breakdown anywhere in Tangerine — ATS only carries a
-- pack-size scalar, and GS1 scale_size_ratios has no key into Tangerine styles.
--
-- This master defines, per prepack, the per-size garment QUANTITIES that make
-- up one pack, so the Inventory Matrix "Explode PPK" toggle can convert packs
-- on-hand into garment-size eaches on the sized sibling style.
--
-- Model (mirrors the size_scales master, but rows carry QUANTITIES):
--   prepack_matrices       — one row per prepack (code, name, the PPK style it
--                            describes, the pack token, an optional pack total).
--   prepack_matrix_sizes   — the composition: (matrix_id, size, qty_per_pack).
--                            A pack of N = SUM(qty_per_pack) across its sizes.
--
-- How a pack references its matrix: each prepack row carries ppk_style_code —
-- the PPK style_code exactly as it appears in ip_item_master (e.g.
-- RYB059430PPK). The explode wiring takes a SIZED style, finds its PPK sibling
-- by appending the PPK token (reusing the salesCompsGrain stem logic), then
-- looks up the matrix by that sibling's style_code. pack_token (PPK24/…) is
-- stored too so one base part can carry more than one pack configuration.
--
-- Additive + idempotent. entity_id DEFAULT rof_entity_id(); anon-read RLS like
-- the other masters; writes via the service role.

-- =========================================================================
-- 1. prepack_matrices — the master row (one per prepack).
-- =========================================================================
CREATE TABLE IF NOT EXISTS prepack_matrices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  code            text NOT NULL,                 -- server-generated PPKM-NNNNN (read-only)
  name            text NOT NULL,
  ppk_style_code  text,                          -- the PPK style_code in ip_item_master (e.g. RYB059430PPK)
  pack_token      text,                          -- the pack size token (e.g. PPK24); informational
  pack_total      integer,                       -- optional declared pack size; SUM(sizes) is the truth
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, code)
);
COMMENT ON TABLE prepack_matrices IS 'Prepack matrix driver: per-prepack master defining a pack''s per-size garment composition. ppk_style_code links it to the PPK style_code in ip_item_master; the Inventory Matrix Explode-PPK toggle uses it to convert packs on-hand into sized eaches.';

-- One matrix per (entity, PPK style_code) when the PPK style is set — so the
-- explode can resolve a sibling PPK style to exactly one matrix. Partial unique
-- index so rows without a ppk_style_code (drafts) do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prepack_matrices_ppk_style
  ON prepack_matrices (entity_id, lower(ppk_style_code))
  WHERE ppk_style_code IS NOT NULL;

ALTER TABLE prepack_matrices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_prepack_matrices" ON prepack_matrices;
CREATE POLICY "anon_read_prepack_matrices" ON prepack_matrices FOR SELECT TO anon USING (true);

-- =========================================================================
-- 2. prepack_matrix_sizes — the per-size composition rows.
-- =========================================================================
CREATE TABLE IF NOT EXISTS prepack_matrix_sizes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_id     uuid NOT NULL REFERENCES prepack_matrices(id) ON DELETE CASCADE,
  size          text NOT NULL,                   -- garment size on the SIZED sibling (e.g. 30, 32, MEDIUM)
  qty_per_pack  integer NOT NULL CHECK (qty_per_pack >= 0),
  sort_order    smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matrix_id, size)
);
COMMENT ON TABLE prepack_matrix_sizes IS 'Per-size garment quantities for one prepack matrix. SUM(qty_per_pack) over a matrix = one pack''s total units. size matches the SIZED sibling style''s size labels.';
CREATE INDEX IF NOT EXISTS idx_prepack_matrix_sizes_matrix ON prepack_matrix_sizes (matrix_id);

ALTER TABLE prepack_matrix_sizes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_prepack_matrix_sizes" ON prepack_matrix_sizes;
CREATE POLICY "anon_read_prepack_matrix_sizes" ON prepack_matrix_sizes FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
