# Tangerine P5 — Close + Core Financials Architecture Pass

Status: **DRAFT** (2026-05-27 night). Operator review gate before implementation chunks kick off. Auto-merges on CI green per the revised plan-approval-not-implementation rule (doc-only PRs go through; implementation chunks still require explicit operator approval).

Implements **M6 (Close + Core Financials)** from the roadmap. Builds directly on P1 (gl_accounts + gl_periods + journal_entries), P3 (M3 AP — accrual + cash), and P4 (M4 AR — accrual + cash with sibling JEs). With AP + AR + inventory FIFO live and posting daily, the operator's accountant now needs the four primary financial statements + a defensible close workflow to produce them at month-end and year-end.

---

## 0. Scope guardrails

**In scope (this phase):**
- Refining the period-close state machine (existing `open` → `soft_close` → `closed` from P1, plus new mechanics).
- **Trial balance** — per-account net debit/credit for any range, both ACCRUAL and CASH books.
- **Income Statement (P&L)** — revenue + expense aggregated per account, with subtotals (gross margin, operating income, net income).
- **Balance Sheet** — assets / liabilities / equity as-of a date.
- **Cash Flow Statement** — indirect method (operating / investing / financing sections).
- **Closing entries** — at fiscal-year-end, post the JE that zeroes revenue/expense accounts and rolls net income into Retained Earnings.
- Admin UI panels for each report (Tangerine → Reports group).
- Cross-cutter hooks: M27 approval gate on `gl_period_close`, M28 notifications when a period flips status, M29 document attachments to close packages.

**Explicitly OUT of scope (deferred):**
- Cash basis reconciliation against bank statements (P6 = M7+M8 Bank Feeds + Reconciliation).
- Multi-currency consolidation (single-currency USD throughout per locked decision 1 in [[project-erp-build-roadmap]]).
- Drill-down from financial statements into source JEs (P5 surfaces totals only; drill-down ships as a P5 follow-up if operator requests).
- Comparative period reporting (this period vs prior-year) — single-period view in MVP; comparative columns are a follow-up.
- Budget-vs-actual variance reports (M21 Budgets & Forecasting is P25).
- Statutory output formats (XBRL, FINREP, etc) — not on the roadmap.

---

## 1. Existing state (one-paragraph map)

After P4: AR/AP both post dual-basis (accrual + cash) sibling JEs. `gl_accounts` carries `account_type` ∈ {asset, liability, equity, revenue, expense, contra_asset, contra_revenue} and `normal_balance` ∈ {DEBIT, CREDIT}. `gl_periods` has a 3-status state machine (`open`/`soft_close`/`closed`) with a posting-trigger guard that already rejects writes to closed periods (with the P4-1-added historical-bypass exception scoped to `journal_type='*_historical'`). `journal_entries.basis` distinguishes ACCRUAL from CASH books. `posting_locked_through` on `entities` provides a hard floor (pinned to `2024-07-31` for ROF post-P4-8). No financial-statement views exist yet — only ad-hoc SQL against `journal_entry_lines`.

---

## 2. Decisions feeding this pass (recap from locked decisions + arch context)

- **Functional currency:** USD only (locked decision 1). Reports render in USD.
- **Accounting basis:** dual — accrual + cash in parallel. Every report must take a `basis` parameter and read from JEs filtered by that basis.
- **Calendar months:** 12 fiscal periods per FY (locked decision 4). FY boundary = end of period 12. No 4-4-5 or 52/53-week variants.
- **Retained earnings account:** operator must designate a single equity account as the retained-earnings target. New `entities.default_retained_earnings_account_id` FK (see §8).
- **Closing-entry direction:** every revenue + expense closes to ONE retained-earnings account per entity. No per-cost-center splits (the operator runs a single legal entity; multi-entity is post-launch).
- **Soft-close means "draft posting accepted, structured posting rejected":** during `soft_close`, manual JEs are blocked but AP/AR receipts/inventory adjustments still post (they're operationally idempotent). `closed` blocks everything except backfill (`journal_type='*_historical'`).
- **Year-end is the only HARD close** — operator can re-open a `closed` non-year-end month if needed (admin-only, audit-logged). A `closed_with_closing_jes` sub-status marks "year-end closed" as a one-way state that cannot be re-opened.

---

## 3. M6 — Period close mechanics

### 3.1 State machine refinement

P1 introduced 3 statuses. P5 adds one terminal state + clarifies transitions:

```
              ┌──────────────────────────────┐
              │                              │
              ▼                              │
            open ──────────► soft_close ────►│──────► closed
              │                              │         │
              │                              │         │
              │                              │         ▼
              │                              │  closed_with_closing_jes (TERMINAL)
              │                              │
              └──────────────────────────────┘
                       (admin reopen)
```

- `open` → `soft_close`: closes manual JE entry, AP/AR/inventory still post. Operator notifies the accountant: "ready for close review."
- `soft_close` → `closed`: blocks all posting (except historical-backfill bypass). Period now requires admin override to re-open.
- `soft_close` → `open`: anyone can reopen (workflow regression, accountant needs more time).
- `closed` → `soft_close`: **admin only**; logged in new `gl_period_status_log` audit table. Used for late corrections.
- `closed` → `closed_with_closing_jes`: **one-way terminal**. Triggered ONLY by the year-end close RPC (§8). Once set, NOTHING posts to this period — not even the historical-backfill bypass. Prevents accidental rewrite of audited financials.

### 3.2 Period audit log — `gl_period_status_log`

```sql
CREATE TABLE gl_period_status_log (
  id                uuid PK,
  entity_id         uuid → entities ON DELETE CASCADE,
  period_id         uuid → gl_periods ON DELETE CASCADE,
  from_status       text,
  to_status         text NOT NULL,
  reason            text,                          -- operator note, required for closed→soft_close
  actor_user_id     uuid → auth.users ON DELETE SET NULL,
  performed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gl_period_status_log_transition_check
    CHECK (from_status IS DISTINCT FROM to_status)
);

CREATE INDEX idx_gl_period_status_log_period ON gl_period_status_log (period_id, performed_at DESC);
```

Trigger on `gl_periods` UPDATE inserts one row per status change. Reopening a `closed` period requires `reason` to be non-empty (enforced in the API handler, not the trigger — operator UX wants to surface a prompt rather than a 500 error).

### 3.3 Close pre-flight checks (read-only RPC)

`gl_period_close_preflight(p_entity_id uuid, p_period_id uuid) RETURNS TABLE(check_name text, status text, detail text, blocking boolean)`

Returns one row per check:

| Check | Blocking | Detail |
|---|---|---|
| `accrual_trial_balanced` | yes | Trial balance for the period nets to 0 (DR = CR). If not, the period has an out-of-balance JE somewhere — close cannot proceed. |
| `cash_trial_balanced` | yes | Same for the cash book. |
| `no_draft_jes` | yes | Any `journal_entries.status IN ('draft','pending_approval')` for this period blocks close. |
| `no_unposted_ar_invoices` | warning | Any `ar_invoices.gl_status IN ('draft','pending_approval')` with `invoice_date` in this period — operator decides. |
| `no_unposted_ap_invoices` | warning | Same for `invoices` (AP). |
| `no_unposted_inventory_adjustments` | warning | Any draft `inventory_adjustments` in this period. |
| `no_unapplied_receipts` | warning | `v_ar_unapplied_receipts` rows where `receipt_date` is in this period. |
| `inventory_layers_consistent` | warning | `inventory_consumption.qty_consumed` sums match `inventory_layers.original_qty - inventory_layers.remaining_qty` per item. |
| `fifo_negative_layers` | yes | Any `inventory_layers.remaining_qty < 0` is a corruption indicator. |
| `period_was_open` | yes | Can only flip an `open` → `soft_close`; can only flip a `soft_close` → `closed`. State-machine guard. |

UI surfaces this as the "Run close checks" button on the Periods panel — clicking it lists each row green/yellow/red. The Close button is disabled if any blocking row is red.

### 3.4 Close transition handler

`POST /api/internal/gl-periods/:id/close`

1. Resolves the period.
2. Reads target_status from body: must be `soft_close` or `closed`.
3. Runs `gl_period_close_preflight` — rejects with 409 + the failing rows if any blocking check fails (warnings allowed through with a `?ignore_warnings=true` query param, which is logged).
4. Optionally requires M27 approval — for `closed` transitions, calls `approvalsAPI.requestIfRequired({ kind: 'gl_period_close', amount_cents: null, ... })`. Operator opts in via the M27 admin UI.
5. UPDATE gl_periods status, fires the existing touch trigger, fires the new `gl_period_status_log` audit trigger.
6. Enqueues M28 notification `gl_period_closed` (recipient_roles=['admin','accountant']).
7. Returns the updated period row.

`POST /api/internal/gl-periods/:id/reopen`

1. Resolves the period; rejects if status is `closed_with_closing_jes` (one-way terminal).
2. Body must include `reason` (non-empty string).
3. Caller must hold the `admin` role on this entity (returns 403 otherwise — not 401 since the user is auth'd but not authorized).
4. UPDATE → `soft_close`. Audit log captures the reason.
5. Enqueues `gl_period_reopened` notification with the reason in the body.

---

## 4. Trial balance

### 4.1 The view

```sql
CREATE OR REPLACE VIEW v_trial_balance AS
SELECT
  je.entity_id,
  je.basis,
  jel.account_id,
  ga.code,
  ga.name,
  ga.account_type,
  ga.normal_balance,
  SUM(jel.debit) AS debit_cents,
  SUM(jel.credit) AS credit_cents,
  SUM(jel.debit) - SUM(jel.credit) AS net_debit_cents,
  SUM(jel.credit) - SUM(jel.debit) AS net_credit_cents
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga ON ga.id = jel.account_id
WHERE je.status = 'posted'
GROUP BY je.entity_id, je.basis, jel.account_id, ga.code, ga.name, ga.account_type, ga.normal_balance;
```

This is the foundation view — every other report selects from it (or from a parameterized RPC version).

### 4.2 Parameterized RPC for ranged TB

`trial_balance(p_entity_id uuid, p_basis text, p_from_date date, p_to_date date) RETURNS TABLE(...)` — same columns as the view but filtered by `je.posting_date BETWEEN p_from AND p_to`. STABLE.

### 4.3 Admin UI

`/tanda` → 💼 Accounting → 📊 **Trial Balance**. Filter: basis (ACCRUAL / CASH), from-date, to-date. Renders a sortable table grouped by `account_type`. Subtotals per group + grand total row that nets to 0 (proof of balance).

---

## 5. Income Statement (P&L)

### 5.1 The view

```sql
CREATE OR REPLACE VIEW v_income_statement AS
SELECT
  je.entity_id,
  je.basis,
  EXTRACT(YEAR FROM je.posting_date)::int AS year,
  EXTRACT(MONTH FROM je.posting_date)::int AS month,
  ga.account_type,
  ga.code,
  ga.name,
  SUM(
    CASE
      WHEN ga.account_type = 'revenue'         THEN jel.credit - jel.debit  -- revenue accounts: CR positive
      WHEN ga.account_type = 'contra_revenue'  THEN jel.debit - jel.credit  -- contra revenue: DR positive, REDUCES revenue
      WHEN ga.account_type = 'expense'         THEN jel.debit - jel.credit  -- expense: DR positive
    END
  ) AS amount_cents
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga ON ga.id = jel.account_id
WHERE je.status = 'posted'
  AND ga.account_type IN ('revenue', 'contra_revenue', 'expense')
GROUP BY je.entity_id, je.basis, year, month, ga.account_type, ga.code, ga.name;
```

### 5.2 Parameterized RPC

`income_statement(p_entity_id, p_basis, p_from_date, p_to_date) RETURNS TABLE(...)` — same shape, filtered by posting_date range.

### 5.3 Section grouping

The admin UI groups output into three sections:

1. **Revenue** — `account_type IN ('revenue','contra_revenue')`. Sum = NET REVENUE.
2. **Cost of Goods Sold** — convention: COGS accounts have `code` starting with `'5'` (operator's standard COA). Sum = COGS.
3. **Operating Expenses** — `account_type = 'expense'` AND NOT in COGS. Sum = OPEX.

**Gross Margin** = Net Revenue − COGS. **Operating Income** = Gross Margin − OPEX. **Net Income** = Operating Income (until M22 Fixed Assets adds depreciation + M21 adds tax — those bolt on as new sub-sections without changing this query).

The COGS-detection convention is a sub-decision; the COA Admin UI can be extended with an explicit `is_cogs boolean` flag if range-based detection turns out wrong.

### 5.4 Admin UI

`/tanda` → 💼 Accounting → 📈 **Income Statement**. Basis toggle + date range. Sections collapsible. Per-account drilldown shows the net amount per posting period.

---

## 6. Balance Sheet

### 6.1 The view

```sql
CREATE OR REPLACE VIEW v_balance_sheet AS
SELECT
  je.entity_id,
  je.basis,
  ga.account_type,
  ga.code,
  ga.name,
  SUM(
    CASE
      WHEN ga.normal_balance = 'DEBIT'  THEN jel.debit - jel.credit
      WHEN ga.normal_balance = 'CREDIT' THEN jel.credit - jel.debit
    END
  ) AS balance_cents
FROM journal_entries je
JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
JOIN gl_accounts ga ON ga.id = jel.account_id
WHERE je.status = 'posted'
  AND ga.account_type IN ('asset', 'liability', 'equity', 'contra_asset')
GROUP BY je.entity_id, je.basis, ga.account_type, ga.code, ga.name;
```

### 6.2 Parameterized as-of RPC

`balance_sheet_as_of(p_entity_id uuid, p_basis text, p_as_of_date date) RETURNS TABLE(...)` — filters `je.posting_date <= p_as_of_date`. STABLE.

**Key invariant:** the as-of view INCLUDES revenue + expense year-to-date impact (which becomes retained earnings only after year-end close). The UI shows this as a "Current Year Earnings" line under Equity until the closing JE flips it into Retained Earnings.

### 6.3 The accounting equation must hold

```
Assets − Contra Assets = Liabilities + Equity + (Revenue − Expense for current year if no closing JE yet)
```

The UI surfaces this as a footer row labeled "Variance" — should always be $0.00. Anything else indicates corruption (a JE didn't balance, a basis mismatch, etc).

### 6.4 Admin UI

`/tanda` → 💼 Accounting → 📋 **Balance Sheet**. Basis toggle + as-of date picker. Three columns (Assets / Liabilities / Equity) with per-section subtotals. Footer row shows the variance check.

---

## 7. Cash Flow Statement (indirect method)

### 7.1 Approach

The indirect method derives operating cash from net income + changes in working capital. Schema-driven aggregation:

```
Operating section:
  Net income (from §5)
  + Depreciation & amortization (none until M22)
  + Decrease in AR (or − increase) — derived from balance change in ar_account
  + Decrease in inventory (or − increase) — derived from inventory_asset_account balance change
  − Decrease in AP (or + increase) — derived from ap_account balance change
  = Net cash from operating activities

Investing section:
  Purchases of equipment (M22)               (out of scope this phase — section reports $0)
  Sales of equipment (M22)                    (same)

Financing section:
  Issuance/repayment of debt                  (operator can map manually via account category tag)
  Owner contributions / distributions         (same)
```

The investing + financing sections require operator-tagging of equity/liability accounts (M22 Fixed Assets / M19 1099 contractor payments / etc) and aren't fully derivable from current schema. **P5 ships a working operating section + skeletal placeholders for investing/financing that show $0** with a "configure account tagging in P22+" note in the UI.

### 7.2 RPC

`cash_flow_indirect(p_entity_id uuid, p_basis text, p_from_date date, p_to_date date) RETURNS TABLE(section text, line_item text, amount_cents bigint)`

Computes operating section live. Investing/financing return placeholder rows.

### 7.3 Admin UI

`/tanda` → 💼 Accounting → 💧 **Cash Flow**. Basis toggle + date range. Operating section detailed; investing/financing sections show placeholder + "configure later" message. Footer: Beginning cash + Net change + Ending cash — beginning/ending pulled from `balance_sheet_as_of` for the relevant dates' cash accounts (account_type='asset' AND code starts with '1' AND name ILIKE '%cash%' or '%bank%' — heuristic with operator override via UI).

---

## 8. Closing entries + Retained Earnings

### 8.1 The closing JE

At fiscal-year end, operator runs the close-year RPC. It computes:

```
Net income (or loss) = Σ(revenue net amounts) − Σ(expense net amounts) for the closing FY
                       (uses §5 income_statement aggregation)
```

Then posts ONE journal entry per basis (accrual + cash siblings) with `journal_type='gl_year_end_close'`:

- DR each revenue account by its current YTD net credit (zero it out)
- CR each expense account by its current YTD net debit (zero it out)
- CR Retained Earnings by the net income amount (DR if loss)

### 8.2 Entity default — `entities.default_retained_earnings_account_id`

New nullable FK. Operator picks a single equity account as the close target via the Entities admin panel. RPC errors if not set.

### 8.3 RPC

```
gl_post_year_end_close(
  p_entity_id uuid,
  p_fiscal_year smallint,
  p_dry_run boolean DEFAULT true
) RETURNS jsonb
```

Returns `{accrual_je_id, cash_je_id, net_income_cents, basis_breakdown: [...]}`. Re-running is blocked by the period's `closed_with_closing_jes` status (set by the RPC at the end), so this is a one-shot operation per FY.

**Dry-run mode:** runs the math, returns the projected JE shape and net income, but inserts nothing. Operator reviews + audits before flipping to live.

### 8.4 Re-opening a year-end close

Once `closed_with_closing_jes` is set, the period is terminal — no re-open path. If the operator absolutely must correct a closed FY, they file an adjustment JE in the next FY's first period referencing the closing entry as documentation. The original closing JE is never altered.

### 8.5 Admin UI

`/tanda` → 💼 Accounting → 🔚 **Year-End Close**. Operator picks FY → click Dry Run → review the proposed JE shape + net income → click Confirm → confirmation prompt + posts both sibling JEs + flips all 12 periods of that FY to `closed_with_closing_jes`. The Periods panel reflects the terminal state visually (gray badge).

---

## 9. Admin UI surfaces (consolidated)

After P5, the **💼 Accounting** group dropdown gains 5 new panels:

| Panel | Emoji | Purpose |
|---|---|---|
| Trial Balance | 📊 | per-account net DR/CR for a date range |
| Income Statement | 📈 | revenue + expense rolled up with subtotals |
| Balance Sheet | 📋 | assets / liabilities / equity as-of a date |
| Cash Flow | 💧 | indirect-method operating section + placeholders |
| Year-End Close | 🔚 | dry-run + commit of the annual closing JE |

The existing Periods panel gets the "Run close checks" + "Soft close" + "Close" + "Reopen" actions on each period card.

---

## 10. RLS

All new tables (`gl_period_status_log`) use the standard P1 template — `anon_all` + `auth_internal_*` scoped through `entity_users.auth_id = auth.uid()`. Views are not RLS-protected (PG views don't carry RLS independently) — they inherit from underlying tables (`gl_accounts`, `journal_entries`, `journal_entry_lines`) which all carry the same auth_internal template.

The new RPCs (`gl_period_close_preflight`, `trial_balance`, `income_statement`, `balance_sheet_as_of`, `cash_flow_indirect`, `gl_post_year_end_close`) are STABLE/SECURITY-INVOKER — RLS evaluates as the caller, so a non-admin user can't pull a balance sheet for an entity they don't belong to.

---

## 11. Hook contract recap

- **M27 Approvals:** new rule kind `gl_period_close`. Operator can require approval before any `closed` transition (the soft_close → closed step). Default: no rule = no gate.
- **M28 Notifications:** new kinds `gl_period_soft_closed`, `gl_period_closed`, `gl_period_reopened`, `gl_year_end_closed`. Recipient_roles = `['admin','accountant']`.
- **M29 Documents:** AR Invoice / AR Receipt / JE detail modals already host DocumentAttachmentList. Period close gets a "Close package" attachment surface — the Period detail modal (new in P5) embeds `<DocumentAttachmentList contextTable="gl_periods" kinds={["close_package_pdf","bank_recon","other"]}/>`.

---

## 12. Chunk split (implementation — DO NOT start until operator approves)

| Chunk | Scope | Migration touches | Tests target |
|---|---|---|---|
| **P5-1** | Period close mechanics + audit log | `gl_period_status_log` + `closed_with_closing_jes` enum extension + 2 transition RPCs | 40-60 |
| **P5-2** | Trial Balance view + RPC + UI | `v_trial_balance`, `trial_balance()` RPC + `InternalTrialBalance.tsx` | 30-40 |
| **P5-3** | Income Statement view + RPC + UI | `v_income_statement`, `income_statement()` RPC + `InternalIncomeStatement.tsx` | 30-40 |
| **P5-4** | Balance Sheet view + RPC + UI | `v_balance_sheet`, `balance_sheet_as_of()` RPC + `InternalBalanceSheet.tsx` + variance footer | 30-40 |
| **P5-5** | Cash Flow Statement RPC + UI | `cash_flow_indirect()` RPC + `InternalCashFlow.tsx` (operating section live; investing/financing placeholders) | 25-35 |
| **P5-6** | Year-End Close RPC + UI + entity FK | `gl_post_year_end_close()` RPC + `entities.default_retained_earnings_account_id` FK + `InternalYearEndClose.tsx` | 50-70 |
| **P5-7** | Close pre-flight RPC + Periods panel actions | `gl_period_close_preflight()` RPC + extend `InternalPeriods.tsx` with Close/Reopen/Run-checks buttons | 30-50 |

Implementation order: P5-1 → P5-2 → (P5-3, P5-4, P5-5 in parallel — they're independent views) → P5-6 → P5-7. Total: ~7 chunks, similar shape/size to P3 and P4.

---

## 13. Sub-decisions deferred to implementation

- **COGS detection in P&L:** range-based on COA code (codes starting with `'5'`) vs explicit `gl_accounts.is_cogs boolean` flag. Default to range-based for MVP; add the flag only if operator hits a misclassification.
- **Cash-account detection in Cash Flow:** name-based heuristic (ILIKE `%cash%` OR `%bank%`) vs an explicit `gl_accounts.is_cash boolean` flag. Same approach — heuristic now, flag if needed.
- **Period status enum migration shape:** does `closed_with_closing_jes` get added to the existing `gl_periods.status` CHECK constraint, or does it move to a new `status_terminal boolean` column? Recommendation: extend the CHECK constraint (lower migration cost; the state is a status, not a side flag).
- **Comparative period reporting:** ship as a P5-X follow-up after the four primary statements work. Not in MVP.
- **PDF export of close packages:** out of scope for P5; if the operator wants it, ship as a separate small chunk using Puppeteer or browser print-to-PDF. The DocumentAttachmentList drop-in on the Period detail modal covers the "attach close documents" workflow without needing on-system PDF generation.

---

## 14. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Closing JE math is wrong → financial-statement corruption | medium | severe | Dry-run mode required; operator audits the JE shape before live commit; the original closing JE is referenced by an `audit_period` tag in metadata |
| Period status enum migration breaks the existing post-guard trigger | low | severe | The new `closed_with_closing_jes` value is treated identically to `closed` in the existing guard (the guard checks `status != 'open'` semantically, so any new "closed" variant inherits the block); test exhaustively in P5-1 |
| Balance sheet variance row shows non-zero in prod | medium | medium | Surface variance prominently in the UI footer; build a `v_balance_sheet_variance_audit` view that joins JEs that are out-of-balance for operator diagnosis; the existing JE post trigger already rejects unbalanced lines so this should be rare but defense-in-depth helps |
| Operator runs year-end close prematurely (before all entries posted) | medium | severe | Pre-flight rejection on draft JEs / unposted invoices; admin-only with explicit confirmation prompt; `dry_run=true` default |
| The COGS / cash-account heuristics misclassify the operator's COA | medium | medium | Both have an operator override pathway via the UI; misclassification surfaces in the variance footer |
| Income statement re-run after the closing JE shows $0 for closed FY | expected (correct behavior) | n/a | Document this in the user guide: post-close, the period's IS shows nothing because revenue/expense were zeroed. Operator runs IS against pre-close JE history if they need to see the FY's activity post-close |

---

## 15. Out of scope (explicit — recap)

1. Bank/CC reconciliation (P6 = M7+M8)
2. Multi-currency
3. Tax computation (P25 = M20 Sales Tax)
4. Depreciation / amortization (M22 Fixed Assets — P25)
5. Budget-vs-actual variance
6. Statutory output formats
7. PDF auto-generation of close packages (use DocumentAttachmentList instead)
8. Drill-down from financial statements into individual JEs (P5 follow-up)
9. Comparative-period columns (P5 follow-up)

---

## 16. Approval handshake

Per the revised plan-approval-not-implementation rule, this arch doc auto-merges on CI green. **Implementation chunks (P5-1 through P5-7) require explicit operator approval before the first PR opens.** The operator's "go ahead with P5" is sufficient blanket approval — no per-chunk re-approval needed; the chunks roll forward automatically with auto-merge on CI green per the standard workflow.

**Kickoff prerequisites:**
- Operator confirms COGS-detection convention (code-starts-with-`5` heuristic vs explicit flag). Default: heuristic.
- Operator confirms cash-account detection convention (name-based ILIKE heuristic vs explicit flag). Default: heuristic.
- Operator picks the retained-earnings account for ROF (a single equity account); if not yet on the COA, create it first. The default seed includes a `3500 Retained Earnings` account from P1; if present, P5-6 auto-wires `entities.default_retained_earnings_account_id` to it.

**Once approved, dispatch order:** P5-1 first (foundation), then P5-2/3/4/5 in parallel (independent views), then P5-6, then P5-7. Estimated 1-2 sessions to ship all 7 chunks at the pace P3/P4 set.
