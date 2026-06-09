-- Masters: geo state dropdown source + multi-contact arrays on customers/factors.
--
--   state_master            — US states (+ DC + territories) and Canadian
--                             provinces/territories. Global (entity-agnostic),
--                             mirrors country_master. Drives the State dropdown
--                             in the shared AddressFields editor.
--   customers.contacts      — jsonb array of up to 12 contacts
--                             {name,email,phone,title,department}.
--   factor_master.contacts  — jsonb array of up to 3 contacts
--                             {name,phone,email,title}.
--   customers.country       — backfill blank/NULL → 'US' (default market).
--
-- Additive + idempotent. Reference master gets anon-read RLS (writes via service role).

-- ─── 1. state_master ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS state_master (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_iso2  char(2) NOT NULL,
  code          text NOT NULL,
  name          text NOT NULL,
  sort_order    smallint NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_iso2, code)
);
COMMENT ON TABLE state_master IS 'States / provinces for address dropdowns, scoped by country_iso2 (FK-by-value to country_master.iso2). Global (entity-agnostic).';
CREATE INDEX IF NOT EXISTS idx_state_master_country ON state_master (country_iso2) WHERE is_active;

-- US states (alphabetical), then DC + the five inhabited territories.
INSERT INTO state_master (country_iso2, code, name, sort_order) VALUES
  ('US','AL','Alabama',0),('US','AK','Alaska',1),('US','AZ','Arizona',2),('US','AR','Arkansas',3),
  ('US','CA','California',4),('US','CO','Colorado',5),('US','CT','Connecticut',6),('US','DE','Delaware',7),
  ('US','FL','Florida',8),('US','GA','Georgia',9),('US','HI','Hawaii',10),('US','ID','Idaho',11),
  ('US','IL','Illinois',12),('US','IN','Indiana',13),('US','IA','Iowa',14),('US','KS','Kansas',15),
  ('US','KY','Kentucky',16),('US','LA','Louisiana',17),('US','ME','Maine',18),('US','MD','Maryland',19),
  ('US','MA','Massachusetts',20),('US','MI','Michigan',21),('US','MN','Minnesota',22),('US','MS','Mississippi',23),
  ('US','MO','Missouri',24),('US','MT','Montana',25),('US','NE','Nebraska',26),('US','NV','Nevada',27),
  ('US','NH','New Hampshire',28),('US','NJ','New Jersey',29),('US','NM','New Mexico',30),('US','NY','New York',31),
  ('US','NC','North Carolina',32),('US','ND','North Dakota',33),('US','OH','Ohio',34),('US','OK','Oklahoma',35),
  ('US','OR','Oregon',36),('US','PA','Pennsylvania',37),('US','RI','Rhode Island',38),('US','SC','South Carolina',39),
  ('US','SD','South Dakota',40),('US','TN','Tennessee',41),('US','TX','Texas',42),('US','UT','Utah',43),
  ('US','VT','Vermont',44),('US','VA','Virginia',45),('US','WA','Washington',46),('US','WV','West Virginia',47),
  ('US','WI','Wisconsin',48),('US','WY','Wyoming',49),
  ('US','DC','District of Columbia',50),
  ('US','PR','Puerto Rico',51),('US','VI','U.S. Virgin Islands',52),('US','GU','Guam',53),
  ('US','AS','American Samoa',54),('US','MP','Northern Mariana Islands',55)
ON CONFLICT (country_iso2, code) DO NOTHING;

-- Canadian provinces + territories (alphabetical).
INSERT INTO state_master (country_iso2, code, name, sort_order) VALUES
  ('CA','AB','Alberta',0),('CA','BC','British Columbia',1),('CA','MB','Manitoba',2),
  ('CA','NB','New Brunswick',3),('CA','NL','Newfoundland and Labrador',4),('CA','NS','Nova Scotia',5),
  ('CA','ON','Ontario',6),('CA','PE','Prince Edward Island',7),('CA','QC','Quebec',8),
  ('CA','SK','Saskatchewan',9),('CA','NT','Northwest Territories',10),('CA','NU','Nunavut',11),
  ('CA','YT','Yukon',12)
ON CONFLICT (country_iso2, code) DO NOTHING;

ALTER TABLE state_master ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_state_master" ON state_master;
CREATE POLICY "anon_read_state_master" ON state_master FOR SELECT TO anon USING (true);

-- ─── 2. customers.contacts — up to 12 contacts ───────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS contacts jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN customers.contacts IS 'Up to 12 contacts: [{name,email,phone,title,department}]. The legacy single contact_name/email/phone columns remain the primary contact.';

-- ─── 3. factor_master.contacts — up to 3 contacts ────────────────────────────
ALTER TABLE factor_master
  ADD COLUMN IF NOT EXISTS contacts jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN factor_master.contacts IS 'Up to 3 contacts: [{name,phone,email,title}]. The legacy single contact_name/phone/email columns remain the primary contact.';

-- ─── 4. customers.country — default blank/NULL to US ─────────────────────────
UPDATE customers SET country = 'US'
  WHERE country IS NULL OR btrim(country) = '';

-- ─── 5. customers.tax_exempt — default every existing customer to TRUE ───────
-- Operator request: all existing AND new customers default to tax-exempt = yes.
-- (New customers already default true in the create modal.)
UPDATE customers SET tax_exempt = true
  WHERE tax_exempt IS NOT TRUE;

NOTIFY pgrst, 'reload schema';
