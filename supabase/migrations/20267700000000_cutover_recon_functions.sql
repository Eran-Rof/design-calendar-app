-- 20267700000000_cutover_recon_functions.sql
--
-- Cutover Reconciliation report (GET /api/internal/cutover-recon).
--
-- Six jsonb-returning tie-out functions, one per domain, each comparing the
-- Tangerine operational tables (native) against the Xoro mirror feeds. Each
-- returns { headline{}, variances[] (capped 200), variance_total, note } so a
-- single RPC round-trip carries the whole section and the PostgREST 1000-row
-- cap never bites. Every query is set-based and bounded (LIMIT 200 on the
-- variance sample; counts aggregate the full set) to stay well under the 60s
-- service_role statement timeout.
--
-- Classification of the returned rows is finished in JS (api/_lib/cutoverRecon.js,
-- classifyRow) so the *definition* of a variance is unit-tested in one place;
-- these functions emit the raw {native_present, mirror_present, native_value,
-- mirror_value, native_status, mirror_status} shape that classifyRow consumes,
-- plus the accurate full-set counts that drive the PASS/FAIL card.
--
-- INVENTORY reuses inventory_onhand_accuracy_summary() + v_inventory_onhand_reconcile
-- (migration that created those). GL reuses v_xoro_tangerine_tb_recon. Nothing
-- here recomputes on-hand cost or the TB break categories from scratch.

-- ── helper: cap constant is inlined (200) per function ────────────────────────

-- 1. INVENTORY -----------------------------------------------------------------
-- Tangerine inventory_layers (remaining>0) units + value at cost vs the REST
-- by-size truth (tangerine_size_onhand latest snapshot). Reuses the existing
-- accuracy summary for headline counts; variance rows are the divergent SKUs
-- ordered by cost exposure. The mirror (REST) is units-only, so the $ headline
-- is the Tangerine layer valuation and exposure is the divergence valued at cost.
CREATE OR REPLACE FUNCTION public.cutover_recon_inventory()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH s AS (SELECT inventory_onhand_accuracy_summary() AS j),
  val AS (
    SELECT COALESCE(sum(layers_qty * unit_cost_cents) FILTER (WHERE layers_qty > 0), 0) AS layers_value_cents
    FROM v_inventory_onhand_reconcile
  ),
  vr AS (
    SELECT sku_code, style_code, color, size, layers_qty, rest_qty,
           divergence, abs_divergence, divergence_value_cents, severity
    FROM v_inventory_onhand_reconcile
    WHERE severity <> 'tie'
    ORDER BY abs(COALESCE(divergence_value_cents, 0)) DESC, abs_divergence DESC
    LIMIT 200
  )
  SELECT jsonb_build_object(
    'headline', jsonb_build_object(
      'rest_snapshot_date',  (SELECT j->>'rest_snapshot_date' FROM s),
      'layers_units',        (SELECT (j->>'layers_total_units')::numeric FROM s),
      'rest_units',          (SELECT (j->>'rest_total_units')::numeric FROM s),
      'unit_divergence',     (SELECT (j->>'sum_abs_units')::numeric FROM s),
      'layers_value_cents',  (SELECT layers_value_cents FROM val),
      'exposure_cents',      (SELECT (j->>'exposure_cents')::numeric FROM s),
      'skus_total',          (SELECT (j->>'skus_total')::int FROM s),
      'skus_divergent',      (SELECT (j->>'skus_divergent')::int FROM s),
      'skus_material',       (SELECT (j->>'skus_material')::int FROM s),
      'status_break_count',  (SELECT (j->>'skus_material')::int FROM s),
      'variance_count',      (SELECT (j->>'skus_divergent')::int FROM s)
    ),
    'variances', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'key', sku_code, 'style_code', style_code, 'color', color, 'size', size,
        'native_present', layers_qty <> 0, 'mirror_present', rest_qty <> 0,
        'native_value', layers_qty, 'mirror_value', rest_qty,
        'native_status', severity, 'mirror_status', severity,
        'divergence_units', divergence, 'exposure_cents', divergence_value_cents,
        'severity', severity)) FROM vr), '[]'::jsonb),
    'variance_total', (SELECT (j->>'skus_divergent')::int FROM s),
    'note', 'Xoro REST by-size feed is units-only; the $ headline is the Tangerine layer valuation at cost and exposure is the unit divergence valued at cost.'
  );
$$;

-- 2. SALES ORDERS --------------------------------------------------------------
-- native sales_orders (confirmed, fulfilling) vs tanda_sos (Released,
-- Partially Shipped) by so_number; qty native = SUM(sales_order_lines.qty_ordered),
-- mirror = SUM(data->'Items'[].QtyOrder). mirror_status shows the actual Xoro
-- status (incl. terminal) so a native-open SO that Xoro has cancelled is visible.
CREATE OR REPLACE FUNCTION public.cutover_recon_sales_orders()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH nat AS (
    SELECT so.so_number AS k, so.status AS st, COALESCE(sum(l.qty_ordered), 0) AS qty
    FROM sales_orders so
    LEFT JOIN sales_order_lines l ON l.sales_order_id = so.id
    WHERE so.status IN ('confirmed', 'fulfilling')
    GROUP BY so.so_number, so.status
  ),
  mir AS (
    SELECT t.so_number AS k, t.status AS st,
           COALESCE(sum((it.value->>'QtyOrder')::numeric), 0) AS qty
    FROM tanda_sos t
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.data->'Items') = 'array' THEN t.data->'Items' ELSE '[]'::jsonb END) it ON true
    WHERE t.status IN ('Released', 'Partially Shipped')
    GROUP BY t.so_number, t.status
  ),
  mir_all AS (SELECT so_number AS k, status AS st FROM tanda_sos),
  j AS (
    SELECT COALESCE(n.k, m.k) AS k,
           (n.k IS NOT NULL) AS np, (m.k IS NOT NULL) AS mp,
           COALESCE(n.qty, 0) AS nq, COALESCE(m.qty, 0) AS mq,
           n.st AS ns, COALESCE(m.st, ma.st, '(absent)') AS ms
    FROM nat n
    FULL OUTER JOIN mir m ON n.k = m.k
    LEFT JOIN mir_all ma ON ma.k = COALESCE(n.k, m.k)
  ),
  v AS (SELECT * FROM j WHERE NOT (np AND mp AND nq = mq))
  SELECT jsonb_build_object(
    'headline', jsonb_build_object(
      'native_open_count', (SELECT count(*) FROM nat),
      'mirror_active_count', (SELECT count(*) FROM mir),
      'native_open_qty', (SELECT COALESCE(sum(qty), 0) FROM nat),
      'mirror_active_qty', (SELECT COALESCE(sum(qty), 0) FROM mir),
      'status_break_count', (SELECT count(*) FROM v),
      'variance_count', (SELECT count(*) FROM v)
    ),
    'variances', COALESCE((SELECT jsonb_agg(x) FROM (
      SELECT jsonb_build_object(
        'key', k, 'native_present', np, 'mirror_present', mp,
        'native_value', nq, 'mirror_value', mq,
        'native_status', ns, 'mirror_status', ms) AS x
      FROM v ORDER BY abs(nq - mq) DESC, k LIMIT 200) q), '[]'::jsonb),
    'variance_total', (SELECT count(*) FROM v),
    'note', null
  );
$$;

-- 3. PURCHASE ORDERS -----------------------------------------------------------
-- native purchase_orders (issued, partially_received) vs tanda_pos (Released,
-- Open, Partially Received) by po_number; qty native = SUM(purchase_order_lines
-- .qty_ordered), mirror = SUM(data->'Items'[].QtyOrder).
CREATE OR REPLACE FUNCTION public.cutover_recon_purchase_orders()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH nat AS (
    SELECT po.po_number AS k, max(po.status) AS st, COALESCE(sum(l.qty_ordered), 0) AS qty
    FROM purchase_orders po
    LEFT JOIN purchase_order_lines l ON l.purchase_order_id = po.id
    WHERE po.status IN ('issued', 'partially_received')
    GROUP BY po.po_number
  ),
  mir AS (
    SELECT t.po_number AS k, t.status AS st,
           COALESCE(sum((it.value->>'QtyOrder')::numeric), 0) AS qty
    FROM tanda_pos t
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.data->'Items') = 'array' THEN t.data->'Items' ELSE '[]'::jsonb END) it ON true
    WHERE t.status IN ('Released', 'Open', 'Partially Received')
    GROUP BY t.po_number, t.status
  ),
  mir_all AS (SELECT po_number AS k, status AS st FROM tanda_pos),
  j AS (
    SELECT COALESCE(n.k, m.k) AS k,
           (n.k IS NOT NULL) AS np, (m.k IS NOT NULL) AS mp,
           COALESCE(n.qty, 0) AS nq, COALESCE(m.qty, 0) AS mq,
           n.st AS ns, COALESCE(m.st, ma.st, '(absent)') AS ms
    FROM nat n
    FULL OUTER JOIN mir m ON n.k = m.k
    LEFT JOIN mir_all ma ON ma.k = COALESCE(n.k, m.k)
  ),
  v AS (SELECT * FROM j WHERE NOT (np AND mp AND nq = mq))
  SELECT jsonb_build_object(
    'headline', jsonb_build_object(
      'native_inbound_count', (SELECT count(*) FROM nat),
      'mirror_inbound_count', (SELECT count(*) FROM mir),
      'native_inbound_qty', (SELECT COALESCE(sum(qty), 0) FROM nat),
      'mirror_inbound_qty', (SELECT COALESCE(sum(qty), 0) FROM mir),
      'status_break_count', (SELECT count(*) FROM v),
      'variance_count', (SELECT count(*) FROM v)
    ),
    'variances', COALESCE((SELECT jsonb_agg(x) FROM (
      SELECT jsonb_build_object(
        'key', k, 'native_present', np, 'mirror_present', mp,
        'native_value', nq, 'mirror_value', mq,
        'native_status', ns, 'mirror_status', ms) AS x
      FROM v ORDER BY abs(nq - mq) DESC, k LIMIT 200) q), '[]'::jsonb),
    'variance_total', (SELECT count(*) FROM v),
    'note', null
  );
$$;

-- 4. ACCOUNTS RECEIVABLE -------------------------------------------------------
-- native ar_invoices open (total_amount_cents > paid_amount_cents) vs the Xoro
-- AR mirror ar_xoro_payment_state (payment_status='Open'). The mirror is a
-- payment-STATUS flag with NO per-invoice dollar balance, so this is a
-- count/status set reconciliation: native dollars are for context only.
CREATE OR REPLACE FUNCTION public.cutover_recon_ar()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH nat AS (
    SELECT invoice_number AS k, (total_amount_cents - COALESCE(paid_amount_cents, 0)) AS open_cents
    FROM ar_invoices
    WHERE total_amount_cents > COALESCE(paid_amount_cents, 0)
  ),
  mir AS (SELECT DISTINCT invoice_number AS k FROM ar_xoro_payment_state WHERE payment_status = 'Open'),
  j AS (
    SELECT COALESCE(n.k, m.k) AS k,
           (n.k IS NOT NULL) AS np, (m.k IS NOT NULL) AS mp,
           COALESCE(n.open_cents, 0) AS ncents
    FROM nat n FULL OUTER JOIN mir m ON n.k = m.k
  ),
  v AS (SELECT * FROM j WHERE NOT (np AND mp))
  SELECT jsonb_build_object(
    'headline', jsonb_build_object(
      'native_open_count', (SELECT count(*) FROM nat),
      'native_open_cents', (SELECT COALESCE(sum(open_cents), 0) FROM nat),
      'mirror_open_count', (SELECT count(*) FROM mir),
      'matched_count', (SELECT count(*) FROM j WHERE np AND mp),
      'native_open_not_mirror', (SELECT count(*) FROM v WHERE np AND NOT mp),
      'mirror_open_not_native', (SELECT count(*) FROM v WHERE mp AND NOT np),
      'native_open_not_mirror_cents', (SELECT COALESCE(sum(ncents), 0) FROM v WHERE np AND NOT mp),
      'status_break_count', (SELECT count(*) FROM v),
      'variance_count', (SELECT count(*) FROM v)
    ),
    'variances', COALESCE((SELECT jsonb_agg(x) FROM (
      SELECT jsonb_build_object(
        'key', k, 'native_present', np, 'mirror_present', mp,
        'native_value', ncents, 'mirror_value', null,
        'native_status', CASE WHEN np THEN 'open' ELSE NULL END,
        'mirror_status', CASE WHEN mp THEN 'Open' ELSE '(not open)' END) AS x
      FROM v ORDER BY ncents DESC, k LIMIT 200) q), '[]'::jsonb),
    'variance_total', (SELECT count(*) FROM v),
    'note', 'Xoro AR mirror (ar_xoro_payment_state) carries the Open/Paid flag only, not per-invoice open dollars. This tie-out is a count/status reconciliation; the $ figures are the native open balances for context.'
  );
$$;

-- 5. ACCOUNTS PAYABLE ----------------------------------------------------------
-- native open vendor bills (invoices, invoice_kind='vendor_bill', status='approved',
-- open>0) vs the Xoro AP mirror in xoro_gl_transactions (accounting_name='Accounts
-- Payable (A/P)', keyed by ref_number = bill_number sans prefix). The GL feed is a
-- stale point-in-time snapshot with no per-bill OPEN balance (payments post under
-- separate refs), so this is a LEFT tie of native-open bills to the feed: bills
-- inside the feed range are amount-compared, bills newer than the feed are flagged
-- missing. Headline surfaces the acct-2000 AP control residual for context.
CREATE OR REPLACE FUNCTION public.cutover_recon_ap()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH nat AS (
    SELECT invoice_number AS inv, regexp_replace(invoice_number, '^[A-Z]+-', '') AS bill_no,
           (total_amount_cents - COALESCE(paid_amount_cents, 0)) AS open_cents
    FROM invoices
    WHERE invoice_kind = 'vendor_bill' AND status = 'approved'
      AND (total_amount_cents - COALESCE(paid_amount_cents, 0)) > 0
  ),
  ap AS (
    SELECT ref_number, round(sum(amount), 2) AS net
    FROM xoro_gl_transactions
    WHERE accounting_name = 'Accounts Payable (A/P)'
    GROUP BY ref_number
  ),
  j AS (
    SELECT n.inv AS k, n.bill_no, n.open_cents,
           (a.ref_number IS NOT NULL) AS mp,
           CASE WHEN a.ref_number IS NOT NULL THEN abs(a.net) * 100.0 END AS mir_cents
    FROM nat n LEFT JOIN ap a ON a.ref_number = n.bill_no
  ),
  v AS (SELECT * FROM j WHERE NOT mp OR abs(open_cents - COALESCE(mir_cents, 0)) > 100)
  SELECT jsonb_build_object(
    'headline', jsonb_build_object(
      'native_open_count', (SELECT count(*) FROM nat),
      'native_open_cents', (SELECT COALESCE(sum(open_cents), 0) FROM nat),
      'in_feed_count', (SELECT count(*) FROM j WHERE mp),
      'missing_from_feed_count', (SELECT count(*) FROM j WHERE NOT mp),
      'amount_matched_count', (SELECT count(*) FROM j WHERE mp AND abs(open_cents - COALESCE(mir_cents, 0)) <= 100),
      'amount_mismatch_count', (SELECT count(*) FROM j WHERE mp AND abs(open_cents - COALESCE(mir_cents, 0)) > 100),
      'ap_control_residual_cents', (SELECT round(sum(amount) * 100.0)::bigint FROM xoro_gl_transactions WHERE accounting_name = 'Accounts Payable (A/P)'),
      'status_break_count', (SELECT count(*) FROM v),
      'variance_count', (SELECT count(*) FROM v)
    ),
    'variances', COALESCE((SELECT jsonb_agg(x) FROM (
      SELECT jsonb_build_object(
        'key', k, 'native_present', true, 'mirror_present', mp,
        'native_value', open_cents, 'mirror_value', mir_cents,
        'native_status', 'approved',
        'mirror_status', CASE WHEN mp THEN 'in AP feed' ELSE '(newer than feed)' END) AS x
      FROM v ORDER BY open_cents DESC, k LIMIT 200) q), '[]'::jsonb),
    'variance_total', (SELECT count(*) FROM v),
    'note', 'Xoro AP mirror is the xoro_gl_transactions AP control feed (dollars) - a stale snapshot with no per-bill open balance; only bills within its range are amount-compared. AP control residual is shown for context.'
  );
$$;

-- 6. GENERAL LEDGER ------------------------------------------------------------
-- Trial balance mirror-fidelity via v_xoro_tangerine_tb_recon. Tangerine's
-- journal_entries are ~99.9% Xoro GL mirror, so a raw TB-vs-TB nets to zero;
-- the meaningful gaps are the per-account UNEXPLAINED residual (variance net of
-- intentional channel reclasses and known-unmirrored Xoro txns) = residual_core.
-- A genuine break = an account whose lifetime residual_core exceeds $1.
CREATE OR REPLACE FUNCTION public.cutover_recon_gl()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH acct AS (
    SELECT gl_code, max(gl_name) AS gl_name,
           round(sum(tang_net_debit), 2) AS tang,
           round(sum(xoro_net_debit), 2) AS xoro,
           round(sum(reclass_net_debit), 2) AS reclass,
           round(sum(xoro_unmirrored_debit), 2) AS unmirrored,
           round(sum(residual_core), 2) AS residual_core
    FROM v_xoro_tangerine_tb_recon
    GROUP BY gl_code
  ),
  v AS (SELECT * FROM acct WHERE abs(residual_core) > 1)
  SELECT jsonb_build_object(
    'headline', jsonb_build_object(
      'accounts_total', (SELECT count(*) FROM acct),
      'accounts_tied', (SELECT count(*) FROM acct WHERE abs(residual_core) <= 1),
      'accounts_broken', (SELECT count(*) FROM v),
      'abs_residual_cents', (SELECT round(COALESCE(sum(abs(residual_core)), 0) * 100.0)::bigint FROM v),
      'net_residual_cents', (SELECT round(COALESCE(sum(residual_core), 0) * 100.0)::bigint FROM acct),
      'status_break_count', (SELECT count(*) FROM v),
      'variance_count', (SELECT count(*) FROM v)
    ),
    'variances', COALESCE((SELECT jsonb_agg(x) FROM (
      SELECT jsonb_build_object(
        'key', gl_code, 'gl_name', gl_name,
        'native_present', true, 'mirror_present', true,
        'native_value', tang, 'mirror_value', xoro,
        'native_status', 'posted', 'mirror_status', 'xoro',
        'reclass', reclass, 'unmirrored', unmirrored, 'residual_core', residual_core) AS x
      FROM v ORDER BY abs(residual_core) DESC LIMIT 200) q), '[]'::jsonb),
    'variance_total', (SELECT count(*) FROM v),
    'note', 'Tangerine GL is ~99.9% Xoro-mirrored, so a raw trial-balance tie nets to zero; the burn-down target is the per-account UNEXPLAINED residual (net of intentional channel reclasses and known-unmirrored Xoro txns).'
  );
$$;

GRANT EXECUTE ON FUNCTION public.cutover_recon_inventory()      TO service_role;
GRANT EXECUTE ON FUNCTION public.cutover_recon_sales_orders()   TO service_role;
GRANT EXECUTE ON FUNCTION public.cutover_recon_purchase_orders() TO service_role;
GRANT EXECUTE ON FUNCTION public.cutover_recon_ar()             TO service_role;
GRANT EXECUTE ON FUNCTION public.cutover_recon_ap()             TO service_role;
GRANT EXECUTE ON FUNCTION public.cutover_recon_gl()             TO service_role;
