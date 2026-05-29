-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P12c-1 — Faire wholesale marketplace foundation schema
--
-- First chunk of P12c (Faire wholesale marketplace — see
-- docs/tangerine/P12-marketplaces-architecture.md §3.6 and §5.4-5.6).
-- Operator-accepted decisions D1-D17 (PR #480).
--
-- Faire is WHOLESALE — fundamentally different shape from FBA / Walmart:
--   - Faire holds buyer payment and remits monthly (D9 — payouts daily,
--     orders 12h polling).
--   - Multi-buyer model: a Faire shop talks to many retailer/buyer accounts;
--     each buyer round-trips to a Tangerine customers row (D6 wholesale
--     buyer mapping).
--   - Commission split: 25% on the first order from each new buyer, 15% on
--     recurring orders (D6). Tracked in-row via commission_rate +
--     is_first_order_for_buyer.
--   - No facilitator tax — wholesale orders aren't taxed at retail.
--   - Operator always ships from their own warehouse (D15 — NO Faire-side
--     inventory location, NO inventory_locations seed in this migration).
--
-- This chunk = SCHEMA ONLY. Handlers (token-encryption real impl, orders
-- poller, payouts poller, AR conversion RPC) land in P12c-2..P12c-4.
--
-- Tables (all idempotent CREATE TABLE IF NOT EXISTS):
--   1. faire_shops         — per-shop config + encrypted API key (D3)
--   2. faire_buyers        — wholesale buyer ↔ customer mapping (D6)
--   3. faire_orders        — one row per Faire order
--   4. faire_order_items   — line-level
--   5. faire_payouts       — monthly remittances (D9)
--
-- Plus:
--   - DEFAULT rof_entity_id() on faire_shops / faire_buyers / faire_orders /
--     faire_payouts so handlers can INSERT without resolving entity_id
--     client-side (per the tanda_pos pattern, memory rule 2026-05-28).
--   - source='faire' CHECK on faire_orders (this table is faire-only; the
--     broader source enum on ar_invoices was set by T10-1 and re-asserted
--     by P12-0).
--   - anon_all_* + auth_internal_* RLS on all 5 tables (P1 template).
--
-- Fully idempotent: CREATE TABLE IF NOT EXISTS, ADD CONSTRAINT under
-- pg_constraint guard, INSERT…ON CONFLICT DO NOTHING, DO $$ guards on
-- RLS policies.
--
-- NO COMMENT ON ... IS 'a ' || 'b' — Postgres requires a string LITERAL
-- in COMMENT statements (P12-0 hotfix PR #485). All COMMENT bodies below
-- are single literals.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. faire_shops ────────────────────────────────────────────────────────
--
-- Per-shop config + encrypted Faire API key. Faire uses a static API key
-- in the X-FAIRE-ACCESS-TOKEN header (no OAuth — D3). UNIQUE on
-- (entity_id, faire_shop_token) so we can never accidentally configure the
-- same shop twice for the same entity.

CREATE TABLE IF NOT EXISTS faire_shops (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  faire_shop_token         text NOT NULL,                                       -- Faire's shop/brand identifier
  shop_name                text NOT NULL,
  api_key_ciphertext       bytea,                                               -- AES-256-GCM, key = FAIRE_TOKEN_ENC_KEY
  api_key_iv               bytea,
  api_key_tag              bytea,
  is_active                boolean NOT NULL DEFAULT true,
  last_orders_sync_at      timestamptz,
  last_payouts_sync_at     timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faire_shops_token_per_entity UNIQUE (entity_id, faire_shop_token)
);

COMMENT ON TABLE faire_shops IS 'P12c-1: per-shop Faire wholesale-marketplace configuration. Multi-shop via UNIQUE (entity_id, faire_shop_token). api_key encrypted at rest with AES-256-GCM (key=FAIRE_TOKEN_ENC_KEY). last_orders_sync_at / last_payouts_sync_at drive the P12c-2/P12c-3 incremental polling cursors.';
COMMENT ON COLUMN faire_shops.api_key_ciphertext IS 'AES-256-GCM ciphertext of the Faire static API key sent in the X-FAIRE-ACCESS-TOKEN header. Decryption is service-role only.';

-- ─── 2. faire_buyers — wholesale buyer ↔ customer mapping ────────────────
--
-- Faire buyers are retailers. Each buyer round-trips to a Tangerine
-- customers row (customer_id) for AR + CRM purposes (D6). Until the
-- buyer's first order is fully processed, customer_id can be NULL.
--
-- is_first_order_completed flag drives the 25%-vs-15% commission split:
-- the FIRST order from this buyer uses 25%, all subsequent use 15%.
-- Faire's API exposes an is_first_order flag on the order itself which is
-- authoritative; this column on the buyer row is a denormalized cache of
-- that flag for fast UI display.

CREATE TABLE IF NOT EXISTS faire_buyers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  faire_shop_id               uuid NOT NULL REFERENCES faire_shops(id) ON DELETE RESTRICT,
  faire_brand_token           text NOT NULL,                                    -- Faire's per-buyer token
  buyer_name                  text NOT NULL,
  buyer_email                 text,
  customer_id                 uuid REFERENCES customers(id) ON DELETE SET NULL,
  first_order_at              timestamptz,
  is_first_order_completed    boolean NOT NULL DEFAULT false,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faire_buyers_token_per_shop UNIQUE (faire_shop_id, faire_brand_token)
);

CREATE INDEX IF NOT EXISTS faire_buyers_entity_shop_idx
  ON faire_buyers (entity_id, faire_shop_id);
CREATE INDEX IF NOT EXISTS faire_buyers_customer_idx
  ON faire_buyers (customer_id)
  WHERE customer_id IS NOT NULL;

COMMENT ON TABLE faire_buyers IS 'P12c-1: Faire wholesale buyers (retailers). One row per (faire_shop_id, faire_brand_token). customer_id back-fills once the buyer round-trips to a Tangerine customers row (D6). is_first_order_completed denormalizes the 25%-vs-15% commission flag for fast UI; Faire orders themselves carry is_first_order_for_buyer which is authoritative at posting time.';

-- ─── 3. faire_orders ──────────────────────────────────────────────────────
--
-- One row per Faire order. source='faire' enforced by inline CHECK (this
-- table is faire-only; the broader source enum on ar_invoices was set by
-- T10-1 and re-asserted by P12-0). ar_invoice_id + je_id populated by the
-- P12c-2 conversion RPC.
--
-- commission_rate stored as numeric(5,4) so we can express 0.2500 / 0.1500
-- exactly (not numeric(5,2) — the doc shows 25.00 but rate is more
-- canonical as a fraction; in-row decomposition per D6).
--
-- is_first_order_for_buyer is the order-level boolean Faire returns; the
-- commission split (25% vs 15%) follows it directly.

CREATE TABLE IF NOT EXISTS faire_orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  faire_shop_id               uuid NOT NULL REFERENCES faire_shops(id) ON DELETE RESTRICT,
  faire_order_id              text NOT NULL,
  faire_brand_token           text,
  faire_buyer_id              uuid REFERENCES faire_buyers(id) ON DELETE SET NULL,
  placed_at                   timestamptz NOT NULL,
  ship_by_at                  timestamptz,
  order_status                text NOT NULL,                                    -- 'NEW','PROCESSING','PRE_TRANSIT','IN_TRANSIT','DELIVERED','CANCELED','BACKORDERED'
  currency                    text NOT NULL DEFAULT 'USD',
  subtotal_cents              bigint NOT NULL,
  shipping_cents              bigint NOT NULL DEFAULT 0,
  commission_cents            bigint NOT NULL,
  commission_rate             numeric(5,4) NOT NULL,                            -- 0.2500 first-order / 0.1500 recurring (D6)
  net_payout_cents            bigint NOT NULL,
  is_first_order_for_buyer    boolean NOT NULL DEFAULT false,
  customer_id                 uuid REFERENCES customers(id) ON DELETE SET NULL,
  ar_invoice_id               uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  source                      text NOT NULL DEFAULT 'faire' CHECK (source = 'faire'),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faire_orders_dedup UNIQUE (faire_shop_id, faire_order_id)
);

CREATE INDEX IF NOT EXISTS faire_orders_entity_placed_idx
  ON faire_orders (entity_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS faire_orders_buyer_idx
  ON faire_orders (faire_buyer_id)
  WHERE faire_buyer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS faire_orders_shop_placed_idx
  ON faire_orders (faire_shop_id, placed_at DESC);

COMMENT ON TABLE faire_orders IS 'P12c-1: Faire wholesale orders materialized from the orders poller (P12c-2). UNIQUE (faire_shop_id, faire_order_id) makes re-ingestion idempotent. ar_invoice_id + je_id populated by faire_convert_order_to_ar (P12c-2). commission_rate stored as numeric(5,4) for exact 0.2500 / 0.1500 representation; is_first_order_for_buyer is Faire-authoritative and drives the split (D6).';
COMMENT ON COLUMN faire_orders.source IS 'Always faire; the per-shop split lives in faire_shop_id. CHECK (source = ''faire'') enforced inline so a stray INSERT cannot mistype.';
COMMENT ON COLUMN faire_orders.commission_rate IS 'Numeric(5,4) commission fraction. 0.2500 = 25 percent (first order from new buyer); 0.1500 = 15 percent (recurring buyer). D6 in-row split — no separate COA accounts.';

-- ─── 4. faire_order_items ─────────────────────────────────────────────────
--
-- Line-level breakdown. ip_item_master_id resolved by SKU match at
-- posting time (NULL when SKU is unknown / new variant not yet in PIM).
-- UNIQUE (faire_order_id, line_number) so backfill replay is idempotent.

CREATE TABLE IF NOT EXISTS faire_order_items (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faire_order_id                uuid NOT NULL REFERENCES faire_orders(id) ON DELETE CASCADE,
  line_number                   int NOT NULL,
  faire_item_token              text NOT NULL,
  sku                           text,
  ip_item_master_id             uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  product_name                  text NOT NULL,
  quantity                      int NOT NULL,
  unit_price_wholesale_cents    bigint NOT NULL,
  line_total_cents              bigint NOT NULL,
  raw_payload                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT faire_order_items_dedup UNIQUE (faire_order_id, line_number)
);

CREATE INDEX IF NOT EXISTS faire_order_items_order_idx
  ON faire_order_items (faire_order_id);
CREATE INDEX IF NOT EXISTS faire_order_items_sku_idx
  ON faire_order_items (sku)
  WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS faire_order_items_item_idx
  ON faire_order_items (ip_item_master_id)
  WHERE ip_item_master_id IS NOT NULL;

COMMENT ON TABLE faire_order_items IS 'P12c-1: per-line breakdown of a Faire order. CASCADE on parent delete; UNIQUE (faire_order_id, line_number) for idempotent replay. unit_price_wholesale_cents because Faire is wholesale (retail price is buyer-side, not stored here).';

-- ─── 5. faire_payouts — monthly remittances ───────────────────────────────
--
-- Faire pays out monthly: gross orders for the period - commission -
-- refunds = net wire to operator's bank. Each payout has period_start /
-- period_end + a Faire-side payout_id. The P6 bank-recon match engine
-- joins on amount + date to set bank_transaction_id, then the matcher
-- posts the JE that clears 1115 Marketplace Receivable Clearing against
-- 1100 Bank (D6 flow).

CREATE TABLE IF NOT EXISTS faire_payouts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  faire_shop_id               uuid NOT NULL REFERENCES faire_shops(id) ON DELETE RESTRICT,
  faire_payout_id             text NOT NULL,
  payout_date                 date NOT NULL,
  period_start                date NOT NULL,
  period_end                  date NOT NULL,
  gross_amount_cents          bigint NOT NULL,
  commission_amount_cents     bigint NOT NULL,
  refunds_amount_cents        bigint NOT NULL DEFAULT 0,
  net_amount_cents            bigint NOT NULL,
  currency                    text NOT NULL DEFAULT 'USD',
  bank_transaction_id         uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  je_id                       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faire_payouts_dedup UNIQUE (faire_shop_id, faire_payout_id)
);

CREATE INDEX IF NOT EXISTS faire_payouts_entity_date_idx
  ON faire_payouts (entity_id, payout_date DESC);
CREATE INDEX IF NOT EXISTS faire_payouts_shop_date_idx
  ON faire_payouts (faire_shop_id, payout_date DESC);

COMMENT ON TABLE faire_payouts IS 'P12c-1: Faire monthly payout remittances. gross - commission - refunds = net. bank_transaction_id linked by P6 bank-recon match engine; je_id posted by the matcher to clear 1115 Marketplace Receivable Clearing against 1100 Bank (D6).';

-- ─── 6. NO inventory location seed — D15 ──────────────────────────────────
--
-- Per D15: Faire ships from operator's own warehouse always. No FAIRE_WH
-- inventory_locations row to seed; Faire orders consume layers from the
-- existing per-entity MAIN_WH location seeded by P12-0. This comment is
-- the entire section — no SQL.

-- ─── 7. RLS — anon_all_* + auth_internal_* template ───────────────────────
--
-- All 5 Faire tables are entity-scoped (faire_order_items via parent FK)
-- and get the standard P1 template: anon_all_* for the service-role / anon
-- API surface; auth_internal_* scoped to entity_users via auth.uid().

ALTER TABLE faire_shops        ENABLE ROW LEVEL SECURITY;
ALTER TABLE faire_buyers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE faire_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE faire_order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE faire_payouts      ENABLE ROW LEVEL SECURITY;

-- faire_shops
DO $$ BEGIN
  CREATE POLICY "anon_all_faire_shops" ON faire_shops
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_faire_shops" ON faire_shops
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- faire_buyers
DO $$ BEGIN
  CREATE POLICY "anon_all_faire_buyers" ON faire_buyers
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_faire_buyers" ON faire_buyers
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- faire_orders
DO $$ BEGIN
  CREATE POLICY "anon_all_faire_orders" ON faire_orders
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_faire_orders" ON faire_orders
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- faire_order_items — gated via parent faire_orders
DO $$ BEGIN
  CREATE POLICY "anon_all_faire_order_items" ON faire_order_items
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_faire_order_items" ON faire_order_items
    FOR ALL TO authenticated
    USING      (faire_order_id IN (
                  SELECT fo.id FROM faire_orders fo
                  WHERE fo.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (faire_order_id IN (
                  SELECT fo.id FROM faire_orders fo
                  WHERE fo.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- faire_payouts
DO $$ BEGIN
  CREATE POLICY "anon_all_faire_payouts" ON faire_payouts
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_faire_payouts" ON faire_payouts
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 8. PostgREST schema cache reload ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
