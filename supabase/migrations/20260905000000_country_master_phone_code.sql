-- country_master: add E.164 calling code (phone_code) + backfill (operator: Vendor #3).
--
-- The Vendor (and Fabric Mill) phone fields gain a country-code dropdown
-- prepopulated from this master. phone_code is the numeric E.164 country
-- calling code (US/Canada = 1, China = 86, Bangladesh = 880, …). We seed the
-- canonical ISO dial-code table directly — these are fixed facts, so a
-- deterministic backfill is more reliable than an AI guess and leaves the
-- column identically populated. UPDATE-by-iso2 only touches rows that exist;
-- extra pairs are harmless no-ops, so the list is generous for future inserts.

ALTER TABLE country_master ADD COLUMN IF NOT EXISTS phone_code int;

COMMENT ON COLUMN country_master.phone_code IS
  'E.164 country calling code (numeric, no +). US/CA=1, CN=86, BD=880, etc. Used by Vendor/Fabric phone country-code dropdowns.';

UPDATE country_master cm SET phone_code = v.code
FROM (VALUES
  ('US',1),('CA',1),('DO',1),('PR',1),('JM',1),('BS',1),('BB',1),('TT',1),
  ('GB',44),('FR',33),('DE',49),('ES',34),('IT',39),('PT',351),('NL',31),
  ('BE',32),('CH',41),('AT',43),('SE',46),('NO',47),('DK',45),('FI',358),
  ('IE',353),('PL',48),('CZ',420),('GR',30),('RO',40),('HU',36),('RU',7),
  ('UA',380),('TR',90),('IL',972),('JO',962),('SA',966),('AE',971),('QA',974),
  ('KW',965),('BH',973),('OM',968),('LB',961),('EG',20),('MA',212),('DZ',213),
  ('TN',216),('LY',218),('ET',251),('KE',254),('TZ',255),('UG',256),('NG',234),
  ('GH',233),('ZA',27),('CN',86),('HK',852),('TW',886),('JP',81),('KR',82),
  ('IN',91),('PK',92),('BD',880),('LK',94),('NP',977),('MM',95),('TH',66),
  ('VN',84),('KH',855),('LA',856),('ID',62),('MY',60),('SG',65),('PH',63),
  ('AU',61),('NZ',64),('MX',52),('GT',502),('SV',503),('HN',504),('NI',505),
  ('CR',506),('PA',507),('CO',57),('PE',51),('EC',593),('BR',55),('AR',54),
  ('CL',56),('UY',598),('VE',58),('BO',591),('PY',595),('MG',261)
) AS v(iso2, code)
WHERE cm.iso2 = v.iso2 AND cm.phone_code IS NULL;
