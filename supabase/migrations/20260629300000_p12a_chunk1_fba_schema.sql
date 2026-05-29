-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P12a-1 — Amazon FBA (SP-API) foundation schema
--
-- First chunk of P12a (Amazon FBA — see
-- docs/tangerine/P12-marketplaces-architecture.md §3.4). Operator-accepted
-- decisions from P12-0 (PR #483, merged):
--   D1   Multi seller accounts per channel
--   D4   FBA fees split into separate GL lines
--   D7   Sponsored Ads as 6521
--   D13/D14 Multi-location inventory via inventory_locations + layers FK
--
-- P12-0 already seeded the cross-channel pieces (inventory_locations,
-- MAIN_WH per entity, marketplace GL accounts 1115/1116/6520-6525,
-- customers.marketplace_buyer_refs jsonb, source_kind extensions). This
-- chunk adds the six FBA-specific tables + the FBA_US inventory location
-- for ROF + the LWA token-encryption stub.
--
-- This chunk = SCHEMA ONLY. Handlers (token encryption real impl, SP-API
-- orders polling, settlements posting, inventory snapshot poller, returns
-- processor) land in P12a-2 .. P12a-N.
--
-- Tables (all idempotent CREATE TABLE IF NOT EXISTS):
--   1. fba_seller_accounts        — multi-account (D1) + encrypted LWA creds
--   2. fba_orders                 — one row per Amazon order
--   3. fba_order_items            — line-level fee + price breakdown
--   4. fba_settlements            — financial event group settlements
--   5. fba_inventory_snapshots    — multi-location FBA inventory mirror
--   6. fba_returns                — FBA return events
--
-- Plus:
--   - FBA_US inventory_location seed for ROF (idempotent)
--   - DEFAULT rof_entity_id() on every entity-scoped FBA table so the
--     SP-API handler can INSERT without resolving entity_id client-side
--     (tanda_pos pattern from PR #463 — memory rule 2026-05-28)
--   - anon_all_* + auth_internal_* RLS template on all 6 tables
--
-- Fully idempotent: CREATE TABLE IF NOT EXISTS, ADD CONSTRAINT under
-- pg_constraint guard, INSERT…ON CONFLICT DO NOTHING, RLS policies
-- wrapped in DO $$ EXCEPTION WHEN duplicate_object blocks.
--
-- LINT — DO NOT concatenate COMMENT ON values with the pipe-pipe operator.
-- Postgres requires a string LITERAL (not an expression) for COMMENT. We
-- shipped that bug twice — every COMMENT below is a single-line literal.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. fba_seller_accounts ──────────────────────────────────────────────
--
-- Multi-account (D1) per-entity. Each row = one (seller_id, marketplace_id)
-- pair → one SP-API session. LWA refresh token + client id/secret encrypted
-- at rest with AES-256-GCM (key = FBA_TOKEN_ENC_KEY). UNIQUE
-- (entity_id, seller_id, marketplace_id) so the same Amazon account can't
-- be configured twice for the same entity / marketplace.
--
-- fba_location_id is the inventory_locations row this account's stock is
-- held at — typically FBA_US (seeded below) for the NA / US marketplace,
-- a separate FBA_CA row for Amazon Canada, etc.

CREATE TABLE IF NOT EXISTS fba_seller_accounts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  seller_id                   text NOT NULL,                                                -- Amazon Merchant Token, e.g. 'A1XXXXXXXXXXXX'
  marketplace_id              text NOT NULL,                                                -- e.g. 'ATVPDKIKX0DER' (US), 'A2EUQ1WTGCTBG2' (CA)
  account_name                text NOT NULL,                                                -- 'ROF US Amazon'
  region                      text NOT NULL CHECK (region IN ('NA','EU','FE')),
  lwa_client_id_ciphertext    bytea,                                                        -- AES-256-GCM, key = FBA_TOKEN_ENC_KEY
  lwa_client_id_iv            bytea,
  lwa_client_id_tag           bytea,
  lwa_client_secret_ciphertext bytea,
  lwa_client_secret_iv        bytea,
  lwa_client_secret_tag       bytea,
  refresh_token_ciphertext    bytea,
  refresh_token_iv            bytea,
  refresh_token_tag           bytea,
  aws_role_arn                text,                                                         -- nullable; legacy Sigv4 path
  fba_location_id             uuid REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  is_active                   boolean NOT NULL DEFAULT true,
  last_orders_sync_at         timestamptz,
  last_settlement_sync_at     timestamptz,
  last_inventory_sync_at      timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fba_seller_accounts_unique UNIQUE (entity_id, seller_id, marketplace_id)
);

COMMENT ON TABLE fba_seller_accounts IS 'P12a-1: per-(seller_id, marketplace_id) Amazon SP-API account. Multi-account via UNIQUE (entity_id, seller_id, marketplace_id). LWA refresh_token + client_id + client_secret encrypted at rest with AES-256-GCM (key=FBA_TOKEN_ENC_KEY).';
COMMENT ON COLUMN fba_seller_accounts.refresh_token_ciphertext IS 'AES-256-GCM ciphertext of the LWA refresh token. Decryption is service-role only.';
COMMENT ON COLUMN fba_seller_accounts.fba_location_id IS 'inventory_locations row that holds this account stock (e.g. FBA_US for the US marketplace). FIFO/COGS queries filter by this id to keep FBA stock distinct from MAIN_WH.';

-- ─── 2. fba_orders ────────────────────────────────────────────────────────
--
-- One row per Amazon order ID. source='fba' enforced by inline CHECK; the
-- per-channel split lives in fba_seller_account_id so a multi-account
-- entity (D1) keeps each account auditable. ar_invoice_id + je_id linked
-- by the posting service in P12a-3 once orders settle.

CREATE TABLE IF NOT EXISTS fba_orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  fba_seller_account_id       uuid NOT NULL REFERENCES fba_seller_accounts(id) ON DELETE RESTRICT,
  amazon_order_id             text NOT NULL,                                                -- '111-1111111-1111111'
  purchase_date               timestamptz NOT NULL,
  last_update_date            timestamptz NOT NULL,
  order_status                text NOT NULL,                                                -- 'Pending'|'Unshipped'|'PartiallyShipped'|'Shipped'|'Canceled'
  fulfillment_channel         text NOT NULL CHECK (fulfillment_channel IN ('AFN','MFN')),
  marketplace_id              text NOT NULL,
  currency                    text NOT NULL DEFAULT 'USD',
  order_total_cents           bigint NOT NULL,
  item_subtotal_cents         bigint NOT NULL DEFAULT 0,
  tax_collected_cents         bigint NOT NULL DEFAULT 0,
  shipping_cents              bigint NOT NULL DEFAULT 0,
  promotion_discount_cents    bigint NOT NULL DEFAULT 0,
  customer_id                 uuid REFERENCES customers(id) ON DELETE SET NULL,
  ar_invoice_id               uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  source                      text NOT NULL DEFAULT 'fba' CHECK (source IN ('fba')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fba_orders_dedup UNIQUE (fba_seller_account_id, amazon_order_id)
);

CREATE INDEX IF NOT EXISTS fba_orders_entity_purchase_idx
  ON fba_orders (entity_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS fba_orders_account_status_idx
  ON fba_orders (fba_seller_account_id, order_status);

COMMENT ON TABLE fba_orders IS 'P12a-1: Amazon orders materialized from SP-API GET_ORDERS. UNIQUE (fba_seller_account_id, amazon_order_id) makes re-ingestion idempotent. ar_invoice_id + je_id populated by P12a-3 posting service.';
COMMENT ON COLUMN fba_orders.source IS 'Always fba; the per-account split lives in fba_seller_account_id (D1).';
COMMENT ON COLUMN fba_orders.fulfillment_channel IS 'AFN=Amazon-fulfilled (FBA), MFN=Merchant-fulfilled (FBM). Inventory deductions only apply to AFN.';

-- ─── 3. fba_order_items ───────────────────────────────────────────────────
--
-- Line-level breakdown for each Amazon order. ip_item_master_id resolved
-- by ASIN / seller SKU lookup at posting time (NULL when SKU is unknown).
-- Holds both the customer-charged amounts (item_price, tax, discount) and
-- the seller-paid fees (fulfillment_fee, referral_fee). UNIQUE on
-- (fba_order_id, order_item_id) keeps backfill replay idempotent.

CREATE TABLE IF NOT EXISTS fba_order_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fba_order_id                uuid NOT NULL REFERENCES fba_orders(id) ON DELETE CASCADE,
  order_item_id               text NOT NULL,                                                -- SP-API OrderItemId
  asin                        text,
  sku                         text,
  ip_item_master_id           uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  title                       text,
  quantity_ordered            int NOT NULL,
  quantity_shipped            int NOT NULL DEFAULT 0,
  item_price_cents            bigint NOT NULL,
  item_tax_cents              bigint NOT NULL DEFAULT 0,
  promotion_discount_cents    bigint NOT NULL DEFAULT 0,
  fulfillment_fee_cents       bigint NOT NULL DEFAULT 0,
  referral_fee_cents          bigint NOT NULL DEFAULT 0,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fba_order_items_dedup UNIQUE (fba_order_id, order_item_id)
);

CREATE INDEX IF NOT EXISTS fba_order_items_order_idx
  ON fba_order_items (fba_order_id);
CREATE INDEX IF NOT EXISTS fba_order_items_sku_idx
  ON fba_order_items (sku)
  WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS fba_order_items_asin_idx
  ON fba_order_items (asin)
  WHERE asin IS NOT NULL;

COMMENT ON TABLE fba_order_items IS 'P12a-1: per-line breakdown of an Amazon order. CASCADE on parent delete; UNIQUE (fba_order_id, order_item_id) for idempotent replay. fulfillment_fee and referral_fee post to 6523 / 6524 at settlement time.';

-- ─── 4. fba_settlements ───────────────────────────────────────────────────
--
-- SP-API FinancialEventGroup payouts. UNIQUE on
-- (fba_seller_account_id, financial_event_group_id) so re-polling the
-- group is idempotent. processing_status 'Open' until SP-API marks
-- 'Closed' (settlement finalized); bank_transaction_id matched by the
-- P6 bank-recon engine; je_id posted by the matcher to clear 1115
-- Marketplace Receivable Clearing.

CREATE TABLE IF NOT EXISTS fba_settlements (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  fba_seller_account_id       uuid NOT NULL REFERENCES fba_seller_accounts(id) ON DELETE RESTRICT,
  financial_event_group_id    text NOT NULL,                                                -- SP-API FinancialEventGroupId
  posted_after                timestamptz NOT NULL,
  posted_before               timestamptz NOT NULL,
  gross_amount_cents          bigint NOT NULL,
  fees_amount_cents           bigint NOT NULL,
  refunds_amount_cents        bigint NOT NULL DEFAULT 0,
  net_amount_cents            bigint NOT NULL,
  currency                    text NOT NULL DEFAULT 'USD',
  processing_status           text NOT NULL DEFAULT 'Open' CHECK (processing_status IN ('Open','Closed')),
  bank_transaction_id         uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  je_id                       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fba_settlements_dedup UNIQUE (fba_seller_account_id, financial_event_group_id)
);

CREATE INDEX IF NOT EXISTS fba_settlements_entity_posted_idx
  ON fba_settlements (entity_id, posted_after DESC);
CREATE INDEX IF NOT EXISTS fba_settlements_unmatched_idx
  ON fba_settlements (posted_after DESC)
  WHERE bank_transaction_id IS NULL;

COMMENT ON TABLE fba_settlements IS 'P12a-1: SP-API FinancialEventGroup settlements. gross - fees - refunds = net (matches bank deposit). bank_transaction_id linked by P6 bank-recon match engine; je_id posted by the matcher to clear 1115 Marketplace Receivable Clearing against 1100 Bank.';

-- ─── 5. fba_inventory_snapshots ───────────────────────────────────────────
--
-- Daily / on-demand snapshot of FBA inventory state per (account, SKU).
-- Mirror table — UNIQUE on (fba_seller_account_id, snapshot_at, asin, sku)
-- preserves historical snapshots so dashboards can chart inventory over
-- time. The "live" FIFO layers live in inventory_layers with
-- location_id=FBA_US (or per-region); this table is the source-of-truth
-- mirror used to reconcile inventory_layers drift.

CREATE TABLE IF NOT EXISTS fba_inventory_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  fba_seller_account_id       uuid NOT NULL REFERENCES fba_seller_accounts(id) ON DELETE RESTRICT,
  snapshot_at                 timestamptz NOT NULL,
  asin                        text,
  sku                         text,
  ip_item_master_id           uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  fulfillable_qty             int NOT NULL DEFAULT 0,
  inbound_working_qty         int NOT NULL DEFAULT 0,
  inbound_shipped_qty         int NOT NULL DEFAULT 0,
  inbound_receiving_qty       int NOT NULL DEFAULT 0,
  reserved_qty                int NOT NULL DEFAULT 0,
  unfulfillable_qty           int NOT NULL DEFAULT 0,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fba_inventory_snapshots_dedup UNIQUE (fba_seller_account_id, snapshot_at, asin, sku)
);

CREATE INDEX IF NOT EXISTS fba_inventory_snapshots_account_taken_idx
  ON fba_inventory_snapshots (fba_seller_account_id, snapshot_at DESC);

COMMENT ON TABLE fba_inventory_snapshots IS 'P12a-1: FBA inventory mirror polled from SP-API GET_FBA_INVENTORY_AGED_DATA / FBA Inventory API. Historical snapshots retained (UNIQUE includes snapshot_at). Source-of-truth for reconciling inventory_layers location_id=FBA_US drift.';

-- ─── 6. fba_returns ───────────────────────────────────────────────────────
--
-- FBA return events from SP-API GET_FBA_RETURNS_DATA. UNIQUE on
-- return_request_id so the same return is never double-counted.
-- ar_credit_memo_id points to the sibling AR credit memo created when
-- the return triggers a refund (D7 partial-refund equivalent on the FBA
-- side); je_id is the GL entry that books the refund + inventory
-- restoration.

CREATE TABLE IF NOT EXISTS fba_returns (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  fba_order_id                uuid REFERENCES fba_orders(id) ON DELETE SET NULL,
  amazon_order_id             text,
  return_request_id           text NOT NULL,
  asin                        text,
  sku                         text,
  ip_item_master_id           uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  quantity                    int NOT NULL,
  reason                      text,
  return_status               text,
  refund_amount_cents         bigint NOT NULL DEFAULT 0,
  ar_credit_memo_id           uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fba_returns_dedup UNIQUE (return_request_id)
);

CREATE INDEX IF NOT EXISTS fba_returns_entity_created_idx
  ON fba_returns (entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fba_returns_order_idx
  ON fba_returns (fba_order_id)
  WHERE fba_order_id IS NOT NULL;

COMMENT ON TABLE fba_returns IS 'P12a-1: Amazon FBA return events. UNIQUE on return_request_id dedupes re-polling. ar_credit_memo_id + je_id linked by P12a-3 posting service for refunds and inventory restoration (fba_return_restock source_kind on inventory_layers).';

-- ─── 7. Seed FBA_US inventory_location for ROF ────────────────────────────
--
-- Idempotent via the existing UNIQUE (entity_id, code) from P12-0.
-- Other entities (e.g. SANDBOX) get their FBA_US row added later if /
-- when they configure FBA — single-tenant ROF seed for this chunk.

INSERT INTO inventory_locations (entity_id, code, name, kind, country_code)
SELECT rof_entity_id(), 'FBA_US', 'Amazon FBA (US)', 'fba', 'US'
ON CONFLICT (entity_id, code) DO NOTHING;

-- ─── 8. RLS — anon_all_* + auth_internal_* template ───────────────────────
--
-- All six FBA tables are entity-scoped (directly or via FK chain). Standard
-- P1 template: anon_all_* for the service-role / anon-key API surface;
-- auth_internal_* gates rows to entity_users → auth.uid().
--
-- fba_order_items + fba_returns gate through their parent fba_order's
-- entity_id when not entity-scoped directly. fba_order_items has no
-- direct entity_id column; fba_returns DOES have entity_id (matches the
-- DEFAULT rof_entity_id() pattern).

ALTER TABLE fba_seller_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fba_orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE fba_order_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fba_settlements          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fba_inventory_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fba_returns              ENABLE ROW LEVEL SECURITY;

-- fba_seller_accounts
DO $$ BEGIN
  CREATE POLICY "anon_all_fba_seller_accounts" ON fba_seller_accounts
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_fba_seller_accounts" ON fba_seller_accounts
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- fba_orders
DO $$ BEGIN
  CREATE POLICY "anon_all_fba_orders" ON fba_orders
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_fba_orders" ON fba_orders
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- fba_order_items — gated through parent fba_order's entity_id
DO $$ BEGIN
  CREATE POLICY "anon_all_fba_order_items" ON fba_order_items
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_fba_order_items" ON fba_order_items
    FOR ALL TO authenticated
    USING      (fba_order_id IN (
                  SELECT fo.id FROM fba_orders fo
                  WHERE fo.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (fba_order_id IN (
                  SELECT fo.id FROM fba_orders fo
                  WHERE fo.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- fba_settlements
DO $$ BEGIN
  CREATE POLICY "anon_all_fba_settlements" ON fba_settlements
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_fba_settlements" ON fba_settlements
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- fba_inventory_snapshots
DO $$ BEGIN
  CREATE POLICY "anon_all_fba_inventory_snapshots" ON fba_inventory_snapshots
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_fba_inventory_snapshots" ON fba_inventory_snapshots
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- fba_returns
DO $$ BEGIN
  CREATE POLICY "anon_all_fba_returns" ON fba_returns
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_fba_returns" ON fba_returns
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 9. PostgREST schema cache reload ────────────────────────────────────
NOTIFY pgrst, 'reload schema';
