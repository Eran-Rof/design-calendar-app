# M43 — Pricing Engine architecture

**Status:** Chunk A (backend) shipped #792. Chunk B (admin UI) + Chunk C (SO/AR auto-fill) ahead.

## Why
Internal SO/AR prices were 100% manual typing; the only structured prices lived in the interim, style-level `b2b_price_list` (#719, *"placeholder until M43"*), used only by the B2B portal. M43 makes pricing real and unifies staff + portal on one engine.

## Model
- **`price_lists`** — named lists. Scope is exactly one of: `customer_id` (per-customer own list), `customer_tier` (per-tier), or `is_default` (global fallback). Entity-scoped, `code` unique per entity, `currency` (USD).
- **`price_list_items`** — per-style prices within a list. Multiple rows per `(list, style)` with ascending `min_qty` give **quantity breaks**; `UNIQUE (price_list_id, style_id, min_qty)`. Effective-dated, `is_active`.
- **`price_promotions`** — discounts layered on the resolved list price. `discount_type` ∈ percent|amount; optional match filters `style_id`/`brand_id`/`customer_id`/`customer_tier` (NULL = any); `min_qty`, effective dates, `code` (NULL = automatic), `priority`.
- **`customers.price_list_id`** — the shared list assigned to a customer (e.g. "Distributor").

Grain = **style-level** (`style_master.id`); single currency (USD, column carried for forward-compat).

## Resolution (`api/_lib/pricing/engine.js`)
For `(customer, style, qty, date)` — the FIRST list in precedence order that prices the style wins, then the best promotion applies:
1. customer's **own** list (`price_lists.customer_id = customer`)
2. customer's **assigned** list (`customers.price_list_id`)
3. **tier** list (`price_lists.customer_tier = customers.customer_tier`)
4. **default** list (`is_default`)

Within the chosen list: highest `min_qty ≤ qty` among active, in-effect items (qty break). Then the single **best (largest-discount)** active, in-effect, matching promotion — **no stacking** in v1. Returns `{ price_cents, base_price_cents, currency, min_qty, source_list_id, source_list_code, applied_promotion_id }` (null when no price).

Two entry points, one implementation: `resolvePrice(admin, {customerId, styleId, qty, date})` and the batch `resolvePricesForCustomer(admin, customerId, styleIds, qty?, date?)`.

## Consumers
- **B2B portal** — `api/_lib/b2b/pricing.js` is now a thin adapter over the engine; `api/_handlers/b2b/catalog.js` + `orders/index.js` resolve through it (no client-visible change).
- **Internal resolve endpoint** — `GET /api/internal/pricing/resolve?customer_id=&style_id=&qty=` (h578) for SO/AR auto-fill (Chunk C) + ad-hoc checks.
- **Admin** (Chunk B) — Price Lists + Promotions panels; customer→price-list assignment on Customer Master.

## Migration
`20260716000000_m43_pricing_engine.sql` (applied to prod): tables + RLS (anon_all + auth_internal entity-scoped) + touch triggers + a seeded **Default Wholesale** list, and an idempotent copy of any `b2b_price_list` rows into the new model (customer rows → that customer's own list; tier rows → a per-tier list; default rows → the Default list). `b2b_price_list` is retained one release (deprecated, no longer read), to be dropped in a later migration.

## Out of scope / fast-follow
Size/SKU-level prices + size-group upcharges; multi-currency; promotion stacking; margin/cost-plus auto-pricing (`ip_item_master.unit_cost` / `ip_item_avg_cost`); contract/quote pricing; price-change approval workflow.
