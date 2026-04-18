-- 20260418150000_shipments_asn.sql
--
-- Phase 2.4 — enable vendor ASN submission without a tracking number.
--
-- Flow: vendor submits ASN with ship date + carrier + lines before the
-- booking/BL/container number is known. Later they (or Searates) attach
-- a tracking reference and live tracking kicks in.
--
-- Changes:
--   • shipments.number / number_type: now nullable (vendor may submit
--     before they have a tracking ref)
--   • shipments.asn_number: vendor's internal shipment reference
--   • Replace old unique index (vendor_id, number, number_type) with two
--     partial indexes — one for tracking rows, one for ASN rows — so both
--     coexist and are unique within their own domain.

ALTER TABLE shipments ALTER COLUMN number      DROP NOT NULL;
ALTER TABLE shipments ALTER COLUMN number_type DROP NOT NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS asn_number text;

DROP INDEX IF EXISTS uq_shipments_vendor_number_type;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_vendor_number_type
  ON shipments (vendor_id, number, number_type)
  WHERE number IS NOT NULL AND number_type IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_vendor_asn_number
  ON shipments (vendor_id, asn_number)
  WHERE asn_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipments_asn_number
  ON shipments (asn_number) WHERE asn_number IS NOT NULL;
