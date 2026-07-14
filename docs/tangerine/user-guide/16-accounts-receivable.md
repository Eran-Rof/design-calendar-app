# 16. Accounts Receivable (M4)

> **P4 status (2026-05-27 night):** all 8 chunks shipped, all migrations applied to prod, all four AR admin panels live in Tangerine → Accounting. PRs #370, #371, #372, #373, #377, #378, #380, #382, #384, #386.

The Accounts Receivable module records customer invoices, drives them through GL posting (with FIFO COGS recognition for inventory lines), captures customer payments, and surfaces the receivables ledger + aging report. AR is the AP module flipped to the customer side: where AP debits an expense / inventory asset and credits AP control, AR debits AR control and credits revenue (plus a FIFO COGS pair per inventory line).

Tangerine P4 Chunk 4 (this chapter) ships the AR Invoices admin UI + handlers on top of the P4 Chunk 1 schema (`ar_invoices`, `ar_invoice_lines`, `ar_receipts`, `ar_receipt_applications`). Receipts UI ships in P4-5 — see the placeholder at the bottom of this page.

## Panels

| Panel | URL | Who uses it | Writable? |
|---|---|---|---|
| 🧮 **AR Invoices** | `/tangerine` → AR Invoices | Accountant, ops | Yes — full CRUD on drafts; Post / Void on sent invoices |
| 💰 **AR Receipts** | _coming in P4-5_ | Accountant | Pending |
| 📊 **AR Aging** | _coming in P4-6_ | CEO, accountant | Pending (operator's daily morning view) |

## Lifecycle

```mermaid
flowchart LR
    Draft["🧾 draft<br/>(edit + delete OK)"]
    PendingApproval["⏳ pending_approval<br/>(awaiting M27 approval)"]
    Sent["✅ sent<br/>(accrual JE live, FIFO consumed)"]
    PartialPaid["💵 partial_paid<br/>(receipt applied)"]
    Paid["💰 paid<br/>(fully paid — cash JE live)"]
    Void["🚫 void<br/>(JEs reversed, FIFO restored)"]

    Draft -->|Post button| PendingApproval
    Draft -->|Post (no rule fires)| Sent
    PendingApproval -->|approver clicks Approve in M27 Inbox| Sent
    PendingApproval -->|approver rejects| Draft
    Sent -->|Receipt (partial)| PartialPaid
    Sent -->|Receipt (full)| Paid
    PartialPaid -->|Receipt (remainder)| Paid
    Sent -->|Void| Void
    Draft -->|Void / Del| Void

    style Draft fill:#cbd5e1,color:#0f172a
    style PendingApproval fill:#fed7aa,color:#0f172a
    style Sent fill:#bbf7d0,color:#0f172a
    style PartialPaid fill:#a7f3d0,color:#0f172a
    style Paid fill:#86efac,color:#0f172a
    style Void fill:#fecaca,color:#0f172a
```

There is also a terminal **`posted_historical`** status reserved for the P4-8 5-year backfill — the operator UI cannot write that state directly; the backfill RPC owns it.

## Creating an AR invoice (draft)

From the **AR Invoices** panel, click **+ New invoice**.

| Field | Required? | Notes |
|---|---|---|
| Customer | yes | Sourced from M36 Customer Master. Type an unknown name → a **"+ Add customer '<name>'"** typeahead row opens the Add-customer popup pre-filled, creates it on the fly, selects it here, and sends a complete-the-info reminder (item 8). UUID paste fallback is offered. |
| Invoice number | optional | Auto-generated as `AR-YYYY-NNNNN` if blank. Must be unique per entity. |
| Kind | yes | `customer_invoice` / `customer_credit_memo` |
| Invoice date | yes | The date the GL JE will land on (must be inside an open period at post time). `posting_date` is kept in lockstep with this field. |
| Payment terms | optional | If set, **Due date** is auto-computed from `payment_terms.net_days`. Manual edit overrides. |
| Due date | optional | Defaults to invoice date if blank. |
| AR account override | optional | Defaults to `entities.default_ar_account_id` (code `1200`). Per-customer override via `customers.default_ar_account_id`. |
| Revenue account (default) | optional | Defaults to `entities.default_revenue_account_id` (code `4000`). Per-line override available. |
| COGS account | optional | Defaults to `entities.default_cogs_account_id` (code `5000`). Required only when an inventory line is present. |
| Inventory asset | optional | Defaults to `entities.default_inventory_account_id` (code `1300`). Required only when an inventory line is present. |
| Description | optional | Free text |
| Lines (≥ 1) | yes | See **Lines + inventory contract** below |

### Lines + inventory contract

Each line must resolve to a positive `line_total_cents`. There are two paths:

1. **Quantity + unit price path** — supply `quantity` and `unit_price_cents` (UI: dollars). The DB trigger `ar_invoice_lines_compute_total_trg` computes `line_total_cents = quantity * unit_price_cents`.
2. **Flat total path** — supply only `line_total_cents` (UI: the **Amount $** column on a non-matrix line) when no per-unit breakdown applies (e.g. a flat service / freight line). The trigger preserves the explicit value.

**Inventory contract:** if a line carries `inventory_item_id` (uuid into `ip_item_master`), it **must** use the quantity + unit price path. The unit price is the **selling price** (not the cost) — the COGS amount is derived at post time from the FIFO layer consumption (see next section). A line without `inventory_item_id` is treated as a service / non-inventory line and never generates a COGS entry.

The trigger `ar_invoice_lines_maintain_total` rebuilds `ar_invoices.total_amount_cents` after every line insert / update / delete. The UI shows a running total under the lines table.

### The line body is the size matrix (shared with Sales Orders)

The invoice line body is the **same editable size-matrix body the Sales Order modal uses** (`LineMatrixBody`, `mode="ar"`), open by default:
- **Always opens in matrix format.** Whether you create a new invoice, open one created from **Allocations** (SO → invoice), or open any existing invoice, the body shows the color × size grids by default. On open, each existing inventory line is resolved back to its style / color / size (via the item master, including now-inactive SKUs) and **regrouped into a per-style matrix**; only lines that can't be matrixed (amount-only charges, non-apparel SKUs, or SKUs that can't be resolved) fall back to a flat row.
- **➕ Add style (matrix)** — pick a style → fill its color × size grid inline, with a per-row **Unit $**; new pickers insert on top.
- **+ Add non-matrix line** — a flat row that doubles as an **amount-only charge** (freight / fees / discounts): enter a **Description** + **Amount $** with no SKU, or a SKU + Qty + Unit $.
- **Revenue routing:** inventory/style (matrix) lines route revenue **server-side** (header → customer → entity default); added flat lines default server-side too but expose an optional per-line **Revenue acct** override.
- Save / Close sit in a **frozen footer**. (The old ☰ List / ▦ Matrix read-only toggle and the per-line price-suggest were removed in favour of this unified editable body.)

## Posting — Approval gate + FIFO consume

Click **Post** on a draft row (or on a pending-approval row to re-emit the gate). The handler:

1. Loads the invoice + lines. Resolves the GL account chain:
   - **AR:** `invoice.ar_account_id` → `entity.default_ar_account_id` → COA code `1200`
   - **Revenue:** `invoice.revenue_account_id` → `entity.default_revenue_account_id` → COA code `4000`
   - **COGS** (only when an inventory line exists): `invoice.cogs_account_id` → `entity.default_cogs_account_id` → COA code `5000`
   - **Inventory asset** (only when an inventory line exists): `invoice.inventory_asset_account_id` → `entity.default_inventory_account_id` → COA code `1300`

   If any required leg is unresolvable, the handler returns **400** with a clear error message before any DB writes occur.

   > **Per-style revenue + COGS routing (operator #6).** Each invoice **line** can carry its own `revenue_account_id` and `cogs_account_id`. When an invoice is created from a sales order, each line's accounts are resolved **style → customer default → entity default** — the style's `style_master.revenue_account_id` / `cogs_account_id` win (these are set per brand bucket: ROF Brands / Boys / PT / Private Label, from the Xoro item GL export). So a single invoice spanning several brands books **each line's revenue and COGS to that brand's accounts**; the invoice-level account is only the fallback for styles with no account set. The `arInvoiceSent` rule applies the per-line account when present, else the invoice default.
   >
   > **Per-style returns routing.** Customer **credit memos** (returns, M23) route the same way: each return line's revenue reversal posts to the style's **`returns_account_id`** (the brand's Sales Returns account — 4236 ROF / 4234 Boys / 4235 PT / 4201 Private Label) → customer `default_returns_account_id` → entity Sales Returns (4100). So returns show up against the right brand's contra-revenue line.

2. Calls `approvalsAPI.requestIfRequired({ kind: 'ar_invoice', amount_cents: total, payload: { customer_id, customer_code } })`.
   - If a rule matches (e.g. amount > $10k, or a `customer_credit_extension` rule fires for over-limit customers — see arch §5.1):
     - Sets `gl_status='pending_approval'`.
     - Fires the `ar_invoice_approval_requested` notification to the **admin** role.
     - Returns `202 { requires_approval: true, approval_request_id }`.
     - The accountant + admin see the row in the **Approval Inbox** panel and decide.
   - If no rule matches: continues directly to step 3.

3. Calls `postEvent({ kind: 'ar_invoice_sent' })`. The posting service:
   - Runs `inventory_fifo_consume()` per inventory line — returns the per-line `cogs_cents` from the FIFO layer draw-down.
   - Builds the accrual JE: **DR AR / CR revenue** (per line) **+** per-inventory-line **DR COGS / CR inventory** with the resolved FIFO amounts.
   - Drops any zero-COGS sentinel pair cleanly (a layer might be already-zero-cost on a return-to-stock layer with damaged units).
   - Persists the JE atomically. The accrual JE id is returned.

4. The handler writes each `consume_results[].cogs_cents` back onto `ar_invoice_lines.cogs_cents` (keyed by `target_line_id`) and stamps `cogs_resolved_at`. These columns are NULL until the invoice is sent.

5. Stamps `ar_invoices.accrual_je_id` and flips `gl_status='sent'`.

6. Fires the `ar_invoice_posted` notification to **admin + accountant**.

When the approver clicks **Approve** in the **Approval Inbox**, the M27 `decide` handler re-runs the post path automatically via `fromApprovalHook=true`. The invoice flips from `pending_approval` to `sent` in one round trip.

### Cash basis is deferred to receipt

Unlike AP (where the cash JE fires at the Pay event), AR's cash basis is recognized at **receipt** time — when an `ar_receipt` is applied to this invoice via `ar_receipt_applications`. See `arPaymentReceived.js`. This means at the **sent** state there is exactly one JE (accrual). At the **paid** state there are two: the original accrual and a deferred cash JE. The trigger `ar_invoices_paid_maintainer` (P4-1) flips `gl_status` from `sent → partial_paid → paid` based on the running sum of receipt applications vs. `total_amount_cents`.

## Voiding an invoice

Click **Void** on a sent row (or **Del** on a draft row for hard delete). The void handler:

1. Returns **409** with `{ has_payments: true, paid_amount_cents }` if any receipt has been applied (i.e. `paid_amount_cents > 0`). The operator must void the receipts first via the P4-5 receipts panel.
2. Calls `postEvent({ kind: 'ar_invoice_voided', data: { invoice_id, accrual_je_id, cash_je_id, gl_status, reason } })`. The `arInvoiceVoided` rule emits a `reversals[]` array of JE ids to reverse:
   - **Draft / pending_approval:** empty array (nothing posted yet).
   - **Sent / partial_paid / paid:** `[accrual_je_id]` and, if `cash_je_id` is set, also includes it.
3. The posting service calls `reverseJournalEntry(jeId)` for each — emitting a new JE with negated lines (`reverses_je_id` set). This reverses the GL, including putting the inventory **asset dollars** back (DR Inventory / CR COGS).
   - **Physical inventory put-back.** The GL reversal alone does **not** restore the on-hand *quantity* (the consumed FIFO layers stay drawn down). So the void flow then calls **`restoreInvoiceConsumption()`** (`api/_lib/inventory/restoreInvoiceConsumption.js`): for each live `inventory_consumption` row this invoice's lines drew, it adds `qty_consumed` back to that layer's `remaining_qty` (true reversal — the exact layers, capped at `original_qty`) and stamps the consumption row `reversed_at` (kept for audit, not deleted). The units return to on-hand, since the goods are no longer considered shipped. A never-posted **draft delete** consumed nothing, so this is a no-op there.
4. Flips `ar_invoices.gl_status='void'`.
5. Appends `[void] <reason>` to `ar_invoices.notes` if a reason was supplied.
6. Fires the `ar_invoice_voided` notification to **admin + accountant**.
7. **Re-opens the originating sales order** (when the invoice carries a `sales_order_id`): `reopenSalesOrderFromInvoice()` rolls the SO lines' `qty_invoiced` back by the invoiced quantities and re-derives the line + header status — **allocated** when the soft allocations still fully cover the order, else **confirmed** (a `cancelled` SO is never resurrected). The same re-open runs on a **draft Delete**. This stops a deleted/voided invoice from stranding its SO in `invoiced`. The Void prompt and the Delete confirmation **warn** *"this will re-open SO-NNNN and restore its allocations"* first, and a toast confirms the re-opened SO afterward. (Allocations are a soft reservation untouched by invoicing, so they remain in place — only the SO status/invoiced quantities are repaired.)

Voiding is **always** reversible to a clean GL — the audit trail keeps both the original JE and its reversal pair, so the AP/AR aging reports always reconcile.

## Editing rules

| Operation | Allowed when `gl_status` is | Notes |
|---|---|---|
| Edit header / lines | `draft`, `unposted` | The PATCH handler rejects with 405 if posted/sent/paid/void/reversed. |
| Delete | `draft`, `unposted` | Use Void instead once posted. |
| Post | `draft`, `unposted`, `pending_approval` | Re-emits approval if still pending. |
| Void | `sent`, `partial_paid`, `paid` | Blocked while applied receipts exist. |

`gl_status`, `accrual_je_id`, `cash_je_id`, `total_amount_cents`, `paid_amount_cents`, and `entity_id` are **server-controlled** — the PATCH handler rejects any direct write attempts with 400.

## Filter row

The top of the panel has six filters:

- **Status** — single-select on `gl_status`.
- **Customer** — single-select on the customer dropdown.
- **From / To** — `invoice_date` range.
- **Limit** — 50 / 100 / 200 / 500.
- **Include void** — checkbox (default off).
- **Search** — `invoice_number` ilike.

Void invoices render at 50% opacity. The **Balance** column shows `total_amount_cents − paid_amount_cents` colored amber when > 0.

## Supporting documents

The edit modal embeds `<DocumentAttachmentList contextTable="ar_invoices" kinds={["customer_invoice_pdf","approval_correspondence","other"]} />` so accountants can attach the PDF copy of the invoice that goes out to the customer plus any approval correspondence.

## Schema coordination

- All money amounts are stored as **`bigint cents`** — never floats. The UI translates dollars ↔ cents at the form boundary; the handler validates every cents field as a BigInt-safe integer.
- The `(entity_id, invoice_number)` UNIQUE constraint on `ar_invoices` enforces operator typo isolation per company. Two ROF invoices can't share a number; the handler returns **409** on collision.
- `ar_invoice_lines.cogs_cents` and `cogs_resolved_at` are populated server-side at post time — the UI never writes these. They appear on the read API but the PATCH handler rejects them.
- The FIFO consume side-effect ordering is the same asymmetry P3-5 documented: `inventory_fifo_consume()` mutates layers + writes the consumption ledger row BEFORE the JE persists. If JE persist fails, the FIFO ledger leads the GL by one event. Accepted tradeoff — operator reconciles out-of-band via the `consume_results` audit trail surfaced on the post response.

## Receipts (P4-5)

_Placeholder._ The P4-5 chunk ships the **AR Receipts** admin UI: a separate panel for entering customer payments (ACH / wire / check / credit card / cash / paypal / stripe), applying one receipt to one or more invoices via the `ar_receipt_applications` junction, and triggering the `arPaymentReceived` posting rule (DR bank / CR AR per applied invoice for the accrual side; DR bank / CR revenue for the deferred cash side). Receipts also support partial application — under-applied amounts surface in the `v_ar_unapplied_receipts` view for accountant cleanup.

This chapter will be extended in P4-5 with:
- Receipt entry form (header + applications grid)
- One-receipt-many-invoices flow with running unapplied balance
- Void receipt flow (reverses the cash JE; restores the invoice's paid_amount_cents)
- Cash receipts journal view (`v_cash_receipts_journal`)

## Related docs

- [`../P4-ar-architecture.md`](../P4-ar-architecture.md) §3 (schema), §4.1 (`arInvoiceSent` rule), §4.3 (`arInvoiceVoided` rule), §5 (hook contracts), §6 (5-year backfill — P4-8)
- [13-accounts-payable.md](13-accounts-payable.md) — the AP-side analogue this chapter mirrors
- [07-approvals.md](07-approvals.md) — the M27 approval-rule gate `ar_invoice` and `customer_credit_extension` rule kinds
- [08-notifications.md](08-notifications.md) — the `ar_invoice_posted`, `ar_invoice_voided`, and `ar_invoice_approval_requested` notification kinds

---

## Customer Receipts (P4-5)

A **receipt** is the record of a customer payment. One receipt may be applied across one or more invoices via the `ar_receipt_applications` junction table; any unapplied portion shows in `v_ar_unapplied_receipts` (an on-account credit).

### Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Draft : Add Receipt
    Draft --> Posted : Post (emits accrual + cash JEs)
    Draft --> Voided : Void (no JE; flips is_void)
    Posted --> Voided : Void (reverses both JEs)
    Voided --> [*]
```

**Three terminal-or-near-terminal states:**

| State | Triggers | What you can do |
|---|---|---|
| **Draft** | Created via the Add Receipt modal; no JEs emitted yet | Edit header fields, add/remove applications, delete (if no applications), post, void |
| **Posted** | `Post` button creates the accrual JE and the cash JE (sibling-linked) | Header is locked; void (which reverses both JEs); no further header edits |
| **Voided** | `Void` button — also fires when posted receipts are reversed | Terminal; applications stay in the DB as audit history; the `paid_amount_cents` maintainer on invoices ignores `is_void=true` so paid totals automatically back out |

### Add Receipt — the multi-application UX

1. **Pick customer.** As soon as a customer is selected the modal fetches their open AR invoices (`gl_status IN ('sent','partial_paid')` AND balance > 0), sorted by `due_date` ascending (oldest first — standard FIFO collection logic).
2. **Enter receipt header.** Amount, date, payment method (ach / wire / check / credit_card / cash / paypal / stripe / other), bank account, and optional reference (check #, wire confirmation, Stripe charge id).
3. **Check rows to apply.** Each checked row auto-fills the apply amount = invoice's outstanding balance (capped at remaining receipt amount). You can override each amount manually.
4. **Live sums** at the bottom show *Receipt / Applied / Unapplied*. Behavior:
   - **Applied ≤ Receipt** — allowed; if Applied < Receipt the difference is on-account (visible in `v_ar_unapplied_receipts`).
   - **Applied > Receipt** — UI shows in red; submit is rejected client-side AND by the DB over-application guard (`ar_receipt_applications_amount_positive`).
   - **Applied = 0** — allowed; creates a fully-unapplied on-account receipt.
5. **Save** creates the receipt as **Draft**. JEs are NOT emitted until you click **Post** in the detail modal.

### Post → JE emission

Posting a receipt invokes the `arPaymentReceived` posting rule in **multi-application mode** (see `api/_lib/accounting/posting/rules/arPaymentReceived.js`). Each posting emits TWO journal entries:

| JE | Side | Shape |
|---|---|---|
| **Accrual JE** | `basis=ACCRUAL`, `journal_type=ar_receipt` | Header: `DR bank_account` (full receipt total). Then one `CR ar_account` line per application (per-invoice). Clears the customer's AR balance proportionally. |
| **Cash JE** | `basis=CASH`, `journal_type=ar_receipt` | Header: `DR bank_account` (full receipt total). Then one `CR revenue_account` line per application. Recognizes revenue on cash basis (deferred from invoice send). |

The two JEs are **sibling-linked** via the `gl_link_sibling_je` RPC inside `persistRuleOutput` — reports can navigate accrual↔cash from either side. The receipt header is then stamped with both `accrual_je_id` and `cash_je_id`.

> **Per-line revenue routing:** if an applied invoice has a per-invoice `revenue_account_id` (set when the invoice was created/sent), the cash JE will credit that revenue account specifically rather than the entity default. This supports e.g. wholesale-vs-ecom revenue split per customer.

### Trigger-driven invoice updates

Two DB triggers do work for you when applications are inserted, updated, or deleted:

1. **`ar_receipt_apps_maintain_paid`** — recomputes `ar_invoices.paid_amount_cents` = SUM of `amount_applied_cents` across all non-voided receipt applications.
2. **`ar_invoices_status_from_paid`** — when `paid_amount_cents` changes, auto-flips `gl_status`:
   - `paid_amount_cents >= total_amount_cents` → **paid**
   - `0 < paid_amount_cents < total_amount_cents` → **partial_paid**
   - `paid_amount_cents = 0` (after voiding all receipts) → back to **sent**

Posting and voiding receipts therefore drive invoice gl_status changes automatically; you don't manually transition invoices through partial_paid → paid → reopened.

### Void → reversal of BOTH JEs

When you void a posted receipt:

1. `reverseJournalEntry()` is invoked for the accrual JE → emits a new accrual JE with negated lines (`reverses_je_id` set).
2. `reverseJournalEntry()` is invoked for the cash JE → same, on the cash side.
3. The receipt is stamped with `is_void=true` + `voided_at=now()` + `voided_by_user_id` + (optional) `void_reason`.
4. **Applications stay in the DB.** They're audit history. The `is_void=false` filter in the paid-amount maintainer ignores voided receipts, so the parent invoices' `paid_amount_cents` automatically back out and the status-from-paid trigger flips them back from `paid` → `partial_paid` → `sent`.

> Voiding a Draft (un-posted) receipt skips steps 1+2 (no JEs to reverse) but still flips `is_void` and notifies the accounting team.

### Unapply (delete a single application)

`DELETE /api/internal/ar-receipt-applications/:id` removes a single application row. Allowed only when the parent receipt is Draft. Posted or Voided parents return 409 — to undo a posted receipt's application, void the entire receipt and create a new one.

### Documents

The receipt detail modal embeds `<DocumentAttachmentList contextTable="ar_receipts">` with these document kinds:

- `customer_payment_proof` — generic
- `check_image` — scanned check
- `wire_confirmation` — wire transfer PDF
- `other`

Documents persist independently of the receipt lifecycle (still accessible after void).

### Notifications

| Event | Kind | Severity | Recipients |
|---|---|---|---|
| Receipt posted | `ar_receipt_posted` | `info` | `admin`, `accountant` |
| Receipt voided | `ar_receipt_voided` | `warn` | `admin`, `accountant` |

### API surfaces

| Endpoint | Methods | Purpose |
|---|---|---|
| `/api/internal/ar-receipts` | GET, POST | List receipts (filter by customer / method / date range / include_void; paginated via `?offset=N`); create draft with applications |
| `/api/internal/ar-receipts/:id` | GET, PATCH, DELETE | Fetch one with applications + customer name; edit header fields (Draft only); delete (Draft + no applications only) |
| `/api/internal/ar-receipts/:id/post` | POST | Emit accrual + cash JEs; stamp the receipt |
| `/api/internal/ar-receipts/:id/void` | POST | Reverse JEs (if any) + flip is_void |
| `/api/internal/ar-receipt-applications/:id` | DELETE | Unapply a single application (Draft parents only) |

### Schema cheat sheet

```
ar_receipts
  id (uuid, PK)
  entity_id, customer_id
  receipt_date (date)
  amount_cents (bigint > 0)
  bank_account_id (uuid → gl_accounts)
  customer_payment_method (ach|wire|check|credit_card|cash|paypal|stripe|other)
  reference, notes (text)
  accrual_je_id, cash_je_id (uuid → journal_entries)
  is_void (bool), voided_at, voided_by_user_id, void_reason

ar_receipt_applications
  id (uuid, PK)
  ar_receipt_id (uuid → ar_receipts, ON DELETE CASCADE)
  ar_invoice_id (uuid → ar_invoices, ON DELETE RESTRICT)
  amount_applied_cents (bigint > 0)
  UNIQUE (ar_receipt_id, ar_invoice_id)
```

### Reporting views

- **`v_cash_receipts_journal`** — every cash event impacting AR, joined to applications and invoices. Useful for monthly bank-statement reconciliation. Excludes voided receipts.
- **`v_ar_unapplied_receipts`** — receipts with an unapplied balance (on-account credits). Each row exposes `applied_cents` and `unapplied_cents`.

### Operator runbook — common scenarios

| Scenario | Steps |
|---|---|
| Wire payment of $5,000 covering one open $5,000 invoice | Add Receipt → pick customer → enter $5,000 → check the one invoice (auto-fills $5,000) → Save → Post |
| ACH for $10,000 paying off three small invoices ($2k + $3k + $4k = $9k) with $1k overpay | Add Receipt → enter $10,000 → check all three → live unapplied shows $1,000 → Save → Post. The receipt's $1k stays as on-account credit in `v_ar_unapplied_receipts` until applied to a future invoice. |
| Customer's check bounced after posting | Open receipt → enter void reason ("NSF bounce") → Void posted receipt. Both JEs reverse; the parent invoices auto-flip from `paid` back to `sent` via the trigger chain. |
| Misapplied a payment to wrong invoice (still draft) | Open the draft receipt → click × next to the wrong application → re-apply via the apply-more action (or void + recreate). |
| Misapplied a payment to wrong invoice (already posted) | Void the entire posted receipt → create a new one. (Unapply on posted receipts is blocked — audit-trail rule.) |

---

## Aging report + overdue cron (P4-6)

### The Aging panel

Navigate to **Tangerine → Accounting → AR Aging** (📅). The panel shows one row per customer with non-zero open AR, broken into six buckets relative to invoice due dates:

| Bucket | Definition |
|---|---|
| **Current** | due date is in the future (or today) |
| **1-30** | 1-30 days past due (yellow) |
| **31-60** | 31-60 days past due (orange) |
| **61-90** | 61-90 days past due (red) |
| **91-120** | 91-120 days past due (deeper red) |
| **120+** | 120+ days past due (deepest red, bolded) |

Each row's "Total Open" matches the sum across all six buckets. The footer row totals each column across the filtered customer set.

> **Drill-through (Phase 2, 2026-07-09):** every amount is clickable — cell, row total, or column
> total — and opens the list of open invoices behind that number (dates, days past due, open
> amount; footer ties to the cell). Clicking a row (its invoice number is shown in blue) opens the invoice, and a **JE** button opens its posting journal
> entry (**JE**). Deep link: `?m=ar_aging&bucket=<key>&party=<customer id>`. See the
> [Accounting chapter's drill-through section](03-accounting.md#drill-through-phase-2--agings-segment-pl-bank-recon-2026-07-09).

### Modes

- **Default mode** (no `as_of` parameter): reads the `v_ar_aging` view which uses `CURRENT_DATE`. Fast — view is computed live by the DB.
- **As-of mode** (pick a date in the past): calls the `ar_aging_as_of(p_entity_id, p_as_of_date)` RPC. Useful for retroactive close-of-period reports. Slightly slower than the view because the RPC re-aggregates.

The mode badge in the header ("mode: current" / "mode: as_of") shows which path is active.

### Daily overdue notification cron

`api/cron/ar-aging-overdue-email.js` runs daily at 14:30 UTC (= 6:30 PT / 09:30 ET) per `vercel.json`. Per entity:

```mermaid
flowchart TD
  C[Cron fires 14:30 UTC] --> E[for each entity]
  E --> A[SELECT * FROM v_ar_aging WHERE entity_id=X]
  A --> R[for each customer row]
  R --> B[for each non-zero bucket]
  B --> D{INSERT into notifications_overdue_log\n entity, customer, bucket, sent_on=today}
  D -- unique violation 23505 --> S[skip — already sent today]
  D -- new row --> N[enqueue customer_overdue_30d / 60d / 90d]
  S --> X[next bucket]
  N --> X
```

**Dedup table** (`notifications_overdue_log`) prevents same-day re-fires. Schema:

```sql
notifications_overdue_log (
  id           uuid PK,
  entity_id    uuid → entities,
  customer_id  uuid → customers,
  bucket       text  CHECK in (30d, 60d, 90d, 120d_plus),
  sent_on      date  DEFAULT current_date,
  open_cents   bigint,
  UNIQUE (entity_id, customer_id, bucket, sent_on)
)
```

Re-running the cron on the same day is a clean no-op (`duplicates_skipped` increments; no duplicate emails go out).

### Notification kinds

| Kind | Bucket(s) | Severity |
|---|---|---|
| `customer_overdue_30d` | 1-30 | info |
| `customer_overdue_60d` | 31-60 | warn |
| `customer_overdue_90d` | 61-90 AND 91-120+ | warn / alert |

Recipient: `recipient_roles=['admin','accountant']`. To silence a kind for a specific user, use the **Notification Preferences** panel (P2-4).

### Manual trigger

Hit the endpoint with a service-role bearer (or via `vercel dev`):

```
curl -X POST https://<your-host>/api/cron/ar-aging-overdue-email
```

Response shape:

```json
{
  "ok": true,
  "entities_scanned": 1,
  "customers_scanned": 47,
  "notifications_enqueued": 12,
  "duplicates_skipped": 23,
  "errors": []
}
```


---

## Historical backfill (P4-8)

Backfills `ar_invoices` + `journal_entries` from the existing `ip_sales_history_wholesale` Xoro feed. **Window: 2024-08-01 → today** (per Xoro initial-use cutoff; earlier `gl_periods` are purged and `entities.posting_locked_through` is pinned to `2024-07-31` so nothing earlier can ever be posted).

### Coverage

**AR history now starts 2024-09-01** (loaded 2026-07-10; previously 2025-01-01). The Sep–Dec 2024 gap was closed from the CEO's Xoro invoice-registry + item-detail exports via `scripts/ar2024-backfill/` (stage → post → verify), reusing this same runner end to end:

- **5,350 invoices / $8,302,559.57** posted with SKU-level lines (Sep $1,820,754.10 · Oct $1,554,575.71 · Nov $2,696,785.79 · Dec $2,230,443.97 — each month ties the Xoro registry to the cent). 23 additional $0 registry invoices (promo/internal) are skipped by the runner's `total<=0` convention.
- Every invoice's lines sum **exactly** to its registry header: item lines are verbatim Xoro detail; any remainder (freight/handling not in the item report) posts as a **`AR2024-FREIGHT`** top-up line routed to the invoice's channel revenue account.
- **1,051 registry invoices have no item lines in Xoro** (confirmed by two independent exports) and post as a single **`AR2024-NODETAIL`** summary line: Macys micro-invoices (970 / $244,071.98) are consignment-style → revenue-only, NO COGS/inventory legs; the wholesale ones (81 / $1,168,374.25 — Ross, Burlington, Bealls, DD'S, etc.) carry **estimated COGS at the period blended cost ratio** of the SKU-lined invoices per channel.
- The **8/31/2024 opening balance sheet (incl. opening inventory/equity) is still pending** CEO exports — GL history before 2024-09-01 remains empty by design.

### Suspected year-end re-issues (CEO review)

The registry contains two exact duplicate pairs straddling 2024→2025 — same customer, amount, and FullPaymentDate, adjacent invoice numbers: `ROF-I015528` (12/31, Ross, $262,028.85) ↔ `ROF-I015526` (1/1), and `ROF-I015522` (12/31, Heritage Surf Shop, $2,667.65) ↔ `ROF-I015523` (1/1). The **Dec-31 versions are posted**; the Jan-1 twins are NOT in `ar_invoices` (they were header-only, so the 2025 load skipped them) and **must stay excluded — or be CEO-confirmed — at the 2025 verbatim line re-do** to avoid double-counting.

### What the runner does

For each month in the window:

1. Reads `ip_sales_history_wholesale` rows with `invoice_number IS NOT NULL`.
2. Groups by `(invoice_number, txn_date, customer_id)`.
3. Resolves the legacy `ip_customer_master.customer_id` to a `customers` row — by `customer_code`, then by name match. Synthesizes a `code='HIST_<legacy>'` row when nothing matches, logged to `bf_unmatched_customers_log`.
4. Inserts one `ar_invoices` row per group with `invoice_kind='customer_invoice_historical'` + `gl_status='posted_historical'`.
5. Posts a `journal_entries` row with `journal_type='ar_invoice_historical'` — the trigger bypasses the period lock for that journal type (P4-1 wired this).
6. **FIFO is NOT touched.** COGS comes from `unit_cost_at_sale` directly. Lines where that's null are logged to `bf_skipped_cogs_log` and the revenue side still posts.
7. Records per-month progress in `bf_backfill_checkpoint_log`.

Re-runs are idempotent: the `(entity_id, invoice_number)` unique index on `ar_invoices` makes ON CONFLICT skip already-inserted rows.

### Operator workflow

```mermaid
flowchart TD
  A[Paste p4-8-ar-backfill-scaffold.sql in Supabase] --> B[Open Tangerine → AR Backfill]
  B --> C[Set window + leave Dry Run checked]
  C --> D[Click Preview → review summary JSON]
  D --> E{Counts look right?}
  E -- no --> F[Adjust window or fix source data]
  F --> C
  E -- yes --> G[Uncheck Dry Run, confirm prompt, Run]
  G --> H[Inspect Checkpoint log + Reconciliation rows]
  H --> I{Any variance > $0.01?}
  I -- yes --> J[Review unmatched / skipped audits, manual-adjust via JE]
  I -- no --> K[Done — historical AR available in panels]
```

### Reconciliation view

`v_ar_backfill_reconciliation` compares `ip_sales_history_wholesale` source totals to `ar_invoices` (historical) totals per month. Rows where `ABS(variance) > 0.01` need operator review.

```sql
SELECT * FROM v_ar_backfill_reconciliation WHERE ABS(variance) > 0.01;
```

### Payment-side backfill

Historical invoices land with `paid_amount_cents=0`; paid state then flows through the Xoro payment-state pipeline: `ar_xoro_payment_state` (nightly `rest_invoice_sync` push, or a registry-export load like the 2024 backfill) → the daily `ar-receipts-reconcile` cron posts `DR 1051` (factored) / `DR 1030` (house) / `CR` the invoice's AR account at `posting_date = FullPaymentDate` and stamps `paid_amount_cents`.

> **2026-07-10 fix:** receipt JEs previously could NEVER post — the cron tagged them `source_table='ar_invoices'`, which collides with the invoice's own accrual JE under the `uq_je_source_basis` unique index (one JE per `(source_table, source_id, basis)`), so every attempt failed with a duplicate-key error (zero `ar_receipt_xoro` JEs existed). Receipts now post under the provenance token `source_table='ar_receipts'` (same convention as `ap_payment_import`). The Sep–Dec 2024 invoices are receipted; **2025+ historical invoices remain unpaid in the GL until their payment states are loaded** (part of the 2025 verbatim re-do / nightly walk). Note the cron scans the 400 oldest unpaid invoices per run, so a large stateless backlog ahead of newer invoices delays their receipts until the backlog gets states.

### Trigger safety

The bypass is structurally locked to the `*_historical` journal_types — operator UI cannot set `journal_type` directly. The hard-lock on the entity (`posting_locked_through=2024-07-31`) ensures even backfill calls can't push into the pre-Xoro era.

## Customer credit limit + approval gate (P4-7)

Each customer carries a `credit_limit_cents` (canonical) and `credit_limit_currency` (default `USD`). Operator sets these via **Customer Master → edit → Credit limit**. A value of **0 or blank** means *no limit* — the gate never fires.

When posting an AR invoice, the post handler runs **two** approval checks in sequence:

1. **Threshold gate** (kind `ar_invoice`) — fires when an `approval_rules` row with `kind='ar_invoice'` matches the invoice total. Standard M27 rule.
2. **Credit-limit gate** (kind `customer_credit_extension`) — runs *after* the threshold gate clears. Computes the customer's current open AR balance (sum of `total - paid` across `sent` + `partial_paid` + `posted_historical` invoices, excluding the in-flight invoice itself) and checks whether posting this invoice would push the projected balance over `credit_limit_cents`. If breach AND an active rule exists with `kind='customer_credit_extension'`, the invoice flips to `pending_approval` and the request is logged in the M27 panel.

The credit-extension request payload carries the full breakdown so the approver sees the math:

```json
{
  "customer_id": "…",
  "customer_name": "Burlington",
  "invoice_number": "AR-2026-00042",
  "invoice_total_cents": 30000,
  "credit_limit_cents": 100000,
  "current_open_cents": 80000,
  "projected_balance_cents": 110000,
  "breach_amount_cents": 10000
}
```

On approval, the `decide` hook re-runs `postArInvoice` with `fromApprovalHook=true` (skips all gates) so the post proceeds atomically. On rejection, the invoice stays at `pending_approval`; operator either lowers the invoice total, raises the customer's limit, or cancels the draft.

### Opting in

The gate is opt-in: it only fires for customers whose `credit_limit_cents > 0` AND an active `approval_rules` row exists with `kind='customer_credit_extension'`. Seed the rule in **Tangerine → Approvals → Rules → New**:

```
kind          = customer_credit_extension
match         = {}         (matches every breach; tighten later if needed)
steps         = [{ step_order: 1, role_required: "admin", mode: "any" }]
is_active     = true
```

Until that rule exists, the credit-check helper still runs (and the result is logged on the post response as `credit_check`), but no request is created — the post proceeds.

### Sanity check

Set `credit_limit_cents=100000` (= $1,000) on a test customer, create an AR invoice for $1,500, click Post. Expected: HTTP 202, `requires_approval: true`, `approval_request_id` returned, invoice `gl_status='pending_approval'`. Approve via the Approvals panel → re-post fires automatically → `gl_status='sent'` + `accrual_je_id` populated.


---

## Factor (Rosenthal) — monthly statements + open-AR tie-out

> **Factor Module Phase 1 (2026-07-08).** Ring of Fire factors its wholesale AR through **Rosenthal Capital Group** (client #11548). Rosenthal delivers two monthly PDFs: the **CLIENT RECAP** (statement economics) and the **FACTORED AR DETAILED** (month-end open-AR by customer/invoice). This module imports both into Tangerine and proves them against the GL.

**Panel:** Tangerine → Accounting → **Factor (Rosenthal)** (`?m=factor_recon`).

- **Statement grid** — one row per month with Net Sales, Cash Collections, Chargebacks (net, sign as printed — negative means net chargebacks), Commissions, Interest, Fees/Other, Advances, Beginning/Ending Net OAR, Net Due Client, and Total Loans. Export to Excel with the export button.
- **Month drill** — click a month to open the month-end **open-AR detail** grouped by customer (with the Rosenthal customer number), each group showing computed aging buckets as of the report date (Current / 1–15 / 16–30 / 31–60 / 61–90 / Over 90; `O`-type rows are open A/P deductions, e.g. chargeback offsets, and carry negative balances). The footer total ties to the report's Net OAR to the cent.
- **Tie-out strip** — the drill header compares the statement's **Ending Net OAR** against the **GL 1107 (Accounts Receivable - Factor)** cumulative ACCRUAL balance as of month end (via the trial-balance endpoint) and shows the difference. While the AR historical backfill is mid-flight a diff is expected; once factored invoices post to 1107 the diff should trend to $0.

**Importing statements:** drop the Rosenthal PDFs in a folder and run

```
node scripts/import-factor-pdfs.mjs <folder-or-pdf-paths>
```

Both filename vintages are recognized ("CLIENT RECAP 07.2025.pdf" and "Client recap 10.24.pdf"); the statement month always comes from the PDF text. The importer is idempotent (upserts on `statement_month` / `(as_of_date, item_num)`), keeps signs exactly as printed, verifies the OAR rollforward inside each statement, checks month-to-month chain continuity (each beginning Net OAR = prior ending), and asserts Σ item balances = the AR-detail footer Net OAR before reporting the tie-out table. Tables: `factor_statements`, `factor_ar_open_items`, `factor_customers` (Rosenthal number → our customer link).

**The factored-customer directory (Rosenthal numbers → Tangerine customers, 12 of 13 linked):** BEALL`S INC. 111987 · BURLINGTON MERCHANDISING 119432 · D D`S DISCOUNT 133867 · ISLAND LEISURE 676622 · ROSS STORES 211832 · MACY`S BACKSTAGE 683407 (Phase-1 seed), plus (linked 2026-07-10): OCEAN HUT SURF SHOP 405767 → Ocean Hut Surf Shop (CUST-00097) · HILTON WATERFRONT BEACH RESORT 704940 → Hilton TWBR (CUST-00064) · SWFM RETAIL GROUP, LLC 786256 → SWFM Retail Group LLC. (CUST-00154) · DISCOUNT FASHION WAREHOUSE/DFWH INC 680749 → Discount Fashion Wh. (CUST-00032) · VARIETY WHOLESALERS INC 236410 → Variety Wholesalers, Inc. (CUST-00175) · TIENDAS LA GRAN VIA INC 244993 → Tiendas La Gran Via (CUST-00161). The links also stamp `customer_id` on `factor_ar_open_items` and `factor_chargebacks` rows. **Still unlinked (CEO review): MACYS CORPORATE SERVICES 577512** — no "Macy's Corporate" customer record exists and it is distinct from the Macys (CUST-00089) trading account; all 5,777 of its chargeback rows (net −$638,258.67, the Macy's-family chargebacks Rosenthal routes through corporate services) carry `client_customer` to disambiguate Macys / Backstage / MMG.

**Phase 2 (deferred):** monthly factoring-cost JEs (commissions / interest / chargebacks → expense accounts) and per-invoice chargeback dispute tracking (needs the Rosenthal chargeback-detail report).

### Phase 2 — chargeback disputes + factoring-cost JEs (2026-07-09)

**Chargebacks tab** (Factor (Rosenthal) panel → Chargebacks): item-grain rows from the monthly Rosenthal **"Chargeback Report MM.YY.pdf"** ("Charge Back Analysis" section — customer, invoice/deduction ref, item date, C/B date, batch, signed amount). Positive = chargeback (deduction taken by the customer); negative = creditback/recovery. Σ per month ties to the report's **TradeStyle Total**, which equals the recap's chargeback line negated — the importer asserts both. **Reasons** (with Rosenthal's 3-digit reason codes) attach best-effort from the report's CHARGEBACK/CREDITBACK SUMMARY section; Rosenthal merges that section at date grain ("GLOBAL"), so high-volume months resolve fewer per-item reasons — unattributed rows show "—".

**Dispute workflow:** each row carries an editable **status** (New / Under review / Disputed / Accepted / Recovered) and a **notes** field, saved inline (PATCH `/api/internal/factor/chargebacks/:id`). Every status change appends `{at, by, from, to, note}` to the row's `status_history` (updated-by audit trail). Re-importing a month **never** overwrites dispute state. Loaded history: Jul 2025 → Jun 2026 (11 months, 5,928 items; **Feb 2026 report was not provided by Rosenthal**; no chargeback detail exists before Jul 2025).

**Factoring-cost JEs** (`scripts/post-factor-cost-jes.mjs`): one accrual JE per statement month, dated month-end —

```
DR 6802 Factor Commissions Expense    (recap COMMISSIONS)
DR 6804 Factor Interest Expense       (TOTAL INTEREST + PRIOR MONTH INT. ADJ.)
DR 6803 Factor Exp - Other            (facility FEES + OTHER lines only)
CR 1051 Factor Advances - Rosenthal   (the factor charges costs to the loan)
```

The recap's "ACCRUED FEES/OTHER TRANSFERS (FACILITY)" is deliberately NOT posted whole — it contains the **prior** month's interest being charged to the loan (already expensed in its accrual month), so only the facility FEES+OTHER components are new cost. Chargebacks are AR-side and excluded from cost JEs. Idempotent per month (`source_module='factor_recap'`, `source_id=<statement month>`; `uq_je_source_basis` backstop). Posted 2024-10 → 2025-09 (12 JEs, **$515,690.72** total factoring cost). Known exception: Oct-24's facility OTHER is a one-off −$188,930.78 loan credit (not a fee — three orders of magnitude beyond every other month's OTHER) and is excluded from 6803 pending CEO/Rosenthal clarification.

**Statement gaps:** CLIENT RECAP statements Oct 2025 → Jun 2026 have not been provided yet — `factor_statements` (and therefore cost JEs) end at Sep 2025; the AR snapshots and chargeback detail already run through Jun 2026. Re-run `import-factor-pdfs.mjs` + `post-factor-cost-jes.mjs` when the CEO forwards them.
