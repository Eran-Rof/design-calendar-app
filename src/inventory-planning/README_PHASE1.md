# Demand & Inventory Planning — Phase 1 (Wholesale MVP)

Wholesale forecasting by customer → category → SKU, with planner
overrides, future buyer requests, and lightweight supply-context
recommendations. Phase 0 established the data contract; this phase adds
the workflow.

## What ships

- **Migration** `supabase/migrations/20260419820000_inventory_planning_phase1.sql`
  — 5 tables: `ip_planning_runs`, `ip_wholesale_forecast`,
  `ip_future_demand_requests`, `ip_planner_overrides`,
  `ip_wholesale_recommendations`.
- **Compute** `src/inventory-planning/compute/` — pure functions for
  period math, the forecast stack, supply assembly, and recommendations.
- **Service** `src/inventory-planning/services/` — repo layer over
  Supabase REST + `runForecastPass`, `applyOverride`, `buildGridRows`.
- **UI** `src/inventory-planning/panels/` +
  `src/inventory-planning/components/` — `WholesalePlanningWorkbench`
  page mounted at `/planning/wholesale`. Grid + filters, buyer-requests
  CRUD panel, forecast detail drawer with the override form.
- **Seed** `supabase/seed/inventory_planning_phase1_fixtures.sql` — ~14
  months of sales history, an open PO book, and a draft planning run for
  a demo.

## Forecast stack

The baseline runs per (customer, SKU) pair. First hit wins:

| # | Method                          | Trigger                                                                                                  | Formula (per month) |
|---|---------------------------------|----------------------------------------------------------------------------------------------------------|---------------------|
| 1 | `trailing_avg_sku`              | ≥ 3 months of non-zero history in the last 12 on the pair.                                               | `sum(last12) / 12`  |
| 2 | `weighted_recent_sku`           | Same as (1) **and** `sum(last3) ≥ 30% × sum(last12)` **and** `recent3/3 > last12/12`. Replaces (1).      | `sum(last3) / 3`    |
| 3 | `cadence_sku`                   | 1–2 non-zero months in the last 12, with some qty.                                                       | `(total / non_zero_months) / cadence_months` |
| 4 | `category_fallback`             | No pair history but the (customer, category) has 6-month activity.                                       | `sum(cat6) / 6 / active_sku_count` |
| 5 | `customer_category_fallback`    | No category, but the customer has activity in the last 3 months.                                         | `sum(cust3) / 3 / active_sku_count` |
| 6 | `zero_floor`                    | Nothing matched.                                                                                         | `0`                 |

Implementation: `src/inventory-planning/compute/forecast.ts`
(`baselineForPair`). Every path is commented with its reasoning.

### Final forecast (authoritative)

```
final_forecast_qty = max(0, system_forecast_qty + buyer_request_qty + override_qty)
```

**Override is an additive signed delta, not a replacement.** To set final
to 100 when the system says 70, a planner enters an override of +30. The
three sources stay independently auditable in the row and in the trail
at `ip_planner_overrides`.

### Confidence levels

| Level       | When                                                                                  |
|-------------|---------------------------------------------------------------------------------------|
| `committed` | A `committed` buyer request touches the period.                                       |
| `probable`  | A `probable` buyer request, **or** SKU history with ≥ 6 non-zero months in last 12.   |
| `possible`  | SKU cadence / SKU average on 3–5 non-zero months.                                     |
| `estimate`  | Fallbacks (category / customer) and `zero_floor`.                                     |

When a buyer request applies to a period, we take
`max(baseline_confidence, request_confidence)` so a committed request
upgrades a sparse baseline.

## Override logic

- `override_qty` on `ip_wholesale_forecast` is the **current** override
  and is signed (delta, can be negative).
- Every edit writes an immutable row to `ip_planner_overrides` with
  `reason_code` and `note`. The drawer shows the trail newest-first.
- Reason codes (matches DB CHECK): `buyer_request`, `planner_estimate`,
  `management_input`, `launch_expectation`, `customer_expansion`,
  `supply_adjustment`.

## Recommendation logic

`ip_wholesale_recommendations` is rebuilt on every forecast pass. Per row:

```
shortage = max(0, final − available_supply)
excess   = max(0, available_supply − final)
```

Thresholds (all tweakable in `DEFAULT_THRESHOLDS`):

| Action    | Rule                                                                                       |
|-----------|--------------------------------------------------------------------------------------------|
| `hold`    | Within ±10% of forecast (or zero × zero).                                                  |
| `buy`     | Shortage ≥ 10% of forecast **and** forecast ≥ monitor floor (6 units).                     |
| `expedite`| `buy` conditions **and** period starts within 30 days from today.                          |
| `reduce`  | Excess ≥ 25% of forecast.                                                                  |
| `monitor` | Past period; **or** shortage that falls under the monitor floor.                           |

`available_supply` is `on_hand + receipts_due_in_period`, where
`receipts_due_in_period` combines actual `ip_receipts_history` rows
landed in-period and open POs with `expected_date` in-period.

## Workflow

1. Planner creates a **planning run** (name + snapshot date + horizon).
   Runs have status `draft` / `active` / `archived`. Multiple active runs
   are allowed.
2. Planner files **future demand requests** (customer, SKU, target month,
   qty, type, confidence, note).
3. Planner clicks **Build forecast**. The service:
   - reads 12 months of wholesale sales (Phase 0 normalized history)
   - reads open requests, overrides, supply
   - computes baseline → applies requests → applies overrides
   - upserts `ip_wholesale_forecast` on the grain index
   - regenerates `ip_wholesale_recommendations` using supply-in-period
4. Planner reviews the **grid**. Clicks a row to open the **drawer**.
5. In the drawer the planner enters an **override** with a reason code.
   The service logs the edit and updates the forecast row.
6. To republish with newer history: click **Build forecast** again — it
   re-uses stored overrides and requests (latest wins).

## Period grain

Monthly (`period_code` = `YYYY-MM`). `period_start` = first of month,
`period_end` = last calendar day. Helpers in `compute/periods.ts` are
strictly UTC. Weekly grain is a one-file change — swap `monthsBetween`
for `weeksBetween` in the compute layer.

## Tests

21 new vitest cases under `src/inventory-planning/__tests__/`:

- `periods.test.ts` — month math, leap years, year boundaries.
- `forecastCompute.test.ts` — dense / ramp / cadence / category
  fallback / zero floor; buyer request without history; negative override
  floored at zero; end-to-end layering.
- `recommendations.test.ts` — buy / expedite / reduce / hold / monitor;
  monitor floor; past period; custom thresholds.
- `supply.test.ts` — on-hand, open PO, receipts-due.

Full suite: **611 passing**.

## Seeding the demo

```sql
-- In Supabase SQL editor (after applying 20260419820000...):
\i supabase/seed/inventory_planning_phase1_fixtures.sql
```

All demo rows are prefixed `DEMO-` for easy cleanup. The seed creates a
`Demo — YYYY-MM` planning run with a 3-month horizon, sales patterns for
dense / sparse / ramp / no-history, and two open buyer requests.

## Known gaps / Phase 2

- **Ecom planning.** Shopify-based ecom forecasting is Phase 2. The
  `planning_scope` column already supports it.
- **Shared supply allocation.** Today `available_supply_qty` is
  un-netted — wholesale rows don't compete with an ecom forecast for the
  same on-hand pool. Phase 2 adds the allocation engine.
- **Seasonality.** Baseline assigns the same monthly qty across the
  horizon. A month-of-year index would be a cheap Phase 2 add.
- **Style-level forecast.** Grain is customer × SKU × period. Style
  rollup is a read-time aggregation today; a persisted style forecast
  may help very-fragmented catalogs in Phase 2.
- **Inline edits.** Override editing runs through the drawer. Inline
  edit from the grid row is a planner quality-of-life ask for Phase 2.
- **Export.** Table is CSV-exportable via the browser, but a first-class
  Excel export (matching the ATS export convention) is Phase 2.
- **Multi-user audit.** `created_by` is plumbed through but the internal
  app still uses the JSON-blob user store; wiring the real user into
  overrides/requests is Phase 2.
- **ERP writeback.** No PO creation, no Xoro writeback. Deferred to a
  later phase — only after planner trust in the numbers is established.
- **Run reset.** There's no "delete all forecast rows for a run" button
  yet — the build upserts but doesn't prune SKUs that dropped out. Safe
  for MVP, but add a prune pass when history gets long.

## Running locally

- Apply the migration in Supabase dashboard.
- Optionally apply the fixtures SQL to get a working demo run.
- `npm run dev`, then navigate to `/planning/wholesale`.
