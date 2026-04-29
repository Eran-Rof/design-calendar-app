# Build Plan

## Phase 10 — Payments, dynamic discounting, SCF, multi-currency, virtual cards, tax, early-payment analytics

Migration: `supabase/migrations/20260420100000_phase10_schema.sql` (DRAFTED, not applied). 12 new tables (including a prerequisite `payments` table that the legacy schema never had). Additive-only; review before `db push`.

Ship order (smallest blast radius first):

### 10.1 — Payments primitive + vendor payment preferences
**API**
- `GET|POST /api/internal/payments` — manual create (ACH/wire/check)
- `GET /api/internal/payments/:id`, `PUT .../complete` — status transitions
- `GET|POST /api/vendor/payment-preferences` — vendor self-serve (upsert resets on vendor edit)
**UI**
- Internal: payments register + per-invoice "Pay" button
- Vendor: preferences form (currency / method / FX handling)
**Tests**: status transitions, vendor auth scope on preferences.

### 10.2 — Multi-currency / FX infrastructure
**API**
- `POST /api/cron/currency-rates-sync` — daily pull from openexchangerates (ENV `OXR_APP_ID`) or ECB feed; writes `currency_rates` rows
- `GET /api/internal/currency-rates?from=&to=` — latest rate lookup
- `POST /api/internal/international-payments` — called when `payments.method='wise'` and currencies differ; writes `international_payments` row + calls Wise/CurrencyCloud provider
**UI**
- Internal payments detail: shows source→vendor FX conversion, rate, fees
- Vendor: currency shown based on preference
**Tests**: rate-lookup fallback (latest per pair), FX calculator (from_amount → to_amount with fee).

### 10.3 — Dynamic discounting
**API**
- `POST /api/internal/discount-offers` — create an offer for an invoice
- `GET /api/vendor/discount-offers` — vendor's pending offers
- `POST /api/vendor/discount-offers/:id/accept|reject`
- Cron `api/cron/discount-offers-expire.js` — daily, flip `offered → expired` past `expires_at`
- On `accepted` → create a `payment` with `status='initiated'` dated for `early_payment_date`; on paid → mark offer `paid`
**Notification events**: `discount_offer_extended` (vendor), `discount_offer_accepted` (internal)
**UI**
- Internal: AP aging page shows "Offer early payment" per invoice
- Vendor: dedicated `/vendor/discount-offers` page
**Tests**: APR calculation, expiry cron semantics, accept→payment linkage.

### 10.4 — Supply Chain Finance (SCF)
**API**
- CRUD on `supply_chain_finance_programs` (internal)
- `POST /api/vendor/finance-requests` — vendor requests funding against an approved invoice
- `PUT /api/internal/finance-requests/:id/approve|reject|fund|repay`
- Utilization tracked on program (+= on fund, -= on repay); enforce `current_utilization <= max_facility_amount`
**UI**
- Internal: program manager + request approval queue + utilization gauge
- Vendor: request form on any approved-but-unpaid invoice
**Tests**: utilization math, status machine, vendor auth.

### 10.5 — Virtual cards
**API**
- `POST /api/internal/virtual-cards` — issue card via provider (Stripe/Marqeta/Railsbank); encrypts PAN + CVV via existing `api/_lib/crypto.js` before insert; returns only last4 + masked data
- `GET /api/internal/virtual-cards/:id` — detail; full PAN only revealed to authorized internal roles via a separate `/reveal` endpoint with audit logging
- `POST /api/internal/virtual-cards/:id/cancel`
- Webhook handler `api/virtual-card-webhook.js` — updates `amount_spent` on transaction events
**UI**
- Internal: "Issue virtual card" action on invoices; card detail screen with masked PAN and reveal-with-reason flow
**Tests**: encryption round-trip, status transitions, webhook idempotency.

### 10.6 — Tax compliance
**API**
- CRUD on `tax_rules` (internal admin)
- Hook in invoice approval path: `api/_lib/tax.js:calculateTaxForInvoice()` runs active rules by jurisdiction + applies_to against line items, writes `tax_calculations` rows
- `GET /api/internal/tax-remittances` — generated remittance queue
- `POST /api/internal/tax-remittances/:id/file` and `.../pay` — status transitions
- Cron `api/cron/tax-remittance-generate.js` — monthly, aggregates `tax_calculations` into `tax_remittances`
**UI**
- Internal: tax rule editor, remittance queue, per-invoice tax detail panel
- Vendor: tax line itemization on invoice detail (read-only)
**Tests**: rule selection (effective date, jurisdiction, exemptions), remittance rollup math.

### 10.7 — Early-payment analytics
**API**
- Cron `api/cron/early-payment-analytics.js` — monthly; rolls up `dynamic_discount_offers` per entity/period, computes APR from discount_pct + days_early, writes `early_payment_analytics`
- `GET /api/internal/analytics/early-payment` — time-series + totals
**UI**
- Extend `InternalAnalytics.tsx` with an "Early-payment capture" panel: offers/accepted ratio, $ captured, annualized return
**Tests**: APR formula, rollup boundaries (month edges), idempotent upsert.

---

## Phase 9 — AI insights, collaboration, ESG/diversity, compliance automation, marketplace, benchmarks

Migration: `supabase/migrations/20260419800000_phase9_schema.sql` (DRAFTED, not applied). Review before running. Additive-only (all `CREATE TABLE IF NOT EXISTS` + RLS); no ALTER/DROP on existing tables.

Ship order: each slice below is independent and individually shippable. Recommended order = smallest blast radius first.

### 9.1 — Compliance automation (smallest, reuses existing compliance_documents)

**API**
- `GET|POST /api/internal/compliance-automation-rules` — list/create rules for an entity
- `PUT|DELETE /api/internal/compliance-automation-rules/:id`
- `GET /api/internal/compliance-audit-trail?vendor_id=&document_id=` — audit history
- Cron job `api/cron/compliance-automation.js` — daily: evaluate active rules, for `expiry_approaching` send renewal request notification (reuse `api/send-notification.js`), write `compliance_audit_trail` rows with `action='requested'`, `performed_by_type='system'`. Escalation: if a document is still not renewed `escalation_after_days` days after request, fire another notification.
- Hook existing `compliance_documents` write paths: on upload / review / approve / reject / expire, insert an audit trail row.

**UI (internal, TandA)**
- New tab "Compliance automation" (`src/tanda/InternalComplianceAutomation.tsx`): table of rules per entity, inline toggle `is_active`, + New rule modal, + Edit.
- New tab "Audit trail" (`src/tanda/InternalComplianceAudit.tsx`): filterable by vendor / document type / action, chronological feed.

**Tests**: unit tests for the cron evaluator (given a doc with expiry in N days + a rule with days_before_expiry, does it fire once?), and RLS smoke: vendor sees only their own audit rows.

### 9.2 — ESG + diversity (vendor-facing forms + internal review)

**API**
- `GET|POST /api/vendor/sustainability-reports` — vendor submits their own; status starts `submitted`
- `GET|POST /api/vendor/diversity-profile` — single row per vendor, upsert
- `GET /api/internal/sustainability-reports?status=submitted` — review queue
- `POST /api/internal/sustainability-reports/:id/approve` and `/reject` (body `{reason}`)
- `POST /api/internal/diversity-profiles/:id/verify` — flips `verified=true`, sets `verified_at/by`
- `GET /api/internal/esg-scores?vendor_id=` + scheduled job `api/cron/esg-compute.js` — monthly generator pulls from sustainability_reports + diversity + scorecard to produce an `esg_scores` row per vendor/period

**UI (vendor, `src/vendor/`)**
- `VendorSustainability.tsx`: list past reports, submit new report form (scope 1/2/3, renewable %, waste %, water, certifications multi-select, file upload via existing storage pattern)
- `VendorDiversity.tsx`: diversity profile form (business_type multi-select, cert body/number/expiry, certificate upload)
- Both routes added under existing VendorApp router.

**UI (internal)**
- `InternalSustainabilityQueue.tsx`, `InternalDiversityQueue.tsx` — approve/reject/verify
- `InternalESGScores.tsx` — dashboard of vendor ESG scores with period selector

**Tests**: form validation, ESG computation stub (given inputs, does overall = weighted avg?), API authz (vendor can only write own).

### 9.3 — AI insights (read-only surface; generator is a stub initially)

**API**
- `GET /api/internal/ai-insights?entity_id=&status=&type=` — list
- `POST /api/internal/ai-insights/:id/actioned` / `/dismissed` / `/read` — status transitions
- `POST /api/internal/ai-insights/generate` (manual trigger) — stub that runs the handful of deterministic rules (low-scoring vendors → risk_alert; multiple overlapping POs → consolidation; contracts within 60 days of expiry → contract_renewal). No LLM call yet — leave the hook point documented.
- Expiry: skip rows where `expires_at < now()` in default list.

**UI (internal)**
- `InternalInsights.tsx`: card-grid feed by type, per-card Action / Dismiss / Mark read.
- Add a badge to the TandA nav showing count of `status='new'`.

**Tests**: generator rule outputs for fixture inputs; list endpoint filters by entity + status + excludes expired.

### 9.4 — Collaboration workspaces (cross-side)

**API**
- CRUD for `collaboration_workspaces`, nested `/pins` and `/tasks`. Both internal (`/api/internal/workspaces/*`) and vendor (`/api/vendor/workspaces/*`) routes, RLS scoped.
- Pin resolver: given `(entity_type, entity_ref_id)`, return a lightweight display payload so the UI can render a chip without joining N tables.

**UI**
- `src/vendor/VendorWorkspaces.tsx` + `src/tanda/InternalWorkspaces.tsx`: workspace list, detail view with pinned items + tasks + notes.
- Task list uses the same patterns as existing PO messages (realtime-ish polling, not websockets — consistent with rest of codebase).

**Tests**: pin resolver covers each entity_type; task status transitions; RLS (vendor only sees their own workspace, internal sees all).

### 9.5 — Marketplace (listings + inquiries)

**API**
- Vendor: `GET|POST|PUT /api/vendor/marketplace-listings` (vendor manages their own)
- Public-to-internal: `GET /api/internal/marketplace-listings?category=&capability=` — discovery
- `POST /api/internal/marketplace-listings/:id/view` — increments `views` (ratelimited per user)
- Inquiries: `POST /api/internal/marketplace-inquiries` (internal inquires), `GET /api/vendor/marketplace-inquiries` (vendor sees theirs), `POST /api/vendor/marketplace-inquiries/:id/respond`, `POST /api/internal/marketplace-inquiries/:id/convert-to-rfq` — creates an `rfqs` row and sets inquiry `rfq_id` + `status='converted_to_rfq'`.

**UI**
- Vendor: `VendorMarketplaceListing.tsx` (edit own listing, publish/suspend).
- Internal: `InternalMarketplace.tsx` (browse + filter + inquire, view inquiries queue).

**Tests**: publish-only visibility in RLS, convert-to-rfq creates linked row, featured flag surfaces first.

### 9.6 — Benchmarks

**API**
- `GET /api/internal/benchmarks?category=&metric=&period_start=&period_end=` — simple read.
- Monthly job `api/cron/benchmark-compute.js` — compute percentiles per category+metric from anonymised aggregate data (from `tanda_pos`, `scorecards`, `contracts`), insert a `benchmark_data` row per (category, metric, period).
- Vendor-facing read: `GET /api/vendor/benchmarks` — same data (public-anon / anonymised, RLS allows authenticated read).

**UI**
- Internal spend analytics page gains a "Benchmark overlay" — show vendor's P50 vs category P50 with spark line.
- Vendor-facing: small widget on vendor scorecard showing how their metric compares to benchmark percentiles (no vendor names exposed).

**Tests**: percentile computation over fixture rows; anonymisation — benchmark rows never carry vendor_id.

---

## Workflow Rules & Executions (Admin approvals)

### API

**GET /api/internal/workflow-rules** (internal admin)
- list all rules for current entity
- filter by `trigger_event`, `is_active`

**POST /api/internal/workflow-rules** (internal admin)
- body: `{ name, trigger_event, conditions, actions }`
- validates condition/action schema
- creates rule

**PUT /api/internal/workflow-rules/:id** (internal admin)
- body: `{ name, conditions, actions, is_active }`

**DELETE /api/internal/workflow-rules/:id** (internal admin)

**GET /api/internal/workflow-executions** (internal auth)
- all pending approvals across all rules
- filter by `status`, `rule_id`, `current_approver`
- order by `triggered_at asc`

**GET /api/internal/workflow-executions/:id** (internal auth)
- execution detail with rule, trigger context, current status

**POST /api/internal/workflow-executions/:id/approve** (internal auth)
- approves execution, resumes processing of the original event
- sets `status = approved`

**POST /api/internal/workflow-executions/:id/reject** (internal auth)
- body: `{ rejection_reason }`
- rejects, triggers rejection notification to vendor
- sets `status = rejected`

### Workflow engine middleware
- on each triggering event, evaluate all active WorkflowRules for that entity
- for matching rules, create WorkflowExecution and pause event
- resume or reject based on approver action
- for `auto_approve` action type: immediately approve and continue
- for `webhook` action: POST to configured URL with event payload
- log all executions
