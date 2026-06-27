# CLAUDE.md — Vendor Portal / PO WIP App

This file is read automatically by Claude Code at the start of every session.
Follow every instruction here without asking for permission or confirmation.

---

## Behaviour rules

- Never ask for permission before reading files, writing code, running migrations, or executing commands
- Never add caveats, disclaimers, or "you may want to consider" commentary
- Never suggest alternatives unless the current approach is technically broken
- Never truncate code with comments like `// ... rest of file` or `// existing code here` — always write complete files
- Never wrap output in explanation unless specifically asked
- If something is ambiguous, make a reasonable decision and state what you chose — do not stop and ask
- Always write production-quality code — no TODOs, no placeholder logic, no stub functions
- When editing an existing file, rewrite the full file — do not output diffs or partial files unless the file is over 500 lines, in which case use targeted edits with full context
- Run linting and type checking after every file change if the project has them configured
- If a test suite exists, run relevant tests after changes and fix failures before reporting done

---

## Project overview

This is a PO WIP app being extended with a full vendor portal. The vendor portal allows external vendor companies to log in, view purchase orders, submit invoices, track shipments, manage compliance documents, and communicate with the internal procurement team.

### Build phases completed (reference only — do not re-implement)

- Phase 1: Auth, PO view, invoice upload
- Phase 2: 3-way match, shipments, payment status, notifications
- Phase 3: Compliance docs, messaging, reporting, scorecards
- Phase 4: Contracts, disputes, catalog, bulk ops, API keys, vendor management
- Phase 5: Onboarding workflows, EDI, ERP integration, anomaly detection, health scores
- Phase 6: Multi-entity, white-label branding, workflow automation, RFQ, mobile push
- Phase 7: AI insights, collaboration workspaces, ESG/sustainability, compliance automation, marketplace
- Phase 8: Dynamic discounting, supply chain finance, FX payments, virtual cards, tax automation

---

## Stack — auto-detect on first run

On first run, read the following and confirm the stack before doing anything else:

- `package.json` / `requirements.txt` / `go.mod` / `Cargo.toml` — language and dependencies
- Migration files — ORM and migration tool
- Existing route files — routing pattern and folder structure
- `.env.example` — environment variables and service dependencies
- Existing middleware — auth pattern, error handling
- Existing tests — test framework and conventions
- Any existing `README.md` for additional context

Match every pattern you find exactly. Do not introduce new patterns, libraries, or conventions without being asked.

---

## Database

- Always write migrations — never modify the schema directly
- Migration filenames must follow the existing naming convention in the project
- Every new table needs: `id` (uuid or serial depending on existing pattern), `created_at`, and any FKs with appropriate cascade rules
- Always add indexes on: all FK columns, any column used in WHERE clauses in hot paths, status columns used for filtering
- Never drop columns or tables — add new columns as nullable, backfill separately
- All money/decimal fields: use `decimal` or `numeric` — never `float`
- Soft deletes: use `deleted_at` timestamp (nullable) or `status` enum — match existing pattern
- Sensitive data (card numbers, bank account numbers, API key hashes, passwords): never store plaintext. Use bcrypt for passwords and tokens, AES-256 for PII fields

---

## API

- All vendor-facing routes: extract `vendor_id` from the JWT payload — never trust it from request body or URL params
- All entity-scoped routes: extract `entity_id` from JWT or `X-Entity-ID` header — never trust from body
- Enforce this at the middleware layer, not inside route handlers
- Every route must validate its input — use the existing validation library
- Return consistent error shapes — match the existing error response format exactly
- HTTP status codes: 200 success, 201 created, 400 validation error, 401 unauthenticated, 403 unauthorized, 404 not found, 409 conflict, 422 unprocessable, 500 server error
- Pagination: match existing pattern (cursor or offset — check existing routes)
- Never return passwords, token hashes, encrypted fields, or internal IDs not meant for external use in API responses
- File uploads: validate MIME type server-side (not just extension), enforce size limits, store to the existing file storage (local or S3 — check existing upload handler)

---

## Auth

- JWT: 15 minute expiry on access tokens
- Refresh tokens: random UUID, stored as bcrypt hash in DB, delivered via `httpOnly` `Secure` `SameSite=Strict` cookie, 30 day expiry
- bcrypt cost factor: 12 for all password and token hashes
- Invite tokens: cryptographically random, stored as bcrypt hash, single-use, 72 hour expiry
- API keys: prefix `vnd_`, cryptographically random, stored as bcrypt hash, shown to user exactly once on creation, never again
- On vendor deactivation: block login at JWT issuance layer (check vendor status on login and refresh), revoke all API keys by setting `revoked_at`

---

## Background jobs

- Use the existing job queue — do not introduce a new one
- Every job must be idempotent — safe to run multiple times with the same input
- Every job must log start, completion, and any errors
- Long-running jobs: process in batches, never load all records into memory at once
- If a job fails, it should not silently swallow the error — log and alert
- Scheduled jobs and their frequencies:
  - 3-way match: triggered on invoice submission and goods receipt creation
  - ERP sync: every 15 minutes per active integration
  - FX rate refresh: every 4 hours
  - Compliance expiry checker: daily
  - Contract expiry checker: daily
  - Anomaly detection: nightly
  - Scorecard generator: monthly (1st of month)
  - Health score calculator: monthly
  - AI insight generator: weekly
  - Benchmark data: monthly
  - Dynamic discount offer generator: daily
  - Dispute escalation checker: daily
  - Workspace task due-soon alerts: daily
  - Push notification delivery: continuous queue processor

---

## Security

- Never log: passwords, token hashes, API keys, card numbers, bank account numbers, PII, request bodies containing sensitive fields
- Encrypt at rest using AES-256: card numbers, CVVs, bank account numbers, routing numbers, ERP integration credentials
- Mask in all API responses: show only last 4 digits of card numbers, never return full account numbers
- FX rates: block payment processing if rates are older than 8 hours — do not use stale rates
- Virtual cards: use provider tokenization (Stripe/Marqeta) — do not store raw PANs in your database
- File storage: never serve uploaded files directly from your web server — use signed URLs with short expiry
- SQL: use parameterised queries always — no string interpolation in SQL
- Rate limiting: apply to all auth endpoints (login, register, token refresh)
- CORS: restrict to known origins — do not use wildcard in production

---

## File structure conventions

Match the existing project structure exactly. If the project uses:
- Feature-based folders: put new code in a folder for that feature
- Layer-based folders (controllers/services/models): follow the same layering
- Do not create new top-level folders without being asked

---

## UI conventions

**NON-NEGOTIABLE — all dropdown fields use the app (dark) colors.** Every
dropdown across every app — native `<select>` *and* its option popup, plus
custom dropdowns (`SearchableSelect`, `MultiSelectDropdown`, the Settings menu,
costing picker cells, the vendor language picker, etc.) — must render in the app
palette, never a light/OS-default control:

- bg `#0b1220` (input) / `#1E293B` (card/menu) · border `#334155` · text
  `#F1F5F9` · muted `#94A3B8` · accent `#3B82F6` · `<select> option` bg
  `#0b1220` text `#F1F5F9`.
- Native `<select>` inherit the global dark default in `index.html` (#1330) —
  **do not inject a light `select`/`select option` rule anywhere** (an unscoped
  `select option{background:#FFFFFF}` in `App.tsx` once leaked white option
  popups into every dark app). Only add inline color to a select when it must
  *differ* from the dark default, and never to make it lighter.
- **Never add a native `<select>`.** A native `<select>`'s OPEN option popup
  renders in the OS/generic (light) theme on Windows and cannot be reliably
  CSS-themed. The whole suite was swept to `SearchableSelect`
  (`src/tanda/components/SearchableSelect.tsx`) — the only remaining native
  control is the intentional `<select multiple>` in `StyleImageGallery`. Always
  use `SearchableSelect` for new dropdowns.
- `SearchableSelect` takes `theme?: "dark" | "light"` (default `"dark"`). Use the
  default in dark apps (Tangerine, inventory-planning, vendor portal, costing,
  AI, ATS, tech packs). Pass **`theme="light"`** in the light-surfaced apps
  (Design Calendar/PLM components, GS1, B2B, the PLM launcher) — otherwise the
  popover renders dark on a white page. (`inventory-planning/components/SearchableSelect.tsx`
  is unused dead code — don't use it.)
- The PLM launcher (`App.tsx` / `PLM.tsx`) and the Design Calendar/GS1/B2B apps
  are the intentionally light surfaces; Tangerine and the other ERP apps are dark.

When you add or touch any dropdown, verify the **closed control and the open
popup** both match the app palette.

---

## Testing

- If tests exist: write tests for every new endpoint and background job
- Match the existing test style exactly (unit vs integration, mocking approach, fixture patterns)
- Tests must pass before you report a task as complete
- Do not write tests that mock the database unless the project already does this — prefer real DB tests with a test database

---

## Date pickers

**NON-NEGOTIABLE — every date-RANGE picker offers quick presets.** When you add
or touch a from/to date-range filter anywhere in any app, add the drop-in
`<DateRangePresets from={..} to={..} onChange={(f,t)=>...} variant="dropdown" />`
(`src/tanda/components/DateRangePresets.tsx`) if it doesn't already have one.

- Built-in presets (MTD, YTD, Last 30/60/90d, This/Last month/quarter/year, …)
  live in `src/tanda/components/dateRangeMath.ts` (`DEFAULT_PRESETS`). Add new
  built-ins there.
- The selector auto-loads the operator's presets from the **Date Presets master**
  (`/api/internal/date-presets`, Tangerine module `date_preset_master`) and merges
  them in — so existing pickers pick up custom presets automatically. Master
  presets are relative expressions (`kind` + `n`), recomputed against "today" via
  `computeForKind()` — never stored absolute ranges.
- The master is **backfilled with the current built-ins** (MTD, YTD, This/Last
  Year, Last 30/60/90d, Last month/quarter, TY→last month) as rows tagged with a
  `source_key` naming the code preset they mirror (migration `20260911…`). So the
  operator sees and manages the live presets — reorder / relabel / disable — from
  the master, not just add new ones. `mergePresets()` drops any code built-in
  whose key is covered by an active `source_key` row, so each preset shows ONCE
  (the editable master row wins); delete a backfilled row and the code built-in
  transparently reappears as the fallback.
- Single-date FORM fields (invoice date, due date, ship date) are exempt —
  presets apply to date-range FILTERS only.

---

## Notifications

Notification events and their channels (add new ones following this pattern):

| Event | Email | In-app | Push |
|---|---|---|---|
| po_issued | yes | yes | yes |
| invoice_approved | yes | yes | yes |
| invoice_discrepancy | yes | yes | yes |
| payment_sent | yes | yes | yes |
| new_message | digest | yes | yes |
| compliance_expiring_soon | yes | yes | yes |
| onboarding_approved | yes | yes | yes |
| rfq_invited | yes | yes | yes |
| rfq_awarded | yes | yes | yes |
| discount_offer_made | yes | yes | yes |
| scf_funded | yes | yes | yes |
| anomaly_detected (high/critical) | yes | yes | no |
| workspace_task_assigned | yes | yes | yes |

Email digest rule: if more than 3 notifications of the same type arrive within 1 hour for the same recipient and entity, batch them into a single digest email.

If no email provider is configured: queue emails to the Notification table and log them — do not fail silently and do not throw.

---

## Domain rules — never violate these

- A vendor can only see data belonging to their own `vendor_id`
- An entity-scoped user can only see data belonging to their `entity_id`
- A vendor cannot submit an invoice against a PO that is not in `acknowledged` status
- A vendor cannot edit a submitted invoice
- A vendor cannot see another vendor's RFQ quotes
- Invoice 3-way match runs as a background job — never inline on the HTTP request
- Dynamic discount annualized return = `(discount_pct / 100) * (365.0 / days_early) * 100` — use exact calendar days, not 30-day months
- Tax rates are stored in the database and editable by non-engineers — never hardcode rates in application code
- Supply chain financing must display a disclaimer that it is a financial product — never call it a loan in UI copy
- Vendor deactivation must: block login, revoke all API keys, preserve all historical data — never delete records
- Onboarding gate: vendor cannot submit invoices until `onboarding.status = approved` and `vendor.status = active`
- Benchmark data requires minimum 5 vendor samples — return null if fewer, never expose individual vendor data through aggregations

---

## When starting a new phase prompt

1. Read this file
2. Read the existing codebase to confirm stack, patterns, and conventions
3. Summarise what you found
4. Confirm you are ready
5. Then build — complete files, no stubs, no TODOs

Do not skip steps 1-4.
