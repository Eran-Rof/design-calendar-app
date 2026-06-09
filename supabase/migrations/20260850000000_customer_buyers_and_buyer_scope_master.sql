-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Customer Buyers + Buyer Scope Master (#1156)
--
-- Replaces the Customer Master "Contacts" jsonb tab with first-class "Buyers":
--   • buyer_scope_master    — what a buyer buys (Men's Tops, Denim, …); editable.
--   • customer_buyers        — one row per buyer on a customer. Required at the
--                              UI/API layer: name/phone/email/title. is_manager
--                              flag + optional reports_to (manager buyers only).
--   • customer_buyer_scopes  — many-to-many buyer ↔ scope.
--   • sales_orders.buyer_id  — optional buyer that placed the order.
--
-- phone/email/title are NULLABLE in the DB so legacy customers.contacts rows
-- (which may have blanks) migrate cleanly; the API + UI enforce them as
-- required for new/edited buyers. customers.contacts is KEPT as a backup.
--
-- Additive + idempotent. Anon-read RLS (browser); writes via service role.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Buyer Scope Master ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buyer_scope_master (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  code        text,
  sort_order  smallint NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A code, when supplied, is unique. Many scopes may have no code (NULLs allowed
-- past a partial unique index), so we can seed name-only rows freely.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_scope_master_code
  ON buyer_scope_master (code) WHERE code IS NOT NULL;
-- Seed-idempotency anchor: never seed the same NAME twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_scope_master_name
  ON buyer_scope_master (name);

CREATE OR REPLACE FUNCTION buyer_scope_master_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS buyer_scope_master_touch_trg ON buyer_scope_master;
CREATE TRIGGER buyer_scope_master_touch_trg
  BEFORE UPDATE ON buyer_scope_master
  FOR EACH ROW EXECUTE FUNCTION buyer_scope_master_touch();

ALTER TABLE buyer_scope_master ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_buyer_scope_master" ON buyer_scope_master;
CREATE POLICY "anon_read_buyer_scope_master" ON buyer_scope_master
  FOR SELECT TO anon USING (true);

-- ~6 sensible apparel scope examples. code/name remain editable in the panel.
INSERT INTO buyer_scope_master (name, code, sort_order) VALUES
  ('Men''s Tops',    'MENS_TOPS',  10),
  ('Men''s Bottoms', 'MENS_BTM',   20),
  ('Women''s',       'WOMENS',     30),
  ('Denim',          'DENIM',      40),
  ('Accessories',    'ACCESS',     50),
  ('Footwear',       'FOOTWEAR',   60)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE buyer_scope_master IS 'Tangerine — what a customer buyer purchases (multi-select on a buyer). Editable code/name.';

-- ── Customer Buyers ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_buyers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid DEFAULT rof_entity_id(),
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name                text NOT NULL,
  phone               text,
  email               text,
  title               text,
  is_manager          boolean NOT NULL DEFAULT false,
  reports_to_buyer_id uuid REFERENCES customer_buyers(id) ON DELETE SET NULL,
  sort_order          smallint NOT NULL DEFAULT 0,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_buyers_no_self_report CHECK (reports_to_buyer_id IS NULL OR reports_to_buyer_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_customer_buyers_customer_id ON customer_buyers (customer_id);

CREATE OR REPLACE FUNCTION customer_buyers_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS customer_buyers_touch_trg ON customer_buyers;
CREATE TRIGGER customer_buyers_touch_trg
  BEFORE UPDATE ON customer_buyers
  FOR EACH ROW EXECUTE FUNCTION customer_buyers_touch();

ALTER TABLE customer_buyers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_customer_buyers" ON customer_buyers;
CREATE POLICY "anon_read_customer_buyers" ON customer_buyers
  FOR SELECT TO anon USING (true);

COMMENT ON TABLE customer_buyers IS 'Tangerine — buyers on a customer (replaces customers.contacts jsonb tab). phone/email/title nullable in DB but required at API/UI for new/edited buyers.';

-- ── Buyer ↔ Scope (many-to-many) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_buyer_scopes (
  buyer_id uuid NOT NULL REFERENCES customer_buyers(id) ON DELETE CASCADE,
  scope_id uuid NOT NULL REFERENCES buyer_scope_master(id) ON DELETE RESTRICT,
  PRIMARY KEY (buyer_id, scope_id)
);
ALTER TABLE customer_buyer_scopes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_customer_buyer_scopes" ON customer_buyer_scopes;
CREATE POLICY "anon_read_customer_buyer_scopes" ON customer_buyer_scopes
  FOR SELECT TO anon USING (true);

-- ── Sales order optional buyer ──────────────────────────────────────────────
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS buyer_id uuid NULL REFERENCES customer_buyers(id) ON DELETE SET NULL;

-- ── Migrate legacy customers.contacts → customer_buyers (idempotent) ────────
-- One buyer per non-empty contacts[] element, mapping name/email/phone/title
-- (the legacy `department` key is dropped). Guarded so re-running — or running
-- after a customer already has buyers — never double-inserts.
INSERT INTO customer_buyers (entity_id, customer_id, name, phone, email, title, sort_order)
SELECT
  c.entity_id,
  c.id,
  NULLIF(TRIM(elem->>'name'),  ''),
  NULLIF(TRIM(elem->>'phone'), ''),
  NULLIF(TRIM(elem->>'email'), ''),
  NULLIF(TRIM(elem->>'title'), ''),
  (ord - 1)::smallint
FROM customers c
CROSS JOIN LATERAL jsonb_array_elements(c.contacts) WITH ORDINALITY AS t(elem, ord)
WHERE jsonb_typeof(c.contacts) = 'array'
  AND jsonb_array_length(c.contacts) > 0
  AND COALESCE(NULLIF(TRIM(elem->>'name'), ''), NULLIF(TRIM(elem->>'email'), ''), NULLIF(TRIM(elem->>'phone'), '')) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM customer_buyers cb WHERE cb.customer_id = c.id);

NOTIFY pgrst, 'reload schema';
