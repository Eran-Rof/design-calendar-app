-- ════════════════════════════════════════════════════════════════════════════
-- Unify Sales Reps into Employees
--
-- The redundant standalone Sales Reps MASTER panel was retired in #770. This
-- migration completes the unification: EMPLOYEES (flagged as sales-role via
-- their title — employee_titles.is_sales_role = true) ARE the sales reps.
--
-- WHY KEEP sales_reps THE TABLE?
--   sales_reps.id is the identity anchor of the entire commission GL subledger:
--   it is the FK target of commission_accruals, commission_payouts,
--   sales_rep_commission_tiers, customer_sales_rep_assignments and
--   costing_projects.sales_rep_id, and is stamped as subledger_id on every
--   posted commission JE line. Physically dropping it would force a rewrite of
--   four SECURITY-DEFINER GL RPCs + the Sales-by-Rep report view to delete an
--   EMPTY table (0 rows in prod, verified) — pure risk on financially-sensitive
--   code with zero payoff.
--
-- So instead: sales_reps becomes a DERIVED SHADOW of a sales-role employee, no
-- longer an independently-edited master. There is exactly one shadow row per
-- employee (employee_id is now UNIQUE). User-facing pickers/search source from
-- employees; when an employee is chosen as a rep, sales_rep_for_employee()
-- resolves-or-creates that employee's shadow row so the commission engine's
-- FKs always resolve. The standalone sales_reps CRUD handler + routes are
-- retired in the same PR.
--
-- Idempotent + additive. No data migration needed (all commission/rep tables
-- are empty in prod), so there are no orphan commissions to reassign.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. One shadow row per employee ────────────────────────────────────────
-- Enforce a single sales_reps row per linked employee. (employee_id was a
-- plain nullable FK before; a partial-unique index makes the shadow 1:1 while
-- still permitting legacy NULL-employee rows that may exist in other entities.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_reps_employee_unique
  ON sales_reps (employee_id) WHERE employee_id IS NOT NULL;

COMMENT ON TABLE sales_reps IS 'Commission subledger identity anchor (FK target of commission_accruals/payouts/tiers/assignments + costing_projects). NO LONGER an independently-edited master: each row is a derived shadow of a sales-role employee (employee_id UNIQUE). Provision rows via sales_rep_for_employee(). User-facing rep picking sources from employees (employee_titles.is_sales_role).';

-- ─── 2. is this employee a sales rep? ──────────────────────────────────────
CREATE OR REPLACE FUNCTION employee_is_sales_role(p_employee_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(t.is_sales_role, false)
    FROM employees e
    LEFT JOIN employee_titles t ON t.id = e.title_id
   WHERE e.id = p_employee_id;
$$;

COMMENT ON FUNCTION employee_is_sales_role(uuid) IS
  'True when the employee has a title flagged employee_titles.is_sales_role. Canonical "is this employee a sales rep" predicate.';

-- ─── 3. resolve-or-create the shadow rep row for an employee ───────────────
-- Returns the sales_reps.id to stamp on commission_accruals / costing_projects.
-- Copies identity (name/email) and the wholesale commission % from the employee
-- so the commission engine's default rate stays in sync at provision-time.
CREATE OR REPLACE FUNCTION sales_rep_for_employee(p_employee_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp        record;
  v_rep_id     uuid;
  v_name       text;
BEGIN
  IF p_employee_id IS NULL THEN
    RAISE EXCEPTION 'sales_rep_for_employee: employee_id is required';
  END IF;

  SELECT id, entity_id, display_name, first_name, last_name, email,
         commission_wholesale_pct
    INTO v_emp
    FROM employees
   WHERE id = p_employee_id;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'sales_rep_for_employee: employee % not found', p_employee_id;
  END IF;

  IF NOT employee_is_sales_role(p_employee_id) THEN
    RAISE EXCEPTION 'sales_rep_for_employee: employee % has no sales-role title (employee_titles.is_sales_role)', p_employee_id;
  END IF;

  -- Existing shadow?
  SELECT id INTO v_rep_id FROM sales_reps WHERE employee_id = p_employee_id;
  IF v_rep_id IS NOT NULL THEN
    RETURN v_rep_id;
  END IF;

  v_name := COALESCE(
    NULLIF(v_emp.display_name, ''),
    NULLIF(trim(COALESCE(v_emp.first_name,'') || ' ' || COALESCE(v_emp.last_name,'')), ''),
    v_emp.email
  );

  INSERT INTO sales_reps (
    entity_id, employee_id, display_name, email,
    default_commission_pct, is_active
  ) VALUES (
    v_emp.entity_id, v_emp.id, v_name, v_emp.email,
    LEAST(GREATEST(COALESCE(v_emp.commission_wholesale_pct, 0), 0), 100), true
  )
  ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL
    DO UPDATE SET display_name = EXCLUDED.display_name,
                  email        = EXCLUDED.email,
                  is_active    = true,
                  updated_at   = now()
  RETURNING id INTO v_rep_id;

  RETURN v_rep_id;
END;
$$;

COMMENT ON FUNCTION sales_rep_for_employee(uuid) IS
  'Resolve-or-create the commission-subledger shadow sales_reps row for a sales-role employee. Returns sales_reps.id (FK-stampable on commission_accruals / costing_projects). Raises if the employee is not a sales rep.';

-- ─── 4. Global search: source sales_rep results from sales-role employees ──
-- Previously the sales_rep branch read the (now-retired-as-master) sales_reps
-- table and deep-linked to a non-existent /sales-reps/ panel. Source it from
-- employees with a sales-role title and route to the Employees module instead.
CREATE OR REPLACE VIEW v_global_search AS
SELECT
  'customer'::text                                       AS entity_type,
  id::text                                               AS entity_id,
  name                                                   AS title,
  code                                                   AS subtitle,
  search_doc                                             AS search_doc,
  '/customers/' || id::text                              AS route_hint
FROM customers
UNION ALL
SELECT
  'vendor'::text,
  id::text,
  name,
  code,
  search_doc,
  '/vendors/' || id::text
FROM vendors
UNION ALL
SELECT
  'ar_invoice'::text,
  id::text,
  'AR ' || invoice_number,
  '$' || to_char(total_amount_cents / 100.0, 'FM999,999,990.00'),
  search_doc,
  '/ar-invoices/' || id::text
FROM ar_invoices
UNION ALL
SELECT
  'ap_invoice'::text,
  id::text,
  'AP ' || invoice_number,
  '$' || to_char(total_amount_cents / 100.0, 'FM999,999,990.00'),
  search_doc,
  '/ap-invoices/' || id::text
FROM invoices
UNION ALL
SELECT
  'po'::text,
  id::text,
  'PO ' || po_number,
  vendor,
  search_doc,
  '/tanda/' || id::text
FROM tanda_pos
UNION ALL
SELECT
  'style'::text,
  s.id::text,
  s.style_code,
  coalesce(s.style_name, s.description),
  s.search_doc
    || to_tsvector('simple', coalesce(b.name, '') || ' ' || coalesce(b.code, '')) AS search_doc,
  '/pim/styles/' || s.id::text
FROM style_master s
LEFT JOIN brand_master b ON b.id = s.brand_id
UNION ALL
SELECT
  'sku'::text,
  id::text,
  sku_code,
  style_code,
  search_doc,
  '/items/' || id::text
FROM ip_item_master
UNION ALL
SELECT
  'gl_account'::text,
  id::text,
  code || ' ' || name,
  account_type,
  search_doc,
  '/gl-accounts/' || id::text
FROM gl_accounts
UNION ALL
SELECT
  'case'::text,
  id::text,
  case_number,
  subject,
  search_doc,
  '/cases/' || id::text
FROM cases
UNION ALL
-- Sales reps ARE sales-role employees. Build the searchable doc inline (the
-- employees table predates T6-1 and has no search_doc tsvector).
SELECT
  'sales_rep'::text,
  e.id::text,
  COALESCE(NULLIF(e.display_name, ''),
           NULLIF(trim(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')), ''),
           e.email),
  e.email,
  to_tsvector('simple',
    coalesce(e.display_name,'') || ' ' || coalesce(e.first_name,'') || ' '
    || coalesce(e.last_name,'') || ' ' || coalesce(e.email,'') || ' '
    || coalesce(e.code,'')),
  '/tangerine?module=employees'                          AS route_hint
FROM employees e
JOIN employee_titles t ON t.id = e.title_id
WHERE t.is_sales_role = true
  AND e.is_active = true
UNION ALL
SELECT
  'bank_txn'::text,
  id::text,
  coalesce(merchant_name, external_txn_id, 'Bank txn'),
  '$' || to_char(amount_cents / 100.0, 'FM999,999,990.00')
    || ' on ' || to_char(created_at, 'YYYY-MM-DD'),
  search_doc,
  '/bank-transactions/' || id::text
FROM bank_transactions
UNION ALL
SELECT
  'brand'::text,
  id::text,
  name,
  'Brand ' || code,
  to_tsvector('simple', coalesce(code, '') || ' ' || coalesce(name, '')) AS search_doc,
  '/tangerine?module=pim_catalog'                        AS route_hint
FROM brand_master;

COMMENT ON VIEW v_global_search IS
  'UNION ALL projection of every searchable entity. sales_rep rows now source from sales-role employees (employee_titles.is_sales_role) routed to the Employees module — the standalone sales_reps master was retired. Use the global_search() RPC to query.';

-- ─── 5. PostgREST schema cache reload ──────────────────────────────────────
NOTIFY pgrst, 'reload schema';
