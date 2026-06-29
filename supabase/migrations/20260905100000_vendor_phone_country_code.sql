-- vendors: persist the selected phone country (dial) code (operator: Vendor #3).
--
-- The vendor phone field gains a country-code dropdown (prepopulated from
-- country_master.phone_code). We store the chosen numeric E.164 calling code so
-- the editor can re-hydrate the dropdown and re-derive the national number on
-- edit. The `phone` text column keeps the composed value:
--   • code 1 (NANP) → national  (NNN) NNN-NNNN
--   • otherwise     → E.164      +<code><national digits>

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS phone_country_code int;

COMMENT ON COLUMN vendors.phone_country_code IS
  'E.164 dial code chosen for the vendor phone (US/CA=1, CN=86, BD=880, …). Drives phone format: 1 → (NNN) NNN-NNNN national, else E.164.';
