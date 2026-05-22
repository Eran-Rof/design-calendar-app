-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 1 / Migration 2
-- entity_users: junction of auth.users → entities for internal staff and the
-- (deferred-identity) external accountant. Replaces what would otherwise need
-- to be a flag/column on auth.users.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §3.3
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS entity_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id   uuid NOT NULL REFERENCES entities(id)   ON DELETE CASCADE,
  role        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_users_auth_entity_unique UNIQUE (auth_id, entity_id),
  CONSTRAINT entity_users_role_check
    CHECK (role IN ('admin', 'accountant', 'staff', 'readonly'))
);

CREATE INDEX IF NOT EXISTS idx_entity_users_entity ON entity_users (entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_users_auth   ON entity_users (auth_id);
CREATE INDEX IF NOT EXISTS idx_entity_users_role   ON entity_users (entity_id, role);

ALTER TABLE entity_users ENABLE ROW LEVEL SECURITY;

-- Internal SPA path (anon key) — full access, matching pattern in invoices etc.
CREATE POLICY "anon_all_entity_users" ON entity_users
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- A signed-in user can see their OWN entity_users rows (which entities + roles they hold).
-- Cross-user visibility belongs to admin tooling and uses the anon-key SPA path.
CREATE POLICY "auth_own_entity_users_select" ON entity_users
  FOR SELECT TO authenticated
  USING (auth_id = auth.uid());

COMMENT ON TABLE  entity_users IS 'Junction of auth.users → entities for internal staff and external accountant. Role is text+CHECK (per Tangerine P1 decision).';
COMMENT ON COLUMN entity_users.role IS 'admin | accountant | staff | readonly. Adding values requires ALTER CONSTRAINT entity_users_role_check.';
