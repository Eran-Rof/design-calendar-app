# design-calendar-app

A React + Vite SPA that hosts the internal PLM suite (Design Calendar, TandA
PO tracker, TechPack, ATS) and a white-labelled vendor portal, backed by
Supabase and deployed on Vercel. POs are synced from the Xoro ERP; vendors
log in through Supabase Auth (separate pool from internal users) and manage
orders, shipments, invoices, compliance, payments, and RFQs end-to-end.

## Table of contents

1. [Project overview](#1-project-overview)
2. [Local setup](#2-local-setup)
3. [Environment variables](#3-environment-variables)
4. [Database migrations](#4-database-migrations)
5. [Running the test suite](#5-running-the-test-suite)
6. [Running background jobs locally](#6-running-background-jobs-locally)
7. [API authentication](#7-api-authentication)
8. [Vendor onboarding flow](#8-vendor-onboarding-flow)
9. [Phase summary and feature list](#9-phase-summary-and-feature-list)
10. [Deploy](#10-deploy)

---

## 1. Project overview

### Architecture

- **Frontend:** React 18 + Vite 5 + TypeScript. Zustand for state. React
  Router 7 splits traffic: `/vendor/*` renders the vendor portal
  (`src/vendor/VendorApp.tsx`); everything else renders the internal PLM
  shell (`src/PLM.tsx`).
- **Backend:** Supabase (Postgres 17, Auth, Storage, RLS). All schema changes
  live in `supabase/migrations/` (47 files at time of writing).
- **Serverless API:** Vercel. **All** routes under `/api/*` are rewritten to
  a single catch-all dispatcher (`api/dispatch.js`) that delegates to handler
  modules under `api/_handlers/` — this was done so we could ship 250+
  endpoints without blowing past Vercel Pro's function cap. URLs and HTTP
  contracts are unchanged.
- **Authentication:** two separate pools.
  - Internal users: custom auth, SHA-256 hashed passwords, JSON blob in
    `app_data['users']`. Entry point `src/PLM.tsx`.
  - Vendor users: Supabase Auth. Linked to a `vendors` row via the
    `vendor_users` table.
- **Integrations:** Xoro (ERP, source of truth for POs), Searates (container
  tracking), Microsoft Graph (Teams / Outlook), Shopify (demand signal for
  ecom planning), Dropbox (document storage), Resend (transactional email),
  Wise/OpenExchangeRates/ECB (FX), Stripe-style stub (virtual cards), APNS +
  FCM (mobile push).

### Sub-apps

- **Design Calendar** (`src/dc/`) — seasonal calendar + task/milestone tracking.
- **TandA** (`src/TandA.tsx` + `src/tanda/`) — internal PO tracker reading
  `tanda_pos`. Also hosts cross-vendor screens (Shipments, 3-Way Match,
  Insights, Workspaces, Marketplace, Payments, etc. — 32 items across six
  nav groups).
- **TechPack** (`src/TechPack.tsx`) — product spec authoring.
- **ATS** (`src/ATS.tsx` + `src/ats/`) — open-PO workbook that syncs live
  PO-WIP data from `tanda_pos` into an Excel-shaped grid.
- **Inventory Planning** (`src/inventory-planning/`) — multi-phase forecast +
  reconciliation + scenario planner (Phases 0–7 of the planning track).
- **Vendor portal** (`src/vendor/`) — external-facing surface.

### API layout

```
api/
├─ dispatch.js                # the ONLY function Vercel sees
├─ _handlers/                 # underscored = skipped by Vercel's scanner
│   ├─ routes.js              # generated route manifest (scripts/generate-api-routes.mjs)
│   ├─ internal/              # internal (admin) endpoints
│   ├─ vendor/                # vendor-scoped endpoints (JWT or API key)
│   ├─ cron/                  # scheduled jobs
│   └─ ...
└─ _lib/                      # shared helpers (auth, crypto, supabase, ...)
```

Do **not** add new top-level files to `api/` — Vercel will count them as
separate functions. New handlers go under `api/_handlers/…`, and you re-run
`node scripts/generate-api-routes.mjs` to refresh the manifest.

---

## 2. Local setup

### Quickstart (fresh clone → running in one block)

```bash
git clone https://github.com/Eran-Rof/design-calendar-app.git
cd design-calendar-app
npm install
cp .env.local.example .env.local         # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
supabase start                           # local Postgres/Auth/Storage (requires Docker)
npm run staging:local                    # apply migrations + seed + create vendor test users
npm run dev                              # http://localhost:5173
```

Internal app lives at `/`; vendor portal at `/vendor`. Test vendor credentials
are printed by `staging:local` and written to `.env.staging`.

### Prerequisites

- **Node 22 or 24** (CI runs on 22). Node 24 is easier locally because it
  ships with npm 11.
- **Supabase CLI** ≥ 2.x (`npm i -g supabase` or `brew install supabase/tap/supabase`).
- **Docker Desktop** (for `supabase start` to run Postgres + Studio locally).
- **Vercel CLI** (`npm i -g vercel`) if you want to exercise the serverless
  handlers locally.
- A **GitHub account** with access to the repo.

### Clone and install

```bash
git clone https://github.com/Eran-Rof/design-calendar-app.git
cd design-calendar-app
npm install
```

### Run the frontend dev server

```bash
cp .env.local.example .env.local      # fill in the VITE_ vars (see §3)
npm run dev                           # Vite, default port 5173
```

Open http://localhost:5173 for the internal app; http://localhost:5173/vendor
for the vendor portal.

### Run the serverless API locally

Two options:

- **`vercel dev`** — simulates production routing (dispatch + rewrites).
  Recommended when you're touching API code.
  ```bash
  vercel link            # first time only
  vercel dev --listen 3000
  ```
- **Direct Node** — handlers are plain ES modules; you can call them from a
  unit test or from `node --import tsx ...` for quick iteration.

### Local Supabase

```bash
supabase start                    # boots Postgres, Studio, Auth, Storage
npm run staging:local             # runs migrations + seeds + creates vendor test users
```

`scripts/staging-setup.mjs --local` writes an `.env.staging` file with the
generated credentials, including a vendor API key for smoke-testing.

### Running the app with test data

Full walkthrough — fresh clone to a logged-in vendor session.

**1. One-time setup** (Docker Desktop must be running):

```bash
npm install
supabase start                   # local Postgres + Auth + Studio
npm run staging:local            # migrations + seed + test vendors + API keys
```

**2. Wire Vite to local Supabase.** `supabase start` prints the URL and
anon key; copy them into `.env.local`:

```bash
cp .env.local.example .env.local
# edit .env.local:
#   VITE_SUPABASE_URL=http://127.0.0.1:54321
#   VITE_SUPABASE_ANON_KEY=<anon key from `supabase status`>
```

**3. Run the app:**

```bash
npm run dev                      # http://localhost:5173
# optional second terminal — gives you /api/* too:
vercel dev --listen 3000
```

**4. Log in.** Three pre-made vendor accounts, all password `Staging@2026!`:

| Email | Vendor in seed data |
|---|---|
| `vendor-a@staging.ringoffireclothing.com` | Sunrise Apparel Co. (CN) |
| `vendor-b@staging.ringoffireclothing.com` | Pacific Thread Works (VN) |
| `vendor-c@staging.ringoffireclothing.com` | Atlas Manufacturing (BD) |

Each vendor sees only their own rows (RLS). Open
`http://localhost:5173/vendor` and sign in.

The **internal app** (`/`) has no pre-seeded users — either sign up through
the internal flow or insert a row into `app_data['users']` directly. The
seed doesn't touch that table because internal auth is custom and hashes
passwords via `src/utils/hash.ts`.

**Reset** when seed data gets dirty:

```bash
npm run staging:reset            # wipes + re-seeds, keeps migrations applied
```

**Gotchas**

- *`supabase start` hangs* — Docker not running, or ports 54321–54324 are taken. `supabase stop --all` to clear.
- *Vendor login fails after `supabase db reset`* — `db reset` wipes `auth.users`; you need `staging-setup.mjs` to recreate them. Re-run `npm run staging:local`.
- *Empty PO list after login* — the email must match one of the three test accounts. Any other email gets zero rows by RLS design.
- *`/api/*` 404s* — you're running `npm run dev` only. Start `vercel dev` in a second terminal.

---

## 3. Environment variables

All client-exposed vars must be prefixed `VITE_`. Anything else is
server-side only and **never** gets bundled into the frontend.

### Required to boot

Without these set, the app won't start or the invite/cron paths fail.

| Name | Scope | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | client | Supabase project URL. |
| `VITE_SUPABASE_ANON_KEY` | client | Supabase anon key (RLS-gated). |
| `VITE_XORO_API_KEY` | client | Xoro REST key (`api/xoro-proxy.js`). |
| `VITE_XORO_API_SECRET` | client | Xoro REST secret. |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Bypasses RLS. Used by `vendor-invite`, crons, admin-scoped handlers. |
| `CRON_SECRET` | server (prod) | Bearer token Vercel sends to cron handlers; handlers verify it. |
| `VENDOR_DATA_ENCRYPTION_KEY` | server | AES-256 key (64 hex chars) for bank details, virtual card PAN/CVV, ERP credentials. |

### Feature-gated (set only for the features you're enabling)

<details>
<summary>Click to expand — ~30 optional vars grouped by feature</summary>

**MS Graph (Teams chat + Outlook email, TandA only)**
- `VITE_AZURE_CLIENT_ID`, `VITE_AZURE_TENANT_ID` — blank disables the integration.

**Container tracking (Phase 1 vendor portal)**
- `SEARATES_API_KEY` — without it, refresh buttons surface a friendly error.

**Email notifications**
- `RESEND_API_KEY`, `RESEND_FROM` — without Resend, notifications log-only.
- `INTERNAL_PROCUREMENT_EMAILS` / `INTERNAL_INVOICE_EMAILS` / `INTERNAL_SHIPMENT_EMAILS` / `INTERNAL_COMPLIANCE_EMAILS` / `INTERNAL_CONTRACT_EMAILS` / `INTERNAL_DISPUTE_EMAILS` / `INTERNAL_MESSAGE_EMAILS` / `INTERNAL_EDI_EMAILS` / `INTERNAL_ONBOARDING_EMAILS` / `INTERNAL_FINANCE_EMAILS` / `INTERNAL_VENDOR_ALERT_EMAILS` — comma-separated distros for each notification class.

**FX / multi-currency (Phase 10.2)**
- `OXR_APP_ID` — OpenExchangeRates. Falls back to ECB free feed if unset.
- `FX_PROVIDER` (`oxr` \| `ecb` \| `manual`), `FX_PROVIDER_NAME`, `FX_BASE_CURRENCY` (default `USD`), `FX_FEE_PCT` (default `0.5`).

**Dynamic discounting + tax (Phase 10.3, 10.6)**
- `COST_OF_CAPITAL_PCT` — APR floor for discount offers. Default `6`.
- `DEFAULT_ENTITY_JURISDICTION` — fallback for tax rules. Default `US`.

**EDI**
- `EDI_INBOUND_SHARED_SECRET` — HMAC secret for inbound 855/856/810/997 webhooks.

**Document mirror**
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.

**Ecom demand sync (Inventory Planning Phase 2)**
- `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_STORES`.

**Mobile push (Phase 8)**
- iOS: `APNS_BUNDLE_ID`, `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_USE_SANDBOX`.
- Android: `FCM_SERVER_KEY`.

</details>

### Staging

`scripts/staging-setup.mjs` writes:

| Name | Purpose |
|---|---|
| `STAGING_API_BASE_URL` | Base URL for smoke tests (`scripts/staging-smoke.mjs`). |
| `STAGING_VENDOR_API_KEY` | Scrypt-hashed vendor API key; raw value only exists in `.env.staging`. |
| `STAGING_VENDOR_B_API_KEY` | Second vendor's key (tests cross-tenant isolation). |

`.env.staging` is gitignored — never commit it.

---

## 4. Database migrations

All schema changes live in `supabase/migrations/<timestamp>_<name>.sql`. The
project follows strict additive conventions (see `CLAUDE.md` §Database):

- Every table gets `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
  `created_at timestamptz NOT NULL DEFAULT now()`, FKs with explicit
  `ON DELETE` behavior, and indexes on FK columns + filter columns.
- Never drop columns or tables; add nullable columns and backfill separately.
- Money fields: `numeric` / `decimal`, never `float`.
- Sensitive fields: encrypted (`bytea` or text) via `api/_lib/crypto.js`.

### Writing a migration

```bash
supabase migration new <descriptive-name>
# edit supabase/migrations/<timestamp>_<name>.sql
```

### Applying migrations locally

```bash
supabase db reset            # drops local DB and re-runs every migration + seed
# or, for incremental work:
supabase db push             # applies pending migrations to whatever's linked
```

Seed data lives in `supabase/seed.sql` plus the phase-specific files under
`supabase/seed/`. `staging-setup.mjs` handles running both in the right
order — if you just do `supabase db reset` you'll only get `seed.sql`.

### Applying to a hosted Supabase project

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

### CI does NOT apply migrations (footgun)

The CI workflow (`.github/workflows/test.yml`) only runs `npm ci && npm test`.
It does **not** touch the database. Vercel deploys the frontend + serverless
handlers the moment `main` is updated — if a handler expects a new table or
column, **the deploy will 500 on that endpoint until you run `supabase db push`
yourself**.

Required order when a PR includes a migration:

1. Merge PR → Vercel starts building.
2. While the build runs: `supabase link --project-ref <prod> && supabase db push`.
3. Verify the migration landed in Supabase Studio.
4. Wait for Vercel to finish. Test the new endpoint.

If you forget step 2, roll back the Vercel deploy — don't try to race it.

### Row-level security

The RLS story is documented in migration `20260415100004_rls_policies.sql`
and DECISIONS.md. Summary:

- Internal apps use the anon key and rely on a permissive
  `FOR ALL TO anon USING (true)` policy — this is what keeps the four
  legacy sub-apps working unchanged.
- Vendor portal uses `authenticated` role and gets scoped by a second
  policy: `USING (vendor_id IN (SELECT vendor_id FROM vendor_users WHERE auth_id = auth.uid()))`.
- Service-role key (server-side) bypasses RLS entirely.

---

## 5. Running the test suite

Vitest, JSDom environment (for React components), ~1060 unit/integration
tests covering the store, hooks, handlers, and helpers.

```bash
npm test                  # full run, headless
npx vitest                # watch mode
npx vitest <pattern>      # scoped run
npx vitest --ui           # optional browser runner (install @vitest/ui first)
```

CI runs on every push/PR against `main` — see `.github/workflows/test.yml`.
A PR cannot merge unless the `Tests` check is green.

### Writing tests

- Component / hook tests live alongside the code in `__tests__/`.
- API handler tests import the handler directly, construct a fake `req`/`res`
  pair, and assert on status/body.
- Anything that parses dates — use UTC date math. The codebase got bitten by
  a `getDate()` vs `getUTCDate()` mismatch that only failed in CI; see the
  `generateMilestones` fix in `src/tanda/milestones.ts`.

### Staging smoke tests

`scripts/staging-smoke.mjs` hits a running staging stack with the generated
API key and verifies the dispatcher routes + auth work end-to-end.

```bash
npm run staging:smoke
```

---

## 6. Running background jobs locally

Cron schedules live in `vercel.json` (15 jobs). Each one is a plain handler
under `api/_handlers/cron/*.js` — callable by HTTP or imported directly.

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/push-delivery` | every 2 min | Drains the pending push queue (APNS + FCM). |
| `/api/cron/ip-integration-health` | every 15 min | Pings active ERP/EDI integrations. |
| `/api/cron/ip-freshness-refresh` | every 4 h | Invalidates stale planning caches. |
| `/api/cron/fx-rate-sync` | every 4 h | Pulls latest FX rates (OXR or ECB). |
| `/api/cron/discount-offers-daily` | 11:00 | Expires offers past `expires_at`, generates new ones. |
| `/api/cron/workspace-tasks-due-soon` | 12:00 | Notifies assignees. |
| `/api/cron/compliance-automation` | 13:00 | Rule-driven compliance reminders + escalation. |
| `/api/cron/compliance-daily` | 14:00 | Baseline expiry marking + notifications. |
| `/api/cron/insights-digest-daily` | 14:00 | Sends unread AI-insights digest. |
| `/api/cron/contracts-daily` | 15:00 | Contract renewal reminders. |
| `/api/cron/anomalies-nightly` | 08:00 | Detects PO/invoice anomalies. |
| `/api/cron/insights-weekly` | Mon 06:00 | Re-runs the insight generator. |
| `/api/cron/scorecards-monthly` | 1st of month, 06:00 | Computes vendor scorecards. |
| `/api/cron/health-scores-monthly` | 1st of month, 07:00 | Computes vendor health scores. |
| `/api/cron/benchmark-compute` | 1st of month, 07:00 | Anonymised benchmark percentiles. |

### Running one on demand

```bash
# via vercel dev — full routing
vercel dev &
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/compliance-daily

# via Node, skipping auth (test context only)
node --import tsx -e \
  "import('./api/_handlers/cron/compliance-daily.js').then(m => m.default({ method: 'GET', headers: {} }, { status: c => ({ json: console.log, end: () => {} }), setHeader: () => {} }))"
```

All cron handlers are idempotent — safe to re-run on the same window without
double-writing.

### Triggering from Vercel

Crons in `vercel.json` auto-register when the `main` branch deploys. You can
manually run them from the Vercel dashboard → Deployment → Functions → Cron.

---

## 7. API authentication

Three caller types — all resolved by `api/_lib/vendor-auth.js`
(`authenticateVendor`) for vendor routes and by JWT/service-role in
`api/_lib/internal-auth.js` for internal routes.

### 1. Internal user (staff)

Internal routes (`/api/internal/*`) accept an internal session JWT. The
frontend stores the session in `sessionStorage` (see `src/PLM.tsx`); the
token is sent as `Authorization: Bearer <jwt>`. Service-role calls
(cron jobs, `vendor-invite`) hit the same handlers with the service role
key — they bypass the JWT check.

### 2. Vendor user — browser session

Vendor routes (`/api/vendor/*`) accept a Supabase Auth JWT.

```
Authorization: Bearer <supabase_auth_jwt>
```

`authenticateVendor` exchanges the JWT for the `vendor_users` row and
returns `{ vendor_id, vendor_user_id, role, scopes: ['*'] }`. A human
session gets the universal-wildcard scope — scope filtering only applies to
API keys.

### 3. Vendor — programmatic API key

For integrations that can't hold a user session (EDI adapters, vendor ERPs),
issue an API key from the vendor portal (`/vendor/api-keys`). Keys are
`vnd_`-prefixed, 40+ bytes of entropy, shown once at creation, stored as a
scrypt hash. Either header works:

```
X-API-Key: vnd_0123456789abcdef...
# or
Authorization: Bearer vnd_0123456789abcdef...
```

Keys carry scopes (e.g. `catalog:read`, `invoices:write`, `pos:*`).
`authenticateVendor(admin, req, { requiredScope: 'invoices:write' })`
rejects keys whose scope set doesn't cover the requirement. Every successful
API-key call fire-and-forget writes to `vendor_api_logs` and bumps
`last_used_at` — don't rely on these writes completing before your response.

Keys are invalidated by setting `revoked_at`; vendor deactivation revokes
all outstanding keys and bans the `auth.users` rows.

### Error shapes

All auth failures return one of:

```json
{ "error": "Missing credentials",   "status": 401 }
{ "error": "Invalid token",         "status": 401 }
{ "error": "Vendor not found",      "status": 401 }
{ "error": "Scope not permitted",   "status": 403 }
{ "error": "Vendor suspended",      "status": 403 }
```

### cURL examples

**Internal JWT** (staff session):
```bash
curl https://app.example.com/api/internal/vendors \
  -H "Authorization: Bearer $INTERNAL_JWT"
```

**Vendor JWT** (browser session, copied from Supabase Auth):
```bash
curl https://app.example.com/api/vendor/pos \
  -H "Authorization: Bearer $VENDOR_SUPABASE_JWT"
```

**Vendor API key** (`vnd_` prefix — integrations, EDI adapters):
```bash
curl https://app.example.com/api/vendor/invoices \
  -H "X-API-Key: $VENDOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"po_number":"PO-1234","invoice_number":"INV-001","total":5000.00}'
```

Scope gate is per-handler — a key missing `invoices:write` will get a 403
even if the request body is valid.

---

## 8. Vendor onboarding flow

Six-step sequential workflow, tracked in `vendor_onboarding_workflows`.
Steps must complete in order; each step has server-side validation in
`api/_handlers/vendor/onboarding/steps/[step_name].js`.

### Step 0 — Invite

Internal user opens the Vendor Directory, clicks "Invite to portal" on a
vendor row. The modal posts to `POST /api/vendor-invite` with
`{ email, display_name, legacy_blob_id, site_url }`. The server:

1. Resolves `legacy_blob_id` → `vendors.id`.
2. Calls `supabase.auth.admin.inviteUserByEmail(email, { redirectTo: '<site_url>/vendor/setup' })`.
3. Inserts a `vendor_users` row linking the new `auth.uid()` to the vendor.

The vendor receives an invite email (Supabase template — see
`docs/vendor-portal-auth-setup.md`). Clicking the link lands them on
`/vendor/setup` with a one-time confirmation token.

### Step 1 — Company info

Required: `legal_name`, `address`, `business_type`, `year_founded`.
Optional: `tax_id` (EIN / VAT).

`PUT /api/vendor/onboarding/steps/company_info` persists the data onto the
workflow row and advances `current_step`.

### Step 2 — Banking

Vendor submits bank details through `POST /api/vendor/banking` first (the
payload is AES-256 encrypted via `api/_lib/crypto.js`), which returns a
`banking_detail_id`. The step handler then verifies the ID belongs to the
authenticated vendor before advancing.

### Step 3 — Tax classification

Required: `classification` (W-9 or W-8BEN), `document_url` (a file already
uploaded to the `compliance-docs` storage bucket).

### Step 4 — Compliance docs

Required: every `compliance_document_types.required = true` type must have
at least one `compliance_documents` row in status `approved` or `submitted`.
Vendors upload via `POST /api/vendor/compliance-documents` which validates
MIME + size + expiry.

### Step 5 — Portal tour

Any payload accepted — the step exists so that the UI can record that the
vendor actually clicked through the product tour.

### Step 6 — Agreement

Required: `accepted_at` (ISO timestamp) and `ip`. Completing this step flips
the workflow to `status = 'pending_review'`, which internal users see in the
Onboarding review queue (`InternalOnboarding.tsx`).

Internal review then moves the workflow to `approved` or `rejected`.
Approval triggers the `onboarding_approved` notification and exposes the
vendor to RFQ inclusion, preferred-vendor promotion, etc.

---

## 9. Phase summary and feature list

Each phase is an independently shippable slice. Detailed specs and
sub-slices live in [../BUILD_PLAN.md](../BUILD_PLAN.md); non-obvious
architectural calls are logged in [../DECISIONS.md](../DECISIONS.md).

| Phase | Theme | Highlights |
|---|---|---|
| 0 | Prerequisites | `vendors` materialized, `vendor_id` FK on `tanda_pos` + fuzzy backfill, `vendor_users`, baseline RLS (anon-permissive + authenticated-filtered). |
| 1 | MVP vendor portal | `/vendor` PO dashboard, admin invite, Searates container tracking (user-initiated), TandA Shipments tab. |
| 2 | Transactional basics | Invoice upload + 3-way match, shipment ASN + timeline, payment status, 20+ notification event types. |
| 3 | Compliance + comms | Compliance docs + expiry cron, per-PO messaging, scorecards, reporting. |
| 4 | Governance primitives | Contracts, disputes, catalog, bulk ops, vendor API keys (scrypt + scopes). |
| 5 | Onboarding + integrations | 6-step onboarding (§8), EDI X12 pipeline (850/855/856/810/820/997), ERP writeback, anomaly + health-score crons. |
| 6 | Execution layer | Dispute lifecycle hardening, optional ERP writeback (export-first, dry-run), accuracy workbench. |
| 7 | Production hardening | Entity scoping, RBAC, audit, stale-data banners, observability. |
| 8 | Multi-entity, workflows, RFQ, mobile | White-label branding, workflow rule engine + approvals, 12-endpoint RFQ lifecycle, mobile push. |
| 9 | AI, ESG, marketplace, benchmarks | Compliance automation, ESG + diversity, AI insights (rule-based; LLM hook), workspaces, marketplace, anonymised benchmarks. |
| 10 | Payments, FX, discounting, SCF, cards, tax | Payments register, daily FX sync, dynamic discounting (APR ≥ 6%), SCF, virtual cards (AES-256, 24h reveal), tax calculations + remittance, early-payment analytics. |

**API consolidation (2026-04-20):** all 253 handlers moved from `api/**/*.js`
to `api/_handlers/**/*.js` behind `api/dispatch.js`. URLs and HTTP contracts
unchanged — see [DECISIONS.md §2026-04-20](../DECISIONS.md).

---

## 10. Deploy

Production runs on Vercel, tracking `main`. The rollout flow:

1. Merge a PR into `main`. GitHub Actions runs `npm ci && npm test` as a
   hard gate (`.github/workflows/test.yml`).
2. Vercel picks up the new `main` commit and builds. Frontend is a static
   Vite bundle; `api/dispatch.js` is the single serverless function.
3. If the PR includes a migration, **also** run `supabase db push` against
   the production project before the deploy finishes — CI does not do this
   (see §4).
4. Vercel promotes the build to production. Preview URLs stay available
   per-branch for QA.

Manual deploy from your machine (skips git, useful for hotfix verification
on preview):

```bash
npm run deploy    # vite build → scripts/setup-vercel.mjs → vercel --prod --prebuilt
```

Crons in `vercel.json` register automatically on every production deploy —
no separate step. Rollbacks are one click from the Vercel dashboard
(Deployments → Promote to Production on any prior green build).

---

## License

Proprietary. All rights reserved.
