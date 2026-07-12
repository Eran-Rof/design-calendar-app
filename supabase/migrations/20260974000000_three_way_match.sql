-- #1676 3-Way Match module (PO <-> receipt <-> AP bill)
-- Classic apparel-ERP payables control. Bill-grain match results with
-- tolerance config and a set-based engine RPC shared by cron + backfill.
--
-- Ground truth (probed 2026-07-10):
--   * AP bills = invoices.invoice_kind='vendor_bill' (3,719 rows).
--   * Explicit PO refs live on invoice_line_items.po_number (text, 4,477 lines).
--   * Receipt tables (receipts / tanda_po_receipts) are EMPTY in prod; the
--     receiving evidence for Xoro POs is po_line_items.qty_received (mirror).
--     Native purchase_order_lines.qty_received is the fallback for POs that
--     only exist natively.
--   * invoices.expense_account_id is NULL on all bills, so "not applicable"
--     classification is vendor-based: vendor has no POs => expense/freight/
--     service bill, out of 3-way scope.

-- ---------------------------------------------------------------------------
-- Tolerance configuration (single row per entity; defaults per spec)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ap_match_tolerances (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                 uuid NOT NULL DEFAULT rof_entity_id() UNIQUE,
  qty_tol_pct               numeric NOT NULL DEFAULT 2.0,   -- qty +/-2%
  price_tol_pct             numeric NOT NULL DEFAULT 1.0,   -- price +/-1% ...
  price_tol_abs_cents       bigint  NOT NULL DEFAULT 5000,  -- ... or $50
  amount_tol_abs_cents      bigint  NOT NULL DEFAULT 10000, -- amount $100
  fuzzy_amount_tol_pct      numeric NOT NULL DEFAULT 1.0,
  fuzzy_amount_tol_abs_cents bigint NOT NULL DEFAULT 10000,
  fuzzy_date_back_days      integer NOT NULL DEFAULT 180,
  fuzzy_date_fwd_days       integer NOT NULL DEFAULT 30,
  updated_by                text,
  updated_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ap_match_tolerances IS '3-way match tolerance config (one row per entity). Defaults: qty +/-2%, price +/-1% or $50, amount $100.';

INSERT INTO ap_match_tolerances (entity_id)
SELECT rof_entity_id()
WHERE NOT EXISTS (SELECT 1 FROM ap_match_tolerances WHERE entity_id = rof_entity_id());

-- ---------------------------------------------------------------------------
-- Match results (one row per AP bill; idempotent upsert by engine)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ap_bill_matches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         uuid NOT NULL DEFAULT rof_entity_id(),
  bill_id           uuid NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE CASCADE,
  status            text NOT NULL CHECK (status IN (
                      'matched_3way','matched_2way_po_only','price_variance',
                      'qty_variance','over_billed_vs_received','no_po_found',
                      'not_applicable')),
  method            text NOT NULL DEFAULT 'none' CHECK (method IN (
                      'explicit_line_ref','fuzzy_vendor_amount_date','none')),
  po_refs           jsonb NOT NULL DEFAULT '[]'::jsonb,
  variance          jsonb NOT NULL DEFAULT '{}'::jsonb,
  matched_at        timestamptz NOT NULL DEFAULT now(),
  engine_version    integer NOT NULL,
  resolution        text NOT NULL DEFAULT 'open' CHECK (resolution IN ('open','accepted','disputed')),
  resolution_reason text,
  resolved_by       text,
  resolved_at       timestamptz,
  source            text NOT NULL DEFAULT 'three_way_match_engine', -- T10
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ap_bill_matches IS '3-way match verdict per AP bill (PO <-> receiving evidence <-> bill). Written only by run_three_way_match(); resolution fields written by the exceptions panel (T11 reason required).';
COMMENT ON COLUMN ap_bill_matches.po_refs IS 'Array of {po_number, tanda_po_uuid, native_po_id} the bill was matched against. tanda_po_uuid = tanda_pos.uuid_id (never bigint id).';
COMMENT ON COLUMN ap_bill_matches.variance IS 'Engine evidence: per-PO billed vs ordered vs received qty/value/price plus tolerance check booleans.';

CREATE INDEX IF NOT EXISTS idx_ap_bill_matches_status ON ap_bill_matches(status);
CREATE INDEX IF NOT EXISTS idx_ap_bill_matches_resolution ON ap_bill_matches(resolution);

ALTER TABLE ap_bill_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_match_tolerances ENABLE ROW LEVEL SECURITY;
-- No anon policies (financial table): service-role access only, like the
-- 20260964000000 security-sprint posture.

DROP TRIGGER IF EXISTS trg_ap_bill_matches_audit ON ap_bill_matches;
CREATE TRIGGER trg_ap_bill_matches_audit
  AFTER INSERT OR UPDATE OR DELETE ON ap_bill_matches
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();
DROP TRIGGER IF EXISTS trg_ap_match_tolerances_audit ON ap_match_tolerances;
CREATE TRIGGER trg_ap_match_tolerances_audit
  AFTER INSERT OR UPDATE OR DELETE ON ap_match_tolerances
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();

-- ---------------------------------------------------------------------------
-- The engine. Set-based, idempotent, re-runnable. Called by the nightly cron,
-- the panel "Re-run engine" action, and the backfill. READ + upsert of match
-- rows only -- never touches GL, bills, POs or receipts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION run_three_way_match()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_engine_version constant integer := 1;
  v_summary jsonb;
BEGIN
  -- Re-runnable within one session/transaction
  DROP TABLE IF EXISTS _twm_tol, _twm_po, _twm_bills, _twm_bill_po, _twm_cum,
                       _twm_explicit, _twm_fuzzy, _twm_final;

  -- Tolerances (single tenant today; first row wins)
  CREATE TEMP TABLE _twm_tol ON COMMIT DROP AS
    SELECT qty_tol_pct, price_tol_pct, price_tol_abs_cents, amount_tol_abs_cents,
           fuzzy_amount_tol_pct, fuzzy_amount_tol_abs_cents,
           fuzzy_date_back_days, fuzzy_date_fwd_days
    FROM ap_match_tolerances ORDER BY updated_at DESC LIMIT 1;
  -- Never run with NO tolerance row (an empty CROSS JOIN would empty
  -- _twm_final and DELETE every match row) — fall back to the defaults.
  IF NOT EXISTS (SELECT 1 FROM _twm_tol) THEN
    INSERT INTO _twm_tol VALUES (2.0, 1.0, 5000, 10000, 1.0, 10000, 180, 30);
  END IF;

  -- PO index: Xoro-mirrored POs (tanda_pos + po_line_items) are canonical;
  -- native purchase_orders only contribute PO numbers absent from the mirror.
  CREATE TEMP TABLE _twm_po ON COMMIT DROP AS
  SELECT tp.po_number,
         tp.uuid_id            AS tanda_po_uuid,
         NULL::uuid            AS native_po_id,
         tp.vendor_id,
         tp.date_order         AS order_date,
         COALESCE(SUM(p.qty_ordered), 0)                                AS ordered_qty,
         COALESCE(SUM(p.line_total), 0)                                 AS ordered_val,
         COALESCE(SUM(p.qty_received), 0)                               AS received_qty,
         COALESCE(SUM(p.qty_received * COALESCE(p.unit_price, 0)), 0)   AS received_val,
         CASE WHEN COALESCE(SUM(p.qty_ordered),0) > 0
              THEN SUM(COALESCE(p.line_total,0)) / SUM(p.qty_ordered) END AS po_avg_price
  FROM tanda_pos tp
  LEFT JOIN po_line_items p ON p.po_id = tp.uuid_id
  GROUP BY tp.po_number, tp.uuid_id, tp.vendor_id, tp.date_order
  UNION ALL
  SELECT np.po_number, NULL, np.id, np.vendor_id, np.order_date,
         COALESCE(SUM(l.qty_ordered), 0),
         COALESCE(SUM(l.line_total_cents), 0) / 100.0,
         COALESCE(SUM(l.qty_received), 0),
         COALESCE(SUM(l.qty_received * COALESCE(l.unit_cost_cents, 0)), 0) / 100.0,
         CASE WHEN COALESCE(SUM(l.qty_ordered),0) > 0
              THEN (COALESCE(SUM(l.line_total_cents),0) / 100.0) / SUM(l.qty_ordered) END
  FROM purchase_orders np
  LEFT JOIN purchase_order_lines l ON l.purchase_order_id = np.id
  WHERE NOT EXISTS (SELECT 1 FROM tanda_pos t2 WHERE t2.po_number = np.po_number)
  GROUP BY np.po_number, np.id, np.vendor_id, np.order_date;

  CREATE INDEX ON _twm_po (po_number);
  CREATE INDEX ON _twm_po (vendor_id);

  -- Bill universe
  CREATE TEMP TABLE _twm_bills ON COMMIT DROP AS
    SELECT i.id, i.vendor_id, i.invoice_date,
           COALESCE(i.total_amount_cents, 0) / 100.0 AS total_val
    FROM invoices i
    WHERE i.invoice_kind = 'vendor_bill'
      AND COALESCE(i.status, '') <> 'rejected';

  -- Explicit bill<->PO line refs, aggregated to bill x po_number grain
  CREATE TEMP TABLE _twm_bill_po ON COMMIT DROP AS
    SELECT ili.invoice_id, ili.po_number,
           SUM(COALESCE(ili.line_total, 0))        AS billed_val,
           SUM(COALESCE(ili.quantity_invoiced, 0)) AS billed_qty,
           CASE WHEN SUM(COALESCE(ili.quantity_invoiced,0)) > 0
                THEN SUM(COALESCE(ili.line_total,0)) / SUM(ili.quantity_invoiced) END AS billed_avg_price
    FROM invoice_line_items ili
    JOIN _twm_bills b ON b.id = ili.invoice_id
    WHERE ili.po_number IS NOT NULL AND ili.po_number <> ''
    GROUP BY ili.invoice_id, ili.po_number;

  -- Cumulative billed per PO across ALL bills (over-billing is cumulative)
  CREATE TEMP TABLE _twm_cum ON COMMIT DROP AS
    SELECT po_number,
           SUM(billed_val) AS cum_billed_val,
           SUM(billed_qty) AS cum_billed_qty
    FROM _twm_bill_po GROUP BY po_number;

  -- Evaluate explicit-ref bills
  CREATE TEMP TABLE _twm_explicit ON COMMIT DROP AS
    SELECT bp.invoice_id,
           BOOL_OR(px.po_number IS NOT NULL) AS any_po_found,
           BOOL_AND(px.po_number IS NOT NULL) AS all_po_found,
           BOOL_OR(COALESCE(px.received_qty, 0) > 0) AS any_receipt,
           BOOL_OR(px.po_number IS NOT NULL AND px.received_qty > 0
                   AND c.cum_billed_val > px.received_val
                       + GREATEST(t.amount_tol_abs_cents / 100.0,
                                  px.received_val * t.qty_tol_pct / 100.0)) AS over_billed,
           BOOL_OR(px.po_number IS NOT NULL AND px.received_qty > 0
                   AND c.cum_billed_qty > px.received_qty * (1 + t.qty_tol_pct / 100.0)) AS qty_var,
           BOOL_OR(px.po_number IS NOT NULL
                   AND bp.billed_avg_price IS NOT NULL AND px.po_avg_price IS NOT NULL
                   AND ABS(bp.billed_avg_price - px.po_avg_price)
                       > GREATEST(px.po_avg_price * t.price_tol_pct / 100.0,
                                  t.price_tol_abs_cents / 100.0)) AS price_var,
           jsonb_agg(jsonb_build_object(
             'po_number', bp.po_number,
             'tanda_po_uuid', px.tanda_po_uuid,
             'native_po_id', px.native_po_id) ORDER BY bp.po_number) AS po_refs,
           jsonb_agg(jsonb_build_object(
             'po_number', bp.po_number,
             'found', px.po_number IS NOT NULL,
             'billed_val', ROUND(bp.billed_val::numeric, 2),
             'billed_qty', bp.billed_qty,
             'billed_avg_price', ROUND(bp.billed_avg_price::numeric, 4),
             'ordered_qty', px.ordered_qty,
             'ordered_val', ROUND(px.ordered_val::numeric, 2),
             'received_qty', px.received_qty,
             'received_val', ROUND(px.received_val::numeric, 2),
             'po_avg_price', ROUND(px.po_avg_price::numeric, 4),
             'cum_billed_val', ROUND(c.cum_billed_val::numeric, 2),
             'cum_billed_qty', c.cum_billed_qty) ORDER BY bp.po_number) AS variance_pos
    FROM _twm_bill_po bp
    LEFT JOIN _twm_po px ON px.po_number = bp.po_number
    LEFT JOIN _twm_cum c ON c.po_number = bp.po_number
    CROSS JOIN _twm_tol t
    GROUP BY bp.invoice_id;

  -- Fuzzy candidates for bills without explicit refs: vendor + amount within
  -- tolerance + PO order date inside the window; only a UNIQUE candidate
  -- counts as a match.
  CREATE TEMP TABLE _twm_fuzzy ON COMMIT DROP AS
    SELECT invoice_id, po_number, tanda_po_uuid, native_po_id,
           ordered_qty, ordered_val, received_qty, received_val, po_avg_price, total_val
    FROM (
      SELECT b.id AS invoice_id, px.*, b.total_val,
             COUNT(*) OVER (PARTITION BY b.id) AS n_cand
      FROM _twm_bills b
      CROSS JOIN _twm_tol t
      JOIN _twm_po px ON px.vendor_id = b.vendor_id
        AND ABS(px.ordered_val - b.total_val)
              <= GREATEST(t.fuzzy_amount_tol_abs_cents / 100.0,
                          px.ordered_val * t.fuzzy_amount_tol_pct / 100.0)
        AND px.order_date BETWEEN b.invoice_date - t.fuzzy_date_back_days
                              AND b.invoice_date + t.fuzzy_date_fwd_days
      WHERE NOT EXISTS (SELECT 1 FROM _twm_bill_po bp WHERE bp.invoice_id = b.id)
    ) z
    WHERE n_cand = 1;

  -- Final verdict per bill
  CREATE TEMP TABLE _twm_final ON COMMIT DROP AS
    SELECT b.id AS bill_id,
           CASE
             WHEN e.invoice_id IS NOT NULL THEN
               CASE
                 WHEN NOT e.any_po_found THEN 'no_po_found'
                 WHEN NOT e.any_receipt  THEN 'matched_2way_po_only'
                 WHEN e.over_billed      THEN 'over_billed_vs_received'
                 WHEN e.qty_var          THEN 'qty_variance'
                 WHEN e.price_var        THEN 'price_variance'
                 ELSE 'matched_3way'
               END
             WHEN f.invoice_id IS NOT NULL THEN
               CASE
                 WHEN COALESCE(f.received_qty, 0) = 0 THEN 'matched_2way_po_only'
                 WHEN f.total_val > f.received_val
                      + GREATEST(t.amount_tol_abs_cents / 100.0,
                                 f.received_val * t.qty_tol_pct / 100.0)
                   THEN 'over_billed_vs_received'
                 ELSE 'matched_3way'
               END
             WHEN EXISTS (SELECT 1 FROM _twm_po px WHERE px.vendor_id = b.vendor_id)
               THEN 'no_po_found'
             ELSE 'not_applicable'
           END AS status,
           CASE
             WHEN e.invoice_id IS NOT NULL THEN 'explicit_line_ref'
             WHEN f.invoice_id IS NOT NULL THEN 'fuzzy_vendor_amount_date'
             ELSE 'none'
           END AS method,
           CASE
             WHEN e.invoice_id IS NOT NULL THEN e.po_refs
             WHEN f.invoice_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
               'po_number', f.po_number,
               'tanda_po_uuid', f.tanda_po_uuid,
               'native_po_id', f.native_po_id))
             ELSE '[]'::jsonb
           END AS po_refs,
           CASE
             WHEN e.invoice_id IS NOT NULL THEN jsonb_build_object(
               'pos', e.variance_pos,
               'checks', jsonb_build_object(
                 'over_billed', e.over_billed, 'qty', e.qty_var,
                 'price', e.price_var, 'all_po_found', e.all_po_found,
                 'any_receipt', e.any_receipt))
             WHEN f.invoice_id IS NOT NULL THEN jsonb_build_object(
               'pos', jsonb_build_array(jsonb_build_object(
                 'po_number', f.po_number,
                 'found', true,
                 'billed_val', ROUND(f.total_val::numeric, 2),
                 'ordered_qty', f.ordered_qty,
                 'ordered_val', ROUND(f.ordered_val::numeric, 2),
                 'received_qty', f.received_qty,
                 'received_val', ROUND(f.received_val::numeric, 2),
                 'po_avg_price', ROUND(f.po_avg_price::numeric, 4))),
               'checks', jsonb_build_object('fuzzy', true))
             ELSE '{}'::jsonb
           END AS variance
    FROM _twm_bills b
    LEFT JOIN _twm_explicit e ON e.invoice_id = b.id
    LEFT JOIN _twm_fuzzy f ON f.invoice_id = b.id
    CROSS JOIN _twm_tol t;

  INSERT INTO ap_bill_matches AS m
    (bill_id, status, method, po_refs, variance, matched_at, engine_version)
  SELECT bill_id, status, method, po_refs, variance, now(), v_engine_version
  FROM _twm_final
  ON CONFLICT (bill_id) DO UPDATE SET
    status         = EXCLUDED.status,
    method         = EXCLUDED.method,
    po_refs        = EXCLUDED.po_refs,
    variance       = EXCLUDED.variance,
    matched_at     = EXCLUDED.matched_at,
    engine_version = EXCLUDED.engine_version,
    updated_at     = now(),
    -- A human resolution survives re-runs unless the verdict changed.
    resolution        = CASE WHEN m.status = EXCLUDED.status THEN m.resolution ELSE 'open' END,
    resolution_reason = CASE WHEN m.status = EXCLUDED.status THEN m.resolution_reason ELSE NULL END,
    resolved_by       = CASE WHEN m.status = EXCLUDED.status THEN m.resolved_by ELSE NULL END,
    resolved_at       = CASE WHEN m.status = EXCLUDED.status THEN m.resolved_at ELSE NULL END
  -- Skip no-op updates: keeps matched_at meaningful ("last verdict change")
  -- and avoids ~4k audit-trigger rows per nightly run.
  WHERE m.status <> EXCLUDED.status
     OR m.method <> EXCLUDED.method
     OR m.po_refs <> EXCLUDED.po_refs
     OR m.variance <> EXCLUDED.variance
     OR m.engine_version <> EXCLUDED.engine_version;

  -- Remove match rows for bills that left the universe (voided/rejected)
  DELETE FROM ap_bill_matches m
  WHERE NOT EXISTS (SELECT 1 FROM _twm_bills b WHERE b.id = m.bill_id);

  SELECT jsonb_build_object(
           'engine_version', v_engine_version,
           'ran_at', now(),
           'bills', (SELECT COUNT(*) FROM ap_bill_matches),
           'by_status', (SELECT COALESCE(jsonb_object_agg(status, jsonb_build_object(
                           'n', n, 'total', total)), '{}'::jsonb)
                         FROM (SELECT m.status, COUNT(*) n,
                                      ROUND(SUM(COALESCE(i.total_amount_cents,0)) / 100.0, 2) total
                               FROM ap_bill_matches m
                               JOIN invoices i ON i.id = m.bill_id
                               GROUP BY m.status) s))
  INTO v_summary;

  RETURN v_summary;
END;
$$;

COMMENT ON FUNCTION run_three_way_match() IS '3-way match engine v1. Idempotent full re-run over all AP bills; upserts ap_bill_matches only (no GL/bill/PO writes). Shared by nightly cron, panel re-run and backfill.';

REVOKE ALL ON FUNCTION run_three_way_match() FROM PUBLIC;
REVOKE ALL ON FUNCTION run_three_way_match() FROM anon;

-- ---------------------------------------------------------------------------
-- Exception resolution (Accept variance / Dispute) — T11: reason REQUIRED,
-- plumbed to the audit trigger via set_audit_context in the same transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_ap_bill_match(
  p_match_id  uuid,
  p_resolution text,
  p_reason     text,
  p_actor_name text DEFAULT NULL
)
RETURNS ap_bill_matches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row ap_bill_matches;
BEGIN
  IF p_resolution NOT IN ('accepted', 'disputed', 'open') THEN
    RAISE EXCEPTION 'resolution must be accepted, disputed or open (got %)', p_resolution;
  END IF;
  IF p_resolution <> 'open' AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'A reason is required to % this match (T11).',
      CASE p_resolution WHEN 'accepted' THEN 'accept' ELSE 'dispute' END;
  END IF;

  PERFORM set_audit_context(
    NULL::uuid, NULL::uuid,
    COALESCE(NULLIF(btrim(p_actor_name), ''), 'internal'),
    'manual',
    NULLIF(btrim(p_reason), ''),
    NULL::text);

  UPDATE ap_bill_matches SET
    resolution        = p_resolution,
    resolution_reason = CASE WHEN p_resolution = 'open' THEN NULL ELSE btrim(p_reason) END,
    resolved_by       = CASE WHEN p_resolution = 'open' THEN NULL ELSE COALESCE(NULLIF(btrim(p_actor_name), ''), 'internal') END,
    resolved_at       = CASE WHEN p_resolution = 'open' THEN NULL ELSE now() END,
    updated_at        = now()
  WHERE id = p_match_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ap_bill_matches row % not found', p_match_id;
  END IF;

  PERFORM clear_audit_context();
  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION resolve_ap_bill_match(uuid, text, text, text) IS 'Accept/dispute/re-open a 3-way match exception. Reason required (T11); audit context set for the row_changes trigger.';
REVOKE ALL ON FUNCTION resolve_ap_bill_match(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_ap_bill_match(uuid, text, text, text) FROM anon;
