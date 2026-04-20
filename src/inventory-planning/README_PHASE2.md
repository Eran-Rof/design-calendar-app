# Demand & Inventory Planning — Phase 2 (Ecom MVP)

Shopify-powered ecom forecasting at the **channel × category × SKU × week**
grain. Shares the data-contract / run / override conventions from Phase 0
and Phase 1, but keeps its math and UI in a dedicated subtree so the
wholesale lane stays untouched.

Primary source of truth: **Shopify** (orders, products, returns).
Xoro is not consulted here.

## What ships

- **Migration** `supabase/migrations/20260419830000_inventory_planning_phase2.sql`:
  - ALTER `ip_sales_history_ecom` — adds `customer_id`
  - ALTER `ip_product_channel_status` — adds `is_active` / `launch_date`
    / `markdown_flag` / `inventory_policy` + backfills `is_active` from
    the Phase 0 `listed` + `status`
  - CREATE `ip_ecom_forecast` — weekly forecast rows with explicit factor
    columns (`seasonality_factor`, `promo_factor`, `launch_factor`,
    `markdown_factor`, `return_rate`, `trailing_4w_qty`,
    `trailing_13w_qty`) and `protected_ecom_qty`
  - CREATE `ip_ecom_override_events` — append-only audit trail
- **Types** `src/inventory-planning/ecom/types/ecom.ts`
- **Compute** `src/inventory-planning/ecom/compute/ecomForecast.ts`
- **Services** `src/inventory-planning/ecom/services/*`:
  - `ecomForecastRepo.ts` — REST repo
  - `ecomForecastService.ts` — `runEcomForecastPass`, `applyEcomOverride`,
    `buildEcomGridRows`, `loadEcomChartSeries`
  - `shopifyIngestService.ts` — promotes `raw_shopify_payloads` into
    `ip_sales_history_ecom` and `ip_product_channel_status`
- **UI** `src/inventory-planning/ecom/panels/*` at `/planning/ecom`:
  - `EcomPlanningWorkbench` — parent page, run picker, ingest button,
    build button, grid/chart tabs
  - `EcomPlanningGrid` — all spec columns + flags + trend %
  - `EcomForecastChart` — Recharts line chart with history + forecast
    and a "forecast →" boundary line
  - `EcomOverrideDrawer` (in `components/`) — number breakdown, factors,
    flag toggles, override form + trail
- **Shopify server wrappers** (Phase 0 held the scaffolds): already
  writing to `raw_shopify_payloads`. Phase 2 normalization runs in the
  browser via `shopifyIngestService` — moving it to a scheduled route is
  Phase 3.
- **Weekly period helpers** in `src/inventory-planning/compute/periods.ts`
  (ISO 8601, Monday-start).
- **Seed** `supabase/seed/inventory_planning_phase2_fixtures.sql` — demo
  channel + items covering every forecast branch.
- **Tests** 26 new vitest cases (periods weekly, factor functions, every
  forecast branch, stability). Full suite now: **TODO N passing** (run
  `npm test` to get the current total).

## Forecast stack (authoritative order)

```
system_forecast_qty =
  baselineGrossQty                           -- step 1 (trailing / launch / category / zero)
    × seasonality_factor                     -- step 2 (month-of-year, clamped 0.6–1.4)
    × promo_factor                           -- step 3 (1.6× default if a promo covers the week)
    × launch_factor                          -- step 4 (applied in step 1 for new SKUs)
    × markdown_factor                        -- step 5 (1.8× weeks 0–1, 1.2× thereafter)
    × (1 − min(return_rate, 0.6))            -- step 6 (net demand after returns)

final_forecast_qty = max(0, system_forecast_qty + override_qty)
protected_ecom_qty = final_forecast_qty      -- MVP policy (Phase 3 tunes)
```

### Baseline (step 1) branches

1. **`weighted_recent`** — ≥ 4 non-zero weeks of 13 and `rr4 > rr13`
   (with `rr4` capped at `2 × rr13` so a one-week spike can't run away).
2. **`trailing_13w`** — ≥ 4 non-zero weeks of 13 but `rr13 ≥ rr4`.
3. **`trailing_4w`** — < 13 weeks of history, at least 4 non-zero weeks.
4. **`launch_curve`** — `launch_date` set and we're 0–7 weeks past; use
   `LAUNCH_BASELINE_UNITS × LAUNCH_CURVE[week]`.
5. **`category_fallback`** — none of the above, but the (channel,
   category) had last-4-week activity. Uses
   `sum(cat_last4) / 4 / active_sku_count`.
6. **`zero_floor`** — nothing matched.

### Tunables (all in `ecomForecast.ts`)

| Constant | Default | What it does |
|---|---|---|
| `LAUNCH_CURVE` | `[0.30, 0.55, 0.75, 0.90, 0.98, 1.00, 1.00, 1.00]` | 8-week ramp from launch |
| `LAUNCH_BASELINE_UNITS` | `12` | Planner-assumed steady-state for a launching SKU |
| `PROMO_UPLIFT_DEFAULT` | `1.6` | Promo multiplier when a window covers the week |
| `MARKDOWN_INITIAL_UPLIFT` | `1.8` | Weeks 0–1 on markdown |
| `MARKDOWN_DECAY_UPLIFT` | `1.2` | Weeks 2+ on markdown |
| `RETURN_RATE_CAP` | `0.6` | Never assume > 60% returns |

## Override logic

- `override_qty` on the forecast row is the current delta and is signed.
- Every edit appends a row to `ip_ecom_override_events` with `reason_code`
  and `note` — immutable audit.
- Reason codes (match DB CHECK):
  `promotion`, `campaign`, `content_push`, `influencer`,
  `launch_expectation`, `markdown_strategy`, `planner_estimate`.
- The drawer's **flag toggles** (promo / launch / markdown) patch the
  flags directly on the forecast row — they don't feed the audit log
  because they're merchandising context, not demand decisions.

## Protected ecom demand

`protected_ecom_qty` is a first-class column on `ip_ecom_forecast`.
Phase 2 sets it equal to `final_forecast_qty` (full ecom protection).
The Phase 3 allocation layer reads this column **before** pulling the
shared inventory pool for wholesale, so Phase 3's policy work happens in
the allocation service — this column just says "here's what ecom needs".

No allocation runs in Phase 2. Nothing nets `protected_ecom_qty` against
on-hand.

## Ingest flow

```
Shopify Admin REST
       │  (Phase 0: api/shopify/{orders,products,...}.js)
       ▼
raw_shopify_payloads                        (Phase 0: jsonb + source_hash dedupe)
       │  (Phase 2: shopifyIngestService.ts — browser-side MVP)
       ▼
ip_sales_history_ecom         ← orders
ip_product_channel_status     ← products (status, launch_date, markdown_flag)
ip_item_master                ← product variants not yet in Xoro
       │
       ▼
runEcomForecastPass(run)
       │  reads: history + product_channel_status + overrides
       │  writes: ip_ecom_forecast (upsert on grain)
       ▼
ip_ecom_forecast              (grid + chart read from here)
```

## Planner workflow

1. On `/planning/ecom`, pick or create a run (`planning_scope = 'ecom'`).
   Horizon defaults to ~8 weeks from today.
2. Click **Ingest Shopify raw → normalized** once after a Shopify pull.
   (This batch is idempotent; running twice is harmless.)
3. Click **Build ecom forecast**. Get a toast with counts.
4. Filter the grid (channel / category / active / launch / promo). Click
   a row to open the drawer.
5. Toggle `promo` / `launch` / `markdown` flags on the drawer (they
   persist immediately but don't retrigger the compute — rebuild when
   you want the math to reflect them).
6. Enter an override delta + reason → hit **Save override**.
7. Switch to the **Chart** tab to see the 26-week history + horizon
   forecast for the selected SKU.

## Assumptions & limitations

- **Weekly grain only.** Wholesale runs monthly; ecom runs weekly. The
  grain is intentionally different.
- **Shopify is authoritative for ecom.** If a SKU exists only in Xoro
  and we see no Shopify history for it, it will land `zero_floor` and
  won't show on the grid unless `ip_product_channel_status` has a row.
- **Flag changes don't retrigger compute.** If you set `markdown_flag`
  the grid shows the flag chip immediately, but `system_forecast_qty`
  reflects what was computed at build time. Re-run to refresh.
- **Customer ingestion not wired.** `customer_id` is on the history row
  but ecom ingest leaves it NULL for MVP.
- **No seasonality below 6 months of history.** The factor map is
  computed per pair; without enough distinct months we use 1.0.
- **No cross-channel aggregation.** A SKU selling on two Shopify
  storefronts produces two independent forecasts.
- **Inline edits from the grid are drawer-only.** Matches Phase 1.

## How Phase 3 uses this

- `protected_ecom_qty` is the hand-off column. Allocation reads it per
  (channel, sku, week) and nets it against available supply before
  fulfilling wholesale.
- `ip_ecom_forecast` survives across phase upgrades — the allocation
  layer never writes it. Only the compute + override flow does.
- If Phase 3 introduces policy (e.g. "protect only 80% of ecom final"),
  that policy patches `protected_ecom_qty` during the allocation pass,
  keeping all the compute / trail / UI in Phase 2 unchanged.

## Running locally

1. Apply `supabase/migrations/20260419830000_inventory_planning_phase2.sql`
   via the Supabase dashboard (or run `supabase db push --linked`).
2. Optionally apply `supabase/seed/inventory_planning_phase2_fixtures.sql`
   for the demo patterns.
3. `npm run dev` → `/planning/ecom`.
