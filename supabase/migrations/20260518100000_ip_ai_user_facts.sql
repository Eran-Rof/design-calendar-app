-- Operator-authored facts for the Ask AI panel (Tier 2H of the improvement plan).
--
-- Lets internal staff teach the AI things that are not in the schema or
-- in the curated glossary — e.g. "RYB0412 is our top-selling jogger family,
-- always surface the PPK24 variant alongside the SKU rows" or "when someone
-- asks about discounts, the formula is qty * price * (1 - discount_pct/100)
-- where discount_pct comes from the customer-tier table, not the SO header".
--
-- Retrieval shape: case-insensitive substring match on `topic` (style code,
-- customer name, short topic keyword), keyed optionally by user_id and app
-- for personalization. Global facts (user_id = NULL) apply to every operator.
--
-- Scale: hundreds of rows, max. Substring match in Postgres is fine until
-- volume justifies pgvector / pg_trgm — neither is needed at MVP.

CREATE TABLE IF NOT EXISTS ip_ai_user_facts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text,                  -- plm_user.id; NULL = global fact (applies to all operators)
  app          text,                  -- 'ats' / 'planning' / etc.; NULL = applies to all apps
  topic        text NOT NULL,         -- keyword for retrieval (style code, customer name, free topic)
  fact         text NOT NULL,         -- free-text fact body
  created_by   text,                  -- plm_user.id of the author (audit trail)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Fast topic lookup. Lowercased for case-insensitive substring match.
CREATE INDEX IF NOT EXISTS idx_ip_ai_user_facts_topic_lower
  ON ip_ai_user_facts ((lower(topic)));

-- Scope filter for per-(user, app) reads.
CREATE INDEX IF NOT EXISTS idx_ip_ai_user_facts_scope
  ON ip_ai_user_facts (user_id, app);

COMMENT ON TABLE ip_ai_user_facts IS
  'Operator-authored facts retrieved by Ask AI via lookup_user_facts(topic). Tier 2H.';
