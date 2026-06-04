# P11-10 — Shopify Product Mirror + Image Unification

Part of **P11 (Shopify)**. M12 (orders/refunds/payouts + COGS posting) is done; this
sub-stream adds the **product catalog mirror** and a **unified image system** that
re-hosts Shopify product images into the PIM (and, later, retires Dropbox image
storage). Status is tracked in `BUILD-PROGRESS.md` (P11 row).

> **Last updated:** 2026-06-02

## Goal
Make Shopify product images appear on Tangerine styles — copied into our own
storage so they survive deletion/re-slug on Shopify — and give styles a durable
link to their Shopify product for future sync.

## Data model (live in prod)
- **`shopify_products`** — mirror of a Shopify product. `id uuid PK`,
  `shopify_product_id bigint` (the real Shopify id), `shopify_handle`, `title`,
  `tags text[]`, `status` (active|archived|draft), `updated_at_shopify`,
  `raw_payload jsonb`, `resolved_style_id → style_master`, `match_method`
  (handle|tag|manual). **UNIQUE (shopify_store_id, shopify_product_id)**.
- **`style_master.shopify_product_id`** — **uuid FK → `shopify_products.id`**
  (NOT the numeric Shopify id).
- **`product_images`** (polymorphic) — `owner_type` (style|task|note_attachment|
  sku|shopify_product), `owner_id`, `source` (manual|shopify|dropbox_migrated),
  `shopify_image_id bigint`, `original_dropbox_url`. Re-hosted images are
  `owner_type='style'`, `source='shopify'`, keyed by `style_id`. Polymorphic
  primary = unique index `uq_pi_primary_per_owner(owner_type,owner_id) WHERE is_primary`.
- **`dropbox_backfill_failures`** — quarantine for the (future) Dropbox migration.
- Storage bucket **`pim-images`**; derivatives thumb/web/print via Sharp.

The schema (P11-10-1) was applied direct-to-prod and was uncommitted; migration
`supabase/migrations/20260720000000_p11_10_1_shopify_image_schema_drift.sql` now
recreates it faithfully + idempotently (verified no-op on prod).

## Build status

| Wave | Scope | PRs | Status |
|---|---|---|---|
| A | Schema + Shopify client (`listProducts`/`getProduct`/`getProductImages`) | #752 #753 | ✅ |
| B | Per-style **link** + **Pull from Shopify** (re-host) + composite render fix (sign URLs) + PIM UI (h604 link / h605 pull) + drift migration | #844 #853 | ✅ |
| **bulk** | **Bulk link by handle=style_code** (walk catalog → match → upsert mirror + link, with dry-run report) + **bulk pull** (batched/cursored over linked styles) | — | ⬜ planned |
| C+ | products/* webhooks + scheduled product backfill cron; `InternalShopifyProducts` admin panel; Dropbox migration + kill switch | — | ⬜ deferred |

## ⛔ Prerequisite blocker (operator)
`shopify_stores` is **empty in prod** — no store, no Admin API token. The entire
Shopify integration (orders + images) is dormant until a store is connected:
1. Shopify admin → Develop apps → custom app with `read_products`
   (+ `read_orders` for the dormant orders sync) → install → copy the
   `shpat_…` Admin API token.
2. Ensure `SHOPIFY_TOKEN_ENC_KEY` is set on Vercel prod.
3. Insert a `shopify_stores` row with the token **encrypted** (`encryptToken`,
   AES-256-GCM). One-time write.

## Bulk plan (P11-10-bulk) — next build
**Match rule (operator-chosen): Shopify `handle` = `style_master.style_code`.**
1. **Dry-run / report** — walk `listProducts`, compute handle→style_code matches,
   return matched / unmatched lists (no writes) for operator review; add
   normalization only if raw equality under-matches.
2. **Bulk link** — for each match: upsert `shopify_products` mirror + set the
   style's uuid FK (reuses `upsertShopifyProduct`). Idempotent.
3. **Bulk pull** — iterate linked styles, re-host each product's images
   (reuses `pullShopifyImages`), **batched with a cursor** to respect Vercel
   function timeout + Shopify rate limits. Summary of pulled/skipped/failed.

Scale today: **2,100 styles, 0 linked.**

## Decisions
Keep-images-safe (re-host, not CDN-reference) chosen by operator 2026-06-02.
Earlier P11-10 decision log (D7–D28) lives in the `p11-10-shopify-product-mirror`
memory.

## See also
- `docs/tangerine/P11-shopify-architecture.md` — P11 foundation (stores, orders, webhooks)
- `BUILD-PROGRESS.md` — P11 row (live status)
