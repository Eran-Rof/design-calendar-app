-- 20260707000000_p14_chunk1_rbac_schema.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P14 RBAC — Chunk 1: schema + seed + backfill.
--
-- Per docs/tangerine/P14-rbac-architecture.md. Layers a per-MODULE × per-ACTION
-- permission matrix on top of P1's entity_users junction (which is NOT touched
-- or replaced — its `role` text column is read once here to seed the new layer).
--
-- ZERO ENFORCEMENT in this chunk: no handler checks permissions yet. The
-- backfill maps every existing entity_users row to the seed role of the same
-- name (defaulting to `admin`), so day-1 everyone keeps exactly the access they
-- have today. Enforcement (log-only, then reject) arrives in chunks 2–3.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT) so a re-apply
-- under supabase-db-push is a safe no-op.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. module_keys — canonical module list (data, not a CHECK constraint) ───
CREATE TABLE IF NOT EXISTS module_keys (
  key               text PRIMARY KEY,
  display_name      text NOT NULL,
  group_name        text NOT NULL,
  sort_order        smallint NOT NULL DEFAULT 0,
  description       text,
  available_actions text[] NOT NULL DEFAULT ARRAY['read','write','export']::text[]
);

-- ─── 2. roles — org-wide role templates (entity-agnostic) ────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL UNIQUE,
  description        text,
  is_seed            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_name ON roles (name);

-- ─── 3. role_permissions — the sparse boolean matrix per role ────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module_key  text NOT NULL REFERENCES module_keys(key) ON DELETE RESTRICT,
  action      text NOT NULL CHECK (action IN ('read','write','post','void','export')),
  allowed     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, module_key, action)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions (role_id);

-- ─── 4. entity_user_roles — role assignment per (user, entity) ───────────────
CREATE TABLE IF NOT EXISTS entity_user_roles (
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id            uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (entity_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_user_roles_user ON entity_user_roles (user_id);
CREATE INDEX IF NOT EXISTS idx_entity_user_roles_role ON entity_user_roles (role_id);

-- ─── 5. entity_user_role_overrides — per-cell allow/revoke deltas ────────────
CREATE TABLE IF NOT EXISTS entity_user_role_overrides (
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module_key         text NOT NULL REFERENCES module_keys(key) ON DELETE RESTRICT,
  action             text NOT NULL CHECK (action IN ('read','write','post','void','export')),
  allowed            boolean NOT NULL,           -- true = grant, false = revoke
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (entity_id, user_id, module_key, action)
);
CREATE INDEX IF NOT EXISTS idx_eur_overrides_user ON entity_user_role_overrides (entity_id, user_id);

-- ─── 6. T11 universal-audit hooks (every grant change → row_changes) ─────────
DROP TRIGGER IF EXISTS trg_entity_user_roles_audit ON entity_user_roles;
CREATE TRIGGER trg_entity_user_roles_audit
  AFTER INSERT OR UPDATE OR DELETE ON entity_user_roles
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

DROP TRIGGER IF EXISTS trg_eur_overrides_audit ON entity_user_role_overrides;
CREATE TRIGGER trg_eur_overrides_audit
  AFTER INSERT OR UPDATE OR DELETE ON entity_user_role_overrides
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

-- ─── 7. RLS — canonical anon-permissive template (internal 4 sub-apps use the
--        anon key). The tighter has_permission()-gated write policy lands in
--        chunk 3 alongside enforcement; chunk 1 stays permissive = no break.
ALTER TABLE module_keys                ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_user_roles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_user_role_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_module_keys" ON module_keys;
CREATE POLICY "anon_all_module_keys" ON module_keys FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_all_roles" ON roles;
CREATE POLICY "anon_all_roles" ON roles FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_all_role_permissions" ON role_permissions;
CREATE POLICY "anon_all_role_permissions" ON role_permissions FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_all_entity_user_roles" ON entity_user_roles;
CREATE POLICY "anon_all_entity_user_roles" ON entity_user_roles FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_all_eur_overrides" ON entity_user_role_overrides;
CREATE POLICY "anon_all_eur_overrides" ON entity_user_role_overrides FOR ALL TO anon USING (true) WITH CHECK (true);

-- ─── 8. v_effective_permissions — role grants ∪ overrides − revocations ──────
CREATE OR REPLACE VIEW v_effective_permissions AS
WITH role_grants AS (
  SELECT eur.entity_id, eur.user_id, rp.module_key, rp.action
  FROM entity_user_roles eur
  JOIN role_permissions rp ON rp.role_id = eur.role_id AND rp.allowed = true
),
grants_plus AS (
  SELECT entity_id, user_id, module_key, action FROM role_grants
  UNION
  SELECT entity_id, user_id, module_key, action
  FROM entity_user_role_overrides WHERE allowed = true
)
SELECT g.entity_id, g.user_id, g.module_key, g.action, true AS allowed
FROM grants_plus g
WHERE NOT EXISTS (
  SELECT 1 FROM entity_user_role_overrides r
  WHERE r.allowed = false
    AND r.entity_id  = g.entity_id
    AND r.user_id    = g.user_id
    AND r.module_key = g.module_key
    AND r.action     = g.action
);

-- ─── 9. has_permission() — single source of truth for middleware + RLS ───────
CREATE OR REPLACE FUNCTION has_permission(
  p_auth_id    uuid,
  p_entity_id  uuid,
  p_module_key text,
  p_action     text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM v_effective_permissions
    WHERE user_id = p_auth_id
      AND entity_id = p_entity_id
      AND module_key = p_module_key
      AND action = p_action
  );
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- SEED DATA
-- ════════════════════════════════════════════════════════════════════════════

-- 9a. module_keys (~32 modules, §3.1). Postable accounting modules expose all
--     5 actions; CRUD modules read/write/export; report/read-only modules
--     read/export.
INSERT INTO module_keys (key, display_name, group_name, sort_order, available_actions) VALUES
  ('style_master',   'Style Master',            'Master Data', 10, ARRAY['read','write','export']),
  ('product_master', 'Product Master',          'Master Data', 20, ARRAY['read','write','export']),
  ('vendor_master',  'Vendor Master',           'Master Data', 30, ARRAY['read','write','export']),
  ('customer_master','Customer Master',         'Master Data', 40, ARRAY['read','write','export']),
  ('coa',            'Chart of Accounts',       'Accounting',  50, ARRAY['read','write','export']),
  ('gl_periods',     'GL Periods',              'Accounting',  60, ARRAY['read','write','post','void','export']),
  ('je_entry',       'Journal Entries (draft)', 'Accounting',  70, ARRAY['read','write','export']),
  ('je_post',        'Journal Entries (post)',  'Accounting',  80, ARRAY['read','write','post','void','export']),
  ('ar_invoices',    'AR Invoices',             'Accounting',  90, ARRAY['read','write','post','void','export']),
  ('ar_receipts',    'AR Receipts',             'Accounting', 100, ARRAY['read','write','post','void','export']),
  ('ap_invoices',    'AP Invoices',             'Accounting', 110, ARRAY['read','write','post','void','export']),
  ('ap_payments',    'AP Payments',             'Accounting', 120, ARRAY['read','write','post','void','export']),
  ('bank_recon',     'Bank Reconciliation',     'Accounting', 130, ARRAY['read','write','post','void','export']),
  ('inventory',      'Inventory',               'Operations', 140, ARRAY['read','write','export']),
  ('po_wip',         'PO WIP',                  'Operations', 150, ARRAY['read','write','export']),
  ('procurement',    'Procurement (P13)',       'Operations', 160, ARRAY['read','write','post','export']),
  ('ats',            'ATS Planning',            'Planning',   170, ARRAY['read','export']),
  ('sales_comps',    'Sales Comps',             'Reports',    180, ARRAY['read','export']),
  ('costing',        'Costing',                 'Operations', 190, ARRAY['read','write','export']),
  ('gs1',            'GS1 Labels',              'Operations', 200, ARRAY['read','write','export']),
  ('tech_pack',      'Tech Packs',              'Operations', 210, ARRAY['read','write','export']),
  ('shopify',        'Shopify (P11)',           'Marketplaces',220, ARRAY['read','export']),
  ('marketplaces',   'Marketplaces (P12)',      'Marketplaces',230, ARRAY['read','export']),
  ('parallel_run',   'Parallel-Run (P9)',       'Accounting', 240, ARRAY['read','export']),
  ('workflows',      'Workflows & Approvals',   'Admin',      250, ARRAY['read','write','export']),
  ('notifications',  'Notifications',           'Admin',      260, ARRAY['read','write','export']),
  ('users_access',   'User Access (RBAC)',      'Admin',      270, ARRAY['read','write','export']),
  ('audit_log',      'Audit Log',               'Admin',      280, ARRAY['read','export']),
  ('analytics',      'Analytics',               'Reports',    290, ARRAY['read','export']),
  ('compliance',     'Compliance',              'Operations', 300, ARRAY['read','write','export']),
  ('sourcing',       'Sourcing / RFQs',         'Operations', 310, ARRAY['read','write','export']),
  ('finance_misc',   'Finance (SCF/cards/FX)',  'Accounting', 320, ARRAY['read','write','export']),
  ('tenancy_admin',  'Tenancy / Entities',      'Admin',      330, ARRAY['read','write','export'])
ON CONFLICT (key) DO NOTHING;

-- 9b. seed roles
INSERT INTO roles (name, description, is_seed) VALUES
  ('admin',      'Full access to every module and action.',                              true),
  ('accountant', 'Read/export everywhere; write + post/void on accounting & procurement.', true),
  ('viewer',     'Read-only across all modules.',                                         true)
ON CONFLICT (name) DO NOTHING;

-- 9c. role_permissions — generated from module_keys so the matrix stays in sync.
--     admin: every available action on every module.
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, a, true
FROM roles r
CROSS JOIN module_keys mk
CROSS JOIN LATERAL unnest(mk.available_actions) a
WHERE r.name = 'admin'
ON CONFLICT (role_id, module_key, action) DO NOTHING;

--     viewer: read on every module that exposes read (all do).
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, 'read', true
FROM roles r
CROSS JOIN module_keys mk
WHERE r.name = 'viewer' AND 'read' = ANY (mk.available_actions)
ON CONFLICT (role_id, module_key, action) DO NOTHING;

--     accountant: read + export everywhere; write on accounting+procurement;
--     post/void on the six core postable accounting modules (§3.4).
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, a.action, true
FROM roles r
CROSS JOIN module_keys mk
CROSS JOIN LATERAL (VALUES ('read'),('write'),('post'),('void'),('export')) AS a(action)
WHERE r.name = 'accountant'
  AND a.action = ANY (mk.available_actions)
  AND (
        a.action IN ('read','export')                                                              -- everywhere
     OR (a.action = 'write' AND mk.key IN (                                                        -- accounting + procurement
            'coa','gl_periods','je_entry','je_post','ar_invoices','ar_receipts','ap_invoices',
            'ap_payments','bank_recon','inventory','parallel_run','costing','procurement','po_wip','finance_misc'))
     OR (a.action IN ('post','void') AND mk.key IN (                                                -- §3.4 exact post/void band
            'je_post','ar_invoices','ap_invoices','ap_payments','bank_recon','gl_periods'))
  )
ON CONFLICT (role_id, module_key, action) DO NOTHING;

-- ─── 10. BACKFILL — every existing entity_users row → entity_user_roles,
--         mapping its `role` text to the seed role of the same name (default
--         `admin` when NULL/unknown). Preserves day-1 behavior exactly.
-- entity_users.role is one of admin/accountant/staff/readonly. Map the two
-- that have a same-named seed role directly; map 'readonly' → 'viewer' (the
-- equivalent seed role); everything else (incl. 'staff' / NULL) → 'admin' so
-- day-1 access is never narrower than today (zero-enforcement chunk). The
-- operator reviews & tightens the matrix before chunk-3 turns enforcement on.
INSERT INTO entity_user_roles (entity_id, user_id, role_id)
SELECT eu.entity_id,
       eu.auth_id,
       COALESCE(
         (SELECT id FROM roles
            WHERE name = CASE eu.role WHEN 'readonly' THEN 'viewer' ELSE eu.role END),
         (SELECT id FROM roles WHERE name = 'admin')
       )
FROM entity_users eu
WHERE eu.auth_id IS NOT NULL
ON CONFLICT (entity_id, user_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
