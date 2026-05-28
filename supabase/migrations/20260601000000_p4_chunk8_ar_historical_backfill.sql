-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P4-8 — Historical AR backfill scaffolding
--
-- Scope adjustment from arch §6 (operator-confirmed 2026-05-27): Xoro
-- initial use was 2024-08-31, so the backfill window is Aug 2024 → today
-- instead of the original 5-year plan. Pre-Aug-2024 gl_periods are purged
-- and entities.posting_locked_through is pinned to 2024-07-31 so anything
-- earlier is structurally un-postable.
--
-- This migration ONLY scaffolds: audit tables, the period purge, the lock
-- bump, and a reconciliation view. The actual backfill loop lives in
-- api/_handlers/internal/ar-backfill/run.js (Node, not PL/pgSQL) — small
-- data volume (~21 months × ~50 invoices) makes the script approach
-- easier to test and resume than a stored procedure.
--
-- Also fixes a defective COMMENT statement from PR #373 (string-literal
-- concatenation via `||` is not legal inside COMMENT ON ... IS).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Audit tables ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bf_backfill_checkpoint_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backfill_run_id    uuid NOT NULL,
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  year               smallint NOT NULL,
  month              smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  invoices_created   integer NOT NULL DEFAULT 0,
  receipts_created   integer NOT NULL DEFAULT 0,
  je_created         integer NOT NULL DEFAULT 0,
  status             text NOT NULL CHECK (status IN ('done','failed','in_progress','skipped','dry_run')),
  error              text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_bf_checkpoint_run
  ON bf_backfill_checkpoint_log (backfill_run_id, year, month);
CREATE INDEX IF NOT EXISTS idx_bf_checkpoint_entity
  ON bf_backfill_checkpoint_log (entity_id, started_at DESC);

CREATE TABLE IF NOT EXISTS bf_unmatched_customers_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backfill_run_id     uuid NOT NULL,
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_customer_id  uuid,
  source_customer_code text,
  source_customer_name text,
  invoice_number      text,
  resolution          text NOT NULL CHECK (resolution IN ('synthesized','skipped','manual_review')),
  resolved_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  notes               text,
  logged_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bf_unmatched_run
  ON bf_unmatched_customers_log (backfill_run_id, logged_at DESC);

CREATE TABLE IF NOT EXISTS bf_skipped_cogs_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backfill_run_id     uuid NOT NULL,
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  invoice_number      text,
  source_line_key     text,
  sku_id              uuid,
  reason              text NOT NULL,
  logged_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bf_skipped_run
  ON bf_skipped_cogs_log (backfill_run_id, logged_at DESC);

-- RLS — standard P1 template
ALTER TABLE bf_backfill_checkpoint_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE bf_unmatched_customers_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE bf_skipped_cogs_log        ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_all_bf_checkpoint" ON bf_backfill_checkpoint_log
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_bf_checkpoint" ON bf_backfill_checkpoint_log
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_all_bf_unmatched" ON bf_unmatched_customers_log
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_bf_unmatched" ON bf_unmatched_customers_log
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_all_bf_skipped" ON bf_skipped_cogs_log
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_bf_skipped" ON bf_skipped_cogs_log
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 2. Pre-Aug-2024 period purge ───────────────────────────────────────────
-- Operator-confirmed (2026-05-27): no Xoro history before 2024-08-31, so any
-- gl_periods ending before 2024-08-01 are safe to delete. Defensive: only
-- delete periods that have NO posted JEs (an unposted period left over from
-- earlier seed runs is what we expect; anything with JEs would block the
-- delete via FK — that surfaces as an error so the operator sees it).
DO $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM gl_periods
   WHERE ends_on < DATE '2024-08-01'
     AND NOT EXISTS (
       SELECT 1 FROM journal_entries je WHERE je.period_id = gl_periods.id
     );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'P4-8: purged % pre-Aug-2024 gl_periods rows', v_deleted;
END $$;

-- ─── 3. Pin entity hard-lock to 2024-07-31 ───────────────────────────────────
-- After this, anything ≤ 2024-07-31 is structurally un-postable (the
-- posting_locked_through guard in journal_entry_post_guards fires even
-- for *_historical journal_types when posting_date <= locked_through).
-- Use IS NULL OR < to avoid lowering an already-tighter lock.
UPDATE entities
   SET posting_locked_through = DATE '2024-07-31'
 WHERE code = 'ROF'
   AND (posting_locked_through IS NULL OR posting_locked_through < DATE '2024-07-31');

-- ─── 4. Reconciliation view ──────────────────────────────────────────────────
-- Compares source totals from ip_sales_history_wholesale to AR totals from
-- ar_invoices (kind = customer_invoice_historical). Operator runs this
-- after each backfill batch and inspects any variance row.

CREATE OR REPLACE VIEW v_ar_backfill_reconciliation AS
WITH source_totals AS (
  SELECT
    EXTRACT(YEAR  FROM txn_date)::int AS year,
    EXTRACT(MONTH FROM txn_date)::int AS month,
    SUM(COALESCE(net_amount, gross_amount, unit_price * qty))::numeric AS source_revenue,
    COUNT(DISTINCT invoice_number)                                    AS source_invoice_count
  FROM ip_sales_history_wholesale
  WHERE invoice_number IS NOT NULL
    AND txn_date >= DATE '2024-08-01'
  GROUP BY 1, 2
),
ar_totals AS (
  SELECT
    EXTRACT(YEAR  FROM posting_date)::int AS year,
    EXTRACT(MONTH FROM posting_date)::int AS month,
    SUM(total_amount_cents) / 100.0       AS ar_revenue,
    COUNT(*)                              AS ar_invoice_count
  FROM ar_invoices
  WHERE invoice_kind = 'customer_invoice_historical'
  GROUP BY 1, 2
)
SELECT
  COALESCE(s.year,  a.year)  AS year,
  COALESCE(s.month, a.month) AS month,
  s.source_invoice_count,
  a.ar_invoice_count,
  s.source_revenue,
  a.ar_revenue,
  (COALESCE(s.source_revenue, 0) - COALESCE(a.ar_revenue, 0)) AS variance,
  CASE
    WHEN COALESCE(s.source_revenue, 0) = 0 THEN NULL
    ELSE ABS(COALESCE(s.source_revenue, 0) - COALESCE(a.ar_revenue, 0))
         / NULLIF(s.source_revenue, 0)
  END AS variance_pct
FROM source_totals s
FULL OUTER JOIN ar_totals a USING (year, month)
ORDER BY year DESC NULLS LAST, month DESC NULLS LAST;

COMMENT ON VIEW v_ar_backfill_reconciliation IS 'P4-8 reconciliation: per-month variance between ip_sales_history_wholesale source totals and ar_invoices historical totals. Rows where variance is non-zero need operator review.';

-- ─── 5. Patch PR #373s broken COMMENT (string concat not legal in COMMENT) ──
COMMENT ON COLUMN inventory_layers.source_kind IS 'ap_invoice | adjustment | opening_balance | transfer_in | credit_memo_return. source_invoice_id is set when source_kind=ap_invoice; source_adjustment_id when source_kind=adjustment. credit_memo_return layers carry the credit memo id in notes.';

NOTIFY pgrst, 'reload schema';
