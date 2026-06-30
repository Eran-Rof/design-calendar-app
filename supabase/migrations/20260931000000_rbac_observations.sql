-- 20260931000000_rbac_observations.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P27 Phase 5 warm-up — make RBAC log-only ACTIONABLE.
--
-- rbacObserve() (RBAC_MODE='log') today only console.warns a "would-deny" to the
-- Vercel logs — invisible/ephemeral. This persists each would-deny as an
-- aggregated counter so the operator gets a real COVERAGE REPORT before flipping
-- RBAC_MODE='enforce': "user X would lose module Y:action" → grant it first.
--
-- Aggregated (one row per entity+user+module+action, hits incremented) so volume
-- stays tiny even if every request is a would-deny during warm-up. Service-role
-- only (RLS on, no anon policy). NOT a security control — pure observability.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rbac_observations (
  entity_id   uuid NOT NULL,
  auth_id     uuid NOT NULL,
  module_key  text NOT NULL,
  action      text NOT NULL,
  method      text,
  sample_path text,
  hits        bigint NOT NULL DEFAULT 0,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, auth_id, module_key, action)
);

ALTER TABLE rbac_observations ENABLE ROW LEVEL SECURITY;
-- No anon/auth policy: service-role (the dispatcher + admin endpoint) bypasses
-- RLS; everyone else is denied. Internal observability, never client-read.

-- Cheap upsert-increment called by rbacObserve on each would-deny.
CREATE OR REPLACE FUNCTION rbac_record_observation(
  p_entity uuid, p_auth uuid, p_module text, p_action text, p_method text, p_path text
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO rbac_observations (entity_id, auth_id, module_key, action, method, sample_path, hits)
  VALUES (p_entity, p_auth, p_module, p_action, p_method, p_path, 1)
  ON CONFLICT (entity_id, auth_id, module_key, action)
  DO UPDATE SET hits        = rbac_observations.hits + 1,
                last_seen   = now(),
                method      = EXCLUDED.method,
                sample_path = EXCLUDED.sample_path;
$$;

COMMENT ON TABLE rbac_observations IS 'P27 Phase 5 warm-up: aggregated RBAC would-deny observations (RBAC_MODE=log). Drives the pre-enforce coverage report. Not a security control.';

NOTIFY pgrst, 'reload schema';
