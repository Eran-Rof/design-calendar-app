-- 20260513154000_ip_ai_call_log.sql
--
-- AI-assisted apparel design pipeline — cross-stage cost guardrail.
-- Append-only log of every Claude / Fal call made by the design pipeline.
--
-- Premortem mitigation #6: v1 had cost capped "in the Fal dashboard" —
-- hand-wavy and silent. v2 enforces a hard monthly cap in code:
-- before every AI call, api/_lib/ai-budget.js sums cost_usd for the
-- current month and refuses with HTTP 402 if it crosses
-- AI_MONTHLY_BUDGET_USD (default $200 trial budget).
--
-- related_table / related_id are loose pointers (no FK) because a call
-- might tie to a brief, concept, palette, tech pack, or none of those.
-- A nullable FK to each would have explosively many columns.

CREATE TABLE IF NOT EXISTS ip_ai_call_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handler_name    text NOT NULL,            -- e.g. 'design/trend-brief/synthesize'
  model           text NOT NULL,            -- e.g. 'claude-sonnet-4-6'
  input_tokens    integer,
  output_tokens   integer,
  cost_usd        numeric(10,6) NOT NULL DEFAULT 0,
  related_table   text,                     -- 'ip_trend_briefs' | 'tech_packs' | ...
  related_id      uuid,
  called_at       timestamptz NOT NULL DEFAULT now(),
  error           text                      -- non-null when the call failed; cost still logged
);

CREATE INDEX IF NOT EXISTS idx_ip_ai_call_log_called_at
  ON ip_ai_call_log (called_at DESC);

CREATE INDEX IF NOT EXISTS idx_ip_ai_call_log_handler
  ON ip_ai_call_log (handler_name, called_at DESC);

ALTER TABLE ip_ai_call_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_ip_ai_call_log" ON ip_ai_call_log;
CREATE POLICY "anon_all_ip_ai_call_log" ON ip_ai_call_log
  FOR ALL TO anon USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
