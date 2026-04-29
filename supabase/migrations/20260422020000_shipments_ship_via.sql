-- 20260422020000_shipments_ship_via.sql
--
-- Vendors now pick a transport mode (Ship via) separate from the
-- carrier — e.g. Maersk Ocean vs Maersk Ocean/Rail intermodal.

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS ship_via text;
