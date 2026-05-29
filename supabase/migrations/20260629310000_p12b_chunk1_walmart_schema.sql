-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P12b-1 — Walmart Marketplace foundation schema
--
-- First chunk of the P12b sub-phase (Walmart Marketplace direct integration —
-- see docs/tangerine/P12-marketplaces-architecture.md §3.5 + §5).
-- Operator-accepted decisions from PR #480 / PR #483 (P12-0 shared GATE).
--
-- Replaces the existing Xoro-mirrored Walmart path with a direct producer:
-- Walmart Marketplace API → Tangerine ar_invoices + JE, source='walmart'.
-- Xoro gets cut out of the Walmart flow after parallel-run reconciles clean.
--
-- This chunk = SCHEMA ONLY. Handlers (token encryption real impl, order
-- ingest cron, settlement reconciler, returns mirror) land in P12b-2..P12b-9.
--
-- Tables (all idempotent CREATE TABLE IF NOT EXISTS):
--   1. walmart_seller_accounts — per-seller config + encrypted client_id /
--                                client_secret (D3 client_credentials OAuth)
--   2. walmart_orders          — one row per Walmart PO (D2 source='walmart')
--   3. walmart_order_items     — line-level revenue + commission + WFS fee
--   4. walmart_settlements     — weekly Walmart Settlement Report (D9)
--   5. walmart_returns         — D11 mirror of /v3/returns
--
-- Plus:
--   - WFS_US inventory_location seeded for ROF (D14 — operator may or may
--     not be on WFS today; either way the location is in place so the WFS
--     poller can flip on once walmart_seller_accounts.wfs_location_id is
--     pointed at it)
--   - anon_all_* + auth_internal_* RLS on all 5 entity-scoped tables
--   - DEFAULT rof_entity_id() on all four entity-scoped tables that the
--     ingest handler will INSERT into directly — same pattern P11-1 used,
--     and the standing rule (memory 2026-05-28) for new entity-scoped
--     tables.
--
-- Fully idempotent: CREATE TABLE IF NOT EXISTS, ADD CONSTRAINT under DO
-- guards, INSERT…ON CONFLICT DO NOTHING.
--
-- NOTE — COMMENT ON: every COMMENT here uses a plain single-quoted string
-- literal. Postgres rejects `COMMENT ON ... IS 'a ' || 'b';` ("input of
-- anonymous composite types is not implemented"). We shipped that bug
-- twice (PR #485 + the earlier P12-0 hotfix); not again.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. walmart_seller_accounts ───────────────────────────────────────────
--
-- Per-seller-account config + encrypted client_credentials OAuth pair.
-- AES-256-GCM with key = WALMART_TOKEN_ENC_KEY (same pattern as Plaid
-- token encryption from P6-2 + Shopify from P11-1). UNIQUE on
-- (entity_id, partner_id) so we never configure the same Walmart seller
-- twice for the same entity.
--
-- wfs_location_id points at the inventory_locations row that holds the
-- operator's WFS-fulfilled stock. NULL for FBM-only sellers. SET NULL
-- on delete because a sloppy location-cleanup shouldn't take the seller
-- account down with it.

CREATE TABLE IF NOT EXISTS walmart_seller_accounts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  partner_id                  text NOT NULL,                            -- Walmart Partner ID (seller identifier)
  account_name                text NOT NULL,                            -- 'ROF Walmart NA'
  client_id_ciphertext        bytea,                                    -- AES-256-GCM, key = WALMART_TOKEN_ENC_KEY
  client_id_iv                bytea,
  client_id_tag               bytea,
  client_secret_ciphertext    bytea,
  client_secret_iv            bytea,
  client_secret_tag           bytea,
  wfs_location_id             uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  is_active                   boolean NOT NULL DEFAULT true,
  last_orders_sync_at         timestamptz,
  last_settlement_sync_at     timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walmart_seller_accounts_partner_per_entity UNIQUE (entity_id, partner_id)
);

COMMENT ON TABLE walmart_seller_accounts IS 'P12b-1: per-seller Walmart Marketplace configuration. Multi-account via UNIQUE (entity_id, partner_id). client_id + client_secret encrypted at rest with AES-256-GCM (key=WALMART_TOKEN_ENC_KEY). wfs_location_id points at the inventory_locations row that holds WFS-fulfilled stock for this seller (NULL for FBM-only).';
COMMENT ON COLUMN walmart_seller_accounts.client_id_ciphertext IS 'AES-256-GCM ciphertext of the Walmart client_credentials OAuth client_id. Decryption is service-role only.';
COMMENT ON COLUMN walmart_seller_accounts.client_secret_ciphertext IS 'AES-256-GCM ciphertext of the Walmart client_credentials OAuth client_secret. Decryption is service-role only.';

-- ─── 2. walmart_orders ────────────────────────────────────────────────────
--
-- One row per Walmart purchase_order_id. source='walmart' enforced by the
-- inline CHECK (this table is walmart-only — non-walmart sources go on
-- ar_invoices where T10-1's broader enum lives). ar_invoice_id + je_id
-- link out to the materialized AR + JE rows once the posting service
-- runs (P12b-3).

CREATE TABLE IF NOT EXISTS walmart_orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  walmart_seller_account_id   uuid NOT NULL REFERENCES walmart_seller_accounts(id) ON DELETE RESTRICT,
  purchase_order_id           text NOT NULL,                            -- Walmart's PO# (their order identifier)
  customer_order_id           text,                                     -- Walmart's customer-facing order id
  order_date                  timestamptz,
  order_status                text,                                     -- 'Created'|'Acknowledged'|'Shipped'|'Delivered'|'Cancelled'
  ship_node_type              text,                                     -- 'SellerFulfilled' | 'WFSFulfilled' | NULL when unknown
  currency                    text NOT NULL DEFAULT 'USD',
  order_total_cents           bigint,
  item_subtotal_cents         bigint NOT NULL DEFAULT 0,
  tax_collected_cents         bigint NOT NULL DEFAULT 0,
  shipping_cents              bigint NOT NULL DEFAULT 0,
  discount_cents              bigint NOT NULL DEFAULT 0,
  customer_id                 uuid REFERENCES customers(id) ON DELETE SET NULL,
  ar_invoice_id               uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload                 jsonb,
  source                      text NOT NULL DEFAULT 'walmart' CHECK (source = 'walmart'),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walmart_orders_dedup UNIQUE (walmart_seller_account_id, purchase_order_id)
);

CREATE INDEX IF NOT EXISTS walmart_orders_entity_order_date_idx
  ON walmart_orders (entity_id, order_date DESC);
CREATE INDEX IF NOT EXISTS walmart_orders_seller_order_date_idx
  ON walmart_orders (walmart_seller_account_id, order_date DESC);

COMMENT ON TABLE walmart_orders IS 'P12b-1: Walmart Marketplace orders materialized from order-feed cron + on-demand /v3/orders fetches. UNIQUE (walmart_seller_account_id, purchase_order_id) makes re-ingestion idempotent. ar_invoice_id + je_id populated by P12b-3 posting service.';
COMMENT ON COLUMN walmart_orders.source IS 'Always walmart; the per-seller split lives in walmart_seller_account_id (D2).';
COMMENT ON COLUMN walmart_orders.ship_node_type IS 'P12b-1: SellerFulfilled (FBM) or WFSFulfilled (Walmart Fulfillment Services). NULL until first order payload arrives. Drives the WFS-fee leg of the posting JE (only WFS orders get a 6525 fee line).';

-- ─── 3. walmart_order_items ───────────────────────────────────────────────
--
-- Line-level breakdown. ip_item_master_id resolved by SKU match at
-- posting time (NULL when SKU is unknown / new variant not yet in PIM).
-- UNIQUE (walmart_order_id, line_number) so backfill replay is idempotent.

CREATE TABLE IF NOT EXISTS walmart_order_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  walmart_order_id            uuid NOT NULL REFERENCES walmart_orders(id) ON DELETE CASCADE,
  line_number                 int NOT NULL,
  item_sku                    text,
  product_name                text,
  ip_item_master_id           uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  quantity                    int,
  unit_price_cents            bigint,
  line_total_cents            bigint,
  tax_cents                   bigint NOT NULL DEFAULT 0,
  commission_cents            bigint NOT NULL DEFAULT 0,
  wfs_fulfillment_fee_cents   bigint NOT NULL DEFAULT 0,
  raw_payload                 jsonb,
  CONSTRAINT walmart_order_items_dedup UNIQUE (walmart_order_id, line_number)
);

CREATE INDEX IF NOT EXISTS walmart_order_items_order_idx
  ON walmart_order_items (walmart_order_id);
CREATE INDEX IF NOT EXISTS walmart_order_items_sku_idx
  ON walmart_order_items (item_sku)
  WHERE item_sku IS NOT NULL;

COMMENT ON TABLE walmart_order_items IS 'P12b-1: per-line breakdown of a Walmart order. CASCADE on parent delete; UNIQUE (walmart_order_id, line_number) for idempotent replay. commission_cents (6520) + wfs_fulfillment_fee_cents (6525) are populated from the Settlement Report — the order feed itself does NOT include final fees.';

-- ─── 4. walmart_settlements ───────────────────────────────────────────────
--
-- Weekly Walmart Settlement Report. Walmart pays weekly; this table is
-- the source of truth for the gross→fees→net waterfall that drives the
-- payout-reconciliation JE (clears 1115 Marketplace Receivable Clearing
-- against 1100 Bank — D6 from P12-0).

CREATE TABLE IF NOT EXISTS walmart_settlements (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  walmart_seller_account_id   uuid NOT NULL REFERENCES walmart_seller_accounts(id) ON DELETE RESTRICT,
  settlement_id               text NOT NULL,
  period_start                date,
  period_end                  date,
  gross_amount_cents          bigint,
  fees_amount_cents           bigint,
  refunds_amount_cents        bigint,
  net_amount_cents            bigint,
  currency                    text NOT NULL DEFAULT 'USD',
  bank_transaction_id         uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  je_id                       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload                 jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walmart_settlements_dedup UNIQUE (walmart_seller_account_id, settlement_id)
);

CREATE INDEX IF NOT EXISTS walmart_settlements_entity_period_idx
  ON walmart_settlements (entity_id, period_end DESC);

COMMENT ON TABLE walmart_settlements IS 'P12b-1: weekly Walmart Settlement Report. gross - fees - refunds = net (matches bank deposit). bank_transaction_id linked by P6 bank-recon match engine; je_id posted by the matcher to clear 1115 Marketplace Receivable Clearing against 1100 Bank (D6 from P12-0).';

-- ─── 5. walmart_returns ───────────────────────────────────────────────────
--
-- D11: mirror /v3/returns. Seller-fulfilled returns flow back to the
-- operator (operator approves restock in panel); WFS returns work like
-- FBA (Walmart decides resell/destroy). credit_memo_id points at the
-- sibling AR credit memo once the posting service runs.
--
-- UNIQUE on return_order_id (Walmart's globally-unique return id).

CREATE TABLE IF NOT EXISTS walmart_returns (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  walmart_order_id            uuid REFERENCES walmart_orders(id) ON DELETE SET NULL,
  customer_order_id           text,
  return_order_id             text NOT NULL,
  item_sku                    text,
  ip_item_master_id           uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  quantity                    int,
  reason                      text,
  return_status               text,
  refund_amount_cents         bigint NOT NULL DEFAULT 0,
  restocking_fee_cents        bigint NOT NULL DEFAULT 0,
  ar_credit_memo_id           uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload                 jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walmart_returns_dedup UNIQUE (return_order_id)
);

CREATE INDEX IF NOT EXISTS walmart_returns_entity_created_idx
  ON walmart_returns (entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS walmart_returns_order_idx
  ON walmart_returns (walmart_order_id)
  WHERE walmart_order_id IS NOT NULL;

COMMENT ON TABLE walmart_returns IS 'P12b-1: Walmart return mirror (D11). Both seller-fulfilled (operator approves restock) and WFS returns (Walmart decides disposition) materialized here. ar_credit_memo_id points at the sibling AR credit memo from P12b-3 posting; je_id posts the COGS reversal + restock JE.';

-- ─── 6. Seed WFS_US inventory_location for ROF (D14) ──────────────────────
--
-- Operator may or may not be on WFS today; either way the location is
-- in place so the WFS poller can flip on once
-- walmart_seller_accounts.wfs_location_id is pointed at it.
--
-- Single-tenant ROF seed for the P12b chunk; future tenants seed their
-- own WFS location via the standard P3 bootstrap.

INSERT INTO inventory_locations (entity_id, code, name, kind, country_code)
  SELECT rof_entity_id(), 'WFS_US', 'Walmart Fulfillment Services (US)', 'wfs', 'US'
  ON CONFLICT (entity_id, code) DO NOTHING;

-- ─── 7. RLS — anon_all_* + auth_internal_* template ───────────────────────
--
-- Five entity-scoped tables follow the standard P1 template (anon_all_*
-- for the service-role / anon-key API surface; auth_internal_* scoped
-- to entity_users via auth.uid()).
--
-- walmart_order_items is gated via its parent walmart_orders (no
-- entity_id of its own).

ALTER TABLE walmart_seller_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE walmart_orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE walmart_order_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE walmart_settlements     ENABLE ROW LEVEL SECURITY;
ALTER TABLE walmart_returns         ENABLE ROW LEVEL SECURITY;

-- walmart_seller_accounts
DO $$ BEGIN
  CREATE POLICY "anon_all_walmart_seller_accounts" ON walmart_seller_accounts
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_walmart_seller_accounts" ON walmart_seller_accounts
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- walmart_orders
DO $$ BEGIN
  CREATE POLICY "anon_all_walmart_orders" ON walmart_orders
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_walmart_orders" ON walmart_orders
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- walmart_order_items — not entity-scoped directly; gated via parent
DO $$ BEGIN
  CREATE POLICY "anon_all_walmart_order_items" ON walmart_order_items
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_walmart_order_items" ON walmart_order_items
    FOR ALL TO authenticated
    USING      (walmart_order_id IN (
                  SELECT wo.id FROM walmart_orders wo
                  WHERE wo.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (walmart_order_id IN (
                  SELECT wo.id FROM walmart_orders wo
                  WHERE wo.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- walmart_settlements
DO $$ BEGIN
  CREATE POLICY "anon_all_walmart_settlements" ON walmart_settlements
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_walmart_settlements" ON walmart_settlements
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- walmart_returns
DO $$ BEGIN
  CREATE POLICY "anon_all_walmart_returns" ON walmart_returns
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_walmart_returns" ON walmart_returns
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 8. PostgREST schema cache reload ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
