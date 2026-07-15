-- 20261060000000_ar_aging_account_filter.sql
-- ════════════════════════════════════════════════════════════════════════════
-- AR Aging — per-AR-account filter + open-by-account summary.
--
-- CEO ask: the AR control account is SPLIT (1105 credit-card AR, 1107 factored
-- AR / Rosenthal, 1108 house AR). The aging panel summed every open invoice
-- regardless of account, so the headline read $9.6M — factored ($7.19M, which is
-- Rosenthal's exposure, not the company's cash-collectable AR) lumped in with
-- house ($2.44M). This migration lets the report split by ar_account_id and
-- surfaces a per-account open summary so the House / Factored / CC split is
-- visible at a glance.
--
--   • v_ar_aging          — append `ar_account_id` as the LAST column (+ GROUP
--                           BY) so the "current"-mode handler can .eq()-filter
--                           by account. CREATE OR REPLACE stays legal (columns
--                           only appended, never reordered/dropped). brand_id
--                           was the previous last column (P15 C3b).
--   • ar_aging_as_of(...) — gain an optional `p_ar_account_id uuid DEFAULT NULL`
--                           (filters BEFORE aggregation; NULL = all accounts, so
--                           existing 3-named-arg callers are unaffected). Output
--                           shape unchanged.
--   • v_ar_open_by_account — new: one row per (entity, ar_account_id) with the
--                           account code/name + open $ + open count. Drives the
--                           panel's account dropdown and the summary strip.
--   • idx — partial index on open AR keyed by (entity_id, ar_account_id) to keep
--           the account filter + summary cheap.
--
-- Idempotent (CREATE OR REPLACE / DROP IF EXISTS / IF NOT EXISTS). No data
-- change — read-model only.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── AR aging "current" view — ar_account_id appended last ───────────────────
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
  inv.brand_id,
  inv.ar_account_id
FROM ar_invoices inv
WHERE inv.paid_amount_cents < inv.total_amount_cents
  AND inv.gl_status IN ('posted','posted_historical','partial_paid','sent')
GROUP BY inv.entity_id, inv.customer_id, age_bucket, inv.brand_id, inv.ar_account_id;

COMMENT ON VIEW v_ar_aging IS 'Foundation AR aging view (relative to CURRENT_DATE). Per (entity_id, customer_id, age_bucket, brand_id, ar_account_id). Handler collapses to (customer, bucket) for "All accounts", or .eq(ar_account_id) narrows to one AR control account (1105 CC / 1107 factor / 1108 house).';

-- ─── AR aging "as_of" RPC — optional brand + ar_account filter ────────────────
DROP FUNCTION IF EXISTS ar_aging_as_of(uuid, date, uuid);
CREATE OR REPLACE FUNCTION ar_aging_as_of(
  p_entity_id     uuid,
  p_as_of_date    date,
  p_brand_id      uuid DEFAULT NULL,
  p_ar_account_id uuid DEFAULT NULL
)
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
       AND (p_brand_id      IS NULL OR i.brand_id      = p_brand_id)
       AND (p_ar_account_id IS NULL OR i.ar_account_id = p_ar_account_id)
  ) inv ON true
  GROUP BY c.id, c.name;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION ar_aging_as_of(uuid, date, uuid, uuid) IS 'Parameterized AR aging by as-of-date. p_brand_id / p_ar_account_id are optional (NULL = all) filters applied BEFORE aggregation; output shape unchanged. ar_account_id splits by AR control account (1105 CC / 1107 factor / 1108 house).';

-- ─── Open AR by control account — powers the account dropdown + summary strip ─
CREATE OR REPLACE VIEW v_ar_open_by_account AS
SELECT
  inv.entity_id,
  inv.ar_account_id,
  ga.code AS ar_account_code,
  ga.name AS ar_account_name,
  COUNT(*)                                                     AS open_count,
  SUM(inv.total_amount_cents - inv.paid_amount_cents)::bigint  AS open_cents
FROM ar_invoices inv
LEFT JOIN gl_accounts ga ON ga.id = inv.ar_account_id
WHERE inv.paid_amount_cents < inv.total_amount_cents
  AND inv.gl_status IN ('posted','posted_historical','partial_paid','sent')
GROUP BY inv.entity_id, inv.ar_account_id, ga.code, ga.name;

COMMENT ON VIEW v_ar_open_by_account IS 'Open AR ($ + count) per (entity_id, ar_account_id) with the gl_accounts code/name. Drives the AR Aging panel account selector + the House/Factored/CC summary strip.';

-- ─── Index — keep the account filter + summary cheap ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_ar_invoices_open_ar_account
  ON ar_invoices (entity_id, ar_account_id)
  WHERE paid_amount_cents < total_amount_cents
    AND gl_status IN ('posted','posted_historical','partial_paid','sent');
