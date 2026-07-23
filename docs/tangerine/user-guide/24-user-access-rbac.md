# 24. User Access & Permissions (P14 RBAC)

> **P14 status (2026-07-08, security sprint):** **`RBAC_MODE=enforce` is now LIVE in production.** A signed-in user lacking a permission gets a 403; unauthenticated/legacy-token callers still pass (incremental adoption), and internal errors fail open, so nobody can be locked out. Both current internal users carry full permission sets (verified 113/107 effective rows), so day-one behavior is unchanged — tighten roles in the User Access panel to make enforcement bite. The same sprint also: **dropped the blanket anonymous access policies on every financial table** (journal entries, GL accounts/periods, AR/AP invoices & payments, receipts, bank accounts/transactions, commitments, commissions — the browser's public key can no longer read or write the ledger; all financial screens go through the server API, which is unaffected), **clamped API CORS to the app's own origins** (was `*` — any website could previously drive the API from a visitor's browser), and **planning endpoints now take the caller's identity from the verified sign-in token, not a spoofable header**. If a planning action ever answers "Sign-in required," sign out and back in once so the app picks up a fresh user token.
>
> *(Historical: shipped 2026-05-30 as PRs #630/#632/#634, off by default; log-mode ran from 2026-06-30.)*

Tangerine RBAC controls **who can do what, per module, per action** — laid on top of the existing entity membership (who belongs to ROF). It does **not** change who can log in; it changes what each logged-in person is allowed to do once inside.

---

## The model in one picture

```
 user ──(member of)──► entity ──┐
   │                            ├─ entity_user_roles  → ONE role per user per entity
   └──(per-cell tweaks)─────────┴─ entity_user_role_overrides → grant/revoke a single cell
                                       │
        role ──► role_permissions (the matrix: module × action = allowed?)
                                       │
                                       ▼
                 v_effective_permissions = role grants ∪ grant-overrides − revoke-overrides
```

- **Module** — a feature area (Style Master, AR Invoices, Journal Entries, Bank Recon, User Access, …). The registry (`module_keys`) holds one row per Tangerine menu item plus a few cross-cutting capabilities — **~144 today**, kept in sync with the nav by `scripts/gen-module-keys.mjs` → `scripts/seed-module-keys.mjs`.
- **Action** — one of five verbs: **read · write · post · void · export**. Not every module exposes all five (a report module is read/export only; only postable accounting modules expose post/void).
- **Role** — a named bundle of (module, action) grants. Three seed roles ship:
  - **admin** — every action on every module. This is guaranteed **structurally**: the effective-permissions view derives the admin role's grants directly from the live `module_keys` registry, so a newly-added module is admin-covered automatically (see "Why admin can't be locked out" below).
  - **accountant** — read/export everywhere; write on accounting + procurement; post/void on the six core postable modules (JE, AR invoices, AP invoices, AP payments, bank recon, GL periods).
  - **viewer** — read-only everywhere.
- **Override** — a per-user, per-cell exception layered on the role. `allowed=true` grants one extra cell; `allowed=false` revokes one cell. **A revoke beats a role grant** — handy to take one capability away from one person without inventing a whole role.

> **Effective permission = role grants, plus grant-overrides, minus revoke-overrides.** That single rule is computed by the `v_effective_permissions` view and the `has_permission()` function in the database — the API and (later) the menu both read from it, so there's one source of truth.

---

## Why admin can't be locked out (the grant-sweep)

The original P14 seed granted **admin** "every action on every module" with a one-time pass over the ~33 modules that existed then. As the app grew, each new menu item was registered in `module_keys` — but nothing re-granted it to the roles. Under `RBAC_MODE=enforce` that meant a freshly-added module was forbidden to **everyone, including the CEO**, until someone hand-granted it (this bit `cases`, and left 111 modules / 439 admin cells ungranted).

Two changes close this for good:

1. **A one-time backfill** re-applied the three seed roles' "everywhere" coverage bands across every current module: **admin** → all actions, **viewer** → read, **accountant** → read + export. (Accountant's write / post / void bands stay the curated accounting+procurement list — a brand-new module isn't assumed to be accounting-writable.)
2. **Structural admin coverage** — `v_effective_permissions` now derives the **admin** role's grants from the live `module_keys` registry instead of stored rows. Any module registered in future is admin-covered the instant it exists; there is no seed step to forget. Per-user **revoke** overrides still apply on top, so an admin cell remains individually revocable.

The seed script (`scripts/seed-module-keys.mjs`) also now attaches all three role bands whenever it upserts the module list, keeping viewer/accountant in sync as the nav changes.

---

## Capabilities (cross-cutting grants) — Margin Visibility

Most modules map to a screen. A **capability** is a cross-cutting grant that gates a *kind of data* wherever it appears, rather than one screen. Capabilities show up in the User Access grid under the **Data Visibility** group and are toggled exactly like any other cell (per-user override) — plus they carry a role default.

- **`margins`** — **Margin Visibility.** Gates every margin % and margin $ (gross-margin) figure across the whole app: the Sales Orders / Purchase Orders / Drop-Ship / Inventory Matrix grids, the Costing & RFQ compare screens, the Wholesale Planning grid, Segment P&L, the Customer Scorecard, the ATS availability KPI + Excel/Sales-Comps exports, and the planning sales-performance report. Two actions:
  - **read** — may *see* margin columns / KPIs. Without it, the margin columns are **simply absent** (no lock icon, no blanked placeholder) — the rest of the grid is unchanged.
  - **export** — may *export* margin data (CSV/Excel). A user with **read** but not **export** sees margins on screen but their exports come out with the margin columns dropped.

  **Default grants:** **admin** and **accountant** roles get **read + export**; **viewer** does **not** (margin is hidden for viewers by design). Grant it to anyone else, or revoke it from an individual, in the User Access grid. Enforcement follows the same `RBAC_MODE` rule as everything else — margins stay visible for everyone until enforcement is on, and the server also strips margin fields from the Sales Orders, Purchase Orders, and Customer Scorecard API responses for non-granted callers as defence-in-depth.

  > Note: margin **input** fields that drive a *price* (e.g. the Price List "Margin %" input, a SKU's target-margin, the ATS "Sls Prc @ Mrgn %" implied-price column) are pricing controls, not profitability read-outs, so they are **not** hidden by this capability.

---

## How everyone got a role (the backfill)

When P14-1 shipped, every existing member was mapped to a seed role so **day-1 access was identical to before**:

| Old `entity_users.role` | New RBAC role |
|---|---|
| `admin` | admin |
| `accountant` | accountant |
| `readonly` | viewer |
| `staff`, blank, anything else | **admin** (never narrower than today) |

So until you deliberately tighten someone, everyone keeps full access. You tighten roles **before** turning enforcement on (next section).

---

## Turning enforcement on (the 3-step rollout)

Enforcement is controlled by the **`RBAC_MODE`** environment variable on the Vercel deployment. Three settings:

| `RBAC_MODE` | Behavior |
|---|---|
| _(unset)_ / `off` | **Default.** No checks at all. Zero behavior change. |
| `log` | Checks every internal API call and writes a `[RBAC log-only] would-deny …` line to the server logs when a caller lacks a permission. **Nothing is blocked.** This is your dry-run. |
| `enforce` | A caller lacking the required permission gets a `403 permission_denied`. Unauthenticated/anon requests still pass (incremental adoption, not a hard cutover), and any internal error **fails open** so you can never lock yourself out. |

**Recommended sequence:**
1. Configure roles/overrides in the User Access panel (below) so each person has exactly what they need.
2. Set `RBAC_MODE=log` and watch the logs for a few days. Because everyone is backfilled to `admin`, the logs stay quiet until you start narrowing roles — a quiet log on a narrowed role means "ready."
3. When the would-deny lines only show people who genuinely shouldn't have that access, set `RBAC_MODE=enforce`.

Flip back to `log` or `off` at any time — it's just an env var; no data changes.

---

## The User Access panel

**Where:** Analytics & Admin → **User Access**. (Requires the `users_access` module — admins have it; this is intentionally admin-only, no self-service.)

What you can do:
- **See the matrix** — every member of the entity, their assigned role, and a module × action grid showing their *effective* permissions (role + overrides combined).
- **Change a role** — pick a different role from the dropdown next to a user. Takes effect immediately (next API call uses it).
- **Grant or revoke a single cell** — tick/untick a module×action checkbox to add a per-user override without changing their role. Add an optional reason (it's stored and audited).
- **Remove an override** — clearing an override reverts that cell to whatever the role says.

Every change to a role assignment or override is written to the **T11 universal audit log** (chapter on Shadow Mirror / audit), so "who granted X access to post JEs, and when" is always answerable.

---

## Security notes (why writes are safe)

- The RBAC tables are **anon-read-only**. The internal apps use a shared browser key that can *read* the matrix (to render the panel) but **cannot write** roles or permissions directly. All writes go through the service-role admin API, which is itself gated on `users_access:write` once enforcement is on.
- `has_permission()` runs as `SECURITY DEFINER` in the database — it's the one authority both the middleware and any future row-level policy consult.
- This is the right hardening for today's shared-key data layer. The deeper move — giving each user their own signed session so the database itself enforces per-user row access — is a separate, later security phase (it does not block anything here).

---

## Beta users & the Beta Data screen

Beta testers work on the **live production database** — three guardrails make that safe:

- **The `beta` role.** Assign it in User Access like any other role. It grants read/write/export
  across the app but **never post or void** — a beta user can draft invoices, orders and masters,
  but nothing they do can reach the GL. (Requires `RBAC_MODE=enforce`, which is live.)
- **The beta window + tagging registry.** An admin opens a "beta window" before the beta starts;
  while it is open, every document or master row created anywhere in the suite is automatically
  recorded in a registry (`beta_created_docs`) with who created it and when. Closing the window
  stops the tagging. Beta users should transact against the **ZZ-BETA** sandbox customer/vendor/style
  records, which are permanent fixtures.
- **The Beta Data screen** (Admin → **Beta Data**, admin-only) drives the whole lifecycle:
  1. **Beta window card** — status, started/ended timestamps, Start/End with confirmation.
     Record a PITR restore point in the Supabase dashboard *before* starting (the confirm
     dialog reminds you; full checklist in `docs/tangerine/BETA-RUNBOOK.md`).
  2. **Registry summary** — per-table counts: total tagged, cleaned, outstanding.
  3. **Outstanding documents** — every tagged row still live, each with a **dry-run eligibility
     verdict** computed against current data: `deletable` (unposted, unpaid, unreferenced),
     `refused` with the reason (`posted — reverse instead`, `has payments`, `has receipts`,
     `has shipments/allocations`, `still referenced`), or `already gone`. Tick rows and
     **Clean up selected**; the confirm dialog lists exactly what will delete vs refuse, and the
     engine re-checks each row at delete time.

Safety rules baked into the cleanup engine: posted documents are **reversed through their own
module (with a reason), never deleted**; journal-entry lines, GL tables and inventory ledgers are
never touched; deletes never cascade beyond a document's own lines; every removal is stamped on
the registry (`cleaned_at`, `cleanup_note`) as the audit trail. Operator walkthrough:
`docs/tangerine/BETA-RUNBOOK.md`.

---

## API surface (for integrators)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/internal/users-access` | The full matrix: `{ entity_id, modules[], roles[], users[] }`. Each user carries `role_id`, `role_name`, `overrides[]`, and flattened `effective[]` (`"module:action"`). Optional `?entity_id=…`. |
| `PUT` | `/api/internal/users-access` | Body `{ user_id, role_id }` — assign/change a user's role. |
| `PUT` | `/api/internal/users-access/override` | Body `{ user_id, module_key, action, allowed, reason? }` — grant (`true`) or revoke (`false`) one cell. |
| `DELETE` | `/api/internal/users-access/override` | Body/query `{ user_id, module_key, action }` — remove the override (revert to role default). |

Validation rejects unknown roles, non-members, unknown modules, and any action a module doesn't expose, so you can't persist an impossible cell.

---

## Code map

- Schema + seed + backfill: `supabase/migrations/20260707000000_p14_chunk1_rbac_schema.sql`
- Grant-table read-only lockdown: `supabase/migrations/20260707010000_p14_chunk3_rbac_grant_rls_lockdown.sql`
- Admin-grant sweep + structural admin coverage: `supabase/migrations/20262340000000_rbac_admin_grant_sweep.sql` (guarded by `api/_lib/__tests__/rbac-admin-grant-sweep.test.js`)
- Module registry sync (nav → `module_keys`, + role grants): `scripts/gen-module-keys.mjs`, `scripts/seed-module-keys.mjs`
- Middleware + route→permission registry: `api/_lib/rbac/` (`index.js`, `routePermissions.js`)
- Admin handlers: `api/_handlers/internal/users-access/` (`index.js`, `override.js`)
- Panel: `src/tanda/InternalUserAccess.tsx` (P14-3b-2)
- Arch doc: `docs/tangerine/P14-rbac-architecture.md`
- Beta guardrails: `src/tanda/InternalBetaData.tsx`, `api/_handlers/internal/beta-data/index.js`,
  `api/_lib/betaData.js`, `docs/tangerine/BETA-RUNBOOK.md`
