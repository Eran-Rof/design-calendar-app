-- P16 (new request) — Employee Title + Department masters, and per-rep
-- commission rates (Wholesale + Closeouts).
--
--   employee_titles      — reference master; is_sales_role flags titles
--                          (e.g. "Sales Representative") that unlock commission
--                          rate entry on the employee.
--   employee_departments — reference master.
--   employees            — title_id / department_id FKs + two commission rates.
--
-- A "closeout" for commission purposes = any sale with margin <= 14% (applied by
-- the commission engine; the rate columns below hold the two %s per rep).
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS employee_titles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  is_sales_role boolean NOT NULL DEFAULT false,
  sort_order    smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, name)
);

CREATE TABLE IF NOT EXISTS employee_departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, name)
);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS title_id                 uuid REFERENCES employee_titles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_id            uuid REFERENCES employee_departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_wholesale_pct numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_closeout_pct  numeric(6,3) NOT NULL DEFAULT 0;

COMMENT ON COLUMN employees.commission_wholesale_pct IS 'P16 — sales-rep commission % on wholesale sales (margin > 14%).';
COMMENT ON COLUMN employees.commission_closeout_pct  IS 'P16 — sales-rep commission % on closeout sales (margin <= 14%).';

INSERT INTO employee_titles (entity_id, name, is_sales_role, sort_order)
SELECT rof_entity_id(), 'Sales Representative', true, 0
ON CONFLICT (entity_id, name) DO NOTHING;

ALTER TABLE employee_titles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_employee_titles" ON employee_titles;
CREATE POLICY "anon_read_employee_titles" ON employee_titles FOR SELECT TO anon USING (true);
ALTER TABLE employee_departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_employee_departments" ON employee_departments;
CREATE POLICY "anon_read_employee_departments" ON employee_departments FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
