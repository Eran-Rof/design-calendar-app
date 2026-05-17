-- Answer cache for the Ask AI panel.
--
-- Caches successful AI replies keyed on a SHA-256 hash of the
-- normalised question (+ a stable fingerprint of the grid context
-- that materially affects the answer). Hits return immediately
-- without re-running the Claude tool loop — biggest perceived speed
-- win for repeated questions like "open AR by status" or "compliance
-- docs expiring this month".
--
-- TTL is checked on read (expires_at > now()); rows past expiry are
-- treated as misses. A nightly cron could prune but isn't necessary
-- — the table stays small (one row per distinct question).

CREATE TABLE IF NOT EXISTS ip_ai_answer_cache (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_hash   text NOT NULL UNIQUE,    -- sha256 hex of normalised question + fingerprint
  question        text NOT NULL,           -- raw question (for debugging + dashboard)
  answer_text     text NOT NULL,
  actions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggestion      jsonb,                   -- nullable
  token_usage     jsonb,                   -- {input_tokens, output_tokens, cost_usd}
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  hit_count       int NOT NULL DEFAULT 0,
  last_hit_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ip_ai_answer_cache_hash_expires
  ON ip_ai_answer_cache (question_hash, expires_at);

CREATE INDEX IF NOT EXISTS idx_ip_ai_answer_cache_expires
  ON ip_ai_answer_cache (expires_at);

COMMENT ON TABLE ip_ai_answer_cache IS
  'Cached AI replies for the Ask AI panel. TTL via expires_at. See api/_lib/ai-answer-cache.js.';
