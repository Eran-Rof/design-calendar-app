-- HTS is style-specific (style_master.hts_code, migration 20260835000000), not
-- fabric-specific: the same fabric in a pant vs a jacket classifies differently.
-- The fabric-codes UI + API stopped exposing hts_code (#1077). Drop the now-dead
-- column (it carried 0 rows of data). Safe to apply ONLY after the #1077 fabric
-- handler is deployed (it no longer SELECTs hts_code).

ALTER TABLE fabric_codes DROP COLUMN IF EXISTS hts_code;
