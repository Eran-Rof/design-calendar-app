# Tangerine P15 — Brand Master + Channel Axis + Inventory Partitions (v2)

**Codename:** Tangerine
**Phase:** P15 Brand Master (cross-cutter, parallel to T4/T6/T7/T9)
**Status:** Architecture only — **awaiting CEO sign-off before any schema.** Per `feedback_plan_approval_not_implementation`, this document is the deliverable.
**Date:** 2026-05-31 (v2 — supersedes the 2026-05-30 v1 which assumed a single brand axis)
**Operator ask:** #18 — brand master + brand-filterable reports; Xoro models this as "store" (separate inventory so ecom doesn't mix with wholesale).

> **v2 changes vs v1 (per CEO answers 2026-05-31):** brand is now **two axes** — `brand` AND `channel` — not one. Inventory separation is a **configurable partition ("store") model**, not a flat per-brand split. Brand reporting is required on a **named set of account categories** (not literally every GL line). Seven real brands + five channels are seeded on day one. Brands are an **append-only** set — super-admin / migration-managed; no edit/delete, no admin UI.

---

## 0. TL;DR

P15 adds **two new reporting axes** on top of `entity`:

- **Brand** — a 1:N child of `entities`. 7 brands seeded under the ROF entity. All brands share ROF's legal/tax/fiscal context **and its chart of accounts**; they report separately on a defined set of P&L categories.
- **Channel** — the sales route (DTC/Shopify, Wholesale/EDI, Amazon FBA, Walmart, Faire). Orthogonal to brand.

Inventory is separated by a configurable **partition** ("store" in Xoro terms): inventory rows are keyed by `(item, partition_id)`, and a mapping table decides which `(brand, channel)` combos draw from which partition. This expresses the CEO's rule that ROF/Departed/Fort Knox/Blue Rise/PLM/Axe Crown keep **separate wholesale vs ecom stock**, while **Psycho Tuna shares one pool** across wholesale + ecom.

Transactional rows carry `brand_id` (+ `channel_id` where a channel applies). A global `<BrandSwitcher>` + `<ChannelSwitcher>` (siblings to `EntitySwitcher`) emit `X-Brand-ID` / `X-Channel-ID`; report middleware slices or consolidates. Backfill-safe: nullable FKs first, seed + backfill, then required on the defined categories.

---

## 1. The two axes + the partition

### 1.1 Brands (seeded under entity = ROF)

| code | name | notes |
|------|------|-------|
| `ROF` | Ring of Fire | flagship; default brand for backfill |
| `PT` | Psycho Tuna | **shares one inventory pool across WS + Ecom** |
| `DEPARTED` | Departed | |
| `FORTKNOX` | Fort Knox | |
| `BLUERISE` | Blue Rise | |
| `PLM` | Private Label Macy's | Macy's private-label program |
| `AXECROWN` | Axe Crown | |

All seven share ROF's COA. They are **not** sub-entities (no separate tax IDs / fiscal years / COAs).

### 1.2 Channels (seeded global, entity-agnostic)

| code | name | existing integration |
|------|------|----------------------|
| `DTC` | DTC / Shopify | Shopify orders + COGS posting |
| `WHOLESALE` | Wholesale / EDI | tanda POs, EDI |
| `FBA` | Amazon FBA | FBA mirror + settlements |
| `WALMART` | Walmart | Walmart marketplace |
| `FAIRE` | Faire | Faire marketplace |

### 1.3 Inventory partitions ("stores") — the Xoro-store model

Inventory on-hand + average cost are keyed by **`(item_id, partition_id)`**, NOT by brand directly. A partition is a stock pool owned by a brand. A mapping table `brand_channel_partition(brand_id, channel_id) → partition_id` decides which combos share stock. **Default seed:**

| brand | wholesale-side channels | ecom-side channels (DTC + marketplaces*) |
|-------|--------------------------|------------------------------------------|
| ROF, Departed, Fort Knox, Blue Rise, PLM, Axe Crown | `{BRAND}-WS` partition | `{BRAND}-EC` partition (separate stock, same styles) |
| Psycho Tuna | `PT` partition | `PT` partition (**same pool**) |

`*` **Open item (C1 pre-flight):** do Amazon FBA / Walmart / Faire draw from the brand's Ecom partition, or do they need their own partitions (FBA physically holds separate stock at Amazon)? The mapping table makes this a data decision, not a schema change — default proposal: **FBA = own `{BRAND}-FBA` partition per stocked brand; Walmart/Faire = brand Ecom partition.** To confirm.

"Same styles kept as separate inventory" is naturally expressed: one `item_id` (style/SKU) with multiple `(item_id, partition_id)` rows.

---

## 2. P&L treatment — shared COA, brand-tagged categories

All brands post to **ROF's single chart of accounts**. Per the CEO, brands need **separate reporting** (and required brand tagging) on these categories, and **roll up to "all brands"** on demand:

**Brand-REQUIRED account categories** (the "separate" set): **Revenue**, **Returns / contra-revenue**, **Dilution / discounts / allowances**, **Inventory adjustments**, **COGS**, and the **brand-specific expense accounts** the CEO designates.

**Brand-OPTIONAL (shared) categories:** shared overhead / G&A / admin expenses, and balance-sheet control accounts (cash, AR control, AP control) that are managed at the entity level.

> **Reconciliation note.** The CEO's axis answer was "brand required everywhere," but the detail ("same P&L as ROF, with separate revenue/returns/adjustments/dilution + *some* expenses") means *required on the categories above, optional on shared overhead* — otherwise every shared utility/rent JE line would need an artificial brand. **This is the recommended interpretation; please confirm, and hand over the exact list of brand-specific expense accounts** (or a rule, e.g. "all 5xxx COGS + the 6xxx marketing accounts"). Reports show per-brand columns with an **"(unassigned/shared)"** bucket for brand-less shared lines.

---

## 3. Tables that get the new columns

`brand_id` (FK `brand_master`) on every transactional + master row; `channel_id` (FK `channel_master`) where a channel applies (sales/order/AR rows, not AP-to-vendor or pure-GL overhead); `partition_id` on inventory rows.

| group | tables | new cols |
|-------|--------|----------|
| Master | `style_master`, `ip_item_master` | `brand_id` |
| Inventory | `ip_item_avg_cost`*, on-hand/layers | `partition_id` (+ keep denormalized `brand_id`) |
| Procurement | `tanda_pos`, `po_line_items` | `brand_id`, `channel_id` |
| GL | `gl_journal_entries`, `gl_journal_entry_lines` | `brand_id` (required on the §2 categories) |
| AR | `ar_invoices`, `ar_invoice_line_items`, `ar_receipts` | `brand_id`, `channel_id` |
| AP | `ap_invoices`, `ap_invoice_line_items`, `ap_payments` | `brand_id` (channel n/a) |
| Marketplace orders | `shopify_orders`(+lines), `fba_orders`, `walmart_orders`, `faire_orders` | `brand_id`, `channel_id` (channel implied by table but stored for uniformity) |
| Sales history | `ip_sales_history_wholesale`, `ip_sales_history_ecom` | `brand_id`, `channel_id` |
| Labels | `gs1_label_runs` | `brand_id` |

`*` **Gotcha (carried from v1):** `ip_item_avg_cost` already has a `brand_name` text column (`20260516000000_item_costing_brand.sql`). C1 promotes it to `partition_id` + keeps `brand_name`/`brand_id` denormalized for Xoro costing-report parity. Pre-flight `SELECT DISTINCT brand_name` to build the mapping; CEO approves before migration.

---

## 4. Revised chunk rollout

1. **C1 — schema + seed + backfill (additive, reversible).** `brand_master` (7 brands FK→entities), `channel_master` (5), `inventory_partition` + `brand_channel_partition` map (seed the §1.3 defaults). Add **nullable** `brand_id` / `channel_id` / `partition_id` to §3 tables. Backfill legacy rows to brand `ROF` + their channel (derive from source table: shopify→DTC, fba→FBA, etc.) + the matching partition. No enforcement, no behavior change.
2. **C2 — switchers + middleware in silent-log mode.** `<BrandSwitcher>` + `<ChannelSwitcher>` emit headers; `withBrandScope` / `withChannelScope` middleware logs cardinality mismatches into `brand_mismatch_log`, doesn't filter yet.
3. **C3 — active filter on operational reports.** AR aging, AP aging, inventory snapshot respect brand (+ channel where present) or "All."
4. **C4 — active filter on financials + required tagging.** TB / BS / P&L / GL detail slice-or-consolidate by brand; brand becomes **required** on the §2 categories for new AR/AP/JE writes (channel required on new sales/marketplace writes).
(No C5 brand-admin UI — brands are append-only and added by migration; see §5.)

Each chunk is one PR, gated on the prior. C1 is safe to build immediately on sign-off (nullable + backfill); the required-tagging flips wait until C4 after the account-category list is confirmed.

---

## 5. Brand administration (per CEO 2026-05-31)

Brands are a **stable, append-only** set — the CEO confirmed brands don't change (no renames/removals); occasionally a **new** brand is added alongside the existing ones. That makes administration trivial:

- **Canonical method:** adding a brand = a tiny idempotent **append migration** (`INSERT INTO brand_master (code,name,entity_id) … ON CONFLICT DO NOTHING;` + its `brand_channel_partition` rows). No edit/delete path needed. This is the accepted default.
- **Permission:** brand mutations are restricted to **super-admin** (RBAC `tenancy_admin` module, since brand is a sub-dimension of entity). Regular admins *assign* brands on transactions but don't *create* them.
- **No brand-admin UI planned.** Because brands are append-only and rare, the v1/C5 "Brands CRUD panel" is dropped — the migration path covers it. (Can be revisited if the cadence ever changes.)

> Design implication: since brands are append-only, **no `brand_id` is ever retired**, so historical rows never need re-pointing. New brands simply start receiving tagged transactions from their go-live date; older data stays on whatever brand it was backfilled to.

---

## 6. Open items for CEO sign-off

1. **Confirm the §1.3 partition defaults**, especially marketplace inventory (FBA own partition vs brand-Ecom partition).
2. **Hand over the brand-specific expense account list** (or a rule) for §2 — which expense accounts are brand-separated vs shared.
3. **Confirm brand codes** in §1.1 (short codes are baked into the seed + used in partition names).
4. **Backfill default** — legacy rows → brand `ROF`. Any historical rows that should map to a different brand? (If yes, supply a mapping; else all-legacy→ROF.)
5. **Channel for AP / vendor bills** — channel is omitted on AP (vendor-facing). Confirm that's fine (brand still applies).

---

## 7. Why brand-as-sub-dimension (unchanged from v1)

Sub-entity rejected (brands share tax/fiscal/COA — no benefit). Tag-only rejected (inventory needs a real partition FK). Orthogonal M×N entity↔brand rejected (no cross-entity brand use case; promotable later). Channel is modeled as its own light dimension rather than folded into brand because the CEO confirmed it as a separate axis and inventory-sharing rules differ by (brand, channel).
