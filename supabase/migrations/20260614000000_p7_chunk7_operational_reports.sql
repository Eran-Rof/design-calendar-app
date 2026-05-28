-- 20260614000000_p7_chunk7_operational_reports.sql
--
-- Tangerine P7-7 — M9-subset operational reports.
--
-- Adds 4 read-only views + 4 STABLE RPCs that back the new 📊 Reports
-- top-nav group: AP Aging, Sales by Rep × Period, Sales by Customer × Period,
-- and GL Detail by Account × Period.
--
-- Mirrors the P4-6 ar_aging_as_of() pattern: a foundation view for "live now"
-- queries + a parameterized STABLE function for the operator's date-picker UI.
-- All views/RPCs read-only; no new tables.
--
-- Per docs/tangerine/P7-revenue-ops-architecture.md §5.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. AP Aging
-- ────────────────────────────────────────────────────────────────────────────
-- Foundation view, relative to CURRENT_DATE. Bucketed by days past due_date:
--   current  : due_date IS NULL or in the future
--   1-30     : 1-30 days past due
--   31-60    : 31-60 days past due
--   61-90    : 61-90 days past due
--   91+      : 91+ days past due (rolled up — operator wanted a single 91+ bucket
--              on AP per arch §5 — AR uses 91-120 + 120+ because the customer
--              dunning playbook treats them differently; AP just needs "very late").
CREATE OR REPLACE VIEW v_ap_aging_buckets AS
SELECT
  inv.entity_id,
  inv.vendor_id,
  CASE
    WHEN inv.due_date IS NULL OR (CURRENT_DATE - inv.due_date) <= 0 THEN 'current'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 1  AND 30 THEN '1-30'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 31 AND 60 THEN '31-60'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 61 AND 90 THEN '61-90'
    ELSE '91+'
  END AS age_bucket,
  SUM(inv.total_amount_cents - inv.paid_amount_cents)::bigint AS outstanding_cents,
  COUNT(*) AS invoice_count
FROM invoices inv
WHERE inv.paid_amount_cents < inv.total_amount_cents
  AND inv.gl_status = 'posted'
  AND inv.invoice_kind IN ('vendor_bill','expense_report')
GROUP BY inv.entity_id, inv.vendor_id, age_bucket;

COMMENT ON VIEW v_ap_aging_buckets IS
  'Tangerine P7-7: foundation AP aging view (relative to CURRENT_DATE). Per (entity_id, vendor_id, age_bucket). Mirrors v_ar_aging from P4-6 but on the AP `invoices` table.';

-- ap_aging_as_of: parameterized variant for the UI as-of-date picker.
-- Mirrors ar_aging_as_of(p_entity_id, p_as_of_date) shape so the operator panel
-- code can stay symmetrical.
CREATE OR REPLACE FUNCTION ap_aging_as_of(p_entity_id uuid, p_as_of_date date)
RETURNS TABLE (
  vendor_id               uuid,
  vendor_name             text,
  vendor_code             text,
  current_cents           bigint,
  bucket_1_30_cents       bigint,
  bucket_31_60_cents      bigint,
  bucket_61_90_cents      bigint,
  bucket_91_plus_cents    bigint,
  total_outstanding_cents bigint
) AS $$
  SELECT
    v.id,
    v.name,
    v.code,
    COALESCE(SUM(CASE WHEN inv.due_date IS NULL OR (p_as_of_date - inv.due_date) <= 0 THEN inv.outstanding ELSE 0 END), 0)::bigint AS current_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 1  AND 30 THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_1_30_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 31 AND 60 THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_31_60_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 61 AND 90 THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_61_90_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) > 90 THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_91_plus_cents,
    COALESCE(SUM(inv.outstanding), 0)::bigint AS total_outstanding_cents
  FROM vendors v
  JOIN LATERAL (
    SELECT i.due_date,
           (i.total_amount_cents - i.paid_amount_cents) AS outstanding
      FROM invoices i
     WHERE i.vendor_id = v.id
       AND i.entity_id = p_entity_id
       AND i.gl_status = 'posted'
       AND i.invoice_kind IN ('vendor_bill','expense_report')
       AND (i.posting_date IS NULL OR i.posting_date <= p_as_of_date)
       AND (i.total_amount_cents - i.paid_amount_cents) > 0
  ) inv ON true
  GROUP BY v.id, v.name, v.code;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION ap_aging_as_of(uuid, date) IS
  'Tangerine P7-7: parameterized AP aging by as-of-date. Mirrors ar_aging_as_of from P4-6. STABLE so Postgres can plan with the current snapshot. Bucket grain: current / 1-30 / 31-60 / 61-90 / 91+.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Sales by Rep × Period
-- ────────────────────────────────────────────────────────────────────────────
-- Aggregates posted AR invoices (basis=ACCRUAL only — cash detail is via P5
-- Cash Flow) per (entity_id, sales_rep_id) for a date window. LEFT-joins
-- commission_accruals so reps with no accrual rows still appear at $0 commission.
-- Defensive: the commission_accruals join uses COALESCE(...,0) so the view
-- compiles even before any accrual rows are written (P7-5 / P7-6 deps).
CREATE OR REPLACE VIEW v_sales_by_rep AS
SELECT
  inv.entity_id,
  csra.sales_rep_id,
  inv.invoice_date,
  inv.id AS ar_invoice_id,
  inv.invoice_number,
  inv.customer_id,
  inv.total_amount_cents AS invoice_total_cents,
  csra.share_pct,
  -- Apportion the invoice total by the assignment's share_pct so split reps
  -- aggregate correctly. Round to cents (bigint).
  ROUND(inv.total_amount_cents * (csra.share_pct / 100.0))::bigint AS apportioned_cents,
  COALESCE(ca.commission_cents, 0)::bigint AS commission_cents
FROM ar_invoices inv
JOIN customer_sales_rep_assignments csra
       ON csra.customer_id = inv.customer_id
      AND csra.effective_from <= inv.invoice_date
      AND (csra.effective_to IS NULL OR csra.effective_to >= inv.invoice_date)
LEFT JOIN commission_accruals ca
       ON ca.ar_invoice_id = inv.id
      AND ca.sales_rep_id = csra.sales_rep_id
      AND ca.status IN ('accrued','paid')
WHERE inv.gl_status IN ('sent','partial_paid','paid','posted','posted_historical')
  AND inv.invoice_kind = 'customer_invoice';

COMMENT ON VIEW v_sales_by_rep IS
  'Tangerine P7-7: one row per (ar_invoice × sales_rep) for the Sales by Rep × Period report. Apportions invoice totals by customer_sales_rep_assignments.share_pct. Commission cents LEFT-joined from commission_accruals so the view is safe before any accruals exist.';

CREATE OR REPLACE FUNCTION sales_by_rep(p_entity_id uuid, p_from date, p_to date)
RETURNS TABLE (
  sales_rep_id     uuid,
  sales_rep_name   text,
  invoice_count    bigint,
  gross_cents      bigint,
  commission_cents bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT
    sr.id                                                            AS sales_rep_id,
    sr.display_name                                                  AS sales_rep_name,
    COUNT(DISTINCT v.ar_invoice_id)::bigint                          AS invoice_count,
    COALESCE(SUM(v.apportioned_cents), 0)::bigint                    AS gross_cents,
    COALESCE(SUM(v.commission_cents), 0)::bigint                     AS commission_cents
  FROM sales_reps sr
  LEFT JOIN v_sales_by_rep v
         ON v.sales_rep_id = sr.id
        AND v.entity_id = p_entity_id
        AND v.invoice_date BETWEEN p_from AND p_to
  WHERE sr.entity_id = p_entity_id
  GROUP BY sr.id, sr.display_name;
$$;

COMMENT ON FUNCTION sales_by_rep(uuid, date, date) IS
  'Tangerine P7-7: per-rep totals across a date window. LEFT join from sales_reps so reps with zero activity still surface (operator can see "Rep X had no sales this month"). Commission_cents is 0 until P7-5 RPCs write accrual rows.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Sales by Customer × Period
-- ────────────────────────────────────────────────────────────────────────────
-- Aggregates the same posted-AR universe but per customer. Includes a
-- credit-memo column so net = gross - credit_memos. Customer-invoice and
-- customer-credit-memo rows both live in ar_invoices distinguished by
-- invoice_kind.
CREATE OR REPLACE VIEW v_sales_by_customer AS
SELECT
  inv.entity_id,
  inv.customer_id,
  inv.invoice_date,
  inv.id AS ar_invoice_id,
  inv.invoice_kind,
  inv.total_amount_cents,
  CASE WHEN inv.invoice_kind = 'customer_invoice'      THEN inv.total_amount_cents ELSE 0 END AS gross_cents,
  CASE WHEN inv.invoice_kind = 'customer_credit_memo'  THEN inv.total_amount_cents ELSE 0 END AS credit_memo_cents
FROM ar_invoices inv
WHERE inv.gl_status IN ('sent','partial_paid','paid','posted','posted_historical')
  AND inv.invoice_kind IN ('customer_invoice','customer_credit_memo');

COMMENT ON VIEW v_sales_by_customer IS
  'Tangerine P7-7: per-customer per-invoice rows for the Sales by Customer × Period report. Separates gross_cents (invoices) from credit_memo_cents so net is gross - credit_memos.';

CREATE OR REPLACE FUNCTION sales_by_customer(p_entity_id uuid, p_from date, p_to date)
RETURNS TABLE (
  customer_id        uuid,
  customer_name      text,
  customer_code      text,
  invoice_count      bigint,
  gross_cents        bigint,
  credit_memo_cents  bigint,
  net_cents          bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id                                                        AS customer_id,
    c.name                                                      AS customer_name,
    c.code                                                      AS customer_code,
    COUNT(DISTINCT CASE WHEN v.invoice_kind = 'customer_invoice' THEN v.ar_invoice_id END)::bigint AS invoice_count,
    COALESCE(SUM(v.gross_cents), 0)::bigint                     AS gross_cents,
    COALESCE(SUM(v.credit_memo_cents), 0)::bigint               AS credit_memo_cents,
    (COALESCE(SUM(v.gross_cents), 0) - COALESCE(SUM(v.credit_memo_cents), 0))::bigint AS net_cents
  FROM customers c
  JOIN v_sales_by_customer v
       ON v.customer_id = c.id
      AND v.entity_id = p_entity_id
      AND v.invoice_date BETWEEN p_from AND p_to
  GROUP BY c.id, c.name, c.code
  HAVING COALESCE(SUM(v.gross_cents), 0) + COALESCE(SUM(v.credit_memo_cents), 0) > 0;
$$;

COMMENT ON FUNCTION sales_by_customer(uuid, date, date) IS
  'Tangerine P7-7: per-customer totals across a date window. Drops customers with zero activity (HAVING) so the report only lists customers who actually transacted. net = gross - credit_memos.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. GL Detail by Account × Period
-- ────────────────────────────────────────────────────────────────────────────
-- Drill view from any Trial Balance row. Returns ordered journal_entry_lines
-- with running balance (DEBIT-positive convention; UI flips sign for credit-
-- normal accounts, same as Trial Balance).
-- Numerics: journal_entry_lines.debit/credit are numeric(18,2) in DOLLARS;
-- multiply by 100 to publish cents on the wire (matches the rest of the API).
CREATE OR REPLACE VIEW v_gl_detail AS
SELECT
  je.entity_id,
  jel.account_id,
  je.id                           AS je_id,
  je.posting_date,
  je.description,
  je.basis,
  je.source_module,
  je.source_id,
  (jel.debit  * 100)::bigint      AS debit_cents,
  (jel.credit * 100)::bigint      AS credit_cents,
  jel.line_number,
  jel.memo
FROM journal_entry_lines jel
JOIN journal_entries je ON je.id = jel.journal_entry_id
WHERE je.status = 'posted';

COMMENT ON VIEW v_gl_detail IS
  'Tangerine P7-7: foundation per-line view of posted JE detail by account. Cents on the wire. UI applies normal-balance flip the same way Trial Balance does.';

CREATE OR REPLACE FUNCTION gl_detail(p_account_id uuid, p_from date, p_to date)
RETURNS TABLE (
  posting_date          date,
  je_id                 uuid,
  description           text,
  debit_cents           bigint,
  credit_cents          bigint,
  running_balance_cents bigint,
  source_module         text,
  source_id             text
)
LANGUAGE sql STABLE
AS $$
  WITH lines AS (
    SELECT
      je.id                          AS je_id,
      je.posting_date,
      je.description,
      je.source_module,
      je.source_id,
      (jel.debit  * 100)::bigint     AS debit_cents,
      (jel.credit * 100)::bigint     AS credit_cents
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id    = p_account_id
      AND je.status         = 'posted'
      AND je.basis          = 'ACCRUAL'
      AND je.posting_date  BETWEEN p_from AND p_to
  )
  SELECT
    posting_date,
    je_id,
    description,
    debit_cents,
    credit_cents,
    SUM(debit_cents - credit_cents) OVER (ORDER BY posting_date, je_id)::bigint AS running_balance_cents,
    source_module,
    source_id
  FROM lines
  ORDER BY posting_date, je_id;
$$;

COMMENT ON FUNCTION gl_detail(uuid, date, date) IS
  'Tangerine P7-7: ordered ACCRUAL journal_entry_lines for a single account in a date window, with running DEBIT-positive balance. UI normal-balance flip presented at render time.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Tell PostgREST to reload its schema cache so the new views + RPCs are
--    callable immediately after migration.
-- ────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
