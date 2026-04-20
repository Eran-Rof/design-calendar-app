# Demand & Inventory Planning — Phase 4 (Scenarios, Approvals, Exports)

Turns the planning module into a usable workflow. A planner can:
- save versioned what-ifs off a base planning run
- adjust demand / supply / allocation assumptions per scenario
- compare base vs scenario side-by-side
- move a scenario through `draft → in_review → approved/rejected → archived`
- export buy plans, shortage/excess reports, recs, and the scenario diff
- inspect an immutable audit trail of every edit

Scope matches the prompt exactly: no ERP writeback, no ML, no heavy
workflow engine. Recomputation reuses the Phase 3 allocation engine
verbatim.

## What ships

- **Migration** `supabase/migrations/20260419850000_inventory_planning_phase4.sql`:
  - `ip_scenarios` — scenario metadata with its own `planning_run_id`
    and a `base_run_reference_id` pointer
  - `ip_scenario_assumptions` — per-scenario typed assumptions with
    customer/channel/category/sku scope + optional period
  - `ip_planning_approvals` — one row per approval event; latest wins
  - `ip_change_audit_log` — flat field-level audit
  - `ip_export_jobs` — record of every export a planner generated
  - **Phase 5 FK wiring** — scenario_id FKs are added on
    `ip_forecast_accuracy` / `ip_override_effectiveness` /
    `ip_planning_anomalies` / `ip_ai_suggestions` (idempotent).
- **Types** `src/inventory-planning/scenarios/types/scenarios.ts`
- **Compute** `src/inventory-planning/scenarios/compute/`
  - `scenarioAssumptions.ts` — pure per-row patchers (scope match +
    specificity-ranked stacking)
  - `scenarioComparison.ts` — diff builder with totals
- **Services** `src/inventory-planning/scenarios/services/`
  - `scenarioRepo.ts` — REST CRUD
  - `scenarioService.ts` — `cloneBaseIntoScenario`, `applyScenarioAssumptions`,
    `recomputeScenarioOutputs` (reuses the Phase 3 compute in-process)
  - `scenarioComparisonService.ts` — gathers base + scenario rows,
    calls `compareScenarioToBase`
  - `approvalService.ts` — state machine + `transitionScenario` +
    `isReadOnly`
  - `auditLogService.ts` — fire-and-forget `logChange(...)`
  - `exportPlanningService.ts` — xlsx exports (reuses `xlsx-js-style`),
    `NO_OP_ERP_WRITEBACK` is the isolated seam for a future writeback
    adapter (not implemented in Phase 4)
- **UI at `/planning/scenarios`**:
  - `ScenarioManager` — parent, run/scenario picker, tabs, new-scenario
    modal
  - `ScenarioAssumptionsPanel` — add/remove assumptions with scope +
    unit hints
  - `ScenarioComparisonView` — 15-column diff grid with "changed only"
    toggle + stat cards for deltas
  - `ApprovalBar` — status chip + valid-transition buttons
  - `ChangeAuditDrawer` — scenario history
- **Tests** (3 new files, ~30 cases): scope matching / specificity,
  per-row patchers, comparison deltas, approval transitions.

## Scenario model

A scenario is a **new planning run** with a reference to its base:

```
ip_planning_runs  ─── id, name, planning_scope, horizon …
        ▲  ▲
        │  │
        │  └── base_run_reference_id  (scenario points at its base)
        │
ip_scenarios ───────── planning_run_id (the scenario's own run)
                       scenario_name, scenario_type, status, note, …
```

Cloning duplicates `ip_wholesale_forecast` + `ip_ecom_forecast` rows to
the scenario's run, so every downstream table (`ip_projected_inventory`,
`ip_inventory_recommendations`, `ip_supply_exceptions`, Phase 5's
accuracy/anomaly/suggestion rows) partitions naturally by `planning_run_id`
without touching the base.

## Assumption types

All assumptions live on `ip_scenario_assumptions` with a numeric value,
a unit string, and optional scope filters.

| Type | Unit | What it does |
|---|---|---|
| `demand_uplift_percent` | `percent` | Multiplies `system_forecast_qty` by `(1 + value/100)`. Stacks across matching assumptions in scope-specificity order. |
| `override_qty` | `qty` | Sets `override_qty` directly on forecast rows. Most-specific match wins. |
| `protection_percent` | `percent` | Ecom: `protected_ecom_qty = final × (value/100)`. |
| `reserve_qty_override` | `qty` | Passed into the allocation engine as a per-rule override when the compute rebuilds. |
| `receipt_delay_days` | `days` | Shifts every open-PO `expected_date` on a scenario-only copy by N days. Base POs untouched. |
| `lead_time_days_override` | `days` | Reserved slot; no supply-side effect in Phase 4. |
| `promo_flag` | `flag` | `1` = set promo_flag on matching ecom rows. |
| `markdown_flag` | `flag` | Same shape, markdown. |

Scope hierarchy (most specific wins): `sku > category > customer/channel > global`.
Optional `period_start` filters to an exact month.

## Approval states

```
draft → in_review → approved → archived
              └── rejected ─── back to draft
approved → in_review (reopen)
```

Enforced by `canTransition`. `isReadOnly` returns true for
`approved` / `archived` so the UI can disable destructive edits. The
scenario's `status` column is denormalized from the latest approval
event for fast filtering.

## Audit behavior

Every meaningful write calls `logChange(...)`:
- scenario created / duplicated
- assumption added / removed
- approval transition (with note as `change_reason`)
- export generated (entity_type = `planning_run`, changed_field = `exported`)

The drawer reads by scenario and shows `old → new`, reason, and `by`.
Failures to write audit are swallowed — audit is advisory, never
blocks the parent operation.

## Export types

All emitted as styled `.xlsx` via `xlsx-js-style` with a consistent
`[type]_[run-slug]_[YYYY-MM-DD].xlsx` naming pattern and a `Meta`
sheet per workbook:

| Type | Contents |
|---|---|
| `wholesale_buy_plan` | `buy` + `expedite` recs for the run |
| `ecom_buy_plan` | `buy` / `expedite` / `protect_inventory` recs |
| `shortage_report` | Every `ip_projected_inventory` row where `shortage_qty > 0`, sorted desc |
| `excess_report` | Every row where `excess_qty > 0`, sorted desc |
| `recommendations_report` | Full `ip_inventory_recommendations` dump |
| `scenario_comparison` | Two sheets: `Totals` + `By SKU/Period` |

Each generated file writes a row to `ip_export_jobs` for audit, and the
"Exports" tab shows the running list.

The `ErpWritebackAdapter` interface in `exportPlanningService.ts` is the
**only** seam for future ERP push. The default is `NO_OP_ERP_WRITEBACK`.
Phase 6+ can swap in a Xoro adapter without touching any other file.

## Known limitations

- **`lead_time_days_override`** accepted but doesn't yet affect supply;
  Phase 3's compute reads `lead_time_days` from `ip_item_master` only.
  When we thread vendor timing into recompute, this assumption wires
  up.
- **Approval is UI-owned**. No email, no Slack, no required approvers.
  `created_by` / `approved_by` aren't threaded through a real user
  layer yet — Phase 0's JSON-blob user story still applies.
- **Export is client-side.** Large horizons with thousands of rows
  serialize in-browser. Phase 6+ can move to a worker / server job;
  `ip_export_jobs.export_status` is ready for queued/failed states.
- **Comparison requires both runs to be reconciled.** If the base run
  hasn't gone through `runReconciliationPass`, the comparison grid is
  empty. The UI surfaces this.
- **Scenario-level accuracy isn't yet populated.** Phase 5 has the
  scenario_id column and the FK is in now; extending
  `runAccuracyAndIntelligencePass` to tag scenario_id is a small
  Phase 5/Phase 6 follow-up.

## Phase 5 hand-off

Phase 5 already shipped (accuracy + AI co-pilot). The only leftover:
populate `scenario_id` on Phase 5 rows when a scenario-scoped pass runs.
The column + FK are in place; the runner just needs to read the
scenario context and pass the id through.

## Running locally

1. Apply `supabase/migrations/20260419850000_inventory_planning_phase4.sql`.
2. Visit `/planning/scenarios`.
3. **+ New scenario** → pick the `Demo Recon — 2026-04` run (or any
   Phase 3 reconciled run) as the base → **Clone + create**.
4. Assumptions tab → add a `demand_uplift_percent = +15` scoped to one
   SKU → click **Apply assumptions + recompute**.
5. Comparison tab — expect deltas to show up for that SKU.
6. Approvals bar: `draft → in_review → approved`.
7. Exports tab: **Scenario comparison** → xlsx downloads.
