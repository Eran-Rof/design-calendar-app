-- Add 'xoro_ap' to invoices.source — the authoritative real-vendor-bill
-- feed from Xoro's bill/getbill (ingested via POST /api/ap/sync-bills).
--
-- Distinct from 'xoro_mirror', which is the T10 shadow-mirror's PO-DERIVED
-- synthetic AP bill. While Xoro is the system of record, real bills
-- (source='xoro_ap') SUPERSEDE the mirror-derived ones on a
-- (vendor_id, invoice_number) collision; manual bills are never touched.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_source_check
  CHECK (source = ANY (ARRAY[
    'manual', 'xoro_mirror', 'xoro_ap', 'shopify', 'fba', 'walmart',
    'faire', 'edi_3pl', 'plaid_sync', 'api', 'system'
  ]));
