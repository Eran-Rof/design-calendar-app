-- 20260513152000_ip_design_palettes.sql
--
-- AI-assisted apparel design pipeline — Stage 4 backing schema.
-- Color palettes generated per concept. One concept can have 1+ palettes
-- (typically 3 alternatives at generation time).
--
-- colors jsonb shape (validated by Zod in the API handler, not the DB):
--   [
--     { "pantone_tcx": "11-0103 TCX",
--       "name": "Marshmallow",
--       "hex": "#F0EAD6",
--       "role": "base" | "accent" | "highlight" | "neutral" },
--     ...
--   ]

CREATE TABLE IF NOT EXISTS ip_design_palettes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id   uuid NOT NULL REFERENCES ip_design_concepts(id) ON DELETE CASCADE,
  name         text,
  colors       jsonb NOT NULL,
  rationale    text,
  model        text,
  token_usage  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_design_palettes_concept_id
  ON ip_design_palettes (concept_id);

ALTER TABLE ip_design_palettes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_ip_design_palettes" ON ip_design_palettes;
CREATE POLICY "anon_all_ip_design_palettes" ON ip_design_palettes
  FOR ALL TO anon USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
