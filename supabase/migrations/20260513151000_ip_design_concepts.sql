-- 20260513151000_ip_design_concepts.sql
--
-- AI-assisted apparel design pipeline — Stage 4 backing schema.
-- Concepts derived from a published trend brief.
--
-- Premortem mitigation: `fit_score` is hallucinated and designers
-- anchor on the number. v2 renames to `ai_fit_estimate` and ships
-- with a default `ai_fit_estimate_label` text that the UI surfaces
-- inline so the score is never read in isolation.
--
-- past_sku_ids is a uuid array of ip_item_master.id values Claude
-- claims the concept resembles. The comparison is asserted by the
-- model, not proven — UI must label it accordingly.

CREATE TABLE IF NOT EXISTS ip_design_concepts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trend_brief_id            uuid NOT NULL REFERENCES ip_trend_briefs(id) ON DELETE CASCADE,
  name                      text NOT NULL,
  rationale_md              text,
  ai_fit_estimate           numeric(3,1)
                              CHECK (ai_fit_estimate IS NULL
                                  OR (ai_fit_estimate >= 0 AND ai_fit_estimate <= 10)),
  ai_fit_estimate_label     text NOT NULL DEFAULT 'AI heuristic — not validated',
  past_sku_ids              uuid[] NOT NULL DEFAULT '{}',
  status                    text NOT NULL DEFAULT 'proposed'
                              CHECK (status IN ('proposed', 'accepted', 'rejected', 'shipped')),
  generated_by              text,
  model                     text,
  token_usage               jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_design_concepts_trend_brief_id
  ON ip_design_concepts (trend_brief_id);

CREATE INDEX IF NOT EXISTS idx_ip_design_concepts_status
  ON ip_design_concepts (status);

ALTER TABLE ip_design_concepts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_ip_design_concepts" ON ip_design_concepts;
CREATE POLICY "anon_all_ip_design_concepts" ON ip_design_concepts
  FOR ALL TO anon USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
