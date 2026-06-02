-- P16 (batch 3) — reference masters + customer factoring + brand-on-style.
--
--   country_master         — ISO alpha-2 countries (drives fabric COO + addresses).
--   gender_master          — Men's/Boys/Child/Toddler/Girls/Women's (+Unisex legacy).
--   style_classifications   — group / category / sub_category values (one table, kind-tagged).
--   factor_master           — factoring / credit-insurance company + contact info.
--   customers.is_factored / factor_id — per-customer factoring.
--   style_master.brand_id   — brand on the style/catalog (+ ATS brand backfill target).
--   style_master gender CHECK — add 'T' (Toddler).
--
-- Additive + idempotent. Reference masters get anon-read RLS (writes via service role).

-- ─── 1. country_master ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS country_master (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  iso2        char(2) NOT NULL UNIQUE,
  name        text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE country_master IS 'P16 — ISO 3166-1 alpha-2 country list for COO + address dropdowns. Global (entity-agnostic).';

-- Seed common apparel-sourcing + major-market countries. Operators add more via the master UI.
INSERT INTO country_master (iso2, name, sort_order) VALUES
  ('US','United States',0),('CN','China',1),('VN','Vietnam',2),('IN','India',3),
  ('BD','Bangladesh',4),('PK','Pakistan',5),('ID','Indonesia',6),('KH','Cambodia',7),
  ('LK','Sri Lanka',8),('TR','Turkey',9),('MX','Mexico',10),('IT','Italy',11),
  ('PT','Portugal',12),('GT','Guatemala',13),('HN','Honduras',14),('MM','Myanmar',15),
  ('TH','Thailand',16),('KR','South Korea',17),('TW','Taiwan',18),('JP','Japan',19),
  ('CA','Canada',20),('GB','United Kingdom',21),('FR','France',22),('DE','Germany',23),
  ('ES','Spain',24),('PE','Peru',25),('CO','Colombia',26),('EG','Egypt',27),
  ('MA','Morocco',28),('ET','Ethiopia',29),('KE','Kenya',30),('PH','Philippines',31),
  ('MY','Malaysia',32),('NP','Nepal',33),('JO','Jordan',34),('SV','El Salvador',35),
  ('DO','Dominican Republic',36),('NI','Nicaragua',37),('BR','Brazil',38),('AU','Australia',39)
ON CONFLICT (iso2) DO NOTHING;

ALTER TABLE country_master ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_country_master" ON country_master;
CREATE POLICY "anon_read_country_master" ON country_master FOR SELECT TO anon USING (true);

-- ─── 2. gender_master ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gender_master (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  label       text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE gender_master IS 'P16 — gender profile for styles. Codes align with style_master.gender_code.';
INSERT INTO gender_master (code, label, sort_order) VALUES
  ('M','Men''s',0),('W','Women''s',1),('B','Boys',2),('G','Girls',3),
  ('C','Child',4),('T','Toddler',5),('U','Unisex',6)
ON CONFLICT (code) DO NOTHING;
ALTER TABLE gender_master ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_gender_master" ON gender_master;
CREATE POLICY "anon_read_gender_master" ON gender_master FOR SELECT TO anon USING (true);

-- style_master.gender_code — widen CHECK to include 'T' (Toddler).
ALTER TABLE style_master DROP CONSTRAINT IF EXISTS style_master_gender_check;
ALTER TABLE style_master ADD CONSTRAINT style_master_gender_check
  CHECK (gender_code IS NULL OR gender_code IN ('M','B','C','G','W','U','T'));

-- ─── 3. style_classifications (group / category / sub_category) ───────────────
CREATE TABLE IF NOT EXISTS style_classifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('group','category','sub_category')),
  name        text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, kind, name)
);
COMMENT ON TABLE style_classifications IS 'P16 — group/category/sub_category master values (one table, kind-tagged). style_master stores the chosen name.';
CREATE INDEX IF NOT EXISTS idx_style_classifications_kind ON style_classifications (entity_id, kind);

-- Seed from the distinct values already on style_master (these came from the
-- 2026-05-30 ATS sweep), so the masters start populated.
INSERT INTO style_classifications (entity_id, kind, name)
SELECT DISTINCT entity_id, 'group', group_name FROM style_master
  WHERE group_name IS NOT NULL AND btrim(group_name) <> ''
ON CONFLICT (entity_id, kind, name) DO NOTHING;
INSERT INTO style_classifications (entity_id, kind, name)
SELECT DISTINCT entity_id, 'category', category_name FROM style_master
  WHERE category_name IS NOT NULL AND btrim(category_name) <> ''
ON CONFLICT (entity_id, kind, name) DO NOTHING;
INSERT INTO style_classifications (entity_id, kind, name)
SELECT DISTINCT entity_id, 'sub_category', sub_category_name FROM style_master
  WHERE sub_category_name IS NOT NULL AND btrim(sub_category_name) <> ''
ON CONFLICT (entity_id, kind, name) DO NOTHING;

ALTER TABLE style_classifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_style_classifications" ON style_classifications;
CREATE POLICY "anon_read_style_classifications" ON style_classifications FOR SELECT TO anon USING (true);

-- ─── 4. factor_master ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS factor_master (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  code          text NOT NULL,
  name          text NOT NULL,
  contact_name  text,
  phone         text,
  email         text,
  website       text,
  address       jsonb NOT NULL DEFAULT '{}'::jsonb,
  api_enabled   boolean NOT NULL DEFAULT false,
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, code)
);
COMMENT ON TABLE factor_master IS 'P16 — factoring / credit-insurance companies (e.g. Rosenthal & Rosenthal) + full contact info. api_enabled flags future API auto-fill.';
ALTER TABLE factor_master ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_factor_master" ON factor_master;
CREATE POLICY "anon_read_factor_master" ON factor_master FOR SELECT TO anon USING (true);

-- ─── 5. customers — factoring ─────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_factored boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS factor_id   uuid REFERENCES factor_master(id) ON DELETE SET NULL;
COMMENT ON COLUMN customers.is_factored IS 'P16 — when true, this customer''s receivables are factored; SOs require factor approval before shipping.';

-- ─── 6. style_master — brand on the style / catalog ───────────────────────────
ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brand_master(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_style_master_brand ON style_master (brand_id) WHERE brand_id IS NOT NULL;
COMMENT ON COLUMN style_master.brand_id IS 'P16 — brand for the style (catalog). Backfilled from the ATS app brand→style mapping.';

NOTIFY pgrst, 'reload schema';
