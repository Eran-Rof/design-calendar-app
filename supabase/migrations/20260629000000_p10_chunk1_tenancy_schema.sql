-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P10-1 — Tenancy / RLS flip foundation schema
--
-- Implements the foundation schema deltas accepted in
--   docs/tangerine/P10-tenancy-architecture.md (PR #479).
--
-- Scope (this migration only):
--   1. Seed the SANDBOX entity row (D1 — 2 entities at v1: ROF + SANDBOX
--      negative test bed).
--   2. Add entity_users.is_default + a per-user partial unique index so each
--      user has at most one default entity (D6 — one login, multi-row
--      entity_users with role-per-entity).
--   3. Create entity_access_audit — append-only denial / switch / sign-in
--      log (D5 — three-pronged audit). No RLS; admin / service-role only.
--   4. Add entities.multi_entity_enabled feature flag — flips the switcher
--      UI on per-entity (D10 — feature-flag rollout). Stays false for ROF
--      until P10-5 ships the switcher.
--   5. Backfill is_default=true for every existing entity_users row so
--      the in-flight signed-in user has a sane default the moment the
--      switcher lands.
--
-- Not in this chunk (deferred to later P10 chunks per arch §6):
--   • current_entity_id() helper          → P10-2
--   • RLS policy audit framework          → P10-2
--   • DEFAULT current_entity_id() swap    → P10-2
--   • entities.is_sandbox flag             → P10-2 (no consumer this chunk)
--   • Switcher API + UI                   → P10-3 / P10-5
--
-- Idempotent: CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
-- DO $$ EXCEPTION WHEN duplicate_object guards throughout. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Seed SANDBOX entity (D1) ───────────────────────────────────────────
-- Required columns per CURRENT-SCHEMA.md: id (default), name, slug, status
-- (default 'active'), metadata (default '{}'). code is nullable but populated
-- for the switcher lookup. functional_currency / fiscal_year_start_month /
-- accounting_basis_primary / country mirror ROF defaults so accounting
-- modules behave consistently in the negative-test bed.
INSERT INTO entities (
  code,
  name,
  slug,
  status,
  functional_currency,
  fiscal_year_start_month,
  accounting_basis_primary,
  country,
  metadata
) VALUES (
  'SANDBOX',
  'Sandbox Negative Test Bed',
  'sandbox',
  'active',
  'USD',
  1,
  'ACCRUAL',
  'US',
  '{"is_sandbox": true, "seeded_by": "p10-chunk1"}'::jsonb
) ON CONFLICT (code) DO NOTHING;

-- ─── 2. entity_users.is_default flag (D6) ──────────────────────────────────
-- Tracks which entity_users row is "where this auth user lands by default
-- after sign-in / where their dropdown defaults to". Partial unique index
-- guarantees at most one default per user.
ALTER TABLE entity_users
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN entity_users.is_default IS 'P10-1: marks the default entity_users row for this auth user. Enforced single-default via partial unique index entity_users_one_default_per_user. Read on sign-in to decide which entity to land in.';

-- Partial unique index — at most one default per (auth_id) user.
-- NB: CURRENT-SCHEMA.md confirms entity_users uses auth_id (not
-- auth_user_id) — keep the actual column name per the project rule.
CREATE UNIQUE INDEX IF NOT EXISTS entity_users_one_default_per_user
  ON entity_users (auth_id)
  WHERE is_default = true;

-- ─── 3. entity_access_audit table (D5) ─────────────────────────────────────
-- Append-only log. No RLS — admin audit table accessible only via
-- SECURITY DEFINER RPC or service-role. attempted_action holds the
-- request verb; event_kind is reserved for the richer arch-doc taxonomy
-- in P10-2 (rls_deny / switch / sign_in_default / admin_override).
CREATE TABLE IF NOT EXISTS entity_access_audit (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  attempted_entity_id  uuid REFERENCES entities(id) ON DELETE SET NULL,
  attempted_table      text NOT NULL,
  attempted_action     text NOT NULL CHECK (attempted_action IN ('select','insert','update','delete')),
  attempted_pk         text,
  denied_at            timestamptz NOT NULL DEFAULT now(),
  request_id           text,
  user_agent           text
);

COMMENT ON TABLE entity_access_audit IS 'P10-1: append-only denial log for cross-entity access attempts. No RLS — admin / service-role only. Auditor evidence trail per P10 arch §3.3.';
COMMENT ON COLUMN entity_access_audit.attempted_action IS 'Lower-case SQL verb: select|insert|update|delete.';
COMMENT ON COLUMN entity_access_audit.attempted_pk IS 'Row primary key if known at deny time; otherwise NULL (e.g. denied list query).';

-- Lookup index — common admin query is "what did user X attempt in the
-- last hour" so an (auth_user_id, denied_at DESC) index covers it.
CREATE INDEX IF NOT EXISTS idx_entity_access_audit_user_time
  ON entity_access_audit (auth_user_id, denied_at DESC);

-- NB: deliberately NO `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` — this
-- table is service-role only. Service role bypasses RLS regardless; an
-- anon-key read of this table will fail with "permission denied" because
-- the table has no anon GRANT.

-- ─── 4. entities.multi_entity_enabled feature flag (D10) ───────────────────
-- Per-entity flag. When false the entity-switcher UI stays hidden /
-- collapsed to a single-entity badge for users whose default entity has
-- the flag off. Operator self-enables ROF when P10-5 ships the switcher.
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS multi_entity_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN entities.multi_entity_enabled IS 'P10-1: feature flag — when true, the entity-switcher UI is exposed for users whose default entity is this one. Defaults to false (including for ROF) so the existing single-entity UX is unchanged until the switcher lands in P10-5 and the operator opts in.';

-- ─── 5. Backfill is_default for existing entity_users rows ─────────────────
-- Every pre-existing row gets is_default=true so the in-flight user has a
-- sane default the moment the switcher lands. Skipped if multiple rows
-- already exist for a single auth_id (would violate the partial unique
-- index) — those few rows are handled manually by the operator post-flip.
UPDATE entity_users
   SET is_default = true
 WHERE auth_id IS NOT NULL
   AND is_default = false
   AND auth_id IN (
     SELECT auth_id
       FROM entity_users
      WHERE auth_id IS NOT NULL
      GROUP BY auth_id
     HAVING count(*) = 1
   );

-- ─── 6. PostgREST schema reload ────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
