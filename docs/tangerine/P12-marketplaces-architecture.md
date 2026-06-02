# Tangerine P12 — Marketplaces Architecture Pass (Amazon FBA / Walmart / Faire)

Status: **DRAFT** (2026-05-28). Operator review gate before implementation chunks kick off. Auto-merges on CI green per the standing plan-approval-not-implementation rule.

Implements **M45 Marketplaces** from the roadmap as three coordinated sub-phases:

- **P12a — M48 Amazon FBA** (Fulfilled-by-Amazon: operator ships into Amazon FCs, Amazon ships to consumer + handles returns + remits net of fees every ~14 days)
- **P12b — M49 Walmart Marketplace** (Walmart's 3P seller channel; weekly settlement)
- **P12c — M50 Faire** (wholesale marketplace; Faire holds payment + remits monthly net of 15-25% commission)

P12 is the multi-channel follow-up to [P11 Shopify](P11-shopify-architecture.md). The shapes recur — orders + payouts + fees + refunds + chargebacks, plus webhook/poll ingest + a backfill cron + a per-channel `source` tag. **Re-uses every pattern P11 established**: per-platform credentials encrypted with AES-256-GCM, per-store GL account mapping, payout-to-bank-txn reconciliation against P6, manual-fallback path on every channel, T10 source-tag enforcement.

The strategic frame (operator 2026-05-28): *"shopify transactions need to fully reconcile including all costs and returns as well as other sales channels such as amazon fba, walmart and others."* P11 reconciles Shopify. P12 does the same for the next three channels — cutting Xoro out of each.

---

## 0. Scope guardrails

**In scope — full marketplace reconciliation across three channels:**

- **Order ingestion** — every FBA / Walmart / Faire order becomes an `ar_invoices` row + lines, with revenue + shipping income + sales tax + discounts + commission/fee lines posted to the right GL accounts.
- **Settlement reconciliation** — each platform's payout / settlement report is mirrored into Tangerine; net deposits matched against `bank_transactions` (P6) by amount + date with channel-specific tolerances.
- **Fee decomposition** — FBA fees (fulfillment + storage + referral + sponsored ads + removal), Walmart commissions, Faire commissions — each split into its own GL line per the D-decisions below.
- **Returns mirror** — FBA customer returns (Amazon decides resell/destroy/dispose), Walmart returns, Faire wholesale credit memos. COGS reversal + inventory restock where the platform indicates resellable status.
- **Multi-location inventory (FBA + WFS)** — Amazon and Walmart hold physical inventory on the operator's behalf. Tangerine `inventory_layers` gains a `location_id` dimension (new `inventory_locations` table) so we can answer "how many units in the operator's own warehouse vs in FBA inbound vs in FBA fulfillable vs in WFS."
- **Marketplace facilitator tax handling** — Amazon, Walmart, and most U.S. Faire wholesale orders are collected-and-remitted by the platform. Tangerine records the gross + the platform-collected tax as memo-only (does NOT credit `2200 Sales Tax Payable` for facilitator tax).
- **Chargebacks + A-to-Z claims (FBA)** — auto-create Case (M47) + reverse AR + post chargeback expense, reusing the P7-9 + P11 pattern.
- **Wholesale buyer mapping (Faire)** — Faire buyers are retailers (often net-new customer master rows). New extension on `customers` for marketplace-buyer linkage.
- **Per-channel backfill cron** matched to platform payout rhythm (FBA every 6h for orders, daily for settlements; Walmart every 6h orders + weekly for reports; Faire every 12h for orders + daily for payouts).
- **Manual fallback** — operator can always type an FBA / Walmart / Faire-style order in the AR Invoices panel with `source='manual'`. The marketplace mirror never touches `source='manual'` rows. Per standing principle.

**Explicitly OUT of scope (deferred):**

- **eBay, TikTok Shop, Etsy, Mercado Libre, Temu, any other channel** — easy to add later by cloning the P12a/b/c template once the v1 schema is proven. Not in this phase.
- **FBM (Fulfilled-by-Merchant) Amazon orders** — fold into M13 3PL / P21; the operator's seller-fulfilled volume is negligible. Schema is forward-compatible.
- **Amazon Brand Registry / IP enforcement / A+ content** — read-only PIM-ish data; punt to M42 PIM v2.
- **Walmart Connect (Walmart Sponsored Search)** — included for media-cost ingest but campaign management stays in the Walmart Connect UI.
- **Faire Direct (wholesale-direct-from-brand site)** — separate Faire product; not in v1.
- **Faire Insider / Faire Plus subscription billing** — operator-side expense, not revenue. Manual AP bill in P3 handles it.
- **Inventory push from Tangerine → FBA / WFS** — receiving + inbound shipment plans live in P13 + P21; v1 is read-only mirror.
- **Multi-currency** — single USD per locked decision (carries from P11).
- **Sandbox harness** — each platform has a sandbox; documented in §8, but not built as ongoing test infrastructure.

---

## 1. Existing state (one-paragraph map)

After P1-P8 + T10 Shadow Mirror + P11 Shopify (in flight): Tangerine has the full financial layer, CRM, PIM, Cases, sales reps, and a working pattern for direct-platform-API integration (Shopify). **FBA, Walmart, and Faire are currently ingested via Xoro's connectors** — orders flow to Xoro (which creates the AR invoice + COGS), and Xoro flows to Tangerine via the nightly fetch with `source='xoro_mirror'`. That works but: (a) it's a day-delayed via Xoro, (b) Xoro flattens platform-specific fee detail (FBA's 5+ fee categories collapse to one line, Walmart commissions buried in revenue net, Faire's 15%-vs-25% new-buyer surcharge is invisible), (c) returns + A-to-Z claims + chargebacks don't make it through with platform context, (d) settlement variance is impossible to investigate because the underlying settlement reports aren't in Tangerine. P12 cuts Xoro out of these three channels — Tangerine talks directly to SP-API, Walmart Marketplace API, and Faire API; rows arrive tagged as `source='fba'`, `source='walmart'`, `source='faire'`.

---

## 2. Decisions (DRAFT — operator to confirm)

| # | Decision | Recommendation | Why | Operator confirm? |
|---|---|---|---|---|
| D1 | Number of seller accounts per channel | **Configurable per channel — `fba_seller_accounts`, `walmart_seller_accounts`, `faire_shops` tables; start with what operator has (likely 1 each)** | Multi-account is essentially free with the right schema (multiple Amazon accounts across NA/EU marketplaces is plausible; multiple Faire shops if brand splits exist). | ☐ |
| D2 | Source tag granularity | **Per-channel: `source='fba'`, `source='walmart'`, `source='faire'`** (NOT a single `source='marketplace'` with a platform discriminator column) | Filter-UI grain matches operator's mental model ("show me Faire orders"). Per-channel analytics work without a join. The `source` enum on T10 already reserves these three values — no migration. Aligns with P11's D4 (`source='shopify'`). | ☐ |
| D3 | Auth model | **Per platform — fixed by platform; document but no decision: FBA = LWA OAuth + AWS Sigv4 + SP-API; Walmart = client_credentials OAuth; Faire = static API key** | Each platform locks the auth model; no choice. Credentials encrypted at rest with AES-256-GCM under per-channel KMS keys, same pattern as P11 `SHOPIFY_TOKEN_ENC_KEY`. | ☐ |
| D4 | FBA fee decomposition | **Split into 4 GL lines per order:** `6520 Marketplace Fees` (referral % — variable per category) + `6521 Sponsored Ads` (PPC/DSP) + `6522 Storage Fees` (monthly + LTSF) + `6523 FBA Fulfillment Fees` (pick/pack/ship per unit). Removal fees → `6524 Marketplace Removal Fees`. | Auditor-friendly P&L. Operator can see "FBA fulfillment is eating margin" vs "Sponsored Ads is eating margin" without spreadsheet work. Aligns with the P11 D6 per-fee-type pattern. | ☐ |
| D5 | Walmart fee decomposition | **Split into 2 GL lines per order:** `6520 Marketplace Fees` (Walmart commission — usually 6-15% by category) + `6525 WFS Fulfillment Fees` (only if WFS-fulfilled). Walmart Connect ad spend → `6521 Sponsored Ads` shared with FBA. | Same rationale as D4; Walmart's fee shape is simpler so 2 lines suffice. | ☐ |
| D6 | Faire fee decomposition | **Single GL line per order:** `6520 Marketplace Fees` with a numeric `commission_rate_pct` column on `faire_order_items` for the 25%-new vs 15%-recurring split. Track it in-row, not in COA. | Faire's commission is one charge per order line; splitting "new buyer" vs "recurring" into two COA accounts would clutter without analytic value. Operator filters by `commission_rate_pct` in the panel. | ☐ |
| D7 | Sponsored Ads / DSP charges (FBA + Walmart Connect) | **`6521 Sponsored Ads`** (new operating expense, not netted against revenue) | Operator can drill "Sponsored Ads spend by month by channel" easily. Tax-deductible as advertising expense, not a contra-revenue. | ☐ |
| D8 | Marketplace facilitator sales tax | **Record platform-collected tax as memo only — do NOT credit `2200 Sales Tax Payable`. Stored on `*_orders.facilitator_tax_cents` for traceability + reporting + state nexus support.** | Amazon, Walmart, and most U.S. Faire orders are marketplace-facilitator-collected-and-remitted. Crediting `2200` would double-count vs Tangerine's own state remittance (which is zero for facilitator-handled states). Faire wholesale orders to retailers in non-collected states (rare) → operator manually flags + we credit `2200`. | ☐ |
| D9 | Settlement timing — cron cadence | **Per-channel matched to payout rhythm: FBA orders 6h + settlements daily; Walmart orders 6h + reports daily (pulls weekly Settlement Report when ready); Faire orders 12h + payouts daily** | Polling matches platform payout cycles. FBA pays every 14d, Walmart weekly, Faire monthly — but the underlying transaction reports update daily on each. | ☐ |
| D10 | FBA returns | **Mirror `returnRequests` into `fba_returns`; on `Resellable` disposition restock to FBA layer + reverse COGS; on `Unsellable/Damaged/CustomerDamaged` mark layer write-off (DR `6420 Inventory Write-off`, CR `1300 Inventory Asset`).** Amazon removal fees post to `6524 Marketplace Removal Fees`. | Matches the operator's economic reality — Amazon makes the resell/destroy call; we just record their decision. Removal fees are real cash out. | ☐ |
| D11 | Walmart returns | **Mirror `return_orders` from order-events stream; same disposition logic as FBA for WFS; for seller-fulfilled returns, operator approves restock in panel.** | Walmart returns flow back to seller for FBM orders; WFS returns work like FBA. Mixed flow needs the operator-in-the-loop branch. | ☐ |
| D12 | Faire returns | **Wholesale credit memo via existing P11 sibling-AR-credit pattern (`invoice_kind='customer_credit_memo'`).** Faire credit-memo events → create Tangerine credit memo + reverse COGS + restock to operator's own warehouse (Faire ships from operator's WH, not Faire's). | Faire is wholesale-style; credit memos are the right primitive. Reuses P11 D7. | ☐ |
| D13 | FBA inventory mirror | **YES — pull `/fba/inventory/v1/summaries` daily and rebuild `inventory_layers` where `location_id = <FBA location row>`. Drop-and-rebuild scoped to `source='fba'` rows only (same idempotent pattern as T10-4).** | FBA holds physical units. Without this mirror, Tangerine's on-hand totals are wrong — operator can't answer "how much of SKU X is sellable right now across all locations?" Layer-age detail is lost in mirror mode (single layer per SKU per location); acceptable for v1. | ☐ |
| D14 | Walmart inventory mirror (WFS) | **YES if WFS in use** — same mechanism as D13 against Walmart's `Inventory Feed` report. Detect WFS-vs-FBM per order from order payload; only WFS items get an inventory layer outside operator's WH. | Operator may not be on WFS today; if so, schema is in place and the WFS poller stays disabled until enabled in `walmart_seller_accounts.wfs_enabled=true`. | ☐ |
| D15 | Faire inventory | **NO remote inventory mirror — operator ships every Faire order from their own warehouse. Faire orders consume layers from `location_id = <Main WH>` only.** | Confirmed in scope discussion: Faire is dropship-style from operator's side. No location proliferation. | ☐ |
| D16 | Per-payout reconciliation report + variance threshold | **Variance threshold = $5 per payout per channel. Beyond → emit `marketplace_payout_unmatched` notification + park in unmatched-deposits inbox.** Same shape as P11 D10 (payout-to-bank-txn match) + P9 D2 (parallel-run variance gate). | $5 covers rounding noise and one-off carrier-correction line items. Wider thresholds risk hiding real settlement bugs (especially FBA fee changes Amazon pushes mid-month). | ☐ |
| D17 | Period close pre-flight | **Extend P5-7 pre-flight to flag any of: unmatched marketplace deposit > 7 days old, unposted FBA settlement, Faire payout received but not yet allocated to orders.** Blocks close until resolved or explicitly waived by operator. | Mirrors P5-7's existing bank-rec-must-be-clean gate. Marketplaces are the same risk class. | ☐ |
| D18 | Tangerine ⇄ Xoro marketplace ingestion cutover | **Per channel, post-4-week parallel run with variance < $5/payout, flip Xoro's connector off for THAT channel. Other channels keep running in parallel until each independently passes.** | Matches P11 D12. Per-channel cutover (not all-three-at-once) lets the operator fail one and keep the others. Strictly safer. | ☐ |

---

## 3. Schema additions

Three new sub-modules, each modeled on the P11 Shopify schema. Plus shared cross-channel extensions for inventory locations + GL accounts + customer-buyer mapping.

### 3.1 Shared — `inventory_locations` (new) + `inventory_layers.location_id`

Currently `inventory_layers` (P3-3) has no location dimension — all layers assumed to be in the operator's single warehouse. FBA + WFS break that assumption.

```sql
CREATE TABLE IF NOT EXISTS inventory_locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code            text NOT NULL,                              -- 'WH-MAIN', 'FBA-NA', 'FBA-EU', 'WFS', 'IN-TRANSIT'
  name            text NOT NULL,
  location_kind   text NOT NULL CHECK (location_kind IN ('warehouse','fba','wfs','in_transit','virtual')),
  is_default      boolean NOT NULL DEFAULT false,             -- exactly one per entity for backward compat
  is_active       boolean NOT NULL DEFAULT true,
  marketplace_seller_account_id uuid,                         -- nullable FK resolved at runtime per kind
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_locations_code_per_entity UNIQUE (entity_id, code)
);

ALTER TABLE inventory_layers
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES inventory_locations(id) ON DELETE RESTRICT;

-- Backfill existing layers to the default location, then enforce NOT NULL
UPDATE inventory_layers il
  SET location_id = (SELECT id FROM inventory_locations
                     WHERE entity_id = il.entity_id AND is_default = true LIMIT 1)
  WHERE location_id IS NULL;

ALTER TABLE inventory_layers ALTER COLUMN location_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_layers_location ON inventory_layers (location_id, item_id);
```

Migration sequence: seed one `'WH-MAIN'` location per entity with `is_default=true`, backfill, then enforce NOT NULL. Every existing FIFO query has to either filter by location_id or aggregate explicitly — listed as a §8 migration risk.

Also extend `inventory_layers.source_kind` to accept `'fba_snapshot'`, `'walmart_snapshot'`, and the existing `'xoro_mirror_snapshot'`:

```sql
ALTER TABLE inventory_layers DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check;
ALTER TABLE inventory_layers ADD CONSTRAINT inventory_layers_source_kind_check
  CHECK (source_kind IN ('ap_invoice','adjustment','opening_balance','transfer_in',
                         'credit_memo_return','xoro_mirror_snapshot',
                         'fba_snapshot','walmart_snapshot'));
```

### 3.2 Shared — `customers` extension for marketplace-buyer mapping

Faire (and to a lesser extent Amazon Business / Walmart Business) bring buyers that need to round-trip as `customers` rows for AR + CRM purposes. Add:

```sql
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketplace_buyer_refs jsonb NOT NULL DEFAULT '{}'::jsonb;
-- shape: { "faire": "buyer_abc123", "fba": "amazon_buyer_xyz", "walmart": "walmart_buyer_q" }
CREATE INDEX IF NOT EXISTS idx_customers_marketplace_buyer_refs
  ON customers USING gin (marketplace_buyer_refs);
```

JSONB chosen over a `customer_marketplace_links` join table because (a) cardinality per customer is ≤ 3-4 platforms, (b) lookups go from platform-buyer-id → `customer_id` via a GIN-indexed `@>` query, (c) avoids a new table the operator has to think about in CRM Customer Detail. Functional pattern matches `customers.billing_address` JSONB already in place.

### 3.3 Shared — new GL accounts seeded

| Code | Name | Type | Normal | Notes |
|---|---|---|---|---|
| 1115 | Marketplace Receivable Clearing | asset | DEBIT | Per-channel clearing account; payout reconciles to bank deposit |
| 6520 | Marketplace Fees | expense | DEBIT | Referral / commission % — FBA + Walmart + Faire share this |
| 6521 | Sponsored Ads | expense | DEBIT | FBA Sponsored Products + Walmart Connect |
| 6522 | FBA Storage Fees | expense | DEBIT | Monthly + LTSF |
| 6523 | FBA Fulfillment Fees | expense | DEBIT | Per-unit pick/pack/ship |
| 6524 | Marketplace Removal Fees | expense | DEBIT | FBA removal orders |
| 6525 | WFS Fulfillment Fees | expense | DEBIT | Walmart WFS pick/pack/ship |
| 6420 | Inventory Write-off | expense | DEBIT | FBA Unsellable disposition + general |

`1110 Payment Processor Clearing`, `6610 Chargeback Expense`, `4100 Shipping Income`, `4500 Restocking Fee Income`, `2200 Sales Tax Payable` already shipped in P7-1 / P11.

### 3.4 M48 Amazon FBA — `fba_*` tables

```sql
CREATE TABLE IF NOT EXISTS fba_seller_accounts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  seller_id                   text NOT NULL,                   -- Amazon Merchant Token (A1XXXX)
  marketplace_id              text NOT NULL,                   -- ATVPDKIKX0DER (US), A2EUQ1WTGCTBG2 (CA), etc.
  region                      text NOT NULL CHECK (region IN ('NA','EU','FE')),
  account_name                text NOT NULL,                   -- 'ROF US Amazon'
  -- LWA OAuth
  lwa_refresh_token_ciphertext bytea,                          -- AES-256-GCM
  lwa_client_id               text,
  lwa_client_secret_ciphertext bytea,
  -- IAM role for SP-API (Sigv4)
  aws_role_arn                text,
  aws_access_key_id_ciphertext bytea,
  aws_secret_access_key_ciphertext bytea,
  inventory_location_id       uuid REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  -- GL account mapping per-account (defaults from entity if null)
  revenue_account_id          uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  shipping_income_account_id  uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  marketplace_fees_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  fulfillment_fees_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  storage_fees_account_id     uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  sponsored_ads_account_id    uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  removal_fees_account_id     uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  receivable_clearing_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,  -- 1115
  default_customer_id         uuid REFERENCES customers(id) ON DELETE SET NULL,       -- consumer-grain — 'Amazon Buyer' synthetic
  is_active                   boolean NOT NULL DEFAULT true,
  last_orders_updated_after   timestamptz,
  last_settlement_group_id    text,
  last_inventory_sync_at      timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fba_seller_unique UNIQUE (entity_id, seller_id, marketplace_id)
);

CREATE TABLE IF NOT EXISTS fba_orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  fba_seller_account_id    uuid NOT NULL REFERENCES fba_seller_accounts(id) ON DELETE RESTRICT,
  amazon_order_id          text NOT NULL,                            -- '111-1111111-1111111'
  marketplace_id           text NOT NULL,
  order_status             text NOT NULL,                            -- 'Pending','Unshipped','PartiallyShipped','Shipped','Canceled'
  fulfillment_channel      text NOT NULL,                            -- 'AFN' (FBA) or 'MFN' (FBM)
  buyer_email              text,
  resolved_customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  total_cents              bigint NOT NULL,
  subtotal_cents           bigint NOT NULL,
  shipping_cents           bigint NOT NULL DEFAULT 0,
  facilitator_tax_cents    bigint NOT NULL DEFAULT 0,                -- memo only — D8
  discount_cents           bigint NOT NULL DEFAULT 0,
  ordered_at               timestamptz NOT NULL,
  last_updated_at          timestamptz NOT NULL,
  ar_invoice_id            uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fba_orders_unique UNIQUE (fba_seller_account_id, amazon_order_id)
);
CREATE INDEX IF NOT EXISTS idx_fba_orders_ar ON fba_orders (ar_invoice_id) WHERE ar_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fba_orders_unsynced ON fba_orders (last_updated_at) WHERE ar_invoice_id IS NULL;

CREATE TABLE IF NOT EXISTS fba_order_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fba_order_id             uuid NOT NULL REFERENCES fba_orders(id) ON DELETE CASCADE,
  amazon_order_item_id     text NOT NULL,
  asin                     text,
  seller_sku               text,
  inventory_item_id        uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  qty                      int NOT NULL,
  unit_price_cents         bigint NOT NULL,
  shipping_cents           bigint NOT NULL DEFAULT 0,
  facilitator_tax_cents    bigint NOT NULL DEFAULT 0,
  promotion_discount_cents bigint NOT NULL DEFAULT 0,
  CONSTRAINT fba_order_items_unique UNIQUE (fba_order_id, amazon_order_item_id)
);

CREATE TABLE IF NOT EXISTS fba_settlements (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                 uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  fba_seller_account_id     uuid NOT NULL REFERENCES fba_seller_accounts(id) ON DELETE RESTRICT,
  financial_event_group_id  text NOT NULL,                            -- SP-API's group ID
  settlement_start          timestamptz NOT NULL,
  settlement_end            timestamptz NOT NULL,
  payout_date               date,
  gross_amount_cents        bigint NOT NULL,
  total_fees_cents          bigint NOT NULL,
  total_refunds_cents       bigint NOT NULL DEFAULT 0,
  total_ad_charges_cents    bigint NOT NULL DEFAULT 0,
  total_storage_fees_cents  bigint NOT NULL DEFAULT 0,
  total_other_charges_cents bigint NOT NULL DEFAULT 0,
  net_amount_cents          bigint NOT NULL,
  matched_bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  raw_payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fba_settlements_unique UNIQUE (fba_seller_account_id, financial_event_group_id)
);
CREATE INDEX IF NOT EXISTS idx_fba_settlements_unmatched
  ON fba_settlements (payout_date) WHERE matched_bank_transaction_id IS NULL;

CREATE TABLE IF NOT EXISTS fba_inventory_snapshots (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  fba_seller_account_id    uuid NOT NULL REFERENCES fba_seller_accounts(id) ON DELETE RESTRICT,
  seller_sku               text NOT NULL,
  asin                     text,
  inventory_item_id        uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  fulfillable_qty          int NOT NULL DEFAULT 0,
  inbound_working_qty      int NOT NULL DEFAULT 0,
  inbound_shipped_qty      int NOT NULL DEFAULT 0,
  inbound_receiving_qty    int NOT NULL DEFAULT 0,
  reserved_qty             int NOT NULL DEFAULT 0,
  unsellable_qty           int NOT NULL DEFAULT 0,
  snapshot_at              timestamptz NOT NULL,
  CONSTRAINT fba_inventory_snapshots_unique UNIQUE (fba_seller_account_id, seller_sku, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_fba_inv_latest
  ON fba_inventory_snapshots (fba_seller_account_id, seller_sku, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS fba_returns (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  fba_seller_account_id    uuid NOT NULL REFERENCES fba_seller_accounts(id) ON DELETE RESTRICT,
  fba_order_id             uuid REFERENCES fba_orders(id) ON DELETE SET NULL,
  amazon_return_id         text NOT NULL,
  seller_sku               text,
  inventory_item_id        uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  qty                      int NOT NULL,
  disposition              text NOT NULL,                            -- 'Resellable','Unsellable','CustomerDamaged','Defective'
  reason                   text,
  return_date              timestamptz NOT NULL,
  credit_memo_invoice_id   uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  raw_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fba_returns_unique UNIQUE (fba_seller_account_id, amazon_return_id)
);
```

### 3.5 M49 Walmart Marketplace — `walmart_*` tables

Same shape as FBA, simpler fee model.

```sql
CREATE TABLE IF NOT EXISTS walmart_seller_accounts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  walmart_seller_id           text NOT NULL,
  account_name                text NOT NULL,
  client_id_ciphertext        bytea,                              -- AES-256-GCM
  client_secret_ciphertext    bytea,
  wfs_enabled                 boolean NOT NULL DEFAULT false,
  inventory_location_id       uuid REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  revenue_account_id          uuid REFERENCES gl_accounts(id),
  shipping_income_account_id  uuid REFERENCES gl_accounts(id),
  marketplace_fees_account_id uuid REFERENCES gl_accounts(id),
  wfs_fees_account_id         uuid REFERENCES gl_accounts(id),
  sponsored_ads_account_id    uuid REFERENCES gl_accounts(id),
  receivable_clearing_account_id uuid REFERENCES gl_accounts(id),
  default_customer_id         uuid REFERENCES customers(id) ON DELETE SET NULL,
  is_active                   boolean NOT NULL DEFAULT true,
  last_orders_updated_after   timestamptz,
  last_report_id              text,
  last_inventory_sync_at      timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walmart_seller_unique UNIQUE (entity_id, walmart_seller_id)
);

CREATE TABLE IF NOT EXISTS walmart_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id               uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  walmart_seller_account_id uuid NOT NULL REFERENCES walmart_seller_accounts(id) ON DELETE RESTRICT,
  purchase_order_id       text NOT NULL,                           -- Walmart's PO# (their order identifier)
  customer_order_id       text,
  order_status            text NOT NULL,                           -- 'Created','Acknowledged','Shipped','Delivered','Cancelled'
  fulfillment_type        text NOT NULL CHECK (fulfillment_type IN ('seller','wfs')),
  buyer_email             text,
  resolved_customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  total_cents             bigint NOT NULL,
  subtotal_cents          bigint NOT NULL,
  shipping_cents          bigint NOT NULL DEFAULT 0,
  facilitator_tax_cents   bigint NOT NULL DEFAULT 0,
  ordered_at              timestamptz NOT NULL,
  last_updated_at         timestamptz NOT NULL,
  ar_invoice_id           uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                   uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walmart_orders_unique UNIQUE (walmart_seller_account_id, purchase_order_id)
);

CREATE TABLE IF NOT EXISTS walmart_order_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  walmart_order_id         uuid NOT NULL REFERENCES walmart_orders(id) ON DELETE CASCADE,
  walmart_line_number      text NOT NULL,
  walmart_item_sku         text,
  inventory_item_id        uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  qty                      int NOT NULL,
  unit_price_cents         bigint NOT NULL,
  shipping_cents           bigint NOT NULL DEFAULT 0,
  facilitator_tax_cents    bigint NOT NULL DEFAULT 0,
  commission_cents         bigint NOT NULL DEFAULT 0,
  CONSTRAINT walmart_order_items_unique UNIQUE (walmart_order_id, walmart_line_number)
);

CREATE TABLE IF NOT EXISTS walmart_settlements (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                 uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  walmart_seller_account_id uuid NOT NULL REFERENCES walmart_seller_accounts(id) ON DELETE RESTRICT,
  report_id                 text NOT NULL,
  settlement_start          timestamptz NOT NULL,
  settlement_end            timestamptz NOT NULL,
  payout_date               date,
  gross_amount_cents        bigint NOT NULL,
  commission_cents          bigint NOT NULL,
  wfs_fees_cents            bigint NOT NULL DEFAULT 0,
  refunds_cents             bigint NOT NULL DEFAULT 0,
  net_amount_cents          bigint NOT NULL,
  matched_bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  raw_payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walmart_settlements_unique UNIQUE (walmart_seller_account_id, report_id)
);

CREATE TABLE IF NOT EXISTS walmart_returns (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  walmart_seller_account_id uuid NOT NULL REFERENCES walmart_seller_accounts(id) ON DELETE RESTRICT,
  walmart_order_id         uuid REFERENCES walmart_orders(id) ON DELETE SET NULL,
  return_order_id          text NOT NULL,
  qty                      int NOT NULL,
  disposition              text,                                  -- analogous to FBA
  reason                   text,
  return_date              timestamptz NOT NULL,
  credit_memo_invoice_id   uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  raw_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT walmart_returns_unique UNIQUE (walmart_seller_account_id, return_order_id)
);
```

### 3.6 M50 Faire — `faire_*` tables

Faire is wholesale-shaped. Buyers are retail customers (round-tripped to `customers`), payouts are monthly, commission split is in-row.

```sql
CREATE TABLE IF NOT EXISTS faire_shops (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  faire_brand_id              text NOT NULL,
  shop_name                   text NOT NULL,
  api_key_ciphertext          bytea,                              -- AES-256-GCM
  inventory_location_id       uuid REFERENCES inventory_locations(id) ON DELETE RESTRICT,  -- always operator's main WH (D15)
  revenue_account_id          uuid REFERENCES gl_accounts(id),
  shipping_income_account_id  uuid REFERENCES gl_accounts(id),
  marketplace_fees_account_id uuid REFERENCES gl_accounts(id),
  receivable_clearing_account_id uuid REFERENCES gl_accounts(id),
  is_active                   boolean NOT NULL DEFAULT true,
  last_orders_updated_after   timestamptz,
  last_payout_id              text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faire_shops_unique UNIQUE (entity_id, faire_brand_id)
);

CREATE TABLE IF NOT EXISTS faire_buyers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  faire_shop_id       uuid NOT NULL REFERENCES faire_shops(id) ON DELETE RESTRICT,
  faire_buyer_id      text NOT NULL,
  store_name          text,
  buyer_email         text,
  resolved_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  first_order_at      timestamptz,
  last_order_at       timestamptz,
  total_orders        int NOT NULL DEFAULT 0,
  raw_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faire_buyers_unique UNIQUE (faire_shop_id, faire_buyer_id)
);

CREATE TABLE IF NOT EXISTS faire_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id               uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  faire_shop_id           uuid NOT NULL REFERENCES faire_shops(id) ON DELETE RESTRICT,
  faire_order_id          text NOT NULL,
  faire_buyer_id          uuid REFERENCES faire_buyers(id) ON DELETE SET NULL,
  resolved_customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  order_status            text NOT NULL,                           -- 'NEW','PROCESSING','PRE_TRANSIT','IN_TRANSIT','DELIVERED','CANCELED','BACKORDERED'
  is_first_order          boolean NOT NULL DEFAULT false,          -- drives 25% vs 15% commission
  total_cents             bigint NOT NULL,
  subtotal_cents          bigint NOT NULL,
  shipping_cents          bigint NOT NULL DEFAULT 0,
  commission_cents        bigint NOT NULL,
  commission_rate_pct     numeric(5,2) NOT NULL,                   -- 25.00 or 15.00 typically
  net_payable_cents       bigint NOT NULL,                         -- what Faire will pay out
  ordered_at              timestamptz NOT NULL,
  ar_invoice_id           uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  je_id                   uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  raw_payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faire_orders_unique UNIQUE (faire_shop_id, faire_order_id)
);

CREATE TABLE IF NOT EXISTS faire_order_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faire_order_id           uuid NOT NULL REFERENCES faire_orders(id) ON DELETE CASCADE,
  faire_item_id            text NOT NULL,
  faire_sku                text,
  inventory_item_id        uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  qty                      int NOT NULL,
  wholesale_unit_price_cents bigint NOT NULL,
  commission_cents         bigint NOT NULL,
  CONSTRAINT faire_order_items_unique UNIQUE (faire_order_id, faire_item_id)
);

CREATE TABLE IF NOT EXISTS faire_payouts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  faire_shop_id            uuid NOT NULL REFERENCES faire_shops(id) ON DELETE RESTRICT,
  faire_payout_id          text NOT NULL,
  payout_date              date NOT NULL,
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  gross_amount_cents       bigint NOT NULL,
  commission_cents         bigint NOT NULL,
  adjustments_cents        bigint NOT NULL DEFAULT 0,
  net_amount_cents         bigint NOT NULL,
  matched_bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  raw_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faire_payouts_unique UNIQUE (faire_shop_id, faire_payout_id)
);
```

---

## 4. API integration shapes per channel

### 4.1 Amazon SP-API (FBA)

- **Auth:** Login With Amazon (LWA) refresh-token grant → access token; every request signed with AWS Sigv4 against the IAM role; per-region endpoint host (`sellingpartnerapi-na.amazon.com` etc.). The LWA refresh + AWS Sigv4 + region triple is what makes FBA's auth notably more complex than Walmart's or Faire's.
- **Orders:** `GET /orders/v0/orders?LastUpdatedAfter=<iso>&MarketplaceIds=<csv>` → paginated by `NextToken`. Items via `GET /orders/v0/orders/{orderId}/orderItems`.
- **Settlements:** `GET /finances/v0/financialEventGroups?FinancialEventGroupStartedAfter=<iso>` → for each group, `GET /finances/v0/financialEventGroups/{id}/financialEvents` → walks `ShipmentEventList`, `RefundEventList`, `ServiceFeeEventList`, `SellerDealPaymentEventList`, etc. The settlement is the source-of-truth for fee breakdown; orders are the source of truth for revenue.
- **Inventory:** `GET /fba/inventory/v1/summaries?granularityType=Marketplace&marketplaceIds=<csv>` → paginated.
- **Returns:** SP-API does not expose a clean returns endpoint at all sellers' tier. Use `GET /reports/2021-06-30/reports` for `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` (a Reports API call that schedules a report → polls for completion → downloads CSV). Async. The `fba_returns` table is populated by the report-poller cron rather than direct API.
- **Webhooks:** SP-API offers limited push notifications (`ORDER_CHANGE`, `ORDER_STATUS_CHANGE`) via Amazon EventBridge. **v1 of P12a does not subscribe** — polling at 6h is sufficient and skips EventBridge setup. Future v2 can add EventBridge for sub-minute order recognition.
- **Rate limits — BRUTAL:** SP-API throttles by endpoint:
  - `getOrders` — 0.0167 req/sec (~1/min) + burst 20
  - `getOrderItems` — 0.5 req/sec + burst 30
  - `getFinancialEventGroups` — 0.5 req/sec + burst 30
  - `getInventorySummaries` — 2 req/sec + burst 2
  - Reports API submit — 0.0167 req/sec + burst 15
  - The orders + reports endpoints are the painful ones. The order-poller cron must sleep between pages; the reports cron submits-and-polls async. Implemented via a token-bucket helper `api/_lib/sp-api/throttle.js`.
- **Idempotency:** `(seller_account_id, amazon_order_id)` UNIQUE handles re-poll; settlement events idempotent on `(seller_account_id, financial_event_group_id)`.
- **Pagination:** opaque `NextToken` cursor — store last token in `fba_seller_accounts.last_orders_updated_after`.
- **Sandbox:** SP-API offers a sandbox environment with mocked endpoints (`sandbox.sellingpartnerapi-na.amazon.com`). Switching via env-var `FBA_SP_API_HOST` per account.

### 4.2 Walmart Marketplace API

- **Auth:** `POST /v3/token` with `client_id` + `client_secret` (Basic auth) → bearer token, 15-min TTL. Refresh-on-401 helper.
- **Orders:** `GET /v3/orders?createdStartDate=<iso>&limit=200` → paginated by `nextCursor`. Order events (acknowledge / ship / cancel / return) trigger via `GET /v3/orders` polling with `lastModifiedStartDate`.
- **Settlements:** weekly via Report API — `POST /v3/getReport?reportType=SETTLEMENT_REPORT` → poll job → download. Daily incremental via `RECONCILIATION_REPORT`.
- **Returns:** `GET /v3/returns?statusFrom=<iso>` paginated; covers both seller-fulfilled and WFS returns.
- **Inventory (WFS):** `GET /v3/wfs/inventory` per item, or `INVENTORY_REPORT` for bulk.
- **Webhooks:** Walmart offers Notification Service for order events but it's opt-in per-seller and requires public HTTPS endpoint registration. v1 of P12b: polling only.
- **Rate limits:** much friendlier — 5 req/sec for orders, 1 req/sec for reports. Standard exponential backoff on 429.
- **Idempotency:** UNIQUE on `(seller_account_id, purchase_order_id)`.
- **Sandbox:** Walmart sandbox at `marketplace.walmartapis.com/sandbox/v3/...` — env-var `WALMART_API_HOST`.

### 4.3 Faire API

- **Auth:** static API key (`X-FAIRE-ACCESS-TOKEN` header). No OAuth. Operator generates in Faire brand portal.
- **Orders:** `GET /v2/orders?updated_at_min=<iso>&limit=50` paginated by `cursor`. Order detail includes commission breakdown + `is_first_order` flag that drives the 25%-vs-15% commission split per Faire's brand contract.
- **Payouts:** `GET /v2/payouts?paid_at_min=<iso>` paginated. Each payout has `included_order_ids` linking back to `faire_orders`.
- **Returns/refunds:** orders transition to `CANCELED` / `RETURNED` via the orders feed; no separate returns endpoint. Credit memos derived from order-state-change events.
- **Buyers:** `GET /v2/retailers` (Faire's term for buyer accounts) → paginates all retailers ever ordered from the brand. Used to populate `faire_buyers`.
- **Webhooks:** Faire offers webhooks (`v1/webhooks`) but they're optional. **v1 of P12c does not subscribe** — 12h polling is sufficient. Wholesale order velocity is low enough.
- **Rate limits:** 20 req/sec aggregate; 2 req/sec for `/payouts`. Generous.
- **Idempotency:** UNIQUE on `(faire_shop_id, faire_order_id)` and `(faire_shop_id, faire_payout_id)`.
- **Sandbox:** Faire offers a test API key against staging; toggle via `FAIRE_API_HOST`.

---

## 5. JE patterns per channel

Same shape as P11 §5 — `*_convert_order_to_ar(...)` SECURITY DEFINER RPCs per channel, idempotent on the order's existing `ar_invoice_id`.

### 5.1 FBA — paid Amazon order with sponsored ad attribution

```
Order ABC-123 (FBA, $100 sale, $5 shipping, $3 facilitator tax, $0 discount):

DR 1115 Marketplace Receivable Clearing (FBA)  10800   -- gross receivable from Amazon
CR 4000 Revenue                                10000
CR 4100 Shipping Income                          500
CR (memo only) facilitator_tax_cents = 300          -- D8: NOT credited to 2200

DR 5000 COGS                                    XXXX   -- FIFO consume from location=FBA-NA
CR 1300 Inventory Asset                         XXXX

When settlement posts (~14d later):
DR 6520 Marketplace Fees                        1500   -- 15% referral
DR 6523 FBA Fulfillment Fees                     350   -- pick/pack/ship
DR 6522 FBA Storage Fees                          80   -- monthly allocation
DR 6521 Sponsored Ads                            220   -- attributed PPC
DR 1100 Bank                                    8650   -- net deposit
CR 1115 Marketplace Receivable Clearing (FBA)  10800   -- closes out
```

### 5.2 FBA — Unsellable disposition return

```
DR 4000 Revenue (contra)                        10000  -- reverse original revenue
DR 6420 Inventory Write-off                      XXXX  -- inventory NOT restocked
DR 6524 Marketplace Removal Fees                  150  -- Amazon removal charge
CR 1115 Marketplace Receivable Clearing       10150
CR 5000 COGS (reversal)                          XXXX
```

### 5.3 Walmart — WFS order

```
Order WM-PO-789 (WFS, $80 sale, $0 shipping, $7 facilitator tax):

DR 1115 Marketplace Receivable Clearing (WMT)   8700
CR 4000 Revenue                                 8000
CR (memo) facilitator_tax_cents = 700

DR 5000 COGS                                    XXXX  -- consume from location=WFS
CR 1300 Inventory Asset                         XXXX

Weekly settlement:
DR 6520 Marketplace Fees                         640  -- 8% commission
DR 6525 WFS Fulfillment Fees                     280  -- WFS pick/pack
DR 1100 Bank                                    7780  -- net
CR 1115 Marketplace Receivable Clearing         8700
```

### 5.4 Faire — first-order from new buyer (25% commission)

```
Order FAIRE-9999 (new buyer, $500 wholesale, 25% commission):

DR 1115 Marketplace Receivable Clearing (FAIRE) 37500  -- net of commission
DR 6520 Marketplace Fees                        12500  -- 25% × $500
CR 4000 Revenue                                 50000  -- gross wholesale

DR 5000 COGS                                     XXXX  -- consume from location=WH-MAIN
CR 1300 Inventory Asset                          XXXX

Monthly payout (covers many orders):
DR 1100 Bank                                  $$$$$$   -- aggregate net
CR 1115 Marketplace Receivable Clearing       $$$$$$
```

### 5.5 Faire — recurring-buyer order (15% commission)

Same shape, `commission_rate_pct = 15.00`, `commission_cents = 7500`, clearing = 42500.

### 5.6 Faire — credit memo / return

```
DR 4000 Revenue (contra)                        50000
DR 1300 Inventory Asset (restock)                XXXX
DR (memo, commission_refunded_cents)            12500
CR 1115 Marketplace Receivable Clearing         37500
CR 5000 COGS (reversal)                          XXXX
CR 6520 Marketplace Fees (reversal)             12500  -- Faire refunds the commission on full refunds
```

---

## 6. Implementation chunks

Three parallel sub-phases. Each is structurally identical to P11 (chunks for schema + auth + ingest + settlement + UI + returns). 14 chunks total + 1 shared inventory-locations migration up front.

### Shared P12-0 (must run first, blocks all three sub-phases)

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **P12-0** | `inventory_locations` table + `inventory_layers.location_id` migration + GL account seeds + cross-channel encryption helpers | One migration: new table, ALTER inventory_layers (backfill default WH, NOT NULL), new GL accounts (`1115`, `6520-6525`, `6420`), `api/_lib/marketplace/encryption.js` | — |

### P12a — Amazon FBA (M48)

| Chunk | Title | Depends on |
|---|---|---|
| **P12a-1** | FBA schema (6 tables) + RLS + SP-API client helper (`api/_lib/sp-api/`) + token-bucket throttle + LWA token cache | P12-0 |
| **P12a-2** | Orders + items poller cron (6h) + order-to-AR conversion RPC `fba_convert_order_to_ar` | P12a-1 |
| **P12a-3** | Settlements poller (daily) + settlement-to-JE poster RPC `fba_post_settlement_je` + payout-to-bank reconciliation | P12a-2 |
| **P12a-4** | Inventory snapshot poller (daily) + drop-and-rebuild `inventory_layers` where `source='fba'` | P12a-1 |
| **P12a-5** | Returns report poller (daily; async report-submit-poll-download flow) + returns-to-credit-memo RPC | P12a-2 |
| **P12a-6** | UI panels — FBA Seller Accounts (config + LWA OAuth walkthrough) + Orders + Settlements + Inventory + Returns + Sync Status | P12a-2..5 |

### P12b — Walmart Marketplace (M49)

| Chunk | Title | Depends on |
|---|---|---|
| **P12b-1** | Walmart schema (5 tables) + RLS + Walmart API client + client_credentials token cache | P12-0 |
| **P12b-2** | Orders poller (6h) + order-to-AR RPC `walmart_convert_order_to_ar` (branches on `seller` vs `wfs` fulfillment_type) | P12b-1 |
| **P12b-3** | Settlement report poller (daily) + settlement-to-JE + payout-to-bank reconciliation | P12b-2 |
| **P12b-4** | Returns poller + WFS inventory poller (conditional on `wfs_enabled=true`) + returns-to-credit-memo RPC | P12b-2 |
| **P12b-5** | UI panels — Walmart Seller Accounts + Orders + Settlements + Returns + Sync Status | P12b-2..4 |

### P12c — Faire (M50)

| Chunk | Title | Depends on |
|---|---|---|
| **P12c-1** | Faire schema (5 tables) + RLS + Faire API client + static-API-key encryption | P12-0 |
| **P12c-2** | Buyers + Orders + Items poller (12h) + buyer-to-customer auto-resolve + order-to-AR RPC `faire_convert_order_to_ar` (commission split via `commission_rate_pct`) | P12c-1 |
| **P12c-3** | Payouts poller (daily) + payout-to-bank reconciliation + Faire-specific monthly receivable-aging UI | P12c-2 |
| **P12c-4** | UI panels — Faire Shops + Buyers + Orders + Payouts + Sync Status | P12c-2..3 |

### P12 close-out (after all three sub-phases)

| Chunk | Title | Depends on |
|---|---|---|
| **P12-99** | User guide chapter 24 Marketplaces + cross-cutter wiring (M28 notification rules for unmatched payouts + chargebacks per channel) + extend P5-7 close pre-flight (D17) + memory close-out | P12a + P12b + P12c |

**Parallel waves:**

- **Wave A:** P12-0 (gate).
- **Wave B:** P12a-1 + P12b-1 + P12c-1 simultaneously (three independent schema chunks).
- **Wave C:** P12a-2 + P12b-2 + P12c-2 simultaneously (three order-ingest chunks).
- **Wave D:** P12a-3 + P12a-4 + P12a-5 + P12b-3 + P12b-4 + P12c-3 simultaneously (settlement / inventory / returns per channel).
- **Wave E:** P12a-6 + P12b-5 + P12c-4 simultaneously (UI per channel).
- **Wave F:** P12-99 (close-out).

**Total: 15 chunks.** ~6-8 weeks waved in parallel with multiple agents (matches P11's 3-4 weeks × 3 channels minus overlap savings). Sequential would be ~9-12 weeks.

---

## 7. T10 Shadow Mirror cutover

Per-channel parallel-run, channel-by-channel cutover. Matches [P11 D12](P11-shopify-architecture.md) but exercised three times.

### Phase A — Parallel ingest (per channel, 4-week minimum)

Both pipes run:

- T10 Xoro nightly mirror keeps writing `source='xoro_mirror'` rows for the channel (Xoro's connector for the platform stays on).
- P12 direct integration writes `source='fba'` / `'walmart'` / `'faire'` rows.

Operator monitors the **Marketplace Reconciliation Inbox** (new panel surface in P12a-6 / P12b-5 / P12c-4) which surfaces:

- Per-channel daily variance: SUM(direct orders for date D) vs SUM(xoro_mirror orders for date D) — by gross, by net, by item count.
- Per-payout variance: direct settlement net vs mirrored equivalent.
- Unmatched-deposit list (D16, $5 threshold).

### Phase B — Cutover per channel

After 4 consecutive weeks of variance < $5/payout AND zero direct-vs-mirror order-count diffs, operator can flip **that channel's** Xoro connector off:

1. Operator turns off the Xoro connector in Xoro's admin (per channel).
2. Operator marks `fba_seller_accounts.parallel_run_complete=true` (or Walmart / Faire equivalent — single boolean on each seller account row).
3. T10 mirror cron skips that channel's rows on next run.
4. Direct integration is sole source-of-truth for that channel.

Each channel cuts over independently. Failing one doesn't roll back the others.

---

## 8. Risks + mitigations

- **SP-API throttle limits.** FBA's getOrders is 1 req/min. A backfill over 18 months of history could take days. Mitigation: token-bucket helper + persistent cursor + idempotent UPSERT means we can resume after kill/restart. Operator-facing: backfill duration estimate shown in the FBA Sync Status panel.
- **Faire monthly payout creates receivable timing confusion.** Faire orders posted today don't pay until end-of-month — orders accumulate in `1115 Marketplace Receivable Clearing (FAIRE)` for 30+ days. Operator might mistake this for "AR aging" in the wrong sense. Mitigation: clearing account is OUT of the standard AR aging report; surfaces only in the new Marketplace Reconciliation Inbox. Document in user guide ch.24.
- **Multi-location inventory migration risk (D13/D14).** Every existing FIFO query in `api/_lib/fifo/*.js` and `gl_post_journal_entry` was written assuming single-location. Adding `location_id` means each consumption call must specify location (defaulting to entity's `is_default=true` location for backward compat). Mitigation: P12-0 backfills + enforces default; existing queries continue to work; only new code paths (P12a-3, P12b-3) pass an explicit location_id. Unit-test sweep across existing FIFO tests required.
- **FBA settlement variance — Amazon changes fee shape.** Amazon periodically introduces new fee event types (recent: "Sponsored Display attribution credit"). Mitigation: `fba_settlements.total_other_charges_cents` captures any unrecognized event types; raw_payload preserved; operator-facing dashboard flags "X unknown fee event types in this settlement, $Y total" → engineering investigates + adds new GL mapping. Defensive on shape.
- **Walmart Settlement Report polling.** Reports API is submit-and-poll async. Mitigation: cron records `walmart_seller_accounts.pending_report_jobs` jsonb to track in-flight jobs across cron runs.
- **Faire commission rate confusion (25% vs 15%).** `is_first_order` is Faire's authoritative flag; we don't re-derive it. Mitigation: trust the API field; reconcile commission_cents against (commission_rate_pct × subtotal_cents) and flag mismatches > $1 as variance rows.
- **Customer-buyer round-tripping.** Faire buyers map cleanly (retailer name + email); FBA + Walmart buyers are end-consumers with often-anonymous email aliases (`amzn-redacted@amazon.com`). Mitigation: FBA + Walmart default to `default_customer_id` on the seller account (synthetic "Amazon Buyer" / "Walmart Buyer" customer row) unless real email matches an existing customer. Faire creates real `customers` rows per `faire_buyers.resolved_customer_id`.
- **Sandbox-vs-production switch.** Each channel has a sandbox; testing in sandbox is mandatory before flipping cutover. Mitigation: per-account `is_sandbox boolean` column (add in P12-0 to the seller-account tables) + UI badge "SANDBOX" + production fees go to a sandbox-segregated clearing account if `is_sandbox=true`. Sandbox rows never feed Trial Balance.
- **Marketplace-facilitator tax double-count risk (D8).** If operator's state-tax accountant doesn't know about facilitator-collected tax handling, they may try to remit it twice. Mitigation: clear docs in user guide + facilitator-tax memo column on every order detail panel + monthly facilitator-tax-summary report for state filing reference.

---

## 9. References

- [P11 Shopify Architecture](P11-shopify-architecture.md) — template + many shared patterns (encryption, payout reconciliation, manual fallback, refund-to-credit-memo)
- [T10 Shadow Mirror Architecture](T10-shadow-mirror-architecture.md) — source tagging + cutover model (per-channel cutover here mirrors T10's "Xoro stays system-of-record until each module decoms" pattern)
- [XORO Decom Map](XORO-DECOM-MAP.md) — strategic context: §"Sales channel reconciliation scope" flagged P11 + P12 scope; this doc satisfies the marketplace half
- [P9 Parallel-Run Architecture](P9-parallel-run-architecture.md) — variance framework that D16's $5 threshold plugs into
- [P5 Close Core Financials](P5-close-core-financials-architecture.md) — period close pre-flight extended per D17
- [P6 Bank Reconciliation](P6-bank-recon-architecture.md) — payout matching reuses the P6 match engine pattern
- [CURRENT-SCHEMA](CURRENT-SCHEMA.md) — `inventory_layers`, `customers`, `gl_accounts`, `ar_invoices`, `bank_transactions` shapes being extended

---

## 10. ETA

**Per channel (sub-phase):** ~3 weeks build (matches P11's 3-4 weeks for Shopify; marketplace shapes are similar in complexity once the schema is in place).

**Total P12, parallel waves with multiple agents:** 6-8 weeks end-to-end (Wave A bottleneck is 1-2 days; Waves B-E run three channels in parallel; Wave F is 2-3 days docs).

**Total P12, sequential:** 9-12 weeks.

**Plus 4 weeks parallel run per channel** before each Xoro connector is shut. Per-channel cutovers are independent — first channel cuts over while the other two are still parallel-running.

**Overall calendar (recommendation): kick off mid-2026-06 → all three sub-phases shipped + parallel-running by ~2026-08 → first cutover (FBA) ~2026-09 → all three cut over ~2026-10.**

---

## 11. Operator confirm before chunks ship

Please mark §2 D1-D18 with answers (or push back). Once confirmed I'll kick off **P12a-1 (Amazon FBA Wave A)** — **recommended first** because FBA is the largest channel by volume (per operator's standing read) and validates the multi-location inventory pattern (D13) that Walmart's WFS (D14) reuses.

After P12-0 ships (the shared inventory_locations migration, ~1-2 days), all three channels can ingest in parallel — P12a + P12b + P12c sub-phases run as three independent agent threads. Channel order is independent; each cuts over on its own 4-week parallel-run timeline.

**Vercel env vars to add before P12-0 ships:**

- `MARKETPLACE_TOKEN_ENC_KEY` (32-byte hex from `openssl rand -hex 32` — shared key for FBA + Walmart + Faire credential encryption; same pattern as `SHOPIFY_TOKEN_ENC_KEY` and `PLAID_TOKEN_ENC_KEY`)

**Vercel env vars per platform (one-time, before each sub-phase's seller-account configuration):**

- FBA: `FBA_LWA_CLIENT_ID`, `FBA_LWA_CLIENT_SECRET`, `FBA_AWS_ROLE_ARN`, `FBA_SP_API_HOST` (sandbox toggle)
- Walmart: `WALMART_API_HOST` (sandbox toggle); per-seller client_id/secret stored encrypted in `walmart_seller_accounts`
- Faire: `FAIRE_API_HOST` (sandbox toggle); per-shop API key stored encrypted in `faire_shops`

**Operator platform-side actions (each sub-phase's seller-account panel walks operator through):**

- **FBA:** SP-API developer registration → LWA app + AWS IAM role → install on seller account → grant SP-API permissions for Orders, Finances, FBA Inventory, Reports. ~1-2 hours of setup per Amazon account. Tangerine surface generates the LWA OAuth consent URL.
- **Walmart:** Walmart Seller Center → Developer Portal → Create app → client_id + client_secret → paste into Tangerine Walmart Seller Accounts panel. ~15 min per account.
- **Faire:** Faire brand portal → Settings → API → Generate API key → paste into Tangerine Faire Shops panel. ~5 min per shop.

**Realistic timeline after operator confirms §2:** 6-8 weeks of build (waved parallel) + 4 weeks parallel run per channel before each Xoro connector is shut. First channel decomm achieved ~10-12 weeks after kickoff. Second piece of operational Xoro decom (Shopify under P11 being the first). Subject to the broader EDI-loop constraint laid out in [XORO Decom Map](XORO-DECOM-MAP.md).
