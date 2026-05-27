-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P2 / Chunk 7 / Migration 1
-- M30 HR/Employee Master - schema for employees + v_audit_user_resolved view.
--
-- Per docs/tangerine/P2-cross-cutters-architecture.md §7.
--
-- Decision (sec 7.2): keep roles on entity_users (Option A). Employees
-- carry name + title + department + manager chain + active flag. The
-- auth.users binding is OPTIONAL - an employee may exist without a login
-- (contractor, future hire, audit trail subject).
--
-- Scope NON-goals: payroll, time tracking, benefits. Stretch-post-launch.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS employees (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  auth_user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  code                   text NOT NULL,
  first_name             text NOT NULL,
  last_name              text NOT NULL,
  display_name           text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  email                  text NOT NULL,
  title                  text,
  department             text,
  manager_employee_id    uuid REFERENCES employees(id) ON DELETE SET NULL,
  hire_date              date,
  termination_date       date,
  is_active              boolean NOT NULL DEFAULT true,
  phone                  text,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT employees_termination_after_hire
    CHECK (termination_date IS NULL OR hire_date IS NULL OR termination_date >= hire_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_entity_code
  ON employees (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_entity_email
  ON employees (entity_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_employees_entity_active
  ON employees (entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_employees_auth_user
  ON employees (auth_user_id)
  WHERE auth_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_manager
  ON employees (manager_employee_id);

COMMENT ON TABLE  employees IS 'Tangerine-owned record per person. auth_user_id is OPTIONAL - employees can exist without a login account. display_name is a computed column joining first + last name.';
COMMENT ON COLUMN employees.auth_user_id IS 'Optional binding to auth.users. NULL for contractors / future hires / pure audit-trail rows. Joining auth_user_id → auth.users.id resolves display names everywhere.';
COMMENT ON COLUMN employees.department  IS 'Free-form text for now. Convert to FK on a future `departments` table if hierarchy emerges.';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS - P1 template
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_employees" ON employees
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_employees" ON employees
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ════════════════════════════════════════════════════════════════════════════
-- v_audit_user_resolved: join auth.users (the system identity) → employees
-- (the human identity). Every created_by_user_id / updated_by_user_id in the
-- schema becomes joinable to a display name via this view.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_audit_user_resolved AS
SELECT
  u.id                              AS user_id,
  u.email                           AS email,
  e.id                              AS employee_id,
  e.display_name                    AS display_name,
  e.code                            AS employee_code,
  e.title                           AS title,
  e.entity_id                       AS entity_id,
  e.is_active                       AS is_active
FROM auth.users u
LEFT JOIN employees e ON e.auth_user_id = u.id;

COMMENT ON VIEW v_audit_user_resolved IS 'Maps auth.users -> employees so any created_by_user_id / updated_by_user_id can render a real display name. RLS on the underlying employees table still applies.';

-- ════════════════════════════════════════════════════════════════════════════
-- Touch trigger
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION employees_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employees_touch_trg ON employees;
CREATE TRIGGER employees_touch_trg
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_touch();

-- ════════════════════════════════════════════════════════════════════════════
-- Optional seed: insert one employees row for the default entity (ROF) if a
-- record matching a known internal email is in auth.users. Operator can later
-- add manager_employee_id + title via the admin UI.
--
-- Defensive: skip if 'employees' already has any row for ROF.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  rof_id uuid;
  ebitton_id uuid;
BEGIN
  SELECT id INTO rof_id FROM entities WHERE code = 'ROF';
  IF rof_id IS NULL THEN
    RAISE NOTICE 'employees seed skipped: ROF entity not found';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM employees WHERE entity_id = rof_id) THEN
    RAISE NOTICE 'employees seed skipped: rows already exist for ROF';
    RETURN;
  END IF;

  -- Try to find the operator account by email
  SELECT id INTO ebitton_id FROM auth.users
    WHERE email = 'eran@ringoffireclothing.com'
    LIMIT 1;

  -- Insert a placeholder employee record; auth_user_id may be NULL on first run
  INSERT INTO employees (entity_id, auth_user_id, code, first_name, last_name,
                         email, title, department, is_active)
  VALUES (rof_id, ebitton_id, 'EB001', 'Eran', 'Bitton',
          'eran@ringoffireclothing.com', 'CEO', 'Executive', true);
END $$;
