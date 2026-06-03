-- Backfill the denormalized employees.title / employees.department text
-- columns from the title_id / department_id FK pointers.
--
-- Why: the Add/Edit Employee modal was switched to FK pickers (title_id /
-- department_id) but the list table + Excel export still read the legacy
-- text columns. Rows edited through the pickers therefore had a title_id set
-- but a NULL title text, showing "—" in the list and blank in exports
-- (e.g. EMP-00001 Molly Levitt). The UI now resolves the name from the FK,
-- and this one-time backfill makes the text columns consistent too.
--
-- Idempotent: only touches rows where the text column is out of sync with the
-- FK-resolved name, so re-running is a no-op.

UPDATE employees e
SET title = t.name
FROM employee_titles t
WHERE e.title_id = t.id
  AND e.title IS DISTINCT FROM t.name;

UPDATE employees e
SET department = d.name
FROM employee_departments d
WHERE e.department_id = d.id
  AND e.department IS DISTINCT FROM d.name;
