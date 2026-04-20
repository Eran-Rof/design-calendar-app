# Demand & Inventory Planning — Phase 7 (Governance, Roles, Performance, Production Hardening)

Adds the operational layer the planning platform needs to run safely:
a role/permission model, hardened audit, background job tracking,
integration-health + data-freshness dashboards, and server-side
permission gates on writeback endpoints.

## What ships

- **Migration** `supabase/migrations/20260420120000_inventory_planning_phase7.sql`:
  - `ip_roles` — 6 built-in roles seeded (admin, planning_manager,
    planner, operations_user, executive_viewer, integration_service)
    with explicit per-permission flags in a JSONB blob
  - `ip_user_roles` — email → role assignments (multi-role supported)
  - `ip_job_runs` — generic job tracker with state machine + retry
    lineage (`retry_of` FK)
  - `ip_integration_health` — per-endpoint sync status (seeded for all
    5 Xoro + 5 Shopify endpoints)
  - `ip_data_freshness_thresholds` — 8 seeded thresholds covering
    sales history, inventory, open POs, Shopify orders/products, and
    forecast age
  - Seeds `admin@local` as a default admin so dev environments can
    immediately use admin UI
- **Types** `governance/types`, `admin/types`, `jobs/types`
- **Services**:
  - `governance/services/permissionService.ts` — `currentUserEmail`
    (localStorage), `loadPermissionsFor`, `can` / `canAny` / `canAll`,
    `requirePermission`, `PermissionDeniedError`, role CRUD,
    `logPermissionDenied` audit helper
  - `governance/services/planningSafetyService.ts` — stale-plan /
    unapproved-scenario / orphan-reference checks, `hasBlocking`
  - `governance/services/auditExplorerService.ts` — unified search
    across `ip_change_audit_log` + `ip_execution_audit_log`
  - `admin/services/integrationHealthService.ts` — list + compute +
    refresh status + `recordSyncAttempt` helper
  - `admin/services/dataFreshnessService.ts` — per-entity age computation
    against thresholds → `IpFreshnessSignal`
  - `jobs/services/jobRunService.ts` — `startJob / succeed / fail /
    partialSuccess / cancel / retry / withJob` wrapper, state machine
- **Server-side permission gate** `api/_lib/ip-permissions.js`:
  - `checkPermission(req, key)` / `requirePermission(req, res, key)`
  - Reads `x-user-email` header, looks up active roles, verifies the
    requested key, returns 401 (missing header) / 403 (not allowed)
  - Writes a `permission_denied` audit row on denial
  - Wired on **every** writeback route
    (`api/_handlers/xoro/writeback/*`) — all require `run_writeback`
- **Client plumbing** — `executionWritebackService.ts` now sends
  `x-user-email: <currentUserEmail()>` on every writeback POST
- **Admin UI at `/planning/admin`** with 4 tabs + header user switcher:
  - `RolesPermissionsPanel` — role list + per-role permission grid +
    user assignments (assign/revoke for admins)
  - `IntegrationHealthDashboard` — per-endpoint status + freshness
    signals table
  - `JobRunsDashboard` — stat cards, filter by type/status, detail
    drawer, retry button for failed rows
  - `AuditExplorer` — search across planning + execution audit logs
    (actor / entity / date / full-text)
- **Tests** (4 new files, ~25 cases): permission guards, stale-data /
  approved-scenario / orphan gates, job state machine, freshness +
  integration-status derivation.

## Role model

All six roles seeded at migration time. Full permission matrix:

| Permission | admin | planning_manager | planner | operations_user | executive_viewer | integration_service |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `read_forecasts` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `edit_forecasts` | ✓ | ✓ | ✓ | | | |
| `edit_buyer_requests` | ✓ | ✓ | ✓ | | | |
| `edit_ecom_overrides` | ✓ | ✓ | ✓ | | | |
| `manage_scenarios` | ✓ | ✓ | ✓ | | | |
| `approve_plans` | ✓ | ✓ | | | | |
| `view_audit_logs` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `create_execution_batches` | ✓ | ✓ | | ✓ | | |
| `approve_execution` | ✓ | | | ✓ | | |
| `run_exports` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `run_writeback` | ✓ | | | ✓ | | |
| `manage_integrations` | ✓ | | | | | ✓ |
| `manage_allocation_rules` | ✓ | ✓ | | | | |
| `manage_ai_suggestions` | ✓ | ✓ | | | | |
| `manage_users_or_roles` | ✓ | | | | | |

## Permission boundaries (enforcement)

- **Client-side**: `can(user, key)` gates UI controls. Every view that
  allows a mutation computes the guard before rendering the button.
- **Server-side**: Xoro writeback routes call
  `requirePermission(req, res, "run_writeback")` BEFORE doing any work.
  The client sends `x-user-email`; the server looks up active roles in
  Supabase via the service-role key. Denial fires a
  `permission_denied` audit row.
- **Audit**: every transition, assumption edit, approval, export, and
  writeback attempt writes either `ip_change_audit_log` or
  `ip_execution_audit_log`. The admin Audit Explorer presents both as
  a unified stream.

## Job lifecycle

```
queued → running → succeeded | failed | partial_success | cancelled
          (terminal)
```

- `startJob(args)` → inserts a row with status='running' + `started_at`.
- `succeed / fail / partialSuccess / cancel` stamp `completed_at`.
- `retry(job, actor)` inserts a NEW row with `retry_of` FK and
  `retry_count = prev + 1`. No automatic retries anywhere.
- `withJob({...}, fn)` is the ergonomic wrapper: auto-succeed on
  return, auto-fail on throw, captures a trimmed summary of the
  return value into `output_json`.

## Stale-data rules

Configurable via `ip_data_freshness_thresholds`. Seeded defaults:

| Entity | Threshold | Severity | Purpose |
|---|---|---|---|
| `xoro_sales_history` | 48 h | warning | Wholesale demand signal |
| `xoro_inventory` | 24 h | **critical** | Buy decisions are risky on stale on-hand |
| `xoro_open_pos` | 24 h | warning | Supply context |
| `shopify_orders` | 24 h | warning | Ecom velocity |
| `shopify_products` | 168 h | info | Catalog drift |
| `planning_run` | 168 h | warning | Banner before executing an old plan |
| `wholesale_forecast` | 168 h | warning | Grid banner |
| `ecom_forecast` | 72 h | warning | Grid banner |

The `checkPlanFreshness` gate is called before
`buildExecutionBatchFromRecommendations` (via the safety service) and
surfaces the signal in the new-batch modal when active.

## Admin / observability structure

- **Roles & permissions** — who has what; admin can assign/revoke
- **Integration health** — one row per endpoint; statuses computed
  from `last_success_at` vs threshold
- **Job runs** — every async op (forecast build, reconciliation,
  export, writeback) can log here; admins see queued / running /
  failed counts and open the detail drawer with `input_json` +
  `output_json` + `error_message`
- **Audit explorer** — unified search across both audit logs
- **Header user switcher** (dev-only shim) — localStorage
  `planning_user_email` is what every client read/write respects. Real
  auth swaps this in one file (`currentUserEmail`).

## Remaining future hardening opportunities

- **Real authentication**. The `currentUserEmail` localStorage shim is
  deliberately temporary. When SSO lands, the client-side helper flips
  to the session claim and the server gate reads the bearer token
  instead of `x-user-email`. No other consumer changes.
- **Per-permission denial audit UI**. The events already write;
  surfacing a "denied attempts" widget on the admin page is a small
  add.
- **Automatic freshness refresh**. Status is recomputed on demand from
  the dashboard. A cron can flip stale rows nightly.
- **Selective recompute**. Phase 3/4 orchestrators rebuild the full
  projected inventory; a `recompute_scope` column on `ip_planning_runs`
  could allow "just this customer / sku set" rebuilds. Schema is
  open-text enough to add without migration.
- **UI virtualization**. Current grids show up to 500 rows and filter
  down. Large catalogs > 10k rows would benefit from `react-window` or
  similar; the PAGE_SIZE constants are centralized for easy swap.
- **Materialized summaries**. Accuracy dashboards rollup in memory;
  a nightly `ip_accuracy_summary` materialized view would be a trivial
  migration when needed.
- **Row-level security by role**. Currently anon-permissive. When
  real auth lands, narrow to `USING (user_has_permission(...))`
  policies per table.

## Running locally

1. Apply `supabase/migrations/20260420120000_inventory_planning_phase7.sql`.
2. `npm run dev`, then `/planning/admin`.
3. Header shows `admin@local · admin` — seeded by the migration.
4. Click the user pill to impersonate other emails (e.g. grant a
   `planner` role to `planner@local`, switch, see the UI degrade).
5. `/planning/execution` → try to submit a writeback as a role that
   lacks `run_writeback` — the server returns 403 and logs the denial.
