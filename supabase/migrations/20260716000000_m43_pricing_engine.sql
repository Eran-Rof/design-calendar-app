-- M43 — Pricing Engine.
--
-- Generalizes the interim style-level b2b_price_list (#719) into a real engine:
-- named price lists (default / per-tier / per-customer scope), quantity price
-- breaks, and promotions. Resolution precedence (engine in api/_lib/pricing/
-- engine.js) for (customer, style, qty, date):
--   1. customer's OWN list   (price_lists.customer_id = customer)
--   2. customer's ASSIGNED list (customers.price_list_id)
--   3. TIER list             (price_lists.customer_tier = customers.customer_tier)
--   4. DEFAULT list          (price_lists.is_default)
-- within a list: highest min_qty <= qty (qty break); then best active promotion.
--
-- Grain = style-level (style_master.id), single currency (USD). The B2B portal is
-- repointed to this engine; b2b_price_list is retained one release (deprecated).
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT throughout.

-- ─── 1. price_lists ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_lists (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  code               text NOT NULL,
  name               text NOT NULL,
  currency           char(3) NOT NULL DEFAULT 'USD',
  -- Scope: at most ONE of (customer_id, customer_tier) set; is_default = global fallback.
  customer_id        uuid REFERENCES customers(id) ON DELETE CASCADE,
  customer_tier      text,
  is_default         boolean NOT NULL DEFAULT false,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT price_lists_entity_code_unique UNIQUE (entity_id, code),
  CONSTRAINT price_lists_one_scope_check
    CHECK ( (customer_id IS NOT NULL)::int + (customer_tier IS NOT NULL)::int <= 1 )
);
CREATE INDEX IF NOT EXISTS idx_price_lists_customer ON price_lists (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_price_lists_tier     ON price_lists (entity_id, customer_tier) WHERE customer_tier IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_price_lists_default  ON price_lists (entity_id) WHERE is_default;

COMMENT ON TABLE price_lists IS 'M43 — named price lists. Scope: customer_id (per-customer), customer_tier (per-tier), or is_default (global fallback). Resolution precedence: customer own list → customer assigned list (customers.price_list_id) → tier list → default list.';

-- ─── 2. price_list_items ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_list_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id   uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  style_id        uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  price_cents     bigint NOT NULL CHECK (price_cents >= 0),
  min_qty         numeric(18,4) NOT NULL DEFAULT 0,   -- quantity break: applies when ordered qty >= min_qty
  effective_from  date,
  effective_to    date,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_list_items_break_unique UNIQUE (price_list_id, style_id, min_qty)
);
CREATE INDEX IF NOT EXISTS idx_price_list_items_lookup ON price_list_items (price_list_id, style_id, min_qty);
CREATE INDEX IF NOT EXISTS idx_price_list_items_style  ON price_list_items (style_id);

COMMENT ON TABLE price_list_items IS 'M43 — per-style prices within a list. Multiple rows per (list, style) with ascending min_qty give quantity price breaks; the engine picks the highest min_qty <= ordered qty among active, in-effect rows.';

-- ─── 3. price_promotions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  code            text,                       -- NULL = automatic (no code needed)
  name            text NOT NULL,
  discount_type   text NOT NULL CHECK (discount_type IN ('percent','amount')),
  discount_value  numeric(18,4) NOT NULL CHECK (discount_value >= 0),  -- percent 0..100, or cents off
  -- Optional match filters (NULL = matches anything on that dimension).
  style_id        uuid REFERENCES style_master(id) ON DELETE CASCADE,
  brand_id        uuid,
  customer_id     uuid REFERENCES customers(id) ON DELETE CASCADE,
  customer_tier   text,
  min_qty         numeric(18,4) NOT NULL DEFAULT 0,
  effective_from  date,
  effective_to    date,
  priority        int NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT price_promotions_pct_range CHECK (discount_type <> 'percent' OR discount_value <= 100)
);
CREATE INDEX IF NOT EXISTS idx_price_promotions_active ON price_promotions (entity_id, is_active);

COMMENT ON TABLE price_promotions IS 'M43 — discounts layered on top of the resolved list price. Match filters (style/brand/customer/tier) NULL = any. Engine applies the single best (largest-discount) active, in-effect, matching promo (no stacking in v1). code NULL = automatic.';

-- ─── 4. customers.price_list_id (assigned shared list) ────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS price_list_id uuid REFERENCES price_lists(id) ON DELETE SET NULL;
COMMENT ON COLUMN customers.price_list_id IS 'M43 — the shared price list assigned to this customer (e.g. "Distributor"). Resolution falls through to this when the customer has no own list pricing the style.';
CREATE INDEX IF NOT EXISTS idx_customers_price_list ON customers (price_list_id) WHERE price_list_id IS NOT NULL;

-- ─── Touch triggers ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pricing_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_lists','price_list_items','price_promotions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch_trg ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_touch_trg BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pricing_touch()', t, t);
  END LOOP;
END $$;

-- ─── RLS (P1 standard: anon_all + auth_internal entity-scoped) ────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_lists','price_list_items','price_promotions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "anon_all_%s" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END $$;
-- price_list_items has no entity_id; scope via parent list for authenticated.
DROP POLICY IF EXISTS "auth_internal_price_lists" ON price_lists;
CREATE POLICY "auth_internal_price_lists" ON price_lists FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "auth_internal_price_promotions" ON price_promotions;
CREATE POLICY "auth_internal_price_promotions" ON price_promotions FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "auth_internal_price_list_items" ON price_list_items;
CREATE POLICY "auth_internal_price_list_items" ON price_list_items FOR ALL TO authenticated
  USING      (price_list_id IN (SELECT pl.id FROM price_lists pl JOIN entity_users eu ON eu.entity_id = pl.entity_id WHERE eu.auth_id = auth.uid()))
  WITH CHECK (price_list_id IN (SELECT pl.id FROM price_lists pl JOIN entity_users eu ON eu.entity_id = pl.entity_id WHERE eu.auth_id = auth.uid()));

-- ─── Seed a Default price list for ROF (idempotent) ───────────────────────────
DO $$
DECLARE v_entity uuid;
BEGIN
  SELECT id INTO v_entity FROM entities WHERE code = 'ROF' LIMIT 1;
  IF v_entity IS NULL THEN RAISE NOTICE 'M43 seed: ROF entity not found; skipping.'; RETURN; END IF;
  INSERT INTO price_lists (entity_id, code, name, is_default)
  SELECT v_entity, 'DEFAULT', 'Default Wholesale', true
  WHERE NOT EXISTS (SELECT 1 FROM price_lists WHERE entity_id = v_entity AND is_default);
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Migrate existing b2b_price_list rows into the new model (idempotent; a no-op
-- when b2b_price_list is empty). customer rows → that customer's own list;
-- tier rows → a per-tier list; default rows → the DEFAULT list.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_entity   uuid;
  v_default  uuid;
  r          record;
  v_list     uuid;
BEGIN
  SELECT id INTO v_entity FROM entities WHERE code = 'ROF' LIMIT 1;
  IF v_entity IS NULL THEN RETURN; END IF;
  IF to_regclass('public.b2b_price_list') IS NULL THEN RETURN; END IF;
  SELECT id INTO v_default FROM price_lists WHERE entity_id = v_entity AND is_default LIMIT 1;

  FOR r IN SELECT * FROM b2b_price_list LOOP
    IF r.customer_id IS NOT NULL THEN
      SELECT id INTO v_list FROM price_lists WHERE entity_id = v_entity AND customer_id = r.customer_id LIMIT 1;
      IF v_list IS NULL THEN
        INSERT INTO price_lists (entity_id, code, name, currency, customer_id)
        VALUES (v_entity, 'CUST-' || left(r.customer_id::text, 8), 'Customer ' || left(r.customer_id::text, 8), r.currency, r.customer_id)
        RETURNING id INTO v_list;
      END IF;
    ELSIF r.customer_tier IS NOT NULL THEN
      SELECT id INTO v_list FROM price_lists WHERE entity_id = v_entity AND customer_tier = r.customer_tier LIMIT 1;
      IF v_list IS NULL THEN
        INSERT INTO price_lists (entity_id, code, name, currency, customer_tier)
        VALUES (v_entity, 'TIER-' || upper(r.customer_tier), 'Tier ' || r.customer_tier, r.currency, r.customer_tier)
        RETURNING id INTO v_list;
      END IF;
    ELSE
      v_list := v_default;
    END IF;

    IF v_list IS NOT NULL THEN
      INSERT INTO price_list_items (price_list_id, style_id, price_cents, min_qty, effective_from, effective_to, is_active)
      VALUES (v_list, r.style_id, r.price_cents, COALESCE(r.min_qty, 0), r.effective_from, r.effective_to, r.is_active)
      ON CONFLICT (price_list_id, style_id, min_qty) DO NOTHING;
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
