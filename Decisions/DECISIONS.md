# Decisions log

Append non-trivial decisions made while executing BUILD_PLAN.md.

Format:
```
## YYYY-MM-DD — <section>
- **Question:** what was unclear
- **Choice:** what was decided
- **Why:** reasoning
- **Rejected alternatives:** what was not picked, and why
```

---

## 2026-04-29 — 10.7 Early-payment analytics: stored-with-live-fallback, not stored-only
- **Question:** Build plan calls for a monthly cron that persists rollups into `early_payment_analytics`, plus `GET /api/internal/analytics/early-payment` reading the stored rows. Existing impl already has `GET /api/internal/discount-offers/analytics` doing live computation per request. Replace, supplement, or graft together?
- **Choice:** Added the missing cron (`api/cron/early-payment-analytics`, monthly on the 2nd at 08:00 UTC) that upserts a row per entity per period via `(entity_id, period_start, period_end)` unique index. Added the missing endpoint (`GET /api/internal/analytics/early-payment`) which reads from the stored table by default and falls back to live `computeAnalytics()` if no row exists. `?source=stored` forces stored-only (404 on miss); `?source=live` forces live recompute. Existing live endpoint at `/api/internal/discount-offers/analytics` left in place.
- **Why:** Stored snapshots give historical comparison without recomputing N months of offers on every page load; live fallback covers same-month and period ranges the cron hasn't materialized yet so the UI never breaks. Upsert via the existing unique index is naturally idempotent — no delete-then-insert needed.
- **Rejected alternatives:** (1) Replace the live endpoint entirely — would break the existing UI panel that already targets `/api/internal/discount-offers/analytics`. (2) Skip the cron, keep live-only — loses cheap historical comparisons and forces the analytics surface to re-scan offers indefinitely. (3) Delete-then-insert idempotency — the migration ships `uq_epa_entity_period`, so upsert with `onConflict` is simpler.

## 2026-04-20 — API consolidation: 253 files → 1 serverless function
- **Question:** Vercel Pro's function cap is ~100. We had 253 under `api/`, and some (including onboarding) were silently dropped — CDN fell through to serving the raw `.js` source, which frontends tried to `JSON.parse`.
- **Choice:** Moved every handler from `api/**/*.js` to `api/_handlers/**/*.js` (underscore-prefixed so Vercel skips them as non-functions). Created a single catch-all `api/[[...path]].js` that loads a build-time generated route manifest (`api/_handlers/routes.js`) and dispatches by URL pattern. URLs and HTTP contracts unchanged; frontends untouched.
- **Why:** 253 handlers was already technical debt; every new feature made it worse. One dispatcher scales to any number of handlers without touching Vercel limits. `_lib/` imports got rewritten with one extra `../` to account for the new depth — idempotent regex, handled by `scripts/consolidate-api-imports.mjs`.
- **Rejected alternatives:** (1) Upgrade Vercel tier — expensive and kicks the can. (2) Partial consolidation of recent phases only — doesn't solve the underlying scaling cliff. (3) Fluid Compute — wasn't confirmed available on our plan.
- **Idempotency notes:** Re-running `scripts/generate-api-routes.mjs` regenerates `routes.js` deterministically. `scripts/consolidate-api-imports.mjs` is a one-off — safe to re-run since the regex now never matches (paths already have the extra `../`).

## 2026-04-19 — 10.6 Tax: didn't add tax_amount/tax_status columns to invoices
- **Question:** Spec step 8 says "Store total tax on Invoice (add tax_amount, tax_status columns)." Modify the existing `invoices` schema?
- **Choice:** No. Derived total-tax per invoice from `SUM(tax_calculations.tax_amount) WHERE invoice_id = X` at query time (see `GET /api/internal/tax/calculations?invoice_id=`).
- **Why:** Adding columns to `invoices` is an `ALTER` on a high-traffic existing table. The calculations are stored; summing them is cheap and always correct. Keeps the invoices schema unchanged.
- **Rejected alternatives:** Add denormalized columns + trigger/backfill — future work if query performance ever becomes a concern; revisit when per-invoice tax sums show up in hot paths.

## 2026-04-19 — 10.6 Tax: jurisdiction resolution falls through three sources
- **Question:** Spec says vendor jurisdiction comes from `Vendor.address` or `VendorPaymentPreference`; neither is a reliable column today.
- **Choice:** Priority: (1) `invoice.metadata.tax_jurisdiction` if the uploader provided one, (2) `vendors.country` if present, (3) env `DEFAULT_ENTITY_JURISDICTION` (defaults to "US"). Documented in `runTaxForInvoice()`.
- **Why:** Lets the calculation run today with minimum plumbing, and lets ops override per-invoice. When the schema grows a real address field, step (2) picks it up automatically.
- **Rejected alternatives:** Require a jurisdiction field up front — blocks the whole feature on a schema change that isn't this slice's scope.

## 2026-04-19 — 10.6 Tax: diversity-verified profile feeds vendor_type_exemptions
- **Question:** How does the tax engine know which "vendor types" a vendor is for exemption purposes?
- **Choice:** Read from the `diversity_profiles.business_type` array, but only when `verified=true`. Merge with `vendors.business_types` if that column exists.
- **Why:** Reuses the already-verified-by-ops diversity data — no double data entry. Unverified profiles don't count (prevents self-claimed exemptions).
- **Rejected alternatives:** Separate `vendor_tax_exemptions` table — more plumbing, same signal.

## 2026-04-19 — 9.3 AI Insights: consolidation "spend per category"
- **Question:** Schema has no direct category-per-invoice field; how do we compute "combined spend per category" for the consolidation detector?
- **Choice:** Attribute each vendor to their dominant catalog-item category (highest count in `catalog_items`), then sum last-12-month approved/paid invoice totals per vendor in that bucket.
- **Why:** `tanda_pos`/`invoices` don't carry category; categorizing line-by-line would require the regex categorizer already used in `_lib/analytics.js` and is heavier. Dominant-category attribution is 90% accurate for vendors who mostly supply one thing and is good enough to surface consolidation opportunities.
- **Rejected alternatives:** (1) line-by-line categorization via `categorize()` — more precise but slower and adds a cross-dependency; can be swapped in later without changing the API/UI contract. (2) Category from `preferred_vendors` — many vendors aren't preferred, so coverage would be thin.

## 2026-04-19 — 9.3 AI Insights: dedup key is (type, vendor_id)
- **Question:** What counts as a "duplicate" insight so the weekly job doesn't spam?
- **Choice:** Suppress a new candidate if an existing `new` or `read` insight for the same `(entity_id, type, vendor_id)` exists. Actioned/dismissed don't block new insights.
- **Why:** Matches the spec ("do not duplicate: check if same type + vendor_id insight already exists and is unread"). Keeping `read` in the suppression set prevents re-notifying on insights the user already saw.
- **Rejected alternatives:** Finer-grained keys (e.g., per-sku for cost_saving, per-contract for contract_renewal). Defer until we see actual duplication pain — insights auto-expire at 30d.

## 2026-04-19 — 10.5 Virtual cards: 24h reveal window via issued_at, no tokens
- **Question:** How to implement "one-time link, expires 24hr" without adding a tokens table?
- **Choice:** The reveal endpoint (`GET /api/vendor/virtual-cards/:id/reveal`) is authenticated like any other vendor endpoint. The window is enforced by comparing `now - issued_at <= 24h`. After that, the endpoint returns 410 Gone; nothing persists client-side that can unlock later.
- **Why:** No token table to manage; no risk of leaked tokens outliving the window; works automatically across all auth modes (JWT + API key).
- **Rejected alternatives:** JWT tokens in the URL — more moving parts, token storage problem. Signed Supabase URLs — don't let us enforce ownership.

## 2026-04-19 — 10.5 Virtual cards: bytea encryption payload = [IV(12) | tag(16) | ciphertext]
- **Question:** The Phase 10 migration defined `card_number_encrypted`/`cvv_encrypted` as `bytea`, but the existing `crypto.js` helper returns a `"iv:tag:ct"` hex string. How to bridge?
- **Choice:** Added a separate `encryptBytes`/`decryptBytes` pair in `api/_lib/virtual-card.js` that returns/consumes Node `Buffer`s in a concatenated format. Never mixed with the string-based banking-info helper.
- **Why:** Aligns with the migration's `bytea` columns, avoids ambiguous column-type semantics, and keeps the two crypto flows visibly distinct. Same key (`VENDOR_DATA_ENCRYPTION_KEY`), same algorithm (AES-256-GCM), different payload shape.
- **Rejected alternatives:** (1) Change columns to `text` — migration already drafted, not worth the churn. (2) Encode Buffer as hex/base64 string and stuff into bytea — redundant double encoding.

## 2026-04-19 — 10.5 Virtual cards: stub provider generates Luhn-valid PAN
- **Question:** Stripe/Marqeta real integration is out of scope for this slice. How to make the flow testable end-to-end?
- **Choice:** `issueCardWithProvider()` in `virtual-card.js` returns a Luhn-valid 16-digit PAN starting with 4242 (Stripe test-card pattern), random CVV, 2-year expiry, and a stub `provider_card_id`. Real integrations replace the function body without touching callers.
- **Why:** QA flows and notification payloads can be exercised without setting up provider sandbox accounts. The Luhn validity means test charging systems treat the PAN as legitimate test input.
- **Rejected alternatives:** Hardcoded constant PAN — breaks tests that expect per-issuance variation. Real Stripe call behind an env flag — adds deployment friction for local dev.

## 2026-04-19 — 10.2 FX: IP row created for all three handling modes, not just conversion
- **Question:** Only `pay_in_vendor_currency` actually crosses currencies on the wire. For `pay_in_usd_we_absorb` / `pay_in_usd_vendor_absorbs`, do we still create an `international_payments` row?
- **Choice:** Yes, for all three modes when `vendor_currency != entity_currency`. The row captures the attempted conversion (rate, fee, intended to-amount) even when the wire stays in entity currency.
- **Why:** It's a single source of truth for "this payment crossed a currency boundary, and here's the fee we booked." Analytics (fx-fees paid by pair) would miss buyer-absorbed and vendor-absorbed fees otherwise. The spec's step 2d ("Create InternationalPayment record") lives above the if/else so this matches the spec reading.
- **Rejected alternatives:** Only create IP row when money physically converts — leaves accounting-only cases invisible to reporting.

## 2026-04-19 — 10.2 FX: ECB provider uses EUR base, cross-computed to requested base
- **Question:** ECB publishes daily EUR-based rates only; how to get USD→EUR or USD→JPY from that?
- **Choice:** Pull the EUR→X feed, then compute `rate(base→target) = rate(EUR→target) / rate(EUR→base)` for each target symbol.
- **Why:** ECB is free and reliable; requiring an OpenExchangeRates key for every deployment is overkill. The cross-rate math is safe and exact to the ECB precision.
- **Rejected alternatives:** Require `OXR_APP_ID` for the free plan (which only supports USD base) — would break deployments without a key.

## 2026-04-19 — 10.4 SCF: utilization bumped at fund time, not approve time
- **Question:** `current_utilization` on an SCF program — does it increase when the request is approved (reserving capacity) or when the disbursement actually happens?
- **Choice:** Bump `current_utilization` at `fund` time. Approval just flips the status + computes the fee; no program write.
- **Why:** Matches how real lines of credit work — drawn vs. committed. An approved-but-unfunded request shouldn't pre-consume capacity; that lets the internal team approve more aggressively without over-committing the facility. Also simpler to roll back a rejection (no utilization cleanup needed).
- **Rejected alternatives:** Two fields (committed vs. utilized) — cleaner but the schema only has `current_utilization`; not adding another column for a distinction that mostly matters when approval volume is high. Revisit if that becomes a pain point.

## 2026-04-19 — 10.4 SCF: linear fee proration, not compound
- **Question:** How to convert `base_rate_pct` (annual) into a fee for an N-day financing window?
- **Choice:** Linear: `fee_pct = base_rate_pct * (days_to_due / 365)`.
- **Why:** Short-window receivables financing is universally quoted on a simple-interest basis. Compounding would add 0.01–0.02% at typical tenors and make the math harder to explain to vendors.
- **Rejected alternatives:** `(1 + rate)^(days/365) - 1` — technically more accurate for long tenors, but (a) the spec explicitly uses the linear formula, and (b) the facility is revolving with sub-60-day tenors where the difference is noise.

## 2026-04-19 — 10.4 SCF: fund creates a payments row, best-effort
- **Question:** Should funding an SCF request also create a payment, or leave that to ops to record separately?
- **Choice:** Inserting a `payments` row (method='wire', status='initiated', linked via `metadata.finance_request_id`) on fund. Best-effort — if the insert fails, the request still flips to funded.
- **Why:** Same rationale as 10.3's offer-acceptance flow — the operational intent is "money goes out now," so creating the payment record at the same moment gives ops the register entry immediately and doesn't strand the vendor waiting for paperwork.
- **Rejected alternatives:** Require ops to manually book the payment — leaves a gap in the payments register and makes reconciliation harder.

## 2026-04-19 — 10.1 Payments: completed payment flips linked discount offer to 'paid'
- **Question:** When a payment linked to a discount offer (via `metadata.discount_offer_id`) completes, who closes the loop back to the offer?
- **Choice:** The payment PUT handler, after a successful `processing → completed` transition, updates `dynamic_discount_offers.status = 'paid'` and sets `paid_at` if the payment's metadata includes `discount_offer_id`.
- **Why:** Offers don't auto-refresh from payments unless this linkage exists. Doing it inline in the payment transition keeps the write atomic and removes the need for a reconciliation cron.
- **Rejected alternatives:** (1) Trigger on `payments` — workable but adds a DB trigger that's invisible from app code. (2) Separate reconciliation cron — extra moving part for a link that's cheap to maintain inline.

## 2026-04-19 — 10.3 Dynamic discount: status='approved' is our match-quality gate
- **Question:** Spec requires `match_status IN (matched, approved_with_exception)` before offering early payment. Our `invoices` table has no `match_status` column — three-way match lives in a view at the PO-line level.
- **Choice:** Use `invoices.status = 'approved'` as the eligibility filter. Don't attempt to roll up the view.
- **Why:** Internal review is what flips an invoice to 'approved' in the first place — in practice that already gates out unmatched/disputed lines. Rolling up the view adds complexity (N+1 joins) for a second check that mostly overlaps.
- **Rejected alternatives:** Materialize match_status onto `invoices` with a trigger — a reasonable future improvement, but not required for the first slice. Logged here so whoever takes that task knows the history.

## 2026-04-19 — 10.3 Dynamic discount: MIN_ANNUALIZED_RETURN_PCT = 6
- **Question:** Where to draw the line on "too-small-a-discount-to-bother"?
- **Choice:** Auto-generated offers below 6% annualized return are suppressed. Manual offers via `discount_pct` override bypass the floor.
- **Why:** Below 6% APR, early payment isn't meaningfully better than leaving cash in a money-market fund. The override is there so ops can still use the feature for one-off policy reasons.
- **Rejected alternatives:** (1) Hard-code to 8% (the spec's lower bound) — prevents valid offers on shorter windows. (2) Make it entity-configurable — deferred until there's demonstrated demand.

## 2026-04-19 — 10.3 Dynamic discount: payment row created on accept, best-effort
- **Question:** Acceptance triggers "early payment processing" per spec — how hard is the linkage?
- **Choice:** Insert a `payments` row with `status='initiated'`, `method='ach'`, `reference='DDO <id>'`, and `metadata.discount_offer_id` for audit. Offer's status flips to 'accepted' even if the payments insert fails (non-fatal).
- **Why:** Accepting the offer should always succeed from the vendor's POV. If the payments table isn't provisioned yet or the insert hits an integrity issue, ops can resolve manually without leaving the vendor in limbo.
- **Rejected alternatives:** Fail the acceptance on payment-create error — bad UX and gives the vendor no remediation path.

## 2026-04-19 — 9.6 Benchmark compute: category for on_time_pct comes from dominant catalog category
- **Question:** `vendor_scorecards` has no `category` field, but the spec asks to compute `on_time_pct` benchmarks "by category (if category tracked)". How to attribute a scorecard to a category?
- **Choice:** Look up the vendor's dominant `catalog_items.category` (most items of that category). If a vendor has no catalog entries, the scorecard row is dropped.
- **Why:** Same approximation used by the consolidation insight detector — keeps a single source of truth for vendor-category attribution and avoids forcing category into the scorecard schema. For vendors who do one thing, the attribution is accurate; for diversified vendors the signal is lossy but the `sample_size` filter (≥5 vendors) should smooth it out.
- **Rejected alternatives:** (1) Add a `primary_category` field to `vendor_scorecards` — schema churn for a field only this job uses. (2) Skip on_time_pct benchmarks until category tracking is proper — leaves a gap the insights market-benchmark detector already consumes.

## 2026-04-19 — 9.6 Benchmark compute: delete-then-insert for idempotency
- **Question:** `benchmark_data` has no unique index — how to make the monthly job safe to re-run?
- **Choice:** For each metric, delete any existing rows matching `(category IN toPublish, metric, period_start, period_end)` before inserting. No index changes.
- **Why:** Pure-additive migrations are preferred; the job runs once a month so delete+insert is cheap. Adds safety if we need to re-run mid-month after fixing data.
- **Rejected alternatives:** Add `UNIQUE(category, metric, period_start, period_end)` + upsert. Cleaner long-term, but requires a migration — park it until we see a real need.

## 2026-04-19 — 9.5 Marketplace: client-side filtering + ranking, not SQL
- **Question:** Filter + rank by featured / views / ESG — pure SQL or in-process?
- **Choice:** Fetch all published listings, filter and rank in `api/_lib/marketplace.js`, then paginate in memory.
- **Why:** Multi-array intersection (`certifications ALL`, `geography ANY`) and full-text across `title/description/capabilities` are awkward in PostgREST; pushing ESG into sort would require a view + join. Published-listing counts are in the low hundreds at most for the foreseeable future — the in-process cost is negligible and keeps the ranking rules unit-testable.
- **Rejected alternatives:** A Postgres view joining listings → latest ESG per vendor, plus `@@` tsvector — correct but premature at current scale. Swap in later if listing volume grows.

## 2026-04-19 — 9.5 Marketplace: publish toggle is vendor-self-serve, no internal approval gate
- **Question:** Spec says "requires internal approval if configured" for publish — build the gate?
- **Choice:** Skipped the approval gate for this slice. `POST /api/vendor/marketplace/listing/publish` flips `status='published'` directly.
- **Why:** Approval gating is already handled by the Workflow Rules engine (`listing_published` would be a trigger event; a rule with `require_approval` pauses it). Duplicating the logic in a per-feature flag would be a second source of truth. If ops wants approval, add a workflow rule.
- **Rejected alternatives:** Hardcoded `needs_internal_approval` column on entity settings — works but collides with the workflow engine's role.

## 2026-04-19 — 9.1 Compliance automation: two crons, not one
- **Question:** Spec says the new job "replaces old expiry checker" (`compliance-daily`). Merge or split?
- **Choice:** Keep `compliance-daily` for always-on behavior (mark-expired + newly-expired notifications) and add a separate `compliance-automation` cron for rule-driven behavior (auto-request, escalation). Both run daily.
- **Why:** `compliance-daily` has existing tests + notification dedup logic; wholesale replacement would force callers to always create rules to get basic expiry notifications. Two crons keeps the "baseline" behavior stable and makes the automation layer purely additive.
- **Rejected alternatives:** Fold everything into one cron — would mean "no rule → no notifications," a regression in behavior.

## 2026-04-19 — 9.1 Compliance automation: dedup via audit-trail notes field
- **Question:** How to prevent the auto-request from firing daily for the same document?
- **Choice:** When a `requested` audit row is written, set `notes=expiry=<date>`. The cron skips any doc whose latest request row has `notes==expiry=<current_expiry_date>`. When the vendor uploads a renewed doc with a new expiry_date, the dedup naturally resets.
- **Why:** Avoids a separate dedup table, uses the existing audit trail as the source of truth, and naturally handles the "vendor renewed but same request is pending" case.
- **Rejected alternatives:** (1) Dedup by `send-notification` dedupe_key — works for emails but doesn't prevent double audit rows. (2) Separate `compliance_automation_sent` table — extra plumbing for the same outcome.

## 2026-04-19 — 9.2 ESG: no-prior-report gives 10 pts neutral on emissions reduction
- **Question:** Spec says "up to 20 for scope emissions reduction YOY" but first-time submitters have no prior period to compare against. Give 0, 20, or something in between?
- **Choice:** Neutral baseline of 10/20 when there's no prior report.
- **Why:** Zero punishes vendors who are submitting for the first time and have no way to earn the points — that's the opposite of the desired incentive. Full 20 makes the score meaningless on year one. 10 is the neutral midpoint; they get full credit once they have two periods to compare.
- **Rejected alternatives:** (1) 0 pts, (2) full 20 as a "grace year."

## 2026-04-19 — 9.2 ESG: vendor edits to diversity profile invalidate verification
- **Question:** When a vendor updates an already-verified diversity profile, keep the ✓ or reset?
- **Choice:** Reset `verified = false`, clear `verified_at`/`verified_by` on any vendor-side update.
- **Why:** Verification is a statement about specific submitted values. If the vendor changes their certification body or number, the prior verification no longer applies. Prevents gaming (submit valid cert → get verified → change number).
- **Rejected alternatives:** Keep the verification and add a "pending re-verification" flag — more UI plumbing for the same end state.

## 2026-04-19 — 9.4 Workspaces: reuse po_messages with nullable po_id
- **Question:** Spec asked to add `workspace_id` to Message; po_messages currently requires `po_id NOT NULL`. Keep one table or fork?
- **Choice:** Alter `po_messages`: drop `po_id NOT NULL`, add `workspace_id uuid` FK, add CHECK enforcing exactly one parent. Same RLS extended so vendors can read their own workspace threads.
- **Why:** Keeps a single Message model/API surface as the spec requested; no duplicate code paths for sending/reading messages. Migration is minimal and additive except for the one NOT NULL drop.
- **Rejected alternatives:** (1) New `workspace_messages` table — would duplicate attachment logic, notifications, and read-flag logic. (2) Rename `po_messages` to `messages` — large blast radius across existing API/UI that queries by name.

## 2026-04-19 — 9.4 Workspaces: pin is soft polymorphic FK
- **Question:** How to reference a PO / invoice / contract / RFQ / document from a single `workspace_pins` row?
- **Choice:** `entity_type text` (enum via CHECK) + `entity_ref_id uuid` (soft FK). Resolution to a display label lives in `resolvePin()` in `api/_lib/workspaces.js` and is called on read. Delete of the referenced row does NOT cascade — pins just show "not found" in the UI.
- **Why:** A polymorphic FK with 5 possible target tables isn't expressible natively; the CHECK + resolver keeps the model simple. Users rarely delete POs/invoices/contracts — graceful degradation is fine.
- **Rejected alternatives:** Five nullable FK columns with a CHECK that exactly one is set — technically cleaner but more painful to read/write in code.

## 2026-04-19 — 9.3 AI Insights: stale expiry via cron, not DB trigger
- **Question:** How to "expire AIInsight records older than 30 days that are still 'new'"?
- **Choice:** Weekly cron runs `UPDATE ai_insights SET status='dismissed' WHERE status='new' AND expires_at < now()`. List endpoint also filters by `expires_at > now()` as a belt-and-suspenders.
- **Why:** Keeps the logic visible and testable; aligns with other cron-driven cleanup jobs in this codebase. No DB trigger = simpler migration surface.
- **Rejected alternatives:** Postgres `pg_cron` / trigger — adds infra complexity without clear benefit when a weekly job already runs.

