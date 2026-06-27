-- Backfill vendors.payment_terms_id from AP invoice history (operator: Vendor #4).
--
-- For each vendor that still lacks a structured payment term, take the MOST
-- COMMON (due_date - invoice_date) day-delta across their AP invoices and map it
-- to the nearest active payment_terms.due_days. Ties broken by the most recent
-- invoice. Only fills NULLs — never overwrites an operator-set term.
--
-- Preview first (no writes):
--   SELECT v.name, modal.dd, pt.code
--   FROM ... (see the SELECT mirror in the runner) ...
--
-- Source: invoices (AP bills carry vendor_id, invoice_date, due_date).

WITH deltas AS (
  SELECT i.vendor_id,
         GREATEST(0, (i.due_date - i.invoice_date)) AS dd,
         count(*)            AS n,
         max(i.invoice_date) AS last_inv
  FROM invoices i
  WHERE i.vendor_id   IS NOT NULL
    AND i.due_date    IS NOT NULL
    AND i.invoice_date IS NOT NULL
  GROUP BY i.vendor_id, GREATEST(0, (i.due_date - i.invoice_date))
),
ranked AS (
  SELECT vendor_id, dd,
         row_number() OVER (PARTITION BY vendor_id ORDER BY n DESC, last_inv DESC) AS rnk
  FROM deltas
),
modal AS (
  SELECT vendor_id, dd FROM ranked WHERE rnk = 1
),
mapped AS (
  SELECT m.vendor_id,
         (SELECT pt.id FROM payment_terms pt
           WHERE pt.is_active
           ORDER BY abs(pt.due_days - m.dd) ASC, pt.due_days ASC
           LIMIT 1) AS term_id
  FROM modal m
)
UPDATE vendors v
SET payment_terms_id = mapped.term_id,
    updated_at = now()
FROM mapped
WHERE v.id = mapped.vendor_id
  AND v.payment_terms_id IS NULL
  AND mapped.term_id IS NOT NULL;
