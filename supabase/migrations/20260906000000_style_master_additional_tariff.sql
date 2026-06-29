-- style_master: additional tariff % shown next to the duty rate (operator #4).
--
-- The Trump-administration additional tariff is a flat +10% applied on top of
-- the HTS duty rate for ALL countries / categories. We surface it as a SEPARATE
-- field next to the duty rate (per COO row in attributes.coo_hts, with the
-- primary row mirrored onto this column the same way hts_code / duty_rate_pct
-- are). Default 10 so it is auto-applied; nullable so it can be cleared/overridden.

ALTER TABLE style_master ADD COLUMN IF NOT EXISTS additional_tariff_pct numeric;

COMMENT ON COLUMN style_master.additional_tariff_pct IS
  'Additional tariff % (Trump-administration flat +10%, all countries) on top of duty_rate_pct. Mirrors attributes.coo_hts[0].additional_tariff_pct.';
