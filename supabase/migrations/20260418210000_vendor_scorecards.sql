-- 20260418210000_vendor_scorecards.sql
--
-- Phase 3.3/3.4 — vendor scorecards (persistent period rollups) and a
-- live KPI view used by the vendor dashboard and internal leaderboard.
--
-- The view computes KPIs on demand from the source tables (tanda_pos +
-- po_acknowledgments + invoices + three_way_match_view). Persist a
-- snapshot via compute_vendor_scorecard(period_start, period_end) when
-- you want a monthly/quarterly historical record.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. vendor_scorecards (snapshotted rollups)
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_scorecards (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id                 uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,

  period_start              date NOT NULL,
  period_end                date NOT NULL,

  on_time_delivery_pct      numeric(5, 2),
  invoice_accuracy_pct      numeric(5, 2),
  avg_acknowledgment_hours  numeric(8, 2),

  po_count                  integer NOT NULL DEFAULT 0,
  invoice_count             integer NOT NULL DEFAULT 0,
  discrepancy_count         integer NOT NULL DEFAULT 0,

  composite_score           numeric(5, 2),   -- weighted blend (computed in function)
  generated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_scorecard_period CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_scorecards_vendor_period
  ON vendor_scorecards (vendor_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_vendor_scorecards_vendor_id ON vendor_scorecards (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_scorecards_period    ON vendor_scorecards (period_start, period_end);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. vendor_kpi_live view (no date filter — last-180-day rolling window)
--    Used by the vendor dashboard and internal leaderboard for "current"
--    numbers without having to materialise a scorecard row.
-- ══════════════════════════════════════════════════════════════════════════
DROP VIEW IF EXISTS vendor_kpi_live CASCADE;
CREATE VIEW vendor_kpi_live
WITH (security_invoker = on) AS
WITH
period AS (
  SELECT (CURRENT_DATE - INTERVAL '180 days')::date AS start_date, CURRENT_DATE AS end_date
),
po_scope AS (
  SELECT tp.uuid_id, tp.vendor_id, tp.po_number,
         (tp.data->>'DateOrder')::date            AS issued_date,
         COALESCE(tp.date_expected_delivery, tp.data->>'DateExpectedDelivery')::date AS required_by,
         ack.acknowledged_at
  FROM   tanda_pos tp
  LEFT JOIN po_acknowledgments ack ON ack.po_number = tp.po_number
  CROSS JOIN period p
  WHERE  tp.vendor_id IS NOT NULL
    AND  (tp.data->>'DateOrder')::date BETWEEN p.start_date AND p.end_date
),
on_time AS (
  SELECT vendor_id,
         COUNT(*)                                                                       AS po_count,
         SUM(CASE WHEN required_by IS NULL OR required_by >= CURRENT_DATE THEN 1 ELSE 0 END)::int
           AS on_time_or_pending,  -- optimistic: not yet due or delivered on time (proxy)
         AVG(CASE WHEN acknowledged_at IS NOT NULL AND issued_date IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (acknowledged_at - issued_date::timestamptz)) / 3600.0
                  END)                                                                  AS avg_ack_hours
  FROM   po_scope
  GROUP BY vendor_id
),
inv AS (
  SELECT v.id AS vendor_id,
         COUNT(i.id)                                                                   AS invoice_count,
         SUM(CASE WHEN i.status = 'paid' THEN 1 ELSE 0 END)::int                        AS paid_count
  FROM   vendors v
  LEFT JOIN invoices i ON i.vendor_id = v.id
       AND i.submitted_at::date BETWEEN (SELECT start_date FROM period) AND (SELECT end_date FROM period)
  GROUP BY v.id
),
disc AS (
  -- Count discrepancies across this vendor's PO lines from the three-way view
  SELECT m.vendor_id,
         SUM(CASE WHEN m.line_status = 'discrepancy' THEN 1 ELSE 0 END)::int AS discrepancy_count,
         COUNT(*)::int                                                        AS line_count,
         SUM(CASE WHEN m.line_status = 'matched' THEN 1 ELSE 0 END)::int      AS matched_count
  FROM   three_way_match_view m
  GROUP BY m.vendor_id
)
SELECT
  v.id                                             AS vendor_id,
  v.name                                            AS vendor_name,
  (SELECT start_date FROM period)                   AS period_start,
  (SELECT end_date   FROM period)                   AS period_end,

  COALESCE(ot.po_count, 0)                          AS po_count,
  COALESCE(inv.invoice_count, 0)                    AS invoice_count,
  COALESCE(disc.discrepancy_count, 0)               AS discrepancy_count,

  ROUND(ot.avg_ack_hours::numeric, 2)               AS avg_acknowledgment_hours,

  -- On-time delivery: proxy until we wire in real delivered dates.
  CASE WHEN COALESCE(ot.po_count, 0) = 0 THEN NULL
       ELSE ROUND(100.0 * ot.on_time_or_pending / ot.po_count, 2)
  END                                                AS on_time_delivery_pct,

  -- Invoice accuracy: 100 minus discrepancy rate across matched lines.
  CASE WHEN COALESCE(disc.line_count, 0) = 0 THEN NULL
       ELSE ROUND(100.0 * (disc.line_count - disc.discrepancy_count) / disc.line_count, 2)
  END                                                AS invoice_accuracy_pct
FROM   vendors v
LEFT JOIN on_time ot ON ot.vendor_id = v.id
LEFT JOIN inv       ON inv.vendor_id = v.id
LEFT JOIN disc      ON disc.vendor_id = v.id
WHERE  v.deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. compute_vendor_scorecard — snapshot a named period to vendor_scorecards
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION compute_vendor_scorecard(
  p_vendor_id    uuid,
  p_period_start date,
  p_period_end   date
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_po_count int := 0;
  v_on_time_pct numeric;
  v_avg_ack numeric;
  v_inv_count int := 0;
  v_disc_count int := 0;
  v_matched_count int := 0;
  v_line_count int := 0;
  v_acc_pct numeric;
  v_composite numeric;
  v_id uuid;
BEGIN
  -- POs in period
  SELECT COUNT(*),
         SUM(CASE WHEN
                  (tp.date_expected_delivery IS NULL
                   OR tp.date_expected_delivery::date >= CURRENT_DATE)
                  THEN 1 ELSE 0 END)::numeric * 100.0 / NULLIF(COUNT(*), 0),
         AVG(CASE WHEN ack.acknowledged_at IS NOT NULL AND (tp.data->>'DateOrder') IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (ack.acknowledged_at - (tp.data->>'DateOrder')::timestamptz)) / 3600.0
                  END)
    INTO v_po_count, v_on_time_pct, v_avg_ack
  FROM   tanda_pos tp
  LEFT JOIN po_acknowledgments ack ON ack.po_number = tp.po_number
  WHERE  tp.vendor_id = p_vendor_id
    AND  (tp.data->>'DateOrder')::date BETWEEN p_period_start AND p_period_end;

  -- Invoices in period
  SELECT COUNT(*) INTO v_inv_count
  FROM   invoices i
  WHERE  i.vendor_id = p_vendor_id
    AND  i.submitted_at::date BETWEEN p_period_start AND p_period_end;

  -- Discrepancies + total match lines across this vendor's POs in period
  SELECT COUNT(*),
         SUM(CASE WHEN m.line_status = 'discrepancy' THEN 1 ELSE 0 END)::int,
         SUM(CASE WHEN m.line_status = 'matched' THEN 1 ELSE 0 END)::int
    INTO v_line_count, v_disc_count, v_matched_count
  FROM   three_way_match_view m
  JOIN   tanda_pos tp ON tp.uuid_id = m.po_id
  WHERE  m.vendor_id = p_vendor_id
    AND  (tp.data->>'DateOrder')::date BETWEEN p_period_start AND p_period_end;

  IF v_line_count > 0 THEN
    v_acc_pct := ROUND(100.0 * (v_line_count - v_disc_count) / v_line_count, 2);
  END IF;

  -- Composite: 50% on-time + 40% accuracy + 10% acknowledgment speed
  -- (lower ack_hours is better; scale so 24h = 100, 72h = 0, clamped)
  v_composite := ROUND(
    COALESCE(v_on_time_pct, 0) * 0.50
  + COALESCE(v_acc_pct,    0) * 0.40
  + LEAST(100.0, GREATEST(0.0, 100.0 - (COALESCE(v_avg_ack, 48) - 24) * 100.0 / 48.0)) * 0.10
  , 2);

  INSERT INTO vendor_scorecards (
    vendor_id, period_start, period_end,
    on_time_delivery_pct, invoice_accuracy_pct, avg_acknowledgment_hours,
    po_count, invoice_count, discrepancy_count,
    composite_score
  ) VALUES (
    p_vendor_id, p_period_start, p_period_end,
    ROUND(v_on_time_pct, 2), v_acc_pct, ROUND(v_avg_ack, 2),
    v_po_count, v_inv_count, v_disc_count,
    v_composite
  )
  ON CONFLICT (vendor_id, period_start, period_end)
  DO UPDATE SET
    on_time_delivery_pct     = EXCLUDED.on_time_delivery_pct,
    invoice_accuracy_pct     = EXCLUDED.invoice_accuracy_pct,
    avg_acknowledgment_hours = EXCLUDED.avg_acknowledgment_hours,
    po_count                 = EXCLUDED.po_count,
    invoice_count            = EXCLUDED.invoice_count,
    discrepancy_count        = EXCLUDED.discrepancy_count,
    composite_score          = EXCLUDED.composite_score,
    generated_at             = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE vendor_scorecards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_vendor_scorecards" ON vendor_scorecards;
CREATE POLICY "anon_all_vendor_scorecards" ON vendor_scorecards
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_scorecards_select" ON vendor_scorecards;
CREATE POLICY "vendor_own_scorecards_select" ON vendor_scorecards
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
