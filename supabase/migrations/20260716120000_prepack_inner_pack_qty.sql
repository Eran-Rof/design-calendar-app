-- Prepack matrices — inner packs + carton totals.
--
-- The PPK token (e.g. PPK24) identifies the CARTON contents (24 units/carton),
-- and each carton holds multiple INNER PACKS. The existing per-size qty_per_pack
-- IS the carton "Qty Per Box" for that size; this adds inner_pack_qty (how many
-- inner packs of that size are in the carton). Carton total = Σ qty_per_pack;
-- inner-pack total = Σ inner_pack_qty.

ALTER TABLE prepack_matrix_sizes
  ADD COLUMN IF NOT EXISTS inner_pack_qty integer NOT NULL DEFAULT 0
    CHECK (inner_pack_qty >= 0);
COMMENT ON COLUMN prepack_matrix_sizes.inner_pack_qty IS 'Number of inner packs of this size in the carton. qty_per_pack remains the carton units (Qty Per Box) for the size; carton total = SUM(qty_per_pack).';

-- ── Seed the operator-provided RYB059430PPK matrix (idempotent) ──────────────
-- Sizes (Inner Pack Qty / Qty Per Box): 30:1/3, 31:1/3, 32:2/6, 33:1/3,
-- 34:2/6, 36:1/3 (38 excluded — 0/0). Carton total = 24; inner packs = 8.
DO $$
DECLARE v_entity uuid; v_matrix uuid;
BEGIN
  SELECT id INTO v_entity FROM entities WHERE code = 'ROF' LIMIT 1;
  IF v_entity IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM prepack_matrices WHERE entity_id = v_entity AND ppk_style_code = 'RYB059430PPK') THEN
    RETURN; -- already set up; don't clobber operator edits
  END IF;
  INSERT INTO prepack_matrices (entity_id, code, name, ppk_style_code, pack_token, pack_total)
  VALUES (v_entity, 'PPKM-RYB059430PPK', 'RYB059430 Pack of 24', 'RYB059430PPK', 'PPK24', 24)
  RETURNING id INTO v_matrix;
  INSERT INTO prepack_matrix_sizes (matrix_id, size, qty_per_pack, inner_pack_qty, sort_order) VALUES
    (v_matrix, '30', 3, 1, 0),
    (v_matrix, '31', 3, 1, 1),
    (v_matrix, '32', 6, 2, 2),
    (v_matrix, '33', 3, 1, 3),
    (v_matrix, '34', 6, 2, 4),
    (v_matrix, '36', 3, 1, 5);
END $$;

NOTIFY pgrst, 'reload schema';
