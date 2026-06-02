# Tangerine P7 — Revenue Operations Architecture Pass

Status: **DRAFT** (2026-05-28 morning). Operator review gate before implementation chunks kick off. Auto-merges on CI green per the revised plan-approval-not-implementation rule.

Implements **M16 (Credit Card Capture)** + **M17 (Sales Reps & Commissions)** + **M9-subset (Operational Reporting)** + **M47 (Customer Service / Cases)** from the roadmap.

P6 just shipped bank-side reconciliation (M7+M8). P7 turns the GL into a revenue operations system: accepting cards as an AR payment method, paying commissions to sales reps, surfacing the operational reports the CEO + accountant ask for daily, and giving the ops team a place to track customer issues that often turn into RMAs / credits / refund JEs.

Together these four modules close the gap between "the books balance" (P3–P6) and "the business runs day-to-day" (P11+ ecom, P16+ SO, P19 RMA). They are deliberately bundled because they share the same surface: every one of them adds rows to the AR sub-ledger or to a new sub-ledger that posts to AR.

---

## 0. Scope guardrails

**In scope (this phase):**
- **M16 — Credit Card Capture for AR Receipts.** Stripe integration. Operator clicks "Charge card" on an AR invoice → captures + posts an `ar_receipts` row (P4) + the matching cash JE through the existing receipt-post path. Tokenized card storage per customer. Webhook handling for async outcomes (charge.succeeded / charge.failed / chargeback). Refund path (full + partial).
- **M17 — Sales Reps & Commissions.** `sales_reps` master + `customer_sales_rep_assignments` (which rep covers which customer). Commission rules engine (per-rep tier table). Commission accrual JE on invoice-post (DR Commission Expense, CR Commissions Payable). Commission settlement JE on rep payout (CR Commissions Payable, DR Cash). Commission report per rep per period.
- **M9-subset — Operational Reporting.** Five operational reports that the CEO + accountant currently rebuild ad-hoc:
  1. AR Aging *(already shipped P4-6 — relisted under M9 menu group)*
  2. AP Aging *(already shipped P3 — relisted under M9 menu group)*
  3. Sales by Rep × Period
  4. Sales by Customer × Period
  5. GL Detail by Account × Period (drill from any TB row)
- **M47 — Customer Service / Cases.** Lightweight ticketing: `cases` table linked to a customer (+ optional invoice / RMA / sales_order). Status state machine: `open` → `in_progress` → `resolved` / `closed`. Comment thread. Assignee. Severity. Email-in (Resend inbound webhook → case-create). No full helpdesk UI — operator's panel only, ~50 cases/year volume.
- **Cross-cutter hooks** — M27 approvals on commission rule changes; M28 notifications when a CC charge fails / chargeback raised / case assigned; M29 documents (attach chargeback evidence PDFs); M30 employees (sales_reps extends employees).

**Explicitly OUT of scope (deferred):**
- **Outbound card payments / virtual card vendor pay** — operator pays vendors via ACH; CC is inbound-only.
- **Sales tax compute** — M19 in P25. P7 commission math is on pre-tax revenue.
- **Multi-currency cards** — Stripe charges in USD only. International customers pay USD via wire (existing AR cash flow).
- **Full BI / dashboard** — M46 is deferred to P24. P7 reports are tables-with-totals, not dashboards.
- **Drop-ship commission split** — P20 (M49). For now, drop-ship orders run the same commission rules as direct-ship.
- **1099 generation for independent reps** — M20 in P25.
- **Public case-portal for customers** — internal-only in this phase; customers reach out via email and the operator types the case.
- **Workflow automations for cases** — basic state machine only; no SLA timers / auto-escalation.

---

## 1. Existing state (one-paragraph map)

After P6: dual-basis GL with full close mechanics + four financial statements + year-end close + bank/CC feed reconciliation. `ar_invoices` + `ar_receipts` + `ar_receipt_applications` ship the AR sub-ledger; receipts only support `payment_method ∈ {check, wire, ach, cash, other}` — **no card flow**. `customers` + `customer_users` exist (P1 + P2-6). `entity_users` covers internal staff identity. **There are no `sales_reps`, no commissions, no cases.** Operational reports exist only as the four primary financial statements + AR Aging (no AP Aging UI yet under Reports menu; the AP module shows aging inline). No Stripe (or any card processor) integration anywhere in the codebase.

---

## 2. Decisions feeding this pass (DRAFT — operator to confirm)

| # | Decision | Recommendation | Why | Operator confirm? |
|---|---|---|---|---|
| D1 | Card processor | **Stripe** | Industry standard, $0 monthly fee, 2.9% + 30¢ per transaction; SDK is best-in-class; Stripe Connect available if we later run a marketplace. Alternatives (Square 2.6%, Authorize.net $25/mo + 2.9%) priced worse for operator's volume. | ☐ |
| D2 | Commission base | **Net revenue (invoice total − discounts − returns)** at invoice-post time, accrued, settled on rep payout date | Accrual matches what most apparel reps expect; cash-basis settlement keeps the GL clean | ☐ |
| D3 | Commission timing | **Accrue at invoice-post, settle at payout** (not at customer-payment-received) | Simpler audit trail; reps don't carry receivable risk; matches how the operator runs it today on a spreadsheet | ☐ |
| D4 | Commission tiers | **Per-rep simple % default + optional tier table** (per-rep override) | Most reps will have a flat % (8–12%); the table supports the 1–2 reps who get bracket bonuses | ☐ |
| D5 | Clawback policy | **On AR void / write-off**, auto-reverse the original accrual (mirror-JE). On RMA, partial reverse proportional to credit-memo amount. | Keeps Commissions Payable honest; matches commercial norms | ☐ |
| D6 | Case email-in | **Resend inbound webhook** to a dedicated address (e.g. `cases@<operator-domain>`) | Already using Resend for outbound; inbound is a flip-the-switch feature; saves building a separate IMAP poller | ☐ |
| D7 | Case-on-RMA link | **Optional FK on `rmas.case_id`** so an RMA can be opened *from* a case, or a case opened *for* an existing RMA | Both flows happen in practice | ☐ |
| D8 | Reports surface | **New Tangerine top-nav group `📊 Reports`** holding AR Aging, AP Aging, Sales by Rep, Sales by Customer, GL Detail | Operator already asked for nav-clean-up once (P5 group dropdowns); 5+ reports deserves its own menu | ☐ |
| D9 | Card-on-file storage | **Stripe Customer + Payment Method ids on `customers`** (no raw PANs) | PCI scope = SAQ A only; operator never touches PAN | ☐ |
| D10 | Stripe webhook auth | **Stripe-Signature header verification with `STRIPE_WEBHOOK_SECRET`** (re-uses the dispatcher pattern we hardened for Plaid) | Same security model as Plaid; one wrinkle — Stripe verification needs raw body, which dispatcher pre-parses. Lift the raw-body fix planned for Plaid first then reuse here. | ☐ |

---

## 3. M16 — Credit Card Capture (Stripe)

### 3.1 Customer-side schema extensions

```sql
ALTER TABLE customers
  ADD COLUMN stripe_customer_id text,                        -- cus_xxx
  ADD COLUMN default_stripe_payment_method_id text;          -- pm_xxx (default card on file)
CREATE UNIQUE INDEX uq_customers_stripe_customer ON customers(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE ar_receipts
  ADD COLUMN stripe_payment_intent_id text,                  -- pi_xxx
  ADD COLUMN stripe_charge_id text,                          -- ch_xxx
  ADD COLUMN stripe_fee_cents bigint,                        -- 290 + 30 type fee captured per-charge for reporting
  ADD COLUMN stripe_status text                              -- requires_action | succeeded | failed | refunded | partial_refunded | chargeback
    CHECK (stripe_status IN ('requires_action','succeeded','failed','refunded','partial_refunded','chargeback'));

-- Extend the AR receipts payment_method enum:
ALTER TABLE ar_receipts
  DROP CONSTRAINT IF EXISTS ar_receipts_payment_method_check,
  ADD CONSTRAINT ar_receipts_payment_method_check
    CHECK (payment_method IN ('check','wire','ach','cash','credit_card','other'));
```

### 3.2 Stripe handlers

| Endpoint | Purpose |
|---|---|
| `POST /api/internal/stripe/setup-intent` | Create a SetupIntent for the customer; frontend uses it to attach a payment method via Stripe Elements. |
| `POST /api/internal/ar-invoices/:id/charge-card` | Create + confirm a PaymentIntent for an AR invoice; on `succeeded` synchronously, POST `ar_receipts` + sibling cash JE. On `requires_action`, return the client_secret for 3DS confirmation; webhook completes the receipt-post on async success. |
| `POST /api/internal/ar-receipts/:id/refund` | Issue a Stripe refund (full or partial); post a reverse AR receipt + reverse cash JE. |
| `POST /api/webhooks/stripe` | Verify Stripe-Signature; handle `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`. |

### 3.3 GL impact

- **Successful charge:** existing P4-2 receipt-post path. `ar_receipts.payment_method='credit_card'`. Cash JE = `DR Stripe Clearing` / `CR AR Control` (clearing account: code `1110` Stripe Clearing). Stripe payout (settled 2-day) hits the bank feed (P6); operator reconciles `Stripe Clearing → Bank` via P6 match engine.
- **Refund:** sibling receipt with `amount_cents` negative + `stripe_refund_id`. Cash JE = `DR AR Control` / `CR Stripe Clearing`.
- **Chargeback:** `DR Chargeback Expense` (new GL account, code `6610`) / `CR Stripe Clearing`. Triggers an M47 case automatically (assignee = operator).
- **Stripe fee:** posted as a separate cash JE on the payout date by the existing P6 auto-post fee rules engine — operator configures one rule per Stripe payout pattern (e.g. `match: '^STRIPE.*PAYOUT'`, `target_account_id: <6510 Merchant Fees>`).

### 3.4 PCI scope

SAQ A — operator never sees PANs. Stripe Elements iframes the card input. Tokenized payment_method ids are the only card-related data Tangerine stores.

---

## 4. M17 — Sales Reps & Commissions

### 4.1 Schema

```sql
CREATE TABLE sales_reps (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  employee_id              uuid REFERENCES employees(id) ON DELETE SET NULL,   -- M30 link (optional for 1099 reps)
  display_name             text NOT NULL,
  email                    text,
  default_commission_pct   numeric(5,2) NOT NULL DEFAULT 0   CHECK (default_commission_pct >= 0 AND default_commission_pct <= 100),
  payout_terms_days        int  NOT NULL DEFAULT 30,                            -- days from accrual to payout
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_reps_name_per_entity_unique UNIQUE (entity_id, display_name)
);

-- Optional bracket overrides. If empty, default_commission_pct applies to all sales.
CREATE TABLE sales_rep_commission_tiers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_rep_id       uuid NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  threshold_cents    bigint NOT NULL CHECK (threshold_cents >= 0),
  rate_pct           numeric(5,2) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  effective_from     date NOT NULL DEFAULT current_date,
  effective_to       date,
  UNIQUE (sales_rep_id, threshold_cents, effective_from)
);

-- Many-to-many: a customer can be co-covered (split commissions) but rare.
CREATE TABLE customer_sales_rep_assignments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sales_rep_id       uuid NOT NULL REFERENCES sales_reps(id) ON DELETE RESTRICT,
  share_pct          numeric(5,2) NOT NULL DEFAULT 100 CHECK (share_pct > 0 AND share_pct <= 100),
  effective_from     date NOT NULL DEFAULT current_date,
  effective_to       date,
  UNIQUE (customer_id, sales_rep_id, effective_from)
);

-- Per-invoice commission accrual snapshot (one row per (invoice, rep)).
CREATE TABLE commission_accruals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  ar_invoice_id            uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE RESTRICT,
  sales_rep_id             uuid NOT NULL REFERENCES sales_reps(id) ON DELETE RESTRICT,
  commissionable_cents     bigint NOT NULL CHECK (commissionable_cents >= 0),  -- post-discount, pre-tax
  rate_pct                 numeric(5,2) NOT NULL,
  commission_cents         bigint NOT NULL CHECK (commission_cents >= 0),
  status                   text NOT NULL DEFAULT 'accrued'
                           CHECK (status IN ('accrued','reversed','paid')),
  accrual_je_id            uuid REFERENCES journal_entries(id),
  payout_je_id             uuid REFERENCES journal_entries(id),
  reversal_je_id           uuid REFERENCES journal_entries(id),
  paid_at                  timestamptz,
  reversed_at              timestamptz,
  reversal_reason          text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ar_invoice_id, sales_rep_id)
);

-- Payout batch (operator runs commissions month-end; one batch per (rep, period)).
CREATE TABLE commission_payouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  sales_rep_id        uuid NOT NULL REFERENCES sales_reps(id) ON DELETE RESTRICT,
  period_id           uuid NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
  total_cents         bigint NOT NULL,
  payment_method      text NOT NULL CHECK (payment_method IN ('check','wire','ach','cash','other')),
  paid_at             date NOT NULL,
  payout_je_id        uuid REFERENCES journal_entries(id),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sales_rep_id, period_id)
);
```

### 4.2 New GL accounts

| Code | Name | Type | Normal |
|---|---|---|---|
| 2300 | Commissions Payable | liability | CREDIT |
| 6210 | Sales Commissions Expense | expense | DEBIT |

Seeded by the migration; safe to ADD because the COA RPC `gl_create_account` is idempotent.

### 4.3 RPCs

| RPC | When | Net effect |
|---|---|---|
| `commissions_accrue_for_invoice(ar_invoice_id)` | Called from `ar_invoices_post` RPC (existing P4) after the AR JE posts | Looks up customer's rep assignments + their tier table; computes commission per rep; inserts `commission_accruals` rows; posts a single batched JE per rep (`DR 6210` / `CR 2300`). |
| `commissions_reverse_for_invoice(ar_invoice_id, reason)` | Called from `ar_invoices_void` and on credit-memo apply | Marks `commission_accruals.status='reversed'` + posts reversal JE. |
| `commissions_settle_payout(sales_rep_id, period_id, payment_method, paid_at)` | Operator clicks "Pay" in the Commissions panel | Sums `accrued` rows for that rep through `period_id.ends_on`; inserts `commission_payouts`; posts JE (`DR 2300` / `CR Cash`); flips matching accrual rows to `status='paid'` and sets `payout_je_id`. |

### 4.4 UI panels (under 💼 Accounting top-nav group)

- **Sales Reps** — master CRUD (display_name / email / default %, tier table inline).
- **Commission Accruals** — list view filtered by rep × period; shows the per-invoice rows + Pay button.
- **Commission Payouts** — historical payouts grid with drill to the JE.

### 4.5 Edge cases handled

- **No rep assigned** to a customer → zero rows in `customer_sales_rep_assignments` → no commission posted, no error.
- **Split commission** (e.g. 60/40 between two reps) → two `customer_sales_rep_assignments` rows summing to 100 → two `commission_accruals` rows; combined JE batched.
- **Tier bracket crossing mid-period** → tier resolution uses cumulative invoiced total for the period; first invoice of the period that crosses the threshold splits across rates.
- **AR void after commission paid** → reversal JE posts to `DR 2300` / `CR 6210` flagged as "clawback owed by rep" in notes. Operator settles outside the system if needed.

---

## 5. M9-subset — Operational Reporting

### 5.1 Scope

5 reports total. All read-only. All use SQL views + STABLE RPCs, never persistent tables.

| Report | View | RPC | Already shipped? |
|---|---|---|---|
| AR Aging | `v_ar_aging_buckets` | `ar_aging_as_of(period_end)` | ✅ P4-6 — relisted under Reports menu |
| AP Aging | NEW `v_ap_aging_buckets` | NEW `ap_aging_as_of(period_end)` | Partial — exists inline in AP module, needs report view |
| Sales by Rep | NEW `v_sales_by_rep` | NEW `sales_by_rep(from, to)` | ❌ |
| Sales by Customer | NEW `v_sales_by_customer` | NEW `sales_by_customer(from, to)` | ❌ |
| GL Detail by Account | NEW `v_gl_detail` | NEW `gl_detail(account_id, from, to)` | ❌ |

### 5.2 GL Detail design

The CEO + accountant currently click into the Trial Balance and want to see "what made up this number?" — that's GL Detail. RPC returns ordered `journal_entry_lines` for the account, with running balance, period totals, and a link to each JE for drill.

```sql
CREATE OR REPLACE FUNCTION gl_detail(
  p_account_id uuid,
  p_from       date,
  p_to         date
) RETURNS TABLE (
  posting_date  date,
  je_id         uuid,
  je_number     text,
  description   text,
  debit_cents   bigint,
  credit_cents  bigint,
  running_balance_cents bigint,
  source_module text,
  source_id     text
)
LANGUAGE sql STABLE
AS $$
  WITH lines AS (
    SELECT je.id AS je_id, je.je_number, je.posting_date, je.description, je.source_module, je.source_id,
           (jel.debit  * 100)::bigint AS debit_cents,
           (jel.credit * 100)::bigint AS credit_cents
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id = p_account_id
      AND je.status = 'posted'
      AND je.basis = 'ACCRUAL'  -- reports default to accrual; CASH detail is via P5 Cash Flow
      AND je.posting_date BETWEEN p_from AND p_to
    ORDER BY je.posting_date, je.je_number
  )
  SELECT
    posting_date, je_id, je_number, description,
    debit_cents, credit_cents,
    SUM(debit_cents - credit_cents) OVER (ORDER BY posting_date, je_number)::bigint AS running_balance_cents,
    source_module, source_id
  FROM lines;
$$;
```

(Normal-balance flip for CREDIT-normal accounts handled in the UI presentation layer, same as existing P5 Trial Balance.)

### 5.3 Sales by Rep / Customer

Both walk `ar_invoices` (basis='ACCRUAL', status IN ('sent','partial_paid','paid'), inside date range) plus `commission_accruals` (for the Rep view). Aggregates: `invoice_count`, `gross_cents`, `net_cents` (after credit memos), and (Rep view only) `commission_cents`.

---

## 6. M47 — Customer Service / Cases

### 6.1 Schema

```sql
CREATE TABLE cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  case_number        text NOT NULL,                                        -- 'CASE-YYYY-NNNNN'
  customer_id        uuid REFERENCES customers(id) ON DELETE SET NULL,
  ar_invoice_id      uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  rma_id             uuid,                                                 -- forward FK to M23 (P19)
  sales_order_id     uuid,                                                 -- forward FK to M10 (P16)
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_progress','resolved','closed')),
  severity           text NOT NULL DEFAULT 'normal'
                     CHECK (severity IN ('low','normal','high','urgent')),
  subject            text NOT NULL,
  body               text,
  assignee_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  external_email     text,                                                 -- if case came in via Resend inbound
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT cases_number_per_entity_unique UNIQUE (entity_id, case_number)
);

CREATE TABLE case_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  is_internal     boolean NOT NULL DEFAULT true,   -- false = visible to customer (future portal)
  external_email  text,                            -- if inbound reply via Resend
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cases_status_severity ON cases(status, severity);
CREATE INDEX idx_cases_customer        ON cases(customer_id) WHERE customer_id IS NOT NULL;
```

### 6.2 Inbound email path

`/api/webhooks/resend-inbound` accepts a Resend inbound payload (HMAC verified). If `to` matches `cases@<domain>`:
- Look up customer by `from` email (`customer_users.email`).
- If existing open case in subject (e.g. `Re: [CASE-2026-00042]`), append a `case_comments` row.
- Else create a new `cases` row with `status='open'`, `external_email=<from>`.
- Notify assignee (M28) — defaults to operator on a new case.

Outbound: when an internal user replies to a case, send via Resend with `Reply-To: cases+<case_number>@<domain>`. Thread continuation works via subject parse.

### 6.3 UI

Single panel under top-nav **🤝 Customers** group (or its own **🎫 Cases** dropdown — TBD §0 D8). List view + detail with comment thread + assignee + status dropdown. No SLA timers / no auto-escalation.

---

## 7. Cross-cutter hooks (M27/M28/M29 recap)

- **M27 Approvals:** commission rule changes (`sales_reps` row update with rate change > 2pp) emit an approval request; default approver = CEO. Approval template seeded by migration. Pattern reused from P3 / P4 approval gates.
- **M28 Notifications:** Stripe `charge.failed` → operator email; `charge.dispute.created` → operator email + auto-open M47 case; commission accrual posted → rep email (when `sales_reps.email` set); case `assignee_user_id` changed → notify new assignee.
- **M29 Documents:** chargeback evidence packets attached to the case; W-9s attached to sales_reps for 1099 prep (M20 future).
- **M30 Employees:** `sales_reps.employee_id` is a nullable FK to the employees master. Internal W-2 reps get a row both places; external 1099 reps get sales_reps-only.

---

## 8. RLS

Standard P1 template applied:
- `anon_all` SELECT-only (filtered through service-role API for sensitive cols).
- `auth_internal_*` SELECT+INSERT+UPDATE for `entity_users` whose `auth_id = auth.uid()`.
- `cases` adds an `assignee_user_id IS NULL OR assignee_user_id = auth.uid()` row restriction for the case-list view (so reps see only their assigned cases when we open this to non-admins later).
- `stripe_payment_intent_id` + `stripe_charge_id` are not service-role-only — both are non-sensitive identifiers (Stripe dashboard equivalent), but `stripe_payment_method_id` IS, since it's the token used to charge.

---

## 9. Chunk split (implementation order — DO NOT start until operator confirms §2 decisions)

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **P7-1** | M16 schema + Stripe SDK helpers | DB migration (customers + ar_receipts extensions, new 1110 Stripe Clearing + 6610 Chargeback Expense + 6510 Merchant Fees GL accounts). `api/_lib/stripe/client.js` wrapper. `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` env vars in Vercel. | — |
| **P7-2** | M16 charge / refund / webhook handlers | h+1..h+4: setup-intent, charge-card, refund, webhook (verified). Reuses the P4 receipt-post path. | P7-1 |
| **P7-3** | M16 UI — Charge Card button on AR Invoice detail + Card-on-file modal in Customer detail | Stripe Elements integration in `src/tanda/InternalARInvoices.tsx` + `src/tanda/InternalCustomerMaster.tsx`. | P7-2 |
| **P7-4** | M17 schema | DB migration (sales_reps + tiers + assignments + commission_accruals + commission_payouts + 2300/6210 GL accounts). | — (can run parallel to P7-1) |
| **P7-5** | M17 RPCs + handlers | `commissions_accrue_for_invoice` (called from existing AR post path via trigger), `commissions_reverse_for_invoice`, `commissions_settle_payout`. Handlers for CRUD + settle. | P7-4 |
| **P7-6** | M17 UI — Sales Reps + Accruals + Payouts panels | Three Tanda panels under 💼 Accounting. | P7-5 |
| **P7-7** | M9-subset reports — AP Aging + Sales by Rep + Sales by Customer + GL Detail | 4 new views + 4 STABLE RPCs + 4 list-view panels under new 📊 Reports menu group. | P7-5 (Sales-by-Rep uses commission_accruals) |
| **P7-8** | M47 schema + inbound webhook | DB migration (cases + case_comments) + `/api/webhooks/resend-inbound` + outbound thread-aware sending. | — |
| **P7-9** | M47 UI — Cases panel | List + detail with thread, assignee, status, severity. | P7-8 |
| **P7-10** | User guide chapter 18 (M16+M17+M9subset+M47) + cross-cutter wiring (M28 case-notify, M27 commission-rule approval template) | Doc + auto-merge. | P7-3, P7-6, P7-7, P7-9 |

Parallel-safe groups (after schemas):
- **Wave A (after operator confirms §2):** P7-1, P7-4, P7-8 simultaneously.
- **Wave B:** P7-2, P7-5 simultaneously.
- **Wave C:** P7-3, P7-6, P7-7, P7-9 simultaneously.
- **Wave D:** P7-10 (single doc PR).

---

## 10. Risks

- **Stripe raw-body verification + dispatcher.** Same blocker as Plaid (§5.4 of P6 arch). Resolution: lift the raw-body fix once for both — likely a `RAW_BODY_PATHS` Set in the dispatcher that bypasses `JSON.parse`. Treat this as P7-2 sub-task.
- **Commission accrual on AR-void cascade.** Multi-step reversal must run inside the void RPC's transaction. If `commissions_reverse_for_invoice` errors, the whole void must rollback. Pattern: wrap in `BEGIN/EXCEPTION WHEN OTHERS THEN RAISE`.
- **Resend inbound webhook delivery latency.** Resend documents ~minutes-not-seconds latency on inbound. For ~50 cases/year this is fine; would be a problem for real helpdesk volume.
- **Stripe Clearing reconciliation drift.** Operator will see clearing balance ≠ 0 between charge time and payout (T+2 days standard). Bank Recon panel already handles this — operator reconciles `Stripe Clearing → Bank` via match engine when the payout lands.
- **Tier resolution edge case.** Two `customer_sales_rep_assignments` summing to <100% (e.g. 60+30=90) — RPC must error rather than silently lose commission. Add CHECK + UI validation.

---

## 11. Tests

- Stripe SDK helpers: mocked Stripe API + roundtrip on `selfCheck()` (pattern from `plaid/encryption.js`).
- Commission math: bracket boundary, split assignment, void clawback. Aim ~80 unit tests.
- GL Detail: running-balance order stability across same-day JEs (sort by `je_number`).
- Resend inbound parsing: subject-line case-number extract; falls back to new-case create.
- AR receipt enum migration: confirm existing receipt rows survive the CHECK swap (Postgres validates new constraint against existing data — must be additive only, which it is).

---

## 12. Operator confirm before chunks ship

Please mark §2 D1–D10 with answers (or push back). Once those are confirmed I'll kick off P7-1, P7-4, P7-8 in parallel.

**Stripe env vars needed in Vercel before P7-2 ships:**
- `STRIPE_SECRET_KEY` (sk_test_… for sandbox, sk_live_… for prod)
- `STRIPE_PUBLISHABLE_KEY` (pk_test_… / pk_live_… — exposed to frontend)
- `STRIPE_WEBHOOK_SECRET` (whsec_… — from Stripe dashboard webhook page)

**Resend inbound setup needed before P7-8 ships:**
- Operator configures `cases@<domain>` to forward to the Resend inbound endpoint.
- `RESEND_WEBHOOK_SECRET` already exists from outbound use — same secret signs inbound.
