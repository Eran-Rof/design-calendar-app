-- 20260513150000_ip_trend_briefs.sql
--
-- AI-assisted apparel design pipeline — Stage 1.
-- Monthly Claude-synthesized trend brief.
--
-- Pipeline contract: fetch_trend_sources.py drops raw source dumps
-- into the trend-sources/ bucket at path '<YYYY-MM>/<source>.json'.
-- post_trend_brief.py POSTs to /api/internal/design/trend-brief/synthesize
-- which reads the bucket, calls Claude Sonnet, and writes one row here.
--
-- One non-archived brief per month (unique partial index). Status flow:
--   draft → published → archived
-- Auth is gated at the API layer via authenticateDesignCalendarCaller;
-- the anon RLS policy matches the existing project-wide pattern.

CREATE TABLE IF NOT EXISTS ip_trend_briefs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_month  date NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'published', 'archived')),
  title        text,
  summary_md   text,
  themes_jsonb jsonb,
  raw_sources  jsonb,
  model        text,
  token_usage  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ip_trend_briefs_active_per_month
  ON ip_trend_briefs (brief_month)
  WHERE status != 'archived';

CREATE INDEX IF NOT EXISTS idx_ip_trend_briefs_status
  ON ip_trend_briefs (status);

CREATE INDEX IF NOT EXISTS idx_ip_trend_briefs_month
  ON ip_trend_briefs (brief_month DESC);

ALTER TABLE ip_trend_briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_ip_trend_briefs" ON ip_trend_briefs;
CREATE POLICY "anon_all_ip_trend_briefs" ON ip_trend_briefs
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- Storage bucket for raw source dumps. Service-role only — no anon
-- policy, no public URLs. Frontend reads via signed URLs minted by
-- the API handlers, which use the service-role client.
INSERT INTO storage.buckets (id, name, public)
VALUES ('trend-sources', 'trend-sources', false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
