# Tangerine P11 — Shopify Architecture Pass

Status: **DRAFT** (2026-05-28). Operator review gate before implementation chunks kick off. Auto-merges on CI green per the standing plan-approval-not-implementation rule.

Implements **M12 (Shopify)** from the roadmap. First real revenue-side integration — validates the Shadow Mirror v2 pattern (source-tagged auto-flow that operator can override manually) before the heavier P12 marketplaces and P22 EDI builds.

This is the integration the operator most directly *uses*: orders, refunds, returns, and Shopify Payments payouts all materialize automatically in Tangerine as `source='shopify'` rows. Reports + CRM + Cases stay in sync without any operator action. When Shopify is down or a one-off invoice needs typing, the existing AR Invoices panel (manual entry, `source='manual'`) still works alongside without conflict.

---

## 0. Scope guardrails

**In scope (this phase) — full Shopify reconciliation:**

- **Order ingestion** — every Shopify order becomes an `ar_invoices` row + lines, with revenue + shipping income + sales tax + discount lines posted to the right GL accounts.
- **Payment + payout reconciliation** — Shopify Payments deposits net amount (after 2.9% + 30¢ per txn); we reverse-engineer the gross + fees and reconcile against the bank deposit (P6 Bank Recon hooks).
- **Refunds** (full + partial) — reverse AR + COGS proportionally; restore inventory on returned items.
- **Returns / RMAs** — inventory restocked, COGS reversed, restocking fees split out as fee revenue.
- **Chargebacks** — auto-create Case (M47) + reverse AR + post chargeback expense (`6610` from P7 schema).
- **Multi-store support** — operator probably has 1+ Shopify stores (DTC and possibly a wholesale instance); each store is its own `shopify_stores` row with its own credentials + GL account map.
- **Manual fallback** (per standing principle) — operator can always type a Shopify-style order in the AR Invoices panel with `source='manual'`. The shopify mirror never touches `source='manual'` rows.
- **Webhook-driven real time** for `orders/create` / `orders/updated` / `orders/cancelled` / `refunds/create` / `app/uninstalled`; periodic backfill cron (every 6h) catches any webhook drops.
- **Daily payout reconciliation** — pulls Shopify Payments payouts via Admin REST API, matches against `bank_transactions` (P6) by amount + date.

**Explicitly OUT of scope (deferred):**

- **Shopify Plus checkout extensibility / scripts** — operator's stores are standard / not Plus.
- **Storefront customization** — Tangerine reads, doesn't push back theme changes.
- **Product catalog push to Shopify** (PIM → Shopify) — M42 PIM has the data; the push is M42 v2 / future, not P11.
- **Inventory level push to Shopify** — same; that's M37 + P21 territory.
- **B2B Shopify (B2B Hub)** — wholesale flow is P18 (M40/M41).
- **Multi-currency stores** — single USD per locked decision.
- **Tax engine integration** — operator's Shopify already collects tax via TaxJar / Avalara / Shopify Tax; we just record what Shopify says.
- **POS Pro / Shopify Retail** — if operator uses Shopify POS in a brick-and-mortar context. Not currently in the picture per my read of the operation; skip.
- **App Bridge / embedded admin app** — Tangerine is its own surface; Shopify integration is API-only.

---

## 1. Existing state (one-paragraph map)

After P1-P8 + T10 Shadow Mirror: Tangerine has the full financial layer, CRM, PIM, Cases, sales reps. T10 just shipped the Xoro nightly mirror. **Shopify is currently ingested via Xoro's web-connector** — Shopify orders flow to Xoro (which creates the AR invoice + COGS), and Xoro flows to Tangerine via the nightly fetch (T10 mirrors with `source='xoro_mirror'`). That works today but: (a) it's a day-delayed via Xoro, (b) we don't see Shopify-specific fields like discount codes, payment_gateway, tax line splits, (c) Shopify Payments fees are aggregated by Xoro into a single "shopify fees" GL line, losing per-order detail. P11 cuts out the Xoro middleman for Shopify — Tangerine talks directly to Shopify and the rows arrive as `source='shopify'` (not `'xoro_mirror'`).

---

## 2. Decisions (DRAFT — operator to confirm)

| # | Decision | Recommendation | Why | Operator confirm? |
|---|---|---|---|---|
| D1 | Number of Shopify stores | **Configurable — `shopify_stores` table; start with whatever operator has** | Multi-store support is essentially free with the right schema; lets you add new stores later without migration. | ☐ |
| D2 | Auth model | **Shopify Custom Apps (per-store) with API access scopes** | Public Apps require Partner approval + OAuth dance; Custom Apps are simpler for a single-org deployment. | ☐ |
| D3 | API surface | **Admin REST API + Webhooks** (no Storefront, no GraphQL for v1) | REST has 5-yr stability; GraphQL nice-to-have can come later. Webhooks are critical for sub-second order recognition. | ☐ |
| D4 | Source tag granularity | **Single `source='shopify'` value across all Shopify stores; the originating store goes in `shopify_orders.shopify_store_id`** | Filter UI doesn't care which store; the row carries detail. Avoids `source='shopify_dtc'` / `'shopify_wholesale'` enum explosion. | ☐ |
| D5 | Sales tax GL handling | **Per Shopify's reported tax — credit `2200 Sales Tax Payable` per line** | Operator's tax already collected by Shopify Tax / TaxJar (or whatever's wired in Shopify). Tangerine just records the liability. | ☐ |
| D6 | Shopify Payments fee handling | **Per-order DR `6510 Merchant Fees` + CR `1110 Payment Processor Clearing`** (existing P7-1 accounts) | Reuses the M16 provider-clearing pattern already shipped. Payout reconciliation matches `1110` to `1100 Bank`. | ☐ |
| D7 | Refund handling | **Full refund = void original AR via existing P4 void path with `source='shopify'`; partial refund = create a sibling AR credit memo for the refunded amount, restock-relevant lines reverse COGS proportionally** | Matches the existing AR void model from P4; adds Shopify-aware sibling for partials. | ☐ |
| D8 | Restocking fees | **Recorded as a separate `4500 Restocking Fee Income` GL line on the refund credit memo, not netted against revenue** | Cleaner P&L; auditor-friendly. New GL account seeded by the migration. | ☐ |
| D9 | Chargeback auto-case | **Yes — Shopify `dispute_created` webhook → opens M47 case + posts `6610 Chargeback Expense` JE** | Reuses the P7-9 Cases path; operator gets one inbox for disputes. | ☐ |
| D10 | Backfill cron cadence | **6h periodic — catches any webhook drops, validates last 7 days against Shopify's `since_id`/`updated_at_min`** | Webhooks are at-least-once but Shopify sometimes drops them after extended outages. | ☐ |
| D11 | Webhook signature verification | **HMAC-SHA256 against `SHOPIFY_WEBHOOK_SECRET` per store** | Standard Shopify pattern. Same raw-body issue as Plaid + Stripe — the dispatcher pre-parses; needs the raw-body fix (planned). Until then, `SHOPIFY_WEBHOOK_SKIP_VERIFY=true` per-store flag. | ☐ |
| D12 | Tangerine ⇄ Xoro Shopify ingestion | **Cut Xoro out of the Shopify flow after P11 ships and parallel-runs cleanly** | Today: Shopify → Xoro → Tangerine (T10 mirror, source='xoro_mirror'). After P11: Shopify → Tangerine directly (source='shopify'). Xoro can stop ingesting Shopify (operator turns off the Shopify connector in Xoro). One-domain partial decom. | ☐ |

---

## 3. M12 Shopify schema

### 3.1 `shopify_stores` (new — per-store config)

```sql
CREATE TABLE IF NOT EXISTS shopify_stores (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_domain           text NOT NULL,           -- 'rof.myshopify.com' or custom domain
  store_name               text NOT NULL,           -- 'ROF DTC' / 'ROF Wholesale'
  access_token_ciphertext  bytea,                   -- AES-256-GCM encrypted, key = SHOPIFY_TOKEN_ENC_KEY
  webhook_secret_ciphertext bytea,                  -- HMAC secret for webhook verification

  -- GL account mapping per-store (defaults from entity-level if null)
  revenue_account_id       uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  shipping_income_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  sales_tax_account_id     uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  discount_account_id      uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  restocking_fee_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  merchant_fees_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  chargeback_expense_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  payment_processor_clearing_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,

  default_customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,  -- for orders w/o resolvable customer
  is_active                boolean NOT NULL DEFAULT true,
  webhook_skip_verify      boolean NOT NULL DEFAULT false,  -- temp until raw-body dispatcher fix

  -- Backfill / sync state
  last_orders_since_id     bigint,                   -- /admin/api/orders.json?since_id=
  last_orders_updated_at   timestamptz,              -- alt cursor for /orders.json?updated_at_min=
  last_payouts_since_id    bigint,                   -- /admin/api/shopify_payments/payouts.json?since_id=
  last_webhook_at          timestamptz,
  last_backfill_at         timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_stores_domain_per_entity UNIQUE (entity_id, shopify_domain)
);
```

### 3.2 `shopify_orders` (new — raw order mirror)

```sql
CREATE TABLE IF NOT EXISTS shopify_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id      uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_order_id      bigint NOT NULL,             -- Shopify's numeric ID
  shopify_order_name    text NOT NULL,               -- '#1042' display
  customer_email        text,
  customer_id_in_shopify bigint,
  resolved_customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,  -- via email match
  financial_status      text,                        -- 'pending'/'authorized'/'paid'/'partially_paid'/'refunded'/'voided'
  fulfillment_status    text,                        -- 'fulfilled'/'partial'/'unfulfilled'/null
  order_status          text,                        -- 'open'/'closed'/'cancelled'

  total_cents           bigint NOT NULL,
  subtotal_cents        bigint NOT NULL,
  shipping_cents        bigint NOT NULL DEFAULT 0,
  tax_cents             bigint NOT NULL DEFAULT 0,
  discount_cents        bigint NOT NULL DEFAULT 0,
  refunded_cents        bigint NOT NULL DEFAULT 0,
  shopify_fee_cents     bigint,                       -- backfilled from /transactions on payment txn
  currency              text NOT NULL DEFAULT 'USD',

  ordered_at            timestamptz NOT NULL,
  cancelled_at          timestamptz,
  closed_at             timestamptz,

  ar_invoice_id         uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,    -- the Tangerine AR row we created
  je_id                 uuid REFERENCES journal_entries(id) ON DELETE SET NULL,

  raw_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- full Shopify order JSON
  last_synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_orders_per_store_unique UNIQUE (shopify_store_id, shopify_order_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_ar ON shopify_orders (ar_invoice_id) WHERE ar_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopify_orders_status ON shopify_orders (order_status, ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_unsynced ON shopify_orders (last_synced_at) WHERE ar_invoice_id IS NULL;
```

### 3.3 `shopify_refunds` (new — per-refund tracker)

```sql
CREATE TABLE IF NOT EXISTS shopify_refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id   uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_order_id   uuid NOT NULL REFERENCES shopify_orders(id) ON DELETE CASCADE,
  shopify_refund_id  bigint NOT NULL,
  refund_kind        text NOT NULL CHECK (refund_kind IN ('full','partial')),
  refund_cents       bigint NOT NULL,
  restocking_fee_cents bigint NOT NULL DEFAULT 0,
  restocked_line_items_count int NOT NULL DEFAULT 0,
  reason             text,
  processed_at       timestamptz NOT NULL,
  credit_memo_invoice_id uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,   -- the AR credit memo we created
  raw_payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_refunds_unique UNIQUE (shopify_store_id, shopify_refund_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_refunds_order ON shopify_refunds (shopify_order_id);
```

### 3.4 `shopify_payouts` (new — payout reconciliation)

```sql
CREATE TABLE IF NOT EXISTS shopify_payouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id    uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_payout_id   bigint NOT NULL,
  payout_date         date NOT NULL,                       -- Shopify Payments deposit date
  net_amount_cents    bigint NOT NULL,                     -- what landed in bank
  gross_amount_cents  bigint NOT NULL,                     -- charges before fees
  fees_amount_cents   bigint NOT NULL,                     -- total fees
  adjustments_amount_cents bigint NOT NULL DEFAULT 0,      -- refund-related debits
  refund_amount_cents bigint NOT NULL DEFAULT 0,
  reserved_amount_cents bigint NOT NULL DEFAULT 0,         -- holdback
  currency            text NOT NULL DEFAULT 'USD',
  matched_bank_transaction_id uuid REFERENCES bank_transactions(id) ON DELETE SET NULL,
  raw_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_payouts_unique UNIQUE (shopify_store_id, shopify_payout_id)
);
```

### 3.5 New GL accounts seeded

| Code | Name | Type | Normal |
|---|---|---|---|
| 4100 | Shipping Income | revenue | CREDIT |
| 4500 | Restocking Fee Income | revenue | CREDIT |
| 2200 | Sales Tax Payable | liability | CREDIT |

`6510 Merchant Fees`, `6610 Chargeback Expense`, `1110 Payment Processor Clearing` already shipped in P7-1.

---

## 4. Webhook handlers

| Endpoint | Triggers from Shopify | Action |
|---|---|---|
| `POST /api/webhooks/shopify/orders/:store_id` | `orders/create`, `orders/updated` | Upserts `shopify_orders` row; if not yet associated with AR invoice, calls the order-to-AR conversion |
| `POST /api/webhooks/shopify/orders-cancel/:store_id` | `orders/cancelled` | Voids the AR invoice + reverses COGS |
| `POST /api/webhooks/shopify/refunds/:store_id` | `refunds/create` | Creates `shopify_refunds` row + AR credit memo |
| `POST /api/webhooks/shopify/disputes/:store_id` | `disputes/create`, `disputes/update` | Opens M47 case + posts chargeback expense (if won by customer) |
| `POST /api/webhooks/shopify/app-uninstall/:store_id` | `app/uninstalled` | Marks `shopify_stores.is_active=false` + emits notification |

All handlers HMAC-verify against `webhook_secret_ciphertext` (per store) unless `webhook_skip_verify=true`. Same raw-body workaround as Plaid + future Stripe.

---

## 5. Order-to-AR conversion (the core RPC)

`shopify_convert_order_to_ar(p_shopify_order_id uuid, p_actor_user_id uuid DEFAULT NULL) RETURNS jsonb` — SECURITY DEFINER. Idempotent: if `shopify_orders.ar_invoice_id IS NOT NULL`, returns existing.

For each order:

```
1. Resolve customer:
   a. shopify_orders.resolved_customer_id (already set by webhook handler from email match)
   b. fall back to shopify_stores.default_customer_id
   c. fail with EXCEPTION 'shopify order has no resolvable customer'
2. Insert ar_invoices row:
   - source = 'shopify'
   - customer_id = resolved customer
   - invoice_number = 'SHOP-<store_short>-<shopify_order_name>'
   - invoice_date = ordered_at::date
   - total_amount_cents = shopify_orders.total_cents
3. Insert ar_invoice_lines from raw_payload.line_items:
   - One line per Shopify line item
   - line_total_cents = qty × unit_price (pre-tax)
   - tax_amount_cents = sum of tax_lines for this line item
   - inventory_item_id resolved via sku → ip_item_master (or null for non-inventory)
4. Insert ar_invoice_lines for shipping + tax + discount as virtual lines:
   - Shipping: shipping_cents → 4100 Shipping Income
   - Tax: tax_cents → 2200 Sales Tax Payable (credit-side liability)
   - Discount: discount_cents → 4000 Revenue contra (negative)
5. Post via existing AR post path (P4-2 receipt-post calls gl_post_journal_entry):
   - DR 1110 Payment Processor Clearing (for Shopify Payments orders)
     OR DR 1200 AR Control (for invoice-pay-later orders)
   - DR 5000 COGS / CR 1300 Inventory Asset (FIFO consume for inventory lines)
   - CR 4000 Revenue + CR 4100 Shipping + CR 2200 Tax + DR 4000 (for discounts)
6. Backfill shopify_orders.ar_invoice_id + je_id
7. Emit notification_event 'shopify_order_processed'
```

Note: the AR invoice that backs a Shopify Payments order needs an immediate receipt — the customer already paid. Insert `ar_receipts` row with `source='shopify'`, `payment_method='credit_card'`, `processor_charge_id=<shopify charge>` (joined to the existing P7-1 processor_intent_id pattern).

---

## 6. Refund-to-credit-memo (sibling RPC)

`shopify_convert_refund_to_credit_memo(p_shopify_refund_id uuid, p_actor_user_id uuid DEFAULT NULL) RETURNS jsonb` — creates an AR credit memo (`ar_invoices` with `invoice_kind='customer_credit_memo'`, `total_amount_cents = -refund_cents`) + reverses COGS for restocked items + posts the offsetting JE.

If `refund_kind='full'` AND the original AR invoice is fully unpaid, just void via the existing P4 void path (atomic).

---

## 7. Payout reconciliation cron

`api/cron/shopify-payouts-reconcile.js` — daily at 02:00 UTC. For each active store:

1. Pull payouts via `GET /admin/api/2024-01/shopify_payments/payouts.json?since_id=...`
2. Upsert `shopify_payouts` rows
3. For each new payout, query `bank_transactions` for a match (within ±1 day, amount = `net_amount_cents`, account = the store's bank-side GL account from `shopify_stores.payment_processor_clearing_account_id` ↔ corresponding bank account)
4. If match found, set `shopify_payouts.matched_bank_transaction_id` + the bank txn auto-flips to `status='matched'` via the existing P6 match engine
5. If no match in ±1 day, emit `notification_event` of kind `shopify_payout_unmatched`

This closes the Shopify Payments → bank-rec loop. Same source-tagging principle as the rest of T10.

---

## 8. Backfill cron (6h cadence)

`api/cron/shopify-backfill.js` — every 6h. For each active store:

1. `GET /admin/api/2024-01/orders.json?updated_at_min=<last_orders_updated_at>&status=any&limit=250`
2. Walk pages until empty
3. For each order, upsert `shopify_orders` + trigger order-to-AR conversion if not yet associated
4. Update `shopify_stores.last_orders_updated_at`
5. Same for refunds, disputes

Catches webhook drops from extended Shopify outages. Idempotent — UPSERT semantics.

---

## 9. UI — Shopify panels (under new top-nav group)

New top-nav group **🛍️ Shopify**:

| Panel | Purpose |
|---|---|
| **Stores** | List + add Shopify stores; configure GL account mapping; test webhook signature; OAuth-style "Connect" flow that walks operator through Custom App creation in Shopify admin |
| **Orders** | List view with filters (store, financial_status, fulfillment_status, date range); click → detail modal with raw payload + linked AR invoice + linked JE |
| **Refunds** | List view + drill to original order + credit memo |
| **Payouts** | List view with reconciliation status; manual re-match button if auto-match failed |
| **Sync Status** | Last webhook + backfill timestamps per store; manual re-run; webhook health |

All panels honor the T10-7 `<source>` filter (already shipped) + `<ExportButton>` (T3/T8) + `<SearchableSelect>` (T9) on store/customer pickers.

---

## 10. Cross-cutter hooks (M27 / M28 / M29 recap)

- **M27 Approvals:** none in v1. Future: approval gate on store deactivation (`is_active=false`).
- **M28 Notifications:** webhook signature failure, chargeback received, payout unmatched, app uninstalled.
- **M29 Documents:** chargeback evidence packets attached to the auto-created M47 case (already wired from P7).

---

## 11. Chunk split (implementation — DO NOT start until operator confirms §2 decisions)

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **P11-1** | Schema + GL account seeds + RLS + Shopify SDK helpers (encryption pattern same as P6 Plaid) | 4 new tables + 3 new GL accounts + `api/_lib/shopify/client.js` (REST wrapper) + `api/_lib/shopify/encryption.js` | — |
| **P11-2** | Webhook handlers (5) + raw-body signature verification + skip-verify env flag | h410-h414 | P11-1 |
| **P11-3** | Order-to-AR conversion RPC + tests | `shopify_convert_order_to_ar` SECURITY DEFINER | P11-1 |
| **P11-4** | Refund-to-credit-memo RPC + tests | `shopify_convert_refund_to_credit_memo` | P11-3 |
| **P11-5** | Payout reconciliation cron + tests | `api/cron/shopify-payouts-reconcile.js` | P11-3 |
| **P11-6** | Backfill cron (6h) + tests | `api/cron/shopify-backfill.js` | P11-3 |
| **P11-7** | Stores admin panel — list / add / configure GL mapping / Connect flow walkthrough | `src/tanda/InternalShopifyStores.tsx` | P11-1 |
| **P11-8** | Orders + Refunds + Payouts + Sync Status panels | 4 new admin panels | P11-3/4/5/6 |
| **P11-9** | User guide chapter 23 + cross-cutter wiring + memory close-out | Doc + notification rule seeds + M47 dispute handler | All above |

Parallel waves:
- **Wave A (after operator confirms §2):** P11-1.
- **Wave B:** P11-2 + P11-3 simultaneously.
- **Wave C:** P11-4 + P11-5 + P11-6 + P11-7 simultaneously.
- **Wave D:** P11-8 (depends on the data flowing).
- **Wave E:** P11-9.

Estimated **~3-4 weeks** end-to-end with parallel agents. Code is straightforward; the operational subtleties (customer matching, payout-to-bank-txn matching, partial-refund line accounting) are where careful tests pay off.

---

## 12. Risks

- **Raw-body webhook verification** — same blocker as Plaid + (future) Stripe. The dispatcher pre-parses request body, breaking HMAC verification. Per-store `webhook_skip_verify` flag is the workaround until the raw-body fix lands; same memory rule applies.
- **Customer matching ambiguity.** Shopify orders have an email but Tangerine `customers.billing_address->>'email'` may not have it. New customers from Shopify → unmatched-customer queue (mirror existing T10 pattern); operator manually links or creates a customer master row.
- **Shopify rate limits.** Admin REST is 2 calls/sec; bulk operations can hit it. Backfill cron pages with delay. Webhooks are not rate-limited.
- **Refund accounting ambiguity** — Shopify sometimes reports refund line breakdowns inconsistently when a manual / partial refund is made via admin UI vs API. Conservative posture: trust Shopify's totals over our derived sums; reconcile mismatches as variance rows for future P9.
- **Tax line splits** — Shopify Tax / TaxJar / Avalara expose different line shapes. Tax mapper is a small module per integration; v1 supports Shopify Tax (the operator's default) + add others as needed.
- **Multi-currency** — explicitly out of scope. If operator adds an international store later, build a currency-aware mirror at that time.

---

## 13. Tests

- Order conversion: every kind of order (paid via Shopify Payments, paid via PayPal, COD, manual invoice, multi-line with multiple tax rates, discount codes, gift cards). ~50 tests.
- Refund conversion: full, partial, with restocking fee, no-restock, multi-line partial. ~30 tests.
- Payout match: same-day exact, ±1d, multi-payout same-day, payout split across 2 bank deposits. ~20 tests.
- Webhook signature: correct HMAC accepted, wrong HMAC rejected (or accepted with skip-verify flag).
- Customer matching: exact email match, missing email → default_customer_id fallback, missing email → unmatched queue.
- Idempotency: same webhook fires twice → second call no-op.
- All UPSERTs idempotent on the Shopify unique IDs.

---

## 14. Operator confirm before chunks ship

Please mark §2 D1-D12 with answers (or push back). Once confirmed I'll kick off P11-1 (Wave A).

**Vercel env vars to add before P11-1 ships:**
- `SHOPIFY_TOKEN_ENC_KEY` (32-byte hex from `openssl rand -hex 32` — encrypts per-store access tokens at rest, same pattern as `PLAID_TOKEN_ENC_KEY`)

**Vercel env vars per store** (added later when configuring each store via the Stores panel):
- Stored encrypted in `shopify_stores.access_token_ciphertext` + `webhook_secret_ciphertext` — no env-var bloat per store

**Operator Shopify-side actions per store (P11-7 panel walks you through):**
1. Shopify admin → Apps → Custom Apps → Create app
2. Configure API scopes: `read_orders`, `read_refunds`, `read_payouts`, `read_customers`, `read_products`, `read_inventory`, `write_inventory_levels` (last one only if pushing inventory back; v1 doesn't)
3. Install app → copy admin access token → paste into Tangerine Stores panel
4. Add 5 webhook subscriptions pointing at `https://<your-domain>/api/webhooks/shopify/{event}/{store_id}` (panel generates the URLs)
5. Copy webhook secret → paste into panel

**Realistic ETA after operator confirms §2:** 3-4 weeks of build, then 1-2 weeks of parallel run alongside Xoro's existing Shopify connector before flipping to "Tangerine direct" (D12). After that, Xoro's Shopify connector can be turned off — first piece of operational Xoro decom achieved (subject to the broader EDI-loop constraint laid out in `XORO-DECOM-MAP.md`).
