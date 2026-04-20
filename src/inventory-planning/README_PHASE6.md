# Demand & Inventory Planning — Phase 6 (Execution + Optional ERP Writeback)

Turns approved recommendations from Phase 3 (and Phase 4 scenarios) into
operational execution batches. **Export-first by default.** The ERP
writeback path is fully isolated, disabled-by-default, and always
dry-run unless explicit environment + config flags flip it live.

## What ships

- **Migration** `supabase/migrations/20260420100000_inventory_planning_phase6.sql`:
  - `ip_execution_batches` — batch metadata + state machine
  - `ip_execution_actions` — one row per executable action
    (suggested_qty + approved_qty + execution_method + status)
  - `ip_execution_audit_log` — append-only per-batch event trail
  - `ip_erp_writeback_config` — per-action-type enable/dry-run flags
    (seeded for Xoro, all **disabled + dry-run-default=true**)
  - `ip_action_templates` — optional per-type payload defaults
- **Types** `src/inventory-planning/execution/types/execution.ts`
- **Compute / utils** `src/inventory-planning/execution/utils/`:
  - `recommendationToAction.ts` — pure rec→action mapper with
    PO-aware routing (buy+open-PO → increase_po; expedite w/o PO →
    falls back to buy; reduce w/o PO → skipped)
  - `payloadMappers.ts` — per-action-type Xoro payload builder
  - `validation.ts` — per-action validation, `hasBlockingErrors`
- **Services** `src/inventory-planning/execution/services/`:
  - `executionRepo.ts` — REST CRUD + audit insert
  - `executionBatchService.ts` — `buildExecutionBatchFromRecommendations`
    (approval-gated), `transitionBatch`, `updateExecutionAction`,
    `markActionStatus`, `removeAction`, `isBatchLocked`
  - `executionExportService.ts` — xlsx export with Actions + Meta sheets
  - `executionWritebackService.ts` — `submitBatch` + `runWritebackDryRun`;
    per-action dispatch to `/api/xoro/writeback/*`
- **Server routes** `api/xoro/writeback/*.js` + shared `api/_lib/xoro-writeback.js`:
  - `create-buy-request`, `update-po`, `cancel-po-line`, `expedite-po`, `reserve-update`
  - Dry-run by default (default param, even without env)
  - `XORO_WRITEBACK_ENABLED=1` env unlocks live mode
  - Phase 6 keeps live calls as **placeholder responses** until the real
    Xoro endpoint contract is confirmed; swapping them in is one file
    change per route
  - Every call writes a row to `ip_execution_audit_log`
- **UI at `/planning/execution`**:
  - `ExecutionBatchManager` parent with list + detail tabs + new-batch modal
  - `ExecutionBatchDetail` — header with approval actions, stat cards,
    execute panel (Export / Dry-run / Submit), actions table with
    inline approved-qty edit + method select + per-row approve/remove
  - `ExecutionAuditPanel` drawer — chronological event log
- **Tests** (3 new files, ~25 cases): mapping, payload shape, validation,
  batch state machine, submit gating.

## Execution model

```
Approved plan/scenario
        │
        ▼
buildExecutionBatchFromRecommendations(batch_type)
        │   (gated: refuses unless run/scenario is approved
        │    unless allowUnapproved=true — audited as unsafe)
        ▼
ip_execution_batches   ←── one per execution intent
ip_execution_actions   ←── one per rec that matches the batch_type
        │
        ▼  planner reviews → sets approved_qty, chooses execution_method
        ▼
status: draft → ready → approved
        │
        ├── Export xlsx   (safe, default path)
        │        │
        │        └── status → exported
        │
        └── Dry-run / Submit writeback   (per-action; needs enabled config)
                 │
                 └── status → submitted → executed | partially_executed | failed
```

## Batch state machine

```
draft → ready → approved → exported | submitted → executed / partially_executed / failed → archived
                            │              ▲
                            └── ready (reopen)
```

Enforced by `canBatchTransition`. `isBatchLocked` is `true` for
approved/exported/submitted/executed/archived — the UI disables
destructive edits in those states and offers **Reopen to ready** for
approved/exported batches.

Failed batches are re-editable and resubmittable — retries are a
planner decision, never automatic.

## Action types

| Type | Source rec | Default execution_method | Writeback endpoint |
|---|---|---|---|
| `create_buy_request` | buy (no open PO) | export_only | `/api/xoro/writeback/create-buy-request` |
| `increase_po` | buy (with open PO) | export_only | `/api/xoro/writeback/update-po` |
| `reduce_po` | reduce (with PO) | export_only | `/api/xoro/writeback/update-po` |
| `cancel_po_line` | cancel_receipt | export_only | `/api/xoro/writeback/cancel-po-line` |
| `expedite_po` | expedite / push_receipt | export_only | `/api/xoro/writeback/expedite-po` |
| `reserve_inventory` | (manual from protect_inventory) | export_only | `/api/xoro/writeback/reserve-update` |
| `release_reserve` | (manual) | export_only | `/api/xoro/writeback/reserve-update` |
| `update_protection_qty` | protect_inventory | export_only | `/api/xoro/writeback/reserve-update` |
| `shift_inventory` | reallocate | export_only | — (no endpoint; export-only) |

## Export-first workflow

Clicking **Export xlsx** generates:
- `Actions` sheet — one row per action with payload_type, approved_qty,
  method, status, reason, PO/vendor/customer/channel refs
- `Meta` sheet — batch id/name/type/status/approver/planning-run
  metadata so ops teams have full lineage

Each export writes `ip_execution_audit_log` + can auto-promote
`approved → exported` batch status.

## Writeback safeguards

- **Disabled by default.** `ip_erp_writeback_config.enabled=false` for
  every seeded row. The UI grays out `api_writeback` method until a row
  is flipped on by an admin.
- **Dry-run by default.** `dry_run_default=true` on every config row.
  The dry-run path returns the preview payload without side effects.
- **Environment gate.** The server endpoints additionally check
  `XORO_WRITEBACK_ENABLED=1`. When unset, even an "enabled" config row
  only emits preview responses (logged + surfaced to the planner).
- **Live endpoint is a placeholder.** Phase 6 does not POST to Xoro;
  the route returns a `{ would_call, preview, note }` envelope so the
  full round-trip is visible. Swapping to a real call is one file each.
- **No silent retries.** Failed actions stay in `failed` status until a
  planner explicitly retries from the UI.
- **Per-action validation** runs before submit; blocking errors stop
  the per-action submit and mark it failed with the validation message.

## Dry-run vs live

Both go through the same endpoint:
- `POST /api/xoro/writeback/X?dry_run=1` (default) → preview
- `POST /api/xoro/writeback/X?dry_run=0` → live (still preview in Phase 6
  until the endpoint contract is confirmed)

Results:
- `dry_run: true`, `status: "submitted"`, `message: "Dry-run OK"` — action stays `submitted`
- `dry_run: false`, `status: "succeeded"` — action marks `succeeded`
- Any error → `status: "failed"`, full response body stored in
  `response_json`, error string in `error_message`

## Approval gating

`buildExecutionBatchFromRecommendations` refuses to start unless:
- the source scenario has `status='approved'`, OR
- the source planning_run has an `ip_planning_approvals` row with
  `approval_status='approved'`

An `allowUnapproved=true` override exists for admin/dev, and the UI
forwards it through a checkbox; every use is audited with a message of
"unsafe override".

## Known limitations

- **Xoro endpoint contract stubbed.** Every writeback route returns a
  structured preview; real POST bodies will need confirmation with Xoro
  support (same gap documented in `xoro-receipts-sync.js`).
- **Action templates underused.** `ip_action_templates` exists but the
  MVP ignores it — Phase 7+ can drive default payloads from it.
- **No real user threading.** `created_by` / `approved_by` / `actor`
  fields take whatever the UI hands them; there's no system user yet
  (internal app still uses the JSON-blob user store).
- **Batch-level warnings when source plan is outdated** — not yet
  implemented. Consider comparing the batch's `created_at` vs the plan's
  latest forecast `updated_at` in Phase 7.
- **Approval row vs denormalized run status.** Phase 4 runs on
  `ip_scenarios.status`; plain `ip_planning_runs` don't have a formal
  approval flag yet — the gate reads `ip_planning_approvals`.

## Future extensions

- Per-planner approver role, separate from execution approver.
- Webhook from Xoro back to `ip_execution_audit_log` on PO updates so
  executed actions get a closing event.
- "Rebuild from source plan" button that keeps the batch but refreshes
  actions when recommendations change.
- Retry UI on failed actions (resubmit just the red rows).

## Running locally

1. Apply `supabase/migrations/20260420100000_inventory_planning_phase6.sql`.
2. (Optional) flip an `ip_erp_writeback_config.enabled=true` row for the
   action type you want to try, or leave all off to stay export-only.
3. Approve a scenario or planning run (Phase 4 UI), then go to
   `/planning/execution` → **+ New batch** → pick approved run →
   `buy_plan` → name → create.
4. In detail view: edit `approved_qty` inline → approve each action →
   approve the batch.
5. **Export xlsx** always works. **Dry-run writeback** exercises the
   server routes without live effects. **Submit writeback** only hits
   the endpoint when the config row is on.
