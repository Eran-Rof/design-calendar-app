-- Costing Module — add Payment Terms to the RFQ header.
--
-- Operator ask: the RFQ (request-for-quote) should carry a Payment Terms
-- selection, sourced from the Tangerine Payment Terms master (payment_terms,
-- P3 Chunk 9). The costing RFQ edit view surfaces it as a SearchableSelect
-- populated from /api/internal/payment-terms, mirroring the Sales Order
-- payment-terms picker.
--
-- Nullable FK to payment_terms(id) (uuid). Idempotent. No DROP of existing
-- columns. Existing RFQs keep payment_terms_id NULL until set.

ALTER TABLE rfqs
  ADD COLUMN IF NOT EXISTS payment_terms_id uuid REFERENCES payment_terms(id);

COMMENT ON COLUMN rfqs.payment_terms_id IS 'FK to payment_terms(id) — Tangerine Payment Terms master. Selected on the costing RFQ edit view. NULL on legacy rows.';

NOTIFY pgrst, 'reload schema';
