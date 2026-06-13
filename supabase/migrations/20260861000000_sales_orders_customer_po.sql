-- Sales Orders — capture the CUSTOMER's purchase-order number.
--
-- The customer's PO number is the reference the buyer uses to identify the
-- order on their side; it's required (UI-enforced) before styles can be added,
-- and it's what the AI "customer PO upload" feature fills in. Free text — POs
-- carry arbitrary formats (alphanumeric, dashes, slashes). Nullable so legacy
-- rows and in-progress drafts are unaffected.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS customer_po text;

COMMENT ON COLUMN sales_orders.customer_po IS 'Customer purchase-order number (their reference). UI requires it before adding styles.';
