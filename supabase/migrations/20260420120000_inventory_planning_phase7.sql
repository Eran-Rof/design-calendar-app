-- 20260420120000_inventory_planning_phase7.sql
--
-- Demand & Inventory Planning — Phase 7 (Governance, Roles, Performance,
-- Production hardening).
--
-- Adds the bones of a production-safe planning platform: a role model
-- with explicit permission sets, a user→role join, background job
-- tracking, per-integration health, and stale-data thresholds.
--
-- Design decisions flagged for review:
--   • Permissions live as a JSONB blob on ip_roles. That keeps the
--     permission surface open for future additions without a migration
--     per new permission key. Enum strings are whitelisted in
--     permissionService.ts.
--   • User identity is email-based (MVP) — the internal app still
--     stores users in the app_data['users'] JSON blob. A later pass
--     can swap ip_user_roles.user_email for a uuid FK without changing
--     permission semantics.
--   • Job runs are generic: any service can insert a row and poll it.
--     Retries don't happen automatically — the UI exposes a retry
--     button that inserts a new row referencing the failed one.
--   • Audit hardening: Phase 4's ip_change_audit_log is already
--     schema-light. Phase 7 defines an `audit_category` free-text
--     column IF we wanted to add it later; for MVP we introduce a
--     conventional prefix in the change_reason column ("category:xxx")
--     and document that in the README. No schema change.

-- ── ip_roles ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name       text NOT NULL UNIQUE,
  description     text,
  -- JSONB map of permission_key → boolean. Keys are whitelisted in
  -- src/inventory-planning/governance/services/permissionService.ts.
  permissions     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system       boolean NOT NULL DEFAULT false,  -- true = built-in, can't delete
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_ip_roles_updated ON ip_roles;
CREATE TRIGGER trg_ip_roles_updated BEFORE UPDATE ON ip_roles
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- Seed the six standard roles. Permissions are conservative — admin
-- has everything, planner has day-to-day edit, viewer is read-only, etc.
INSERT INTO ip_roles (role_name, description, permissions, is_system) VALUES
  ('admin', 'Full access including user/role management and ERP writeback', '{
    "read_forecasts": true, "edit_forecasts": true, "edit_buyer_requests": true,
    "edit_ecom_overrides": true, "manage_scenarios": true, "approve_plans": true,
    "view_audit_logs": true, "create_execution_batches": true,
    "approve_execution": true, "run_exports": true, "run_writeback": true,
    "manage_integrations": true, "manage_allocation_rules": true,
    "manage_ai_suggestions": true, "manage_users_or_roles": true
  }'::jsonb, true),
  ('planning_manager', 'Planner lead — approves plans, manages scenarios, can export', '{
    "read_forecasts": true, "edit_forecasts": true, "edit_buyer_requests": true,
    "edit_ecom_overrides": true, "manage_scenarios": true, "approve_plans": true,
    "view_audit_logs": true, "create_execution_batches": true,
    "approve_execution": false, "run_exports": true, "run_writeback": false,
    "manage_integrations": false, "manage_allocation_rules": true,
    "manage_ai_suggestions": true, "manage_users_or_roles": false
  }'::jsonb, true),
  ('planner', 'Day-to-day planning — edits forecasts, runs scenarios, exports', '{
    "read_forecasts": true, "edit_forecasts": true, "edit_buyer_requests": true,
    "edit_ecom_overrides": true, "manage_scenarios": true, "approve_plans": false,
    "view_audit_logs": true, "create_execution_batches": false,
    "approve_execution": false, "run_exports": true, "run_writeback": false,
    "manage_integrations": false, "manage_allocation_rules": false,
    "manage_ai_suggestions": false, "manage_users_or_roles": false
  }'::jsonb, true),
  ('operations_user', 'Operations — reviews/executes approved batches, no forecast edit', '{
    "read_forecasts": true, "edit_forecasts": false, "edit_buyer_requests": false,
    "edit_ecom_overrides": false, "manage_scenarios": false, "approve_plans": false,
    "view_audit_logs": true, "create_execution_batches": true,
    "approve_execution": true, "run_exports": true, "run_writeback": true,
    "manage_integrations": false, "manage_allocation_rules": false,
    "manage_ai_suggestions": false, "manage_users_or_roles": false
  }'::jsonb, true),
  ('executive_viewer', 'Read-only across everything planning-related', '{
    "read_forecasts": true, "edit_forecasts": false, "edit_buyer_requests": false,
    "edit_ecom_overrides": false, "manage_scenarios": false, "approve_plans": false,
    "view_audit_logs": true, "create_execution_batches": false,
    "approve_execution": false, "run_exports": true, "run_writeback": false,
    "manage_integrations": false, "manage_allocation_rules": false,
    "manage_ai_suggestions": false, "manage_users_or_roles": false
  }'::jsonb, true),
  ('integration_service', 'Machine account for sync jobs — no UI edit rights', '{
    "read_forecasts": true, "edit_forecasts": false, "edit_buyer_requests": false,
    "edit_ecom_overrides": false, "manage_scenarios": false, "approve_plans": false,
    "view_audit_logs": false, "create_execution_batches": false,
    "approve_execution": false, "run_exports": false, "run_writeback": false,
    "manage_integrations": true, "manage_allocation_rules": false,
    "manage_ai_suggestions": false, "manage_users_or_roles": false
  }'::jsonb, true)
ON CONFLICT (role_name) DO NOTHING;

-- ── ip_user_roles ─────────────────────────────────────────────────────────
-- Simple email → role mapping. MVP; swap to auth.uid() when real SSO lands.
CREATE TABLE IF NOT EXISTS ip_user_roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email    text NOT NULL,
  role_id       uuid NOT NULL REFERENCES ip_roles(id) ON DELETE CASCADE,
  granted_by    text,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  active        boolean NOT NULL DEFAULT true,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A user can hold multiple roles (permissions OR across them).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_user_roles_email_role
  ON ip_user_roles (lower(user_email), role_id);
CREATE INDEX IF NOT EXISTS idx_ip_user_roles_email  ON ip_user_roles (lower(user_email));
CREATE INDEX IF NOT EXISTS idx_ip_user_roles_active ON ip_user_roles (active) WHERE active;

DROP TRIGGER IF EXISTS trg_ip_user_roles_updated ON ip_user_roles;
CREATE TRIGGER trg_ip_user_roles_updated BEFORE UPDATE ON ip_user_roles
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_job_runs ────────────────────────────────────────────────────────────
-- Generic job tracker. Any service that kicks off async work inserts a
-- row; the UI reads them by status.
CREATE TABLE IF NOT EXISTS ip_job_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'xoro_sync' | 'shopify_sync' | 'forecast_wholesale' | 'forecast_ecom'
  -- | 'reconciliation' | 'scenario_recompute' | 'accuracy_pass' |
  -- 'ai_suggestions' | 'execution_batch_build' | 'writeback_submit' |
  -- 'export' | 'other'
  job_type        text NOT NULL,
  -- Free-text scope label: e.g. the run id, "demo-scenario-2026-04",
  -- or "api:writeback:create-buy-request:<action_id>"
  job_scope       text,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN (
                      'queued', 'running', 'succeeded', 'failed',
                      'cancelled', 'partial_success'
                    )),
  started_at      timestamptz,
  completed_at    timestamptz,
  initiated_by    text,
  input_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json     jsonb,
  error_message   text,
  retry_count     integer NOT NULL DEFAULT 0,
  retry_of        uuid REFERENCES ip_job_runs(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_job_runs_status      ON ip_job_runs (status);
CREATE INDEX IF NOT EXISTS idx_ip_job_runs_type        ON ip_job_runs (job_type);
CREATE INDEX IF NOT EXISTS idx_ip_job_runs_created     ON ip_job_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_job_runs_initiator   ON ip_job_runs (initiated_by);
CREATE INDEX IF NOT EXISTS idx_ip_job_runs_retry_of    ON ip_job_runs (retry_of) WHERE retry_of IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ip_job_runs_updated ON ip_job_runs;
CREATE TRIGGER trg_ip_job_runs_updated BEFORE UPDATE ON ip_job_runs
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_integration_health ──────────────────────────────────────────────────
-- One row per integration endpoint. Updated by sync jobs; read by the
-- admin dashboard.
CREATE TABLE IF NOT EXISTS ip_integration_health (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_name            text NOT NULL,                      -- 'xoro' | 'shopify'
  endpoint               text NOT NULL,                      -- 'sales-history' | 'orders' | ...
  last_attempt_at        timestamptz,
  last_success_at        timestamptz,
  last_error_at          timestamptz,
  last_error_message     text,
  last_rows_synced       integer,
  -- Derived: 'healthy' | 'warning' | 'error' | 'unknown'.
  -- The admin service computes this from thresholds and writes it here.
  status                 text NOT NULL DEFAULT 'unknown'
                           CHECK (status IN ('healthy', 'warning', 'error', 'unknown')),
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_integration_health_system_endpoint
  ON ip_integration_health (system_name, endpoint);

DROP TRIGGER IF EXISTS trg_ip_integration_health_updated ON ip_integration_health;
CREATE TRIGGER trg_ip_integration_health_updated BEFORE UPDATE ON ip_integration_health
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- Seed the integration endpoints the planning module knows about so the
-- admin dashboard isn't empty on day one. Status starts as 'unknown'
-- and flips as syncs run.
INSERT INTO ip_integration_health (system_name, endpoint, status) VALUES
  ('xoro',    'sales-history',      'unknown'),
  ('xoro',    'inventory-snapshot', 'unknown'),
  ('xoro',    'receipts',           'unknown'),
  ('xoro',    'items',              'unknown'),
  ('xoro',    'open-pos',           'unknown'),
  ('shopify', 'orders',             'unknown'),
  ('shopify', 'products',           'unknown'),
  ('shopify', 'collections',        'unknown'),
  ('shopify', 'returns',            'unknown'),
  ('shopify', 'inventory',          'unknown')
ON CONFLICT (system_name, endpoint) DO NOTHING;

-- ── ip_data_freshness_thresholds ───────────────────────────────────────────
-- Declarative policy for "what counts as stale?" Every entity_type is
-- free text (keeps the schema open). Severity is used by the UI to
-- color the banner.
CREATE TABLE IF NOT EXISTS ip_data_freshness_thresholds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL UNIQUE,
  -- Hours beyond which the entity is considered stale.
  max_age_hours   integer NOT NULL,
  severity        text NOT NULL DEFAULT 'warning'
                    CHECK (severity IN ('info', 'warning', 'critical')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_ip_freshness_updated ON ip_data_freshness_thresholds;
CREATE TRIGGER trg_ip_freshness_updated BEFORE UPDATE ON ip_data_freshness_thresholds
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

INSERT INTO ip_data_freshness_thresholds (entity_type, max_age_hours, severity, note) VALUES
  ('xoro_sales_history',   48,  'warning',  'Wholesale demand history older than 2 days → flag'),
  ('xoro_inventory',       24,  'critical', 'On-hand older than 1 day is risky for buy decisions'),
  ('xoro_open_pos',        24,  'warning',  'Open PO book older than 1 day flags supply context'),
  ('shopify_orders',       24,  'warning',  'Ecom orders older than 1 day flag velocity signal'),
  ('shopify_products',     168, 'info',     'Product catalog older than 7 days → soft nudge'),
  ('planning_run',         168, 'warning',  'Plans older than 7 days should be refreshed before execution'),
  ('wholesale_forecast',   168, 'warning',  'Forecast older than 7 days → banner on wholesale grid'),
  ('ecom_forecast',        72,  'warning',  'Ecom forecast older than 3 days → banner on ecom grid')
ON CONFLICT (entity_type) DO NOTHING;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE ip_roles                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_user_roles                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_job_runs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_integration_health          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_data_freshness_thresholds   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ip_roles', 'ip_user_roles', 'ip_job_runs',
    'ip_integration_health', 'ip_data_freshness_thresholds'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ── Seed a default admin user so dev envs have someone who can do things ─
-- Idempotent: only inserts if the user_email row doesn't exist.
DO $$
DECLARE v_admin_role uuid;
BEGIN
  SELECT id INTO v_admin_role FROM ip_roles WHERE role_name = 'admin';
  IF v_admin_role IS NOT NULL THEN
    INSERT INTO ip_user_roles (user_email, role_id, granted_by, note)
    SELECT 'admin@local', v_admin_role, 'system', 'Seeded by Phase 7 migration'
    WHERE NOT EXISTS (
      SELECT 1 FROM ip_user_roles WHERE lower(user_email) = 'admin@local' AND role_id = v_admin_role
    );
  END IF;
END $$;
