-- Saved Ask AI documents (Tier 3J of the improvement plan).
--
-- A document is a NAMED, persisted invocation of a workflow (from
-- api/_lib/ai/workflows.js) with stored params. Opening the document
-- re-runs the workflow against live data, so the operator gets a
-- "saved report template" instead of a static snapshot.
--
-- Privacy: user_id = NULL means visible to every operator (shared);
-- otherwise only the owner sees it. Mirrors the user/global scope
-- shape from ip_ai_user_facts.
--
-- Scale: dozens of docs, max. Pagination not needed at this volume.

CREATE TABLE IF NOT EXISTS ip_ai_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           text,                -- plm_user.id; NULL = shared with everyone
  name              text NOT NULL,
  description       text,
  workflow_name     text NOT NULL,       -- references WORKFLOWS[].name (no FK — code-owned)
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by        text,                -- author plm_user.id
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_rendered_at  timestamptz          -- bumped on every successful /render call
);

-- Fast per-operator listing.
CREATE INDEX IF NOT EXISTS idx_ip_ai_documents_owner
  ON ip_ai_documents (user_id, updated_at DESC);

-- Workflow-scoped lookups (e.g. "show every doc using monday_briefing").
CREATE INDEX IF NOT EXISTS idx_ip_ai_documents_workflow
  ON ip_ai_documents (workflow_name);

COMMENT ON TABLE ip_ai_documents IS
  'Saved Ask AI workflow invocations. Each render re-runs the workflow against live data. Tier 3J.';
