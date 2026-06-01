-- P18 / Chunk A — B2B customer-facing portal foundation (M40 Portal · M41 Wholesale Website).
--
-- External wholesale buyers log in (magic-link via Supabase Auth) and browse the
-- catalog, see per-customer wholesale prices, place orders (→ draft sales_orders
-- routed to the internal Sales Orders queue), and view their invoices/AR.
--
--   b2b_accounts    — portal login ↔ customer mapping (admin pre-authorizes emails).
--   b2b_price_list  — (customer | tier | default) × style → wholesale price.
--   sales_orders    — origin + placed_by_b2b_account_id (portal-placed orders).
--   b2b_current_customer_id() — SECURITY DEFINER helper resolving the logged-in
--                     buyer's customer_id from auth.uid(); drives portal RLS.
--
-- Security: portal API endpoints ALWAYS derive customer_id from the verified
-- session (never from client input). RLS below is defense-in-depth.
-- Additive + idempotent.

-- ─── 1. b2b_accounts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS b2b_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email              text NOT NULL,
  auth_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  display_name       text,
  role               text NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer','approver','admin')),
  is_active          boolean NOT NULL DEFAULT true,
  can_place_orders   boolean NOT NULL DEFAULT true,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_b2b_accounts_email ON b2b_accounts (lower(email));
CREATE INDEX IF NOT EXISTS idx_b2b_accounts_customer ON b2b_accounts (customer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_accounts_auth_user ON b2b_accounts (auth_user_id) WHERE auth_user_id IS NOT NULL;
COMMENT ON TABLE b2b_accounts IS 'P18/M40 — B2B portal login mapped to a customer. Admin pre-authorizes the email; auth_user_id binds on first magic-link login.';

-- ─── 2. b2b_price_list ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS b2b_price_list (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id     uuid REFERENCES customers(id) ON DELETE CASCADE,   -- NULL = applies to all (default)
  customer_tier   text,                                              -- optional tier match (customers.customer_tier)
  style_id        uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  currency        char(3) NOT NULL DEFAULT 'USD',
  price_cents     bigint NOT NULL CHECK (price_cents >= 0),
  min_qty         numeric(18,4) NOT NULL DEFAULT 0,
  effective_from  date,
  effective_to    date,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_b2b_price_style ON b2b_price_list (style_id);
CREATE INDEX IF NOT EXISTS idx_b2b_price_customer_style ON b2b_price_list (customer_id, style_id);
COMMENT ON TABLE b2b_price_list IS 'P18 — wholesale prices for the B2B portal. Resolution most-specific first: customer_id match > customer_tier match > default (customer_id IS NULL). Placeholder until the M43 Pricing Engine ships.';

-- ─── 3. sales_orders — portal origin ──────────────────────────────────────────
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS origin                   text NOT NULL DEFAULT 'internal'
                             CHECK (origin IN ('internal','b2b_portal','edi','marketplace')),
  ADD COLUMN IF NOT EXISTS placed_by_b2b_account_id uuid REFERENCES b2b_accounts(id) ON DELETE SET NULL;
COMMENT ON COLUMN sales_orders.origin IS 'P18 — how the SO was created. b2b_portal = placed by a wholesale buyer via the portal (lands as draft for internal review).';

-- ─── 4. b2b_current_customer_id() — RLS helper ───────────────────────────────
CREATE OR REPLACE FUNCTION b2b_current_customer_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT customer_id FROM b2b_accounts
  WHERE auth_user_id = auth.uid() AND is_active
  LIMIT 1;
$$;
COMMENT ON FUNCTION b2b_current_customer_id() IS 'P18 — the logged-in B2B buyer''s customer_id (via b2b_accounts.auth_user_id = auth.uid()). NULL for staff/anon. Drives portal RLS.';

-- ─── 5. RLS (defense-in-depth; portal endpoints also enforce server-side) ─────
ALTER TABLE b2b_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "b2b_account_self_read" ON b2b_accounts;
CREATE POLICY "b2b_account_self_read" ON b2b_accounts FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

ALTER TABLE b2b_price_list ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "b2b_price_scoped_read" ON b2b_price_list;
CREATE POLICY "b2b_price_scoped_read" ON b2b_price_list FOR SELECT TO authenticated
  USING (customer_id IS NULL OR customer_id = b2b_current_customer_id());

NOTIFY pgrst, 'reload schema';
