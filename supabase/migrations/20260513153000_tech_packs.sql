-- 20260513153000_tech_packs.sql
--
-- AI-assisted apparel design pipeline — Stage 6 backing schema.
-- AI-drafted tech pack stub. Forward-compatible with the future
-- TechPack.tsx app: `payload` jsonb stores the full TechPack interface
-- shape (src/TechPack.tsx:50-60). When the real Tech Packs app ships,
-- it can read this column directly via Zod validation
-- (api/_lib/tech-pack-schema.js — created in a later stage).
--
-- Premortem mitigation #3: AI-drafted POMs/BOMs cannot leave Supabase
-- as a "production tech pack" without explicit human approval. status
-- enum splits ai_drafted → human_editing → human_approved. The PDF
-- render handler and the bucket-write step both gate on
-- status='human_approved'. The AI prompt is also instructed to leave
-- payload.measurements = [] in v1 (POMs require a real fit sample).
--
-- shipped_sku_id closes the loop for the "did this ship and sell?"
-- metric described in the plan's verification section.

CREATE TABLE IF NOT EXISTS tech_packs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id          uuid REFERENCES ip_design_concepts(id) ON DELETE SET NULL,
  version             integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'ai_drafted'
                        CHECK (status IN ('ai_drafted', 'human_editing', 'human_approved', 'archived')),

  payload             jsonb NOT NULL,        -- conforms to TechPack interface
  flat_image_url      text,                  -- signed-URL-mintable storage path
  pdf_url             text,                  -- signed-URL-mintable storage path

  shipped_sku_id      uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,

  generated_by        text,                  -- 'claude-opus-4-7' for AI drafts, internal user id for hand-edits
  model               text,
  token_usage         jsonb,

  human_approved_at   timestamptz,
  human_approved_by   text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tech_packs_concept_id  ON tech_packs (concept_id);
CREATE INDEX IF NOT EXISTS idx_tech_packs_status      ON tech_packs (status);
CREATE INDEX IF NOT EXISTS idx_tech_packs_shipped_sku ON tech_packs (shipped_sku_id) WHERE shipped_sku_id IS NOT NULL;

ALTER TABLE tech_packs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_tech_packs" ON tech_packs;
CREATE POLICY "anon_all_tech_packs" ON tech_packs
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- Storage buckets for flat sketches and rendered PDFs. Service-role
-- only — no anon policies, public=false. Frontend reads via signed URLs.
INSERT INTO storage.buckets (id, name, public) VALUES
  ('design-flats',    'design-flats',    false),
  ('tech-pack-pdfs',  'tech-pack-pdfs',  false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
