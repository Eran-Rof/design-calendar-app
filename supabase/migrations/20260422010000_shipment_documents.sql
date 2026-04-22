-- 20260422010000_shipment_documents.sql
--
-- Vendors can now attach a packing list and a Bill of Lading document
-- when submitting a shipment/ASN. Storage paths live on the shipments
-- row; the files themselves are in the vendor-docs bucket under
-- <vendor_id>/shipments/<shipment_id>/…

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS packing_list_url text,
  ADD COLUMN IF NOT EXISTS bl_document_url  text;
