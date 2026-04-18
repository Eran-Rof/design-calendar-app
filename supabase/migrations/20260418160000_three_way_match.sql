-- 20260418160000_three_way_match.sql
--
-- Phase 2.5 — 3-way match engine as a SQL view.
--
-- Joins po_line_items (ordered) + shipment_lines (shipped per ASN) +
-- receipt_line_items (received per 3PL/EDI) + invoice_line_items
-- (vendor billed). One row per PO line with summed quantities and
-- boolean discrepancy flags.
--
-- Discrepancy definitions:
--   • under_received:            qty_received < qty_ordered
--   • over_received:             qty_received > qty_ordered
--   • shipped_not_received:      qty_shipped > qty_received (in transit or lost)
--   • invoiced_more_than_received: qty_invoiced > qty_received (bill ahead)
--   • price_variance:            invoiced unit price differs from PO unit price
--     by more than a penny
--
-- Views are SECURITY INVOKER so RLS on the base tables applies — a
-- vendor who queries three_way_match_view sees only their own rows.

DROP VIEW IF EXISTS three_way_match_summary CASCADE;
DROP VIEW IF EXISTS three_way_match_view CASCADE;

CREATE VIEW three_way_match_view
WITH (security_invoker = on) AS
SELECT
  pli.id                                         AS po_line_item_id,
  pli.po_id,
  tp.po_number,
  tp.vendor_id,
  pli.line_index,
  pli.item_number,
  pli.description,
  COALESCE(pli.qty_ordered, 0)                   AS qty_ordered,
  pli.unit_price                                  AS po_unit_price,
  COALESCE(ship_sum.qty_shipped, 0)               AS qty_shipped,
  COALESCE(rcv_sum.qty_received, 0)               AS qty_received,
  COALESCE(inv_sum.qty_invoiced, 0)               AS qty_invoiced,
  inv_sum.avg_invoiced_price                       AS invoiced_unit_price,

  -- discrepancy flags
  (COALESCE(rcv_sum.qty_received, 0) < COALESCE(pli.qty_ordered, 0))            AS under_received,
  (COALESCE(rcv_sum.qty_received, 0) > COALESCE(pli.qty_ordered, 0))            AS over_received,
  (COALESCE(ship_sum.qty_shipped, 0) > COALESCE(rcv_sum.qty_received, 0))       AS shipped_not_received,
  (COALESCE(inv_sum.qty_invoiced, 0) > COALESCE(rcv_sum.qty_received, 0))       AS invoiced_more_than_received,
  (inv_sum.avg_invoiced_price IS NOT NULL
   AND pli.unit_price IS NOT NULL
   AND ABS(COALESCE(inv_sum.avg_invoiced_price, 0) - COALESCE(pli.unit_price, 0)) > 0.01)
                                                                                 AS price_variance,

  -- line status roll-up (used by the UI for badges)
  CASE
    WHEN COALESCE(pli.qty_ordered, 0) = 0                                       THEN 'no_data'
    WHEN COALESCE(rcv_sum.qty_received, 0) >= COALESCE(pli.qty_ordered, 0)
         AND COALESCE(inv_sum.qty_invoiced, 0) >= COALESCE(pli.qty_ordered, 0)
         AND NOT (inv_sum.avg_invoiced_price IS NOT NULL
                  AND pli.unit_price IS NOT NULL
                  AND ABS(COALESCE(inv_sum.avg_invoiced_price, 0) - COALESCE(pli.unit_price, 0)) > 0.01)
                                                                                 THEN 'matched'
    WHEN COALESCE(rcv_sum.qty_received, 0) > 0 AND COALESCE(inv_sum.qty_invoiced, 0) = 0
                                                                                 THEN 'awaiting_invoice'
    WHEN COALESCE(inv_sum.qty_invoiced, 0) > 0 AND COALESCE(rcv_sum.qty_received, 0) = 0
                                                                                 THEN 'invoiced_before_receipt'
    WHEN COALESCE(inv_sum.qty_invoiced, 0) > COALESCE(rcv_sum.qty_received, 0)
         OR (inv_sum.avg_invoiced_price IS NOT NULL
             AND pli.unit_price IS NOT NULL
             AND ABS(COALESCE(inv_sum.avg_invoiced_price, 0) - COALESCE(pli.unit_price, 0)) > 0.01)
                                                                                 THEN 'discrepancy'
    WHEN COALESCE(ship_sum.qty_shipped, 0) > 0 AND COALESCE(rcv_sum.qty_received, 0) = 0
                                                                                 THEN 'in_transit'
    ELSE                                                                              'pending'
  END                                              AS line_status

FROM po_line_items pli
JOIN tanda_pos tp ON tp.uuid_id = pli.po_id

LEFT JOIN (
  SELECT po_line_item_id, SUM(quantity_shipped) AS qty_shipped
  FROM shipment_lines
  WHERE po_line_item_id IS NOT NULL
  GROUP BY po_line_item_id
) ship_sum ON ship_sum.po_line_item_id = pli.id

LEFT JOIN (
  SELECT po_line_item_id, SUM(quantity_received) AS qty_received
  FROM receipt_line_items
  WHERE po_line_item_id IS NOT NULL
  GROUP BY po_line_item_id
) rcv_sum ON rcv_sum.po_line_item_id = pli.id

LEFT JOIN (
  SELECT
    ili.po_line_item_id,
    SUM(ili.quantity_invoiced) AS qty_invoiced,
    AVG(ili.unit_price)         AS avg_invoiced_price
  FROM invoice_line_items ili
  JOIN invoices i ON i.id = ili.invoice_id
  WHERE ili.po_line_item_id IS NOT NULL
    AND i.status <> 'rejected'
  GROUP BY ili.po_line_item_id
) inv_sum ON inv_sum.po_line_item_id = pli.id;

-- PO-level roll-up for the dashboard card / TandA list.
CREATE VIEW three_way_match_summary
WITH (security_invoker = on) AS
SELECT
  v.po_id,
  v.po_number,
  v.vendor_id,
  COUNT(*)::int                                                 AS line_count,
  SUM(CASE WHEN v.line_status = 'matched'     THEN 1 ELSE 0 END)::int  AS matched_lines,
  SUM(CASE WHEN v.line_status = 'discrepancy' THEN 1 ELSE 0 END)::int  AS discrepancy_lines,
  SUM(CASE WHEN v.line_status IN ('pending', 'in_transit', 'awaiting_invoice', 'invoiced_before_receipt')
          THEN 1 ELSE 0 END)::int                               AS pending_lines,
  SUM(v.qty_ordered)                                             AS total_ordered,
  SUM(v.qty_shipped)                                             AS total_shipped,
  SUM(v.qty_received)                                            AS total_received,
  SUM(v.qty_invoiced)                                            AS total_invoiced,
  CASE
    WHEN COUNT(*) = 0                                          THEN 'no_data'
    WHEN SUM(CASE WHEN v.line_status = 'discrepancy' THEN 1 ELSE 0 END) > 0
                                                                 THEN 'discrepancy'
    WHEN SUM(CASE WHEN v.line_status = 'matched' THEN 1 ELSE 0 END) = COUNT(*)
                                                                 THEN 'matched'
    ELSE                                                             'pending'
  END                                                            AS po_status
FROM three_way_match_view v
GROUP BY v.po_id, v.po_number, v.vendor_id;
