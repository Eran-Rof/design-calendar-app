# Demand & Inventory Planning — Phase 3 (Supply Reconciliation + Allocation)

Turns the Phase 1 wholesale forecasts and Phase 2 ecom forecasts into
actionable **buy / expedite / hold / reduce / reallocate / push /
cancel / protect** decisions.

Rule-based. Deterministic. Every number in the grid can be traced back
through the allocation waterfall in the detail drawer.

## What ships

- **Migration** `supabase/migrations/20260419840000_inventory_planning_phase3.sql`:
  - ALTER `ip_planning_runs` — adds `wholesale_source_run_id`, `ecom_source_run_id`
  - CREATE `ip_projected_inventory` — one row per (run, sku, period)
  - CREATE `ip_inventory_recommendations` — cross-lane recs with priority
  - CREATE `ip_allocation_rules` — reserve / protect / strategic / cap
  - CREATE `ip_supply_exceptions` — exception log
  - CREATE `ip_vendor_timing_signals` — optional vendor risk metadata
- **Types** `src/inventory-planning/supply/types/supply.ts`
- **Compute** `src/inventory-planning/supply/compute/*` — all pure:
  - `supplyReconciliation.ts` — `buildProjectedInventory`,
    `totalAvailableSupply`, `activeRulesForSku`
  - `allocationEngine.ts` — `computeAllocation` (the waterfall) and
    `splitAllocation` helper
  - `recommendationEngine.ts` — `generateInventoryRecommendations`
  - `exceptionEngine.ts` — `generateSupplyExceptions`
- **Services** `src/inventory-planning/supply/services/*`:
  - `supplyReconciliationRepo.ts` — REST CRUD over Phase 3 tables
  - `supplyReconciliationService.ts` — `runReconciliationPass(run)`,
    `buildReconciliationGrid(run)`
- **UI** at `/planning/supply`:
  - `ReconciliationWorkbench` — parent, run picker, new-run modal that
    explicitly links wholesale + ecom source runs
  - `ReconciliationGrid` — 18-column grid with stats, filters, row
    click to drawer
  - `SupplyExceptionPanel` — severity-grouped exception list
  - `AllocationDetailDrawer` — supply / demand breakdown + waterfall
    trace + applied rules + all recommendations
- **Seed** `supabase/seed/inventory_planning_phase3_fixtures.sql` — a
  strategic-customer reserve, a protect_ecom rule, vendor timing, and
  a draft reconciliation run linking the Phase 1 / Phase 2 demo runs.
- **Tests** (new):
  - `supplyAllocation.test.ts` — waterfall ordering, shortage / excess,
    rule types, split allocation
  - `supplyRecommendations.test.ts` — recommendation branches + every
    exception type

## Supply input assumptions

```
total_available_supply_qty =
    beginning_on_hand_qty
  + inbound_receipts_qty           -- historical receipts in-period
  + inbound_po_qty                 -- open POs expected in-period
  + wip_qty
```

- **`beginning_on_hand_qty`** — from the latest `ip_inventory_snapshot`
  at the run's `source_snapshot_date`. Rolls forward: the
  `ending_inventory_qty` of month N becomes the beginning on-hand of
  month N+1, so a multi-month horizon stays coherent without re-using
  the same snapshot every month.
- **`ats_qty`** — read from the snapshot's `qty_available`. Stored for
  the UI only. **Not added** to `total_available_supply_qty` — most
  ERPs define ATS as a view of on-hand minus commitments, so adding
  both double-counts.
- **`inbound_receipts_qty`** — `ip_receipts_history` rows whose
  `received_date` falls in the period. For past periods this is real
  landed qty; future periods will always be 0.
- **`inbound_po_qty`** — `ip_open_purchase_orders` rows whose
  `expected_date` falls in the period, summed.
- **`wip_qty`** — intentionally 0. Resolved as a *timing* refinement, not a
  separate bucket: "inbound PO is WIP" (the open-PO qty already IS the
  in-production supply, so adding a WIP qty would double-count). Instead the
  open PO's `expected_date` is taken from the Tanda "In House / DDP" milestone
  (`days_before_ddp = 0`) in `syncOpenPosFromTandaPos`, so WIP lands in the
  right month. See `docs/tangerine/user-guide/33-…` §33.8 (M31/P17 step 5).

## Demand input assumptions

- **Wholesale demand**: `ip_wholesale_forecast.final_forecast_qty` summed
  by `(sku, period_start)` from the **`wholesale_source_run_id`** on the
  reconciliation run.
- **Ecom demand**: `ip_ecom_forecast.final_forecast_qty` summed by
  `(sku, month-containing-week_start)` from the
  **`ecom_source_run_id`**. Protected qty uses
  `ip_ecom_forecast.protected_ecom_qty` the same way.
- If either source run is missing (NULL on the reconciliation run), that
  lane contributes zero.

## Allocation waterfall (authoritative order)

1. **Reserved wholesale** — sum of active `reserve_wholesale` +
   `strategic_customer` rules matching the (sku, category, customer).
   `reserve_qty` wins if set; otherwise `reserve_percent × wholesale_demand`.
   Total capped at `wholesale_demand_qty`.
2. **Protected ecom** — Phase 2's `protected_ecom_qty` (per week, summed
   to month) optionally augmented by active `protect_ecom` rules.
   Capped at `ecom_demand_qty`.
3. **Remaining wholesale** — `wholesale_demand − reserved_taken`.
4. **Remaining ecom** — `ecom_demand − protected_taken`, optionally
   further capped by a `cap_ecom` rule (lowest `priority_rank` wins).
5. `ending_inventory_qty = supply_left_after_step_4`.
6. `shortage_qty = max(0, total_demand − allocated_total)`.
7. `excess_qty = max(0, total_supply − total_demand)`.

The `AllocationDetailDrawer` shows a step-by-step trace including the
supply left after each step, matching what the compute did.

## Recommendation logic

Thresholds live in `recommendationEngine.ts` and are exported for
tweaking (`SHORTAGE_PCT_TRIGGER = 10%`, `EXCESS_PCT_TRIGGER = 30%`,
`EXPEDITE_WITHIN_DAYS = 30`, `MONITOR_FLOOR_QTY = 6`,
`CRITICAL_SHORTAGE_FRACTION = 25%`).

| Recommendation | Trigger |
|---|---|
| `expedite` | Shortage ≥ 10% of demand **and** period starts ≤ 30 days from today. |
| `buy` | Shortage ≥ 10%, period not imminent. |
| `cancel_receipt` | Excess ≥ 30% of demand **and** an inbound PO that covers it lands in-period. |
| `push_receipt` | Excess + inbound PO but excess < PO qty (push the PO later). |
| `reduce` | Excess ≥ 30%, no inbound PO to defer. |
| `hold` | Supply / demand within tolerance. |
| `monitor` | Past periods, or demand below the monitor floor. |
| `protect_inventory` | Protected ecom shortfall flagged by the service context. |
| `reallocate` | Strategic reserve shortfall flagged by the service context. |

Priority: `critical` when shortage ≥ 25% of demand, else `high` for
forward-period shortages and `medium` for excess recommendations,
`low` for hold / monitor.

## Exception logic

Produced by `generateSupplyExceptions` and stored in `ip_supply_exceptions`:

| Type | Severity rule |
|---|---|
| `projected_stockout` | `critical` ≥ 25% shortage · `high` ≥ 10% · else `medium` |
| `negative_ats` | Always `high` — signals bad data. |
| `late_po` | `medium` — any open PO expected after period_end while row is short. |
| `excess_inventory` | `high` if excess ≥ demand, else `medium` (≥ 30% trigger). |
| `supply_demand_mismatch` | `low` — supply=0 xor demand=0. |
| `missing_supply_inputs` | `high` — all four buckets=0 AND demand>0. |
| `protected_not_covered` | `high` — Phase 2 protected floor wasn't met. |
| `reserved_not_covered` | `high` — strategic reserve wasn't covered. |

Each exception row carries `details` JSONB with the exact values that
triggered it, so the panel can show `shortage_qty=60 · demand=120 · supply=60`.

## Known limitations

- **WIP = inbound PO.** `wip_qty` stays 0 by design; WIP is the open PO,
  now timed by the Tanda "In House / DDP" milestone (M31/P17 step 5).
- **No scenario comparisons.** The reconciliation produces one plan per
  run. Scenario diffing is Phase 4.
- **No approvals / ERP writeback.** Recommendations are advisory. Phase
  4 adds approval state + a Xoro writeback adapter.
- **Customer-level reserve can't be enforced per-customer in allocation.**
  The waterfall allocates in aggregate; the optional `splitAllocation`
  helper can distribute the total by demand weight, but the reserve
  itself is applied to aggregate wholesale demand.
- **Ecom weekly → monthly roll-up is the only aggregation.** Phase 4
  may surface the weekly detail in the drawer for planners who want
  intra-month visibility.
- **No SLA on cache invalidation.** When a Phase 1 or Phase 2 forecast
  is re-run, the reconciliation doesn't auto-rebuild — click **Run
  reconciliation** again.

## How Phase 4 uses this

- `ip_projected_inventory` + `ip_inventory_recommendations` are the
  hand-off tables. A Phase 4 scenario workbench can clone a run, apply
  a what-if (extra reserve, lower ecom demand, a specific PO push) and
  diff the outputs.
- The `priority_level` column is the entry point for an approval
  workflow: `critical` / `high` recs can require sign-off before export.
- Existing ERP writeback path (eventually): take approved `buy` and
  `expedite` rows → create Xoro POs via the existing proxy. The rec
  row already carries `recommendation_qty` and a reason string.

## Running locally

1. Apply the migration (`supabase db push --linked` with the usual
   park-then-restore for any unrelated pending migration).
2. Optionally apply
   `supabase/seed/inventory_planning_phase3_fixtures.sql` to create the
   demo allocation rules, vendor timing, and the `Demo Recon — YYYY-MM`
   run. It links itself to the existing Phase 1/2 demo runs if present.
3. `/planning/supply` → pick the demo reconciliation run → **Run
   reconciliation** → click any row to inspect the waterfall.
