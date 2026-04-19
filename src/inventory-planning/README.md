# Demand & Inventory Planning — Phase 0

Foundation for the wholesale-first planning module. Phase 0 ships the data
contract, the raw-payload stores, the Xoro + Shopify ingest handlers, and
a data-quality surface. No forecasting, replenishment, or scenario logic
is in this phase.

## Folder layout

```
src/inventory-planning/
  types/         — typed entities, raw payload shapes, data-quality types
  mapping/       — canonical key builders, defensive parsers, reconciliation
  normalize/     — Xoro/Shopify payload → normalized model mappers
  services/      — data-quality scanner + Supabase reader for the admin page
  admin/         — admin pages (Phase 0: DataQualityReport)
  __tests__/     — vitest suites (pure functions only)
api/
  _lib/
    xoro-client.js       — server-side Xoro fetcher (shared by api/xoro/*)
    shopify-client.js    — server-side Shopify Admin REST helper
    planning-raw.js      — raw-payload writer + Supabase admin client
  xoro/
    sales-history.js
    inventory-snapshot.js
    receipts.js
    items.js
    open-pos.js
  shopify/
    orders.js
    products.js
    collections.js
    returns.js
    inventory.js
supabase/migrations/
  20260419810000_inventory_planning_phase0.sql
```

## Canonical keys

| Entity   | Internal key | Human key      | Rule                                                         |
|----------|--------------|----------------|--------------------------------------------------------------|
| SKU      | `sku_id`     | `sku_code`     | Upper-case, trimmed. Preserves punctuation (`-._/`).         |
| Style    | `style_id`*  | `style_code`   | Upper-case, trimmed. PLM-authoritative when available; else derived from SKU by dropping last two hyphen segments. |
| Customer | `customer_id`| `customer_code`| Upper-case, punctuation stripped except `&`.                 |
| Category | `category_id`| `category_code`| Upper-case, whitespace compacted.                            |
| Channel  | `channel_id` | `channel_code` | Upper-case, separators → `_`.                                |
| Vendor   | `vendor_id`  | `vendor_code`  | Upper-case, corp suffixes (INC/LTD/LLC/…) stripped.          |

*`style_id` is not a table yet; only `style_code` text lives on items in Phase 0.*

## Source-of-truth matrix

| Domain                    | Primary (writer) | Secondary (read-only / reconcile) | Notes |
|---------------------------|------------------|-----------------------------------|-------|
| Item master (cost/lead)   | Xoro             | Shopify (price/status only)       | Shopify has no unit cost on variants. |
| Wholesale sales/orders    | Xoro             | —                                 | Customer hierarchy lives in our master, not Xoro. |
| Ecom orders / returns     | Shopify          | —                                 | Storefront-scoped; one channel row per shop. |
| Inventory on-hand         | Xoro             | Shopify (for mismatch detection)  | Never plan replenishment from Shopify qty. |
| PO book / receipts        | Xoro             | Vendor portal `shipments`         | Portal shipments are vendor-submitted proof, not authoritative. |
| Customer master           | Supabase `ip_customer_master` | Xoro               | We stabilize the hierarchy; Xoro gives the raw name. |
| Category master           | Supabase `ip_category_master` | Xoro / Shopify collection handles | |
| Channel master            | Supabase `ip_channel_master`  | Shopify shop domains              | |
| Vendor master (planning)  | Supabase `ip_vendor_master`   | Portal `vendors`                  | Linked via `portal_vendor_id`. |

## Raw vs normalized data flow

```
  Xoro API                            Shopify Admin REST
      │                                        │
      ▼                                        ▼
  api/xoro/<endpoint>.js          api/shopify/<endpoint>.js
      │                                        │
      ▼                                        ▼
  raw_xoro_payloads            raw_shopify_payloads
  (jsonb, append-only,         (jsonb, storefront-scoped,
   source_hash dedupes)          source_hash dedupes)
      │                                        │
      └──────────┬─────────────────────────────┘
                 ▼
    normalize/* maps raw rows → typed models (types/entities.ts)
                 ▼
    mapping/reconcile.ts resolves canonical keys (external_refs > code > name)
                 ▼
    upserts to ip_* fact tables (Phase 1)
                 ▼
    services/dataQuality.ts scans all of the above and writes
    ip_data_quality_issues with a stable entity_key for upsert
```

Every raw row is kept so a contract change in normalization (new mapping,
bug fix, additional field) does not require re-hitting Xoro or Shopify.

## Mapping / reconciliation rules

For every upstream row we attempt three tiers, in order:

1. **`external_refs` exact match** — authoritative. e.g. an `xoro_item_id`
   we previously stored against the item wins.
2. **Canonical `*_code` match** — typed/assigned human key.
3. **Canonical name match** — last resort; always emits a data-quality
   note so a human can confirm the binding.

A `reconcile*` call that falls to tier 3 or returns `none` should produce
an `IpDataQualityIssue` in the calling pipeline — this is intentional
pressure to keep external_refs current.

## Data-quality categories

Emitted by `services/dataQuality.ts`:

| Category                  | Severity | Trigger |
|---------------------------|----------|---------|
| `duplicate_sku`           | error    | Two or more item rows with the same canonical sku_code. |
| `missing_sku_mapping`     | warning  | Upstream sku that didn't resolve to an internal item. |
| `missing_style_mapping`   | warning  | Item with no `style_code`. |
| `missing_lead_time`       | warning  | Active item with null/≤0 lead time. |
| `missing_category`        | warning  | Active item with no category. |
| `missing_customer`        | warning  | Wholesale sale with no customer_id. |
| `missing_channel`         | error    | Ecom sale with no channel_id. |
| `missing_vendor`          | warning  | Receipt with no vendor_id. |
| `date_inconsistency`      | warning  | Open PO with `expected_date < order_date`. |
| `impossible_inventory`    | error/warning | Negative on-hand, or available > on-hand. |
| `shopify_sku_unmapped`    | warning  | Shopify SKU that didn't resolve to an internal sku_code. |
| `orphan_sales_row`        | error    | Sales row pointing at a sku_id not in item_master. |

## Known gaps / Phase 1 TODOs

- **Xoro endpoint paths.** `sales-history`, `inventory-snapshot`, `receipts`,
  `items` default to best-guess paths (`salesorder/getsalesorder`,
  `inventory/getinventory`, `itemreceipt/getitemreceipt`, `item/getitem`).
  Same gap as `xoro-receipts-sync.js`. Callers can override via
  `?path=xerp/<module>/<action>` until confirmed with Xoro support.
- **Shopify credentials.** `SHOPIFY_STORES` (or the single-store fallback)
  is not yet set in Vercel — `api/shopify/*` returns 501 cleanly until it
  is. Schema for `SHOPIFY_STORES`:
  `{"US":{"shop":"rof-us.myshopify.com","token":"shpat_..."}, "EU":{...}}`.
- **Upsert normalization pass.** Handlers currently only write
  `raw_*_payloads`. Phase 1 adds a `services/ingest/*` pass that reads the
  latest raw row, runs the normalizer + reconciler, and upserts into the
  `ip_*` fact tables. Intentionally deferred so we can iterate on the
  mapper offline.
- **Period model.** `IpPlanningPeriod` exists as a type but is not
  persisted. Phase 1 either introduces a `ip_planning_period` table or
  computes buckets on read — open decision.
- **Shopify inventory helper.** `api/shopify/inventory.js` requires
  `location_ids`/`inventory_item_ids`. A small helper that iterates the
  variant list in batches belongs in Phase 1.
- **Admin: issue resolution.** `DataQualityReport` is read-only. Phase 1
  writes scan results into `ip_data_quality_issues` (the table already
  exists) and lets an operator mark issues resolved.
- **Cron.** No scheduled pulls yet. Phase 1 will add `/api/cron/xoro-daily`
  and `/api/cron/shopify-daily` wired up in `vercel.json`.
- **Style master.** Phase 0 keeps `style_code` as free text on items; a
  dedicated `ip_style_master` table (with merchandising attributes like
  season, tier, etc.) is deferred to Phase 1.

## Running Phase 0

- Migration: apply
  `supabase/migrations/20260419810000_inventory_planning_phase0.sql`
  via the Supabase dashboard SQL editor (same pattern as prior phases).
- Admin page: `/planning/data-quality` mounts `DataQualityReport`.
- Ingest smoke test (once credentials are set):
  `GET /api/xoro/open-pos?fetch_all=false`
  should write one `raw_xoro_payloads` row and return `{ok:true, raw_payload_id, record_count}`.
