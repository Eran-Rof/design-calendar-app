-- P16 foundation — customer / sales-order field additions for the sales batch.
--
-- Backs the Customer Master + Sales Order UI work:
--   • customers   — two commissioned sales reps, default brand / channel, and
--                   returns + COGS GL routing (revenue + AR + terms already exist
--                   as default_revenue_account_id / default_ar_account_id /
--                   payment_terms_id).
--   • sales_orders — factor / credit-insurance approval (Rosenthal & Rosenthal).
--                    Manual-entry now; an api source value is reserved for the
--                    future Factor API auto-fill.
--   • customer_locations — store vs distribution-center classification.
--
-- All additive + idempotent (ADD COLUMN IF NOT EXISTS). Inert until the UI ships.

-- ─── 1. customers — sales reps + default brand/channel + returns/COGS GL ──────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS sales_rep_1_id             uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sales_rep_1_commission_pct numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sales_rep_2_id             uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sales_rep_2_commission_pct numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS default_brand_id           uuid REFERENCES brand_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_channel_id         uuid REFERENCES channel_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_returns_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_cogs_account_id    uuid REFERENCES gl_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_sales_rep_1 ON customers (sales_rep_1_id) WHERE sales_rep_1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_sales_rep_2 ON customers (sales_rep_2_id) WHERE sales_rep_2_id IS NOT NULL;

COMMENT ON COLUMN customers.sales_rep_1_id             IS 'P16 — primary sales rep (employees.id). Commission % in sales_rep_1_commission_pct.';
COMMENT ON COLUMN customers.sales_rep_2_id             IS 'P16 — secondary sales rep. Commission % in sales_rep_2_commission_pct.';
COMMENT ON COLUMN customers.default_brand_id           IS 'P16 — default brand for new sales orders from this customer (brand_master).';
COMMENT ON COLUMN customers.default_channel_id         IS 'P16 — default channel for new sales orders from this customer (channel_master).';
COMMENT ON COLUMN customers.default_returns_account_id IS 'P16 — returns/contra-revenue GL account for this customer''s SO + invoice flows.';
COMMENT ON COLUMN customers.default_cogs_account_id    IS 'P16 — COGS GL account for this customer''s SO + invoice flows.';

-- ─── 2. sales_orders — factor / credit-insurance approval ─────────────────────
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS factor_approval_status   text NOT NULL DEFAULT 'not_submitted'
                             CHECK (factor_approval_status IN ('not_submitted','pending','approved','partial','declined','not_required')),
  ADD COLUMN IF NOT EXISTS factor_approved_cents    bigint,
  ADD COLUMN IF NOT EXISTS factor_reference         text,
  ADD COLUMN IF NOT EXISTS factor_checked_at        timestamptz,
  ADD COLUMN IF NOT EXISTS factor_source            text NOT NULL DEFAULT 'manual'
                             CHECK (factor_source IN ('manual','rosenthal_api'));

COMMENT ON COLUMN sales_orders.factor_approval_status IS 'P16 — Factor/Ins (Rosenthal & Rosenthal) credit-approval state. Manual now; rosenthal_api auto-fill reserved.';
COMMENT ON COLUMN sales_orders.factor_approved_cents  IS 'P16 — credit amount approved by the factor, in cents.';
COMMENT ON COLUMN sales_orders.factor_reference       IS 'P16 — factor approval / reference number.';

-- ─── 3. customer_locations — store vs distribution-center type ────────────────
ALTER TABLE customer_locations
  ADD COLUMN IF NOT EXISTS location_type text NOT NULL DEFAULT 'store'
                             CHECK (location_type IN ('dc','store','other'));

COMMENT ON COLUMN customer_locations.location_type IS 'P16 — dc (distribution center) | store | other. Drives the SO multi-store ship-to picker.';

NOTIFY pgrst, 'reload schema';
