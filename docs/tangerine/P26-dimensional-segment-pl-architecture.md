# P26 — Dimensional / Segment P&L Architecture

> Status: **DRAFT for CEO sign-off** (2026-06-29). No code written yet.
> Goal: view Revenue and all related accounts (returns, discounts, COGS, gross
> margin) sliced by **Brand × Channel × Store/Warehouse × Gender**, with the
> dimensions rendered as **configurable columns** (3 segments or many — operator
> picks). GL accounts stay **shared** (no per-dimension account proliferation).

---

## 1. CEO requirements (confirmed 2026-06-29)

1. See revenue + related accounts **by gender** (Men / Women / Boys / Girls / Child / Unisex).
2. See **Private Label / ROF DTC / PT DTC** (and more) as **columns** — fully
   configurable, "separate as much as I want," not capped at 3.
3. GL accounts may be **shared** across segments — the split is a *reporting*
   pivot, not new accounts.
4. Approach: **dimensional GL** (true GL tie-out), **plus historical rebuild**
   (past periods sliced the same way).
5. Dimensions wanted: **Brand, Channel, Store/Warehouse, Gender** (all four).

---

## 2. The problem with today's GL

`journal_entry_lines` carries only `account_id, debit, credit, memo, subledger_*`.
A `brand_id` column exists but **defaults to ROF and is never populated by the
posting code**; there is **no channel_id, no store, no gender** on the line.
Every sales path collapses to flat accounts:

| Path | Posts | Revenue acct | COGS acct |
|---|---|---|---|
| Wholesale / Private Label (Sales Order → AR invoice) | `ar-invoices/post.js` | **4000** | **5000** |
| ROF DTC / PT DTC (Shopify) | `_lib/shopify/post-order-je.js` + `shopify/post-cogs/[id].js` | **4000** | **5000** |
| Marketplaces (FBA/Walmart/Faire) | where wired | 4000 | 5000 |

So the GL knows the totals but **not** the segment mix. The dimension identity
exists on the *source documents* and is discarded at posting time.

---

## 3. Where the data lives (confirmed join paths)

Every revenue line resolves to **`ip_item_master`**, which carries
`gender_code`, `brand_id`, `style_code` — so **gender + brand are always
derivable** from a sale line.

| Source (sub-ledger) | Line → item join | Brand | Channel | Store/Warehouse |
|---|---|---|---|---|
| `ar_invoice_lines` | `.inventory_item_id` → `ip_item_master` | invoice `brand_id` / item | `ar_invoices.channel_id` (default WHOLESALE) | linked `sales_orders.sale_store` |
| `shopify_order_lines` | `.ip_item_master_id` → `ip_item_master` | order `brand_id` / item | DTC | `shopify_orders.shopify_store_id` → `shopify_stores` (= ROF DTC vs PT DTC) |
| `ip_sales_history_ecom` *(history)* | `.sku_id` → `ip_item_master` | item `brand_id` | `channel_id` | DTC store |
| `ip_sales_history_wholesale` *(history)* | `.sku_id` → `ip_item_master` | item `brand_id` | `channel_id` | ROF Main (wholesale) |

`ip_sales_history_*` is gold for the historical rebuild — it already holds
`qty, gross_amount, discount_amount, refund/returned, net_amount, cogs_amount,
margin_amount, margin_pct` + `channel_id`, and joins to gender/brand/style via
`sku_id`. The only weak spot historically is precise warehouse (ecom≈DTC store,
wholesale≈ROF Main).

### Dimension masters
- **Brand** — `brand_master` (8: ROF, PT, Departed, Fort Knox, Blue Rise, Axe
  Crown, MPL Epic, MPL Sun & Stone).
- **Channel** — `channel_master` (DTC/Shopify, Wholesale/EDI, FBA, Walmart, Faire).
- **Store/Warehouse** — `inventory_locations` (Main Warehouse, Psycho Tuna, PT
  Ecom, ROF Ecom) + `sales_orders.sale_store` (text, reconciled mig 20260925).
- **Gender** — `style_master.gender_code` / `ip_item_master.gender_code`
  (M, W, B, C, G, U).

### Segment definitions (examples — columns are operator-built)
- **Private Label** = brand ∈ {MPL Epic, MPL Sun & Stone} (Macy's PL; wholesale).
- **ROF DTC** = brand ROF + channel DTC.
- **PT DTC** = brand PT + channel DTC.

---

## 4. Architecture — hybrid dimensional fact + forward GL tagging

Because posted JE lines are **immutable** (P0001 trigger) and the CEO wants
history too, we build **two reconciled layers**:

### Layer A — `fact_sales_dimensional` (the reporting cube; covers ALL periods)
A purpose-built fact table at the finest grain, fed from the sub-ledgers:

```
fact_sales_dimensional (
  id, entity_id, posting_date,
  account_code,            -- 4000 / 4100 returns / 4200 disc / 5000 COGS …
  brand_id, channel_id, store_key, gender_code,   -- the 4 dimensions
  qty, amount_cents,       -- signed; revenue CR positive, contra negative
  source, source_doc_type, source_doc_id,         -- provenance / drill
  je_id                    -- NULL for history-only rows; set when GL-tied
)
```

- **History backfill**: one-time + incremental ETL from
  `ip_sales_history_wholesale` + `ip_sales_history_ecom` (and AR/Shopify for the
  GL-era), exploded per `sku_id` so each row already has gender/brand/channel.
- **Forward**: same rows generated at posting time (or derived from the JE's
  source doc), with `je_id` set so they tie to the GL.
- **Reconciliation view**: `SUM(amount) by account_code` from this table must
  equal the GL `income_statement` per account per period — surfaced as a
  variance report so we can prove the cube ties out.

This layer **alone** answers the CEO's question for **all** periods and is the
source for the configurable report.

### Layer B — dimension tags on `journal_entry_lines` (forward, audit tie-out)
For new postings, stamp the JE line with `brand_id` (populate the existing col),
`channel_id`, `store_key`, `gender_code`, **and explode revenue/COGS lines per
(gender × brand × channel × store)** so the *real* GL is dimensional going
forward. This is the GL-critical change (changes the shape of every sales JE).

> **Gender forces line explosion.** Today a sale books one `Cr 4000`. To carry
> gender in the GL, the JE builders must emit one revenue line + one COGS line
> per gender group. The fact table (Layer A) gets this "for free" from the
> sub-ledger; Layer B requires changing `ar-invoices/post.js`,
> `_lib/shopify/post-order-je.js`, and `shopify/post-cogs`.

---

## 5. The configurable Income Statement / Segment P&L

New endpoint `GET /api/internal/segment-pl` (pivot over Layer A, falls back to /
reconciles with the GL):

- Params: `from, to, basis, rows=accounts|gender, columns=[brand|channel|store|gender|<filter expr>]`.
- A **column builder** UI: operator defines each column as a filter over the
  dimensions — `{brand:ROF, channel:DTC}` → "ROF DTC"; `{brand:[MPLEPIC,MPLSUNSTONE]}`
  → "Private Label"; etc. N columns, saved as named layouts.
- Rows = revenue + contra-revenue + COGS + Gross Margin (+ %), optionally with
  gender sub-rows.
- Universal export (xlsx) per the suite rule.

### Shape (illustrative)
```
                       │ Private Label │ ROF DTC │ PT DTC │  …  │  Total
 Gross Revenue (4000)  │    412,300    │ 168,900 │ 94,200 │     │ 675,400
   ├ Men               │    250,100    │ 120,400 │ 61,000 │     │ 431,500
   ├ Women             │    140,200    │  42,500 │ 28,900 │     │ 211,600
   └ Other             │     22,000    │   6,000 │  4,300 │     │  32,300
 Returns (4100)        │   (18,400)    │ (12,100)│ (5,600)│     │ (36,100)
 Discounts (4200)      │    (9,200)    │  (8,700)│ (3,100)│     │ (21,000)
 Net Revenue           │    384,700    │ 148,100 │ 85,500 │     │ 618,300
 COGS (5000)           │  (242,000)    │ (71,300)│(40,800)│     │(354,100)
 Gross Margin          │    142,700    │  76,800 │ 44,700 │     │ 264,200
 Gross Margin %        │     37.1%     │  51.9%  │ 52.3%  │     │  42.7%
```

---

## 6. Phased plan

- **Phase 0 — discovery/recon (1 pass).** Confirm: returns/discount account codes
  in COA (4100/4200?), marketplace posting status, store_key normalization
  (sale_store ↔ inventory_locations ↔ shopify_store), and tie-out of
  `ip_sales_history_*` totals vs GL revenue per period.
- **Phase 1 — Layer A fact table + history backfill + reconciliation view.**
  Delivers the full configurable cube for **all** periods (history included),
  read-only, zero risk to posting. *This answers the CEO's question end-to-end.*
- **Phase 2 — Segment P&L API + configurable column-builder UI + export.**
- **Phase 3 — Layer B: forward GL dimension tags + sales-JE line explosion.**
  GL-critical; gated, well-tested, forward-only. Makes the *real* Income
  Statement dimensional and audit-clean.
- **Phase 4 — wire the standard Income Statement panel to offer the segment
  pivot toggle** (so it's not a separate report island).

## 6b. PHASE 0 FINDINGS (prod recon 2026-06-29) — REFRAMES THE PROJECT

Ran read-only diagnostics on PROD. The result changes the priority order:

**The Tangerine GL is empty of sales.** Entire `journal_entries` = **2 rows**,
`journal_entry_lines` = **4 rows** (one asset/expense test pair, net $10,010).
**Zero revenue (4xxx) or COGS (5xxx) postings exist.** AR invoices = 2, both
`gl_status='draft'` (never posted). Shopify orders = 460, **0 posted** (all
`je_id` NULL). So Tangerine is **not** the system of record for sales today.

**The real sales history lives in `ip_sales_history_wholesale`:** **50,249 rows,
$41.58M net, 2025-01-01 → 2026-06-26**, with COGS + margin. `ip_sales_history_ecom`
is **EMPTY** (0 rows) — DTC history is not captured here.

**The cube is PROVEN** — brand (via `style_master` by `style_code`) × gender ×
margin computes cleanly off wholesale history (net sales $ and GM% per brand/
gender). Brand totals: Ring of Fire ~$29.7M, Axe Crown $4.65M, Psycho Tuna
$1.81M, Blue Rise $1.54M, MPL Epic $1.07M (PL), Departed $0.91M, MPL Sun & Stone
$0.46M (PL), Fort Knox ~$0.31M, unbranded ~$0.44M.

**The COA already has segment revenue accounts** (legacy QB): 4008 PT Ecom, 4011
ROF Ecom, 4009 PT, 4012 Private Label, 4005 ROF Brands, 4006 Boys, etc. — but
nothing posts to them in Tangerine.

### Reframed recommendation
- **Layer A (sub-ledger dimensional cube) IS the answer**, not just phase 1. It
  works today on real data for the **wholesale + Private Label** business (~$41.6M).
  Build the Segment P&L off `ip_sales_history_wholesale` now.
- **Layer B (GL line tagging + explosion) is MOOT right now** — there is no
  posted revenue in the Tangerine GL to tag. Defer until/unless the org decides
  Tangerine becomes the posting GL (a separate, larger decision; QB is current GL).
- **DTC gap is the real open item.** `ip_sales_history_ecom` is empty and only
  460 unposted Shopify orders exist (likely a recent webhook window, not full
  history). ROF DTC / PT DTC need a history source: backfill Shopify and/or
  import DTC from QuickBooks/Shopify analytics.
- **Data hygiene surfaced:** gender code still `'WMS'` (not normalized to `'W'`)
  in `ip_item_master`; ~$0.44M sales on styles with no `style_master` brand;
  Fort Knox missing COGS.

## 7. Risks / open decisions
- **Line explosion (Phase 3)** changes every sales JE shape — needs careful
  testing + approvals; keep behind a flag during rollout.
- **History fidelity**: store/warehouse is approximate for pre-GL Xoro history.
- **Returns/discounts**: confirm contra-revenue accounts exist + are populated
  per segment (Shopify discount is on the order; wholesale via credit memos).
- **Reconciliation**: Layer A must tie to GL per account/period or the CEO sees
  two "truths." The variance report is mandatory, not optional.
