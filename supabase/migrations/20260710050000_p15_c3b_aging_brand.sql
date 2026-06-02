-- 20260710050000_p15_c3b_aging_brand.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P15 Brand Master — C3b: make the AR/AP aging reports brand-aware.
--
-- Two shapes per report (unchanged): the "current" VIEW (long: row per
-- customer/vendor × bucket) and the "as_of" RPC (wide: row per customer/vendor
-- with bucket columns).
--
--   • Views (v_ar_aging, v_ap_aging_buckets): append `brand_id` to the GROUP BY
--     + SELECT (LAST column, so CREATE OR REPLACE VIEW stays legal). The handler
--     re-collapses by (party, bucket) for "All", or the gated .eq(brand_id)
--     filter narrows to one brand first.
--   • RPCs (ar_aging_as_of, ap_aging_as_of): gain an optional `p_brand_id uuid
--     DEFAULT NULL` and a `(p_brand_id IS NULL OR brand_id = p_brand_id)` filter
--     BEFORE aggregation — output shape and GROUP BY unchanged. DEFAULT NULL =
--     identical to today, so unfiltered callers are unaffected.
--
-- Filtering is only ever *exercised* when the server's BRAND_SCOPE_MODE=enforce
-- and a brand is selected (the handler passes p_brand_id / applies the .eq).
-- ar_invoices + invoices both carry brand_id as of 20260710020000.
-- Idempotent (CREATE OR REPLACE / DROP IF EXISTS).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── AR aging "current" view — brand_id appended last ────────────────────────
CREATE OR REPLACE VIEW v_ar_aging AS
SELECT
  inv.entity_id,
  inv.customer_id,
  CASE
    WHEN inv.due_date IS NULL OR (CURRENT_DATE - inv.due_date) <= 0 THEN 'current'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 1   AND 30  THEN '1-30'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 31  AND 60  THEN '31-60'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 61  AND 90  THEN '61-90'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 91  AND 120 THEN '91-120'
    ELSE '120+'
  END AS age_bucket,
  SUM(inv.total_amount_cents - inv.paid_amount_cents)::bigint AS outstanding_cents,
  COUNT(*) AS invoice_count,
  inv.brand_id
FROM ar_invoices inv
WHERE inv.paid_amount_cents < inv.total_amount_cents
  AND inv.gl_status IN ('posted','posted_historical','partial_paid','sent')
GROUP BY inv.entity_id, inv.customer_id, age_bucket, inv.brand_id;

-- ─── AR aging "as_of" RPC — optional brand filter ────────────────────────────
DROP FUNCTION IF EXISTS ar_aging_as_of(uuid, date);
CREATE OR REPLACE FUNCTION ar_aging_as_of(p_entity_id uuid, p_as_of_date date, p_brand_id uuid DEFAULT NULL)
RETURNS TABLE (
  customer_id              uuid,
  customer_name            text,
  current_cents            bigint,
  bucket_1_30_cents        bigint,
  bucket_31_60_cents       bigint,
  bucket_61_90_cents       bigint,
  bucket_91_120_cents      bigint,
  bucket_120_plus_cents    bigint,
  total_outstanding_cents  bigint
) AS $$
  SELECT
    c.id,
    c.name,
    COALESCE(SUM(CASE WHEN inv.due_date IS NULL OR (p_as_of_date - inv.due_date) <= 0  THEN inv.outstanding ELSE 0 END), 0)::bigint AS current_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 1   AND 30  THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_1_30_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 31  AND 60  THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_31_60_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 61  AND 90  THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_61_90_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 91  AND 120 THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_91_120_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) > 120 THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_120_plus_cents,
    COALESCE(SUM(inv.outstanding), 0)::bigint AS total_outstanding_cents
  FROM customers c
  JOIN LATERAL (
    SELECT i.due_date,
           (i.total_amount_cents - i.paid_amount_cents) AS outstanding
      FROM ar_invoices i
     WHERE i.customer_id = c.id
       AND i.entity_id  = p_entity_id
       AND i.gl_status IN ('posted','posted_historical','partial_paid','sent')
       AND i.posting_date <= p_as_of_date
       AND (i.total_amount_cents - i.paid_amount_cents) > 0
       AND (p_brand_id IS NULL OR i.brand_id = p_brand_id)
  ) inv ON true
  GROUP BY c.id, c.name;
$$ LANGUAGE sql STABLE;

-- ─── AP aging "current" view — brand_id appended last ────────────────────────
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
  COUNT(*) AS invoice_count,
  inv.brand_id
FROM invoices inv
WHERE inv.paid_amount_cents < inv.total_amount_cents
  AND inv.gl_status = 'posted'
  AND inv.invoice_kind IN ('vendor_bill','expense_report')
GROUP BY inv.entity_id, inv.vendor_id, age_bucket, inv.brand_id;

-- ─── AP aging "as_of" RPC — optional brand filter ────────────────────────────
DROP FUNCTION IF EXISTS ap_aging_as_of(uuid, date);
CREATE OR REPLACE FUNCTION ap_aging_as_of(p_entity_id uuid, p_as_of_date date, p_brand_id uuid DEFAULT NULL)
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
       AND (p_brand_id IS NULL OR i.brand_id = p_brand_id)
  ) inv ON true
  GROUP BY v.id, v.name, v.code;
$$ LANGUAGE sql STABLE;

NOTIFY pgrst, 'reload schema';
