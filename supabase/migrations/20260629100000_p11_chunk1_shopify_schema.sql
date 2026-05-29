-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P11-1 — Shopify direct-integration foundation schema
--
-- First chunk of P11 (Shopify direct integration — see
-- docs/tangerine/P11-shopify-architecture.md). Operator-accepted decisions
-- D1-D12 (PR #461 merged).
--
-- Replaces the existing day-delayed Shopify-via-Xoro path with a direct
-- producer: webhook → Tangerine ar_invoices + JE, source='shopify'. Xoro
-- gets cut out of the Shopify flow after parallel-run reconciles clean
-- (D12).
--
-- This chunk = SCHEMA ONLY. Handlers (token encryption real impl, webhook
-- intake, backfill cron) land in P11-2..P11-9.
--
-- Tables (all idempotent CREATE TABLE IF NOT EXISTS):
--   1. shopify_stores        — per-store config + encrypted creds (D1, D2, D11)
--   2. shopify_orders        — one row per Shopify order (D4)
--   3. shopify_order_lines   — line-level (revenue + tax + discount split)
--   4. shopify_refunds       — full / partial refunds (D7, D8)
--   5. shopify_payouts       — Shopify Payments payouts (D6 reconciliation)
--   6. shopify_webhook_log   — at-least-once webhook dedup (D11)
--
-- Plus:
--   - 1 new GL account seeded: 4500 Restocking Fee Income (D8). The other
--     three (1110, 6510, 6610) were seeded by P7-1; we INSERT…ON CONFLICT
--     DO NOTHING to be tolerant if they were dropped, but expect a no-op.
--   - inventory_layers.source_kind CHECK extended with
--     'shopify_refund_restock' (D7 partial-refund inventory restore)
--   - auth_internal_* RLS template on all 5 entity-scoped Shopify tables
--   - DEFAULT rof_entity_id() on shopify_orders / shopify_refunds /
--     shopify_payouts so the webhook handler can INSERT without resolving
--     entity_id client-side (per the tanda_pos pattern, memory rule
--     2026-05-28: 11 other entity-scoped tables still need this default)
--
-- Fully idempotent: CREATE TABLE IF NOT EXISTS, ADD CONSTRAINT under
-- pg_constraint guard, INSERT…ON CONFLICT DO NOTHING.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. shopify_stores ────────────────────────────────────────────────────
--
-- Per-store config + encrypted Admin API token + webhook HMAC secret.
-- AES-256-GCM with key = SHOPIFY_TOKEN_ENC_KEY (same pattern as Plaid
-- token encryption from P6-2). UNIQUE on (entity_id, shopify_domain) so
-- we can never accidentally configure the same store twice for the same
-- entity.

CREATE TABLE IF NOT EXISTS shopify_stores (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                 uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_domain            text NOT NULL,                            -- 'rof.myshopify.com'
  store_name                text NOT NULL,                            -- 'ROF DTC'
  access_token_ciphertext   bytea,                                    -- AES-256-GCM, key = SHOPIFY_TOKEN_ENC_KEY
  access_token_iv           bytea,
  access_token_tag          bytea,
  webhook_secret_ciphertext bytea,
  webhook_secret_iv         bytea,
  webhook_secret_tag        bytea,
  api_version               text NOT NULL DEFAULT '2025-01',
  is_active                 boolean NOT NULL DEFAULT true,
  last_backfill_at          timestamptz,
  last_webhook_at           timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_stores_domain_per_entity UNIQUE (entity_id, shopify_domain)
);

COMMENT ON TABLE shopify_stores IS 'P11-1: per-store Shopify configuration. Multi-store via UNIQUE (entity_id, shopify_domain). access_token + webhook_secret encrypted at rest with AES-256-GCM (key=SHOPIFY_TOKEN_ENC_KEY).';
COMMENT ON COLUMN shopify_stores.access_token_ciphertext IS 'AES-256-GCM ciphertext of the Shopify Admin API access token. Decryption is service-role only.';
COMMENT ON COLUMN shopify_stores.webhook_secret_ciphertext IS 'AES-256-GCM ciphertext of the per-store HMAC secret used to verify Shopify webhook signatures (D11).';

-- ─── 2. shopify_orders ────────────────────────────────────────────────────
--
-- One row per Shopify order. source='shopify' enforced by the inline CHECK
-- (this table is shopify-only — non-shopify sources go on ar_invoices
-- where T10-1's broader enum lives). ar_invoice_id + je_id link out to
-- the materialized AR + JE rows once the posting service runs (P11-3).

CREATE TABLE IF NOT EXISTS shopify_orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id         uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_order_id         text NOT NULL,                                            -- Shopify GID
  order_number             text NOT NULL,                                            -- '#1001'
  financial_status         text NOT NULL,                                            -- 'paid'|'refunded'|'partially_refunded'|'pending'|'voided'
  fulfillment_status       text,                                                     -- 'fulfilled'|'partial'|'unfulfilled'|NULL
  processed_at             timestamptz NOT NULL,
  currency                 text NOT NULL DEFAULT 'USD',
  total_amount_cents       bigint NOT NULL,
  subtotal_amount_cents    bigint NOT NULL,
  tax_amount_cents         bigint NOT NULL DEFAULT 0,
  shipping_amount_cents    bigint NOT NULL DEFAULT 0,
  discount_amount_cents    bigint NOT NULL DEFAULT 0,
  payment_gateway          text,
  discount_codes           jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer_id              uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_email           text,
  ar_invoice_id            uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload              jsonb NOT NULL,
  source                   text NOT NULL DEFAULT 'shopify' CHECK (source IN ('shopify')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_orders_dedup UNIQUE (shopify_store_id, shopify_order_id)
);

CREATE INDEX IF NOT EXISTS shopify_orders_entity_processed_idx
  ON shopify_orders (entity_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS shopify_orders_store_processed_idx
  ON shopify_orders (shopify_store_id, processed_at DESC);

COMMENT ON TABLE shopify_orders IS 'P11-1: Shopify orders materialized from webhooks + backfill. UNIQUE (shopify_store_id, shopify_order_id) makes re-ingestion idempotent. ar_invoice_id + je_id populated by P11-3 posting service.';
COMMENT ON COLUMN shopify_orders.source IS 'Always shopify; the per-store split lives in shopify_store_id (D4).';

-- ─── 3. shopify_order_lines ───────────────────────────────────────────────
--
-- Line-level breakdown for the order. ip_item_master_id resolved by SKU
-- match at posting time (NULL when SKU is unknown / new variant not yet
-- in PIM). UNIQUE (shopify_order_id, line_number) so backfill replay is
-- idempotent.

CREATE TABLE IF NOT EXISTS shopify_order_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id         uuid NOT NULL REFERENCES shopify_orders(id) ON DELETE CASCADE,
  line_number              int NOT NULL,
  shopify_line_id          text NOT NULL,
  sku                      text,
  ip_item_master_id        uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  title                    text NOT NULL,
  quantity                 int NOT NULL,
  unit_price_cents         bigint NOT NULL,
  line_total_cents         bigint NOT NULL,
  line_tax_cents           bigint NOT NULL DEFAULT 0,
  line_discount_cents      bigint NOT NULL DEFAULT 0,
  raw_payload              jsonb NOT NULL,
  CONSTRAINT shopify_order_lines_dedup UNIQUE (shopify_order_id, line_number)
);

CREATE INDEX IF NOT EXISTS shopify_order_lines_order_idx
  ON shopify_order_lines (shopify_order_id);
CREATE INDEX IF NOT EXISTS shopify_order_lines_sku_idx
  ON shopify_order_lines (sku)
  WHERE sku IS NOT NULL;

COMMENT ON TABLE shopify_order_lines IS 'P11-1: per-line breakdown of a Shopify order. CASCADE on parent delete; UNIQUE (shopify_order_id, line_number) for idempotent replay.';

-- ─── 4. shopify_refunds ───────────────────────────────────────────────────
--
-- D7: full refund void-equivalent (handled via P4 void path, populates
-- the je_id with the reversal); partial refund creates a sibling AR
-- credit memo (ar_credit_memo_id) for the refunded amount with
-- proportional COGS reverse + optional restocking fee line.

CREATE TABLE IF NOT EXISTS shopify_refunds (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_order_id         uuid NOT NULL REFERENCES shopify_orders(id) ON DELETE RESTRICT,
  shopify_refund_id        text NOT NULL,
  refund_type              text NOT NULL CHECK (refund_type IN ('full','partial')),
  refund_amount_cents      bigint NOT NULL,
  restocking_fee_cents     bigint NOT NULL DEFAULT 0,
  processed_at             timestamptz NOT NULL,
  ar_credit_memo_id        uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,        -- sibling for partial (D7)
  je_id                    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload              jsonb NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_refunds_dedup UNIQUE (shopify_order_id, shopify_refund_id)
);

CREATE INDEX IF NOT EXISTS shopify_refunds_entity_processed_idx
  ON shopify_refunds (entity_id, processed_at DESC);

COMMENT ON TABLE shopify_refunds IS 'P11-1: Shopify refunds. refund_type=full → P4 void of original ar_invoice; refund_type=partial → ar_credit_memo_id points to the sibling AR credit memo (D7). restocking_fee_cents posts to 4500 Restocking Fee Income (D8).';

-- ─── 5. shopify_payouts ───────────────────────────────────────────────────
--
-- For D6 reconciliation: Shopify Payments deposits the *net* amount (after
-- 2.9% + 30¢ per txn). The payout webhook + daily cron populate this
-- table; the P6 bank-recon match engine joins on amount + date to set
-- bank_transaction_id, then the matcher posts the JE that clears the
-- 1110 Payment Processor Clearing account against 1100 Bank.

CREATE TABLE IF NOT EXISTS shopify_payouts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id         uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_payout_id        text NOT NULL,
  payout_date              date NOT NULL,
  gross_amount_cents       bigint NOT NULL,
  fees_amount_cents        bigint NOT NULL,
  net_amount_cents         bigint NOT NULL,
  currency                 text NOT NULL DEFAULT 'USD',
  bank_transaction_id      uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  je_id                    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload              jsonb NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_payouts_dedup UNIQUE (shopify_store_id, shopify_payout_id)
);

CREATE INDEX IF NOT EXISTS shopify_payouts_entity_date_idx
  ON shopify_payouts (entity_id, payout_date DESC);
CREATE INDEX IF NOT EXISTS shopify_payouts_store_date_idx
  ON shopify_payouts (shopify_store_id, payout_date DESC);

COMMENT ON TABLE shopify_payouts IS 'P11-1: Shopify Payments payouts. gross - fees = net (matches bank deposit). bank_transaction_id linked by P6 bank-recon match engine; je_id posted by the matcher to clear 1110 Payment Processor Clearing against 1100 Bank (D6).';

-- ─── 6. shopify_webhook_log ───────────────────────────────────────────────
--
-- At-least-once webhook delivery dedup. UNIQUE on the X-Shopify-Webhook-Id
-- header so a re-delivered webhook is detected as a duplicate and skipped
-- (status='skipped_duplicate'). NOT entity-scoped — RLS uses anon-only
-- (the webhook intake handler is service-role).

CREATE TABLE IF NOT EXISTS shopify_webhook_log (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_store_id         uuid REFERENCES shopify_stores(id) ON DELETE SET NULL,
  webhook_id               text NOT NULL,                                            -- X-Shopify-Webhook-Id
  topic                    text NOT NULL,
  received_at              timestamptz NOT NULL DEFAULT now(),
  processed_at             timestamptz,
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','processed','failed','skipped_duplicate')),
  error_message            text,
  raw_payload              jsonb NOT NULL,
  CONSTRAINT shopify_webhook_log_dedup UNIQUE (webhook_id)
);

CREATE INDEX IF NOT EXISTS shopify_webhook_log_status_received_idx
  ON shopify_webhook_log (status, received_at DESC);
CREATE INDEX IF NOT EXISTS shopify_webhook_log_store_received_idx
  ON shopify_webhook_log (shopify_store_id, received_at DESC)
  WHERE shopify_store_id IS NOT NULL;

COMMENT ON TABLE shopify_webhook_log IS 'P11-1: webhook idempotency log. UNIQUE on webhook_id (X-Shopify-Webhook-Id header) detects re-deliveries → status=skipped_duplicate. status=pending until processed by the intake handler.';

-- ─── 7. Seed new GL accounts (D6, D8, D9) ─────────────────────────────────
--
-- D8: 4500 Restocking Fee Income (NEW — first time seeded).
-- D6 + D9: 1110 / 6510 / 6610 already seeded by P7-1; INSERT…ON CONFLICT
-- DO NOTHING here as a belt-and-suspenders guard. Single-tenant ROF
-- seed for the P11 chunk; future tenants seed their own COA via the
-- standard P3 bootstrap.

DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping P11-1 GL account seed; rerun once entity exists';
    RETURN;
  END IF;

  -- 4500 Restocking Fee Income (D8) — NEW
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '4500', 'Restocking Fee Income', 'revenue', 'CREDIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;

  -- 6510 Merchant Fees (D6) — already seeded by P7-1, idempotent guard
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '6510', 'Merchant Fees', 'expense', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;

  -- 6610 Chargeback Expense (D9) — already seeded by P7-1, idempotent guard
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '6610', 'Chargeback Expense', 'expense', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;

  -- 1110 Payment Processor Clearing (D6) — already seeded by P7-1, idempotent guard
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '1110', 'Payment Processor Clearing', 'asset', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

-- ─── 8. Extend inventory_layers.source_kind CHECK (D7 partial-refund restock) ──
--
-- D7 partial refunds may restock returned inventory. T10-1 already
-- extended the enum with 'xoro_mirror_snapshot'; we union 'shopify_refund_restock'
-- onto that set. Drop + recreate the CHECK additively (preserves all
-- existing values).

ALTER TABLE inventory_layers
  DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check;

ALTER TABLE inventory_layers
  ADD CONSTRAINT inventory_layers_source_kind_check
    CHECK (source_kind IN (
      'ap_invoice',
      'adjustment',
      'opening_balance',
      'transfer_in',
      'credit_memo_return',
      'xoro_mirror_snapshot',
      'shopify_refund_restock'
    ));

CREATE INDEX IF NOT EXISTS idx_inventory_layers_shopify_refund_restock
  ON inventory_layers (entity_id, source_kind)
  WHERE source_kind = 'shopify_refund_restock';

COMMENT ON COLUMN inventory_layers.source_kind IS 'P11-1 added shopify_refund_restock value (D7 partial-refund inventory restoration). T10-1 added xoro_mirror_snapshot. P4-2 added credit_memo_return. P3-3 original set: ap_invoice / adjustment / opening_balance / transfer_in.';

-- ─── 9. RLS — anon_all_* + auth_internal_* template ───────────────────────
--
-- Five entity-scoped tables follow the standard P1 template (anon_all_*
-- for the service-role / anon-key API surface; auth_internal_* scoped
-- to entity_users via auth.uid()).
--
-- shopify_webhook_log gets anon_all_* only (not entity-scoped — it's
-- a global webhook intake log; the intake handler is service-role).

ALTER TABLE shopify_stores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_order_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_refunds      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_payouts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_webhook_log  ENABLE ROW LEVEL SECURITY;

-- shopify_stores
DO $$ BEGIN
  CREATE POLICY "anon_all_shopify_stores" ON shopify_stores
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_shopify_stores" ON shopify_stores
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- shopify_orders
DO $$ BEGIN
  CREATE POLICY "anon_all_shopify_orders" ON shopify_orders
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_shopify_orders" ON shopify_orders
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- shopify_order_lines — not entity-scoped directly; gated via parent
DO $$ BEGIN
  CREATE POLICY "anon_all_shopify_order_lines" ON shopify_order_lines
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_shopify_order_lines" ON shopify_order_lines
    FOR ALL TO authenticated
    USING      (shopify_order_id IN (
                  SELECT so.id FROM shopify_orders so
                  WHERE so.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (shopify_order_id IN (
                  SELECT so.id FROM shopify_orders so
                  WHERE so.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- shopify_refunds
DO $$ BEGIN
  CREATE POLICY "anon_all_shopify_refunds" ON shopify_refunds
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_shopify_refunds" ON shopify_refunds
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- shopify_payouts
DO $$ BEGIN
  CREATE POLICY "anon_all_shopify_payouts" ON shopify_payouts
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_shopify_payouts" ON shopify_payouts
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- shopify_webhook_log — anon-only (global intake log; service-role writes)
DO $$ BEGIN
  CREATE POLICY "anon_all_shopify_webhook_log" ON shopify_webhook_log
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 10. PostgREST schema cache reload ────────────────────────────────────
NOTIFY pgrst, 'reload schema';
