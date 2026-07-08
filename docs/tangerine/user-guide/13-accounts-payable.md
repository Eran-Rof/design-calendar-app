# 13. Accounts Payable (M3)

The Accounts Payable module records vendor bills, drives them through approval + GL posting, captures payments, and surfaces the payment ledger for accountant review. AP is fully integrated with three P2 cross-cutters: **Approvals** (gate by amount or new-vendor flag), **Notifications** (events fan out to accountant + admin recipients), and **Documents** (attach the vendor's PDF + supporting receipts to each invoice).

Tangerine P3 Chunk 2 (PR #351) ships the admin UI + handlers on top of the P3 Chunk 1 schema (PR #349).

## Panels

| Panel | URL | Who uses it | Writable? |
|---|---|---|---|
| 🧾 **AP Invoices** | `/tangerine` → AP Invoices | Accountant, ops | Yes — full CRUD on drafts; Post / Pay / Void on posted invoices |
| 💸 **AP Payments** | `/tangerine` → AP Payments | Accountant | Read-only ledger of `invoice_payments` |

## Lifecycle

```mermaid
flowchart LR
    Draft["🧾 draft<br/>(edit + delete OK)"]
    PendingApproval["⏳ pending_approval<br/>(awaiting M27 approval)"]
    Posted["✅ posted<br/>(accrual JE live)"]
    Paid["💸 paid<br/>(fully paid)"]
    Void["🚫 void<br/>(reversed JEs)"]

    Draft -->|Post button| PendingApproval
    Draft -->|Post (no rule fires)| Posted
    PendingApproval -->|approver clicks Approve in M27 Inbox| Posted
    PendingApproval -->|approver rejects| Draft
    Posted -->|Pay (partial)| Posted
    Posted -->|Pay (full)| Paid
    Posted -->|Void| Void
    Paid -->|Void| Void
    Draft -->|Void| Void

    style Draft fill:#cbd5e1,color:#0f172a
    style PendingApproval fill:#fed7aa,color:#0f172a
    style Posted fill:#bbf7d0,color:#0f172a
    style Paid fill:#86efac,color:#0f172a
    style Void fill:#fecaca,color:#0f172a
```

## Creating an AP invoice (draft)

From the **AP Invoices** panel, click **+ New invoice**.

| Field | Required? | Notes |
|---|---|---|
| Vendor | yes | Sourced from M35 Vendor Master (must already exist) |
| Invoice number | yes | The vendor's number; must be unique per (entity, vendor) |
| Kind | yes | `vendor_bill` / `vendor_credit_memo` / `expense_report` |
| Posting date | yes | The date the GL JE will land on (must be inside an open period at posting time) |
| Due date | optional | Defaults to posting date if blank — set explicitly per vendor terms |
| Payment terms | optional | **Auto-fills from the vendor master's `payment_terms_id`** when you pick a vendor. On a new invoice the vendor's preset is adopted; on an existing invoice it only fills if the field is still empty (an explicit edit is never clobbered). Pick from the M-Payment-Terms master or leave `(none)`. |
| Default expense account | optional | Used when a line has no per-line override (also auto-fills from the vendor master) |
| AP account | optional | Defaults to `entities.default_ap_account_id` (code `2010`) (also auto-fills from the vendor master) |
| Description | optional | Free text |
| Lines (≥ 1) | yes | Mix of expense lines and inventory lines |

### Line types

**Expense line:** `expense_account_id` + `amount_cents` (dollars in the UI, stored as cents).

**Inventory line:** `inventory_item_id` + `quantity` + `unit_cost_cents` (unit cost in dollars in the UI). At post time, inventory lines feed M5 FIFO layer creation (wired in P3-4 — until then they post against the default inventory GL account `1310`).

The trigger `invoice_line_items_total_trg` (from P3-1) recomputes `invoices.total_amount_cents` after every line insert / update / delete. The UI shows a running total under the lines table.

### ☰ List / ▦ Matrix view

The Lines section has a **☰ List / ▦ Matrix** toggle. **List** is the editable default (mix of expense + inventory lines). **Matrix** shows the **inventory** lines as a read-only **color × size grid** (rows = color, columns = size, with row/column totals) by resolving each inventory line's item id to its SKU's color/size — useful for checking the size breakdown of a goods bill against the PO. **Expense lines** (and any inventory item missing a color/size) can't go in the grid; they're listed under a **"Non-matrix lines"** section beneath the matrix.

## Posting — Approval gate

Click **Post** on a draft row. The handler:

1. Calls `approvalsAPI.requestIfRequired({ kind: 'ap_invoice', amount_cents: total, payload: { vendor_new } })`.
2. If a rule matches (e.g. amount > $5k, or new vendor):
   - Sets `gl_status='pending_approval'`.
   - Fires the `ap_invoice_approval_requested` notification to the **admin** role.
   - Returns `202 { requires_approval: true, approval_request_id }`.
   - The accountant + admin see the row in the **Approval Inbox** panel and decide.
3. If no rule matches: continues directly to step 4.
4. Calls `postEvent({ kind: 'ap_invoice_received' })` — the posting service produces the accrual JE (DR expense / inventory; CR AP control). No cash JE at receipt — cash basis recognizes the expense at payment time.
5. Sets `gl_status='posted'` and stamps `accrual_je_id`.
6. Fires the `ap_invoice_posted` notification to **accountant + admin**.

When the approver clicks **Approve** in the **Approval Inbox**, the M27 `decide` handler (P2 Chunk 2) re-runs the post path automatically via the side-effect hook in `approval-requests/decide.js`. The invoice flips from `pending_approval` to `posted` in one round trip.

## Recording a payment

Click **Pay** on a posted row. The Pay sub-modal collects:

| Field | Required | Notes |
|---|---|---|
| Payment date | yes | YYYY-MM-DD |
| Amount $ | yes | Defaults to outstanding balance; partial pays are OK |
| Method | yes | `ach` / `wire` / `check` / `credit_card` / `cash` |
| Bank account | optional | Defaults to `entities.default_bank_account_id` (code `1010`) |
| Reference | optional | Check number, wire confirm, card auth |
| Notes | optional | Free text |

The handler:

1. Inserts a row in `invoice_payments`. The DB overpay trigger (`invoice_payments_overpay_guard_trg` from P3-1) blocks `paid + new > total` with a check-violation → 409 surfaces as "Overpayment rejected".
2. Calls `postEvent({ kind: 'ap_invoice_paid' })` — posts the accrual JE (DR AP / CR Bank) **and** the sibling cash JE (DR Expense / CR Bank) linked via `gl_link_sibling_je`.
3. Stamps `invoice_payments.cash_je_id`. If this payment fully covers the invoice, flips `invoices.gl_status='paid'`.
4. Fires the `ap_invoice_paid` notification.

After payment, the payment row is visible in the **AP Payments** ledger.

## Voiding

Click **Void** on any non-void row. The handler:

1. Calls `postEvent({ kind: 'ap_invoice_voided' })`. The `apInvoiceVoided` rule (from P3-1) returns either an empty reversal list (for never-posted invoices) or `[accrual_je_id, cash_je_id?]` for posted/paid invoices.
2. Reverses each JE via `reverseJournalEntry` (creates a new reversing JE; flips the original to `status='reversed'`).
3. Flips `invoices.gl_status='void'` regardless.
4. Fires the `ap_invoice_voided` notification.

Voids are non-destructive — the original JEs stay in the GL with `status='reversed'`, and the reversing JEs net them to zero. The invoice row is preserved (you can re-open the modal in read-only mode to see lines + linked JEs).

> **Frozen Save/Close footer.** The AP Invoice edit modal keeps its **Save / Close** (and **Record payment**) buttons pinned to the bottom as the modal scrolls, so they stay reachable on tall invoices with many lines + attachments. Same behaviour across the AR Receipts, Journal Entry, Receiving, QC Inspection, Cycle Count and Customs Entry modals.

## Document attachments

Inside the AP Invoice edit modal, the **Supporting documents** section embeds `<DocumentAttachmentList>` (M29) scoped to `contextTable='invoices'` and the invoice's id. Supported kinds:

- `vendor_invoice_pdf` — the vendor's actual bill
- `receipt`           — receipts for expense lines
- `approval_correspondence` — emails about the approval decision
- `other`             — anything else

Files upload to the `tangerine-documents` Supabase storage bucket. Signed URLs are 5-minute expiring; never linkable directly.

## API surface (for integrations)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/internal/ap-invoices` | List with filters: `?status=`, `?vendor_id=`, `?from=`, `?to=`, `?q=`, `?include_void=` |
| POST | `/api/internal/ap-invoices` | Create a draft |
| GET  | `/api/internal/ap-invoices/:id` | Single + lines |
| PATCH | `/api/internal/ap-invoices/:id` | Edit (draft / unposted only) |
| DELETE | `/api/internal/ap-invoices/:id` | Delete (draft / unposted only) |
| POST | `/api/internal/ap-invoices/:id/post` | Promote to posted (or pending_approval) |
| POST | `/api/internal/ap-invoices/:id/pay` | Record a payment |
| POST | `/api/internal/ap-invoices/:id/void` | Void + reverse JEs |
| GET  | `/api/internal/ap-payments` | Read-only ledger |
| POST | `/api/ap/sync-bills` | Bulk ingest of real Xoro vendor bills (CSV) — see below |

Money is in BigInt cents on the wire. The UI converts dollars ↔ cents at the form boundary.

## Xoro real-bill feed (`source='xoro_ap'`)

While Xoro remains the system of record (pre-Tangerine go-live), the actual posted vendor bills flow in automatically from Xoro's `bill/getbill` endpoint. The nightly `rof_xoro_project/scripts/rest_ap_sync.py` downloads the bills and POSTs the gzipped `BillDetail*.csv` to **`POST /api/ap/sync-bills`** (multipart field `bills`, `design-calendar-api` Bearer token — same upload shape as `/api/master/sync`). Each bill lands as one `invoices` row (`source='xoro_ap'`, `invoice_kind='vendor_bill'`) plus its `invoice_line_items`.

**Supersede rule.** These real bills are authoritative. On a `(vendor_id, invoice_number)` collision:

| Existing `source` | Action |
|---|---|
| `manual` (or any non-xoro source) | **Skipped** — an operator-typed bill is never overwritten |
| `xoro_mirror` (T10 PO-derived synthetic) | **Updated in place** — the real bill supersedes the mirror-derived one |
| `xoro_ap` | **Updated in place** — idempotent re-sync |

Vendors are matched by **Vendor Name** against `vendors.code` / `vendors.aliases` (the CSV "Vendor Code" is the Xoro internal id and does not map); unmatched vendors are skipped and returned in the response so the operator can add a vendor or alias. At Tangerine go-live, native AP entry takes over and this feed is retired.

### Per-bill GL posting (2026-07-08)

Every synced Xoro bill now posts its own journal entry — this replaced the old daily AP summary, which had **never successfully posted** (it credited the AP control account without a vendor subledger, so the posting guard rejected it every night; found and confirmed during the July 8 re-rate). The per-bill JE:

- **DR 1201 Inventory** for item-linked lines (purchases build inventory; the per-invoice sales history posts the COGS that relieves it),
- **DR 8007 Uncategorized Expense** for non-item lines plus the tax/rounding remainder (re-route from the JE as needed — nothing silently disappears). If the vendor has a **default expense account** set (Vendor Master → `default_gl_expense_account_id`), that account is used for this line instead of 8007 (the account must exist, be postable, active, and non-control — otherwise the sweep falls back to 8007),
- **CR 2000 Accounts Payable** for the bill total, **subledgered to the vendor** — so the AP control account ties out to the bill ledger by construction. Credit memos post with the directions flipped.

The sweep runs automatically at the end of every `POST /api/ap/sync-bills` ingest and can be run by hand via **`POST /api/internal/ap-backfill/run`** `{ dry_run?: true, limit? }` (internal token; idempotent — only `gl_status='unposted'` bills are touched, and a duplicate post heals the bill row instead of erroring). Posted bills get `gl_status='posted'` + `accrual_je_id`, which lights up the status badge → JE drill in the AP Invoices panel. `journal_type='ap_invoice_historical'` rides the period-lock bypass so older bills backfill cleanly. **Not yet covered:** payment-side JEs (the CSV carries only a paid/unpaid status, no payment dates or amounts) — cash application for Xoro bills is a follow-up alongside the bank-feed work.

## Sub-decisions defaults (P3-1 → P3-2)

Per arch §11:

| Default | Code | Where stored |
|---|---|---|
| AP control account | `2010` | `entities.default_ap_account_id` (auto-seeded if `gl_accounts.code='2010'` exists) |
| Bank account | `1010` | `entities.default_bank_account_id` (auto-seeded if `gl_accounts.code='1010'` exists) |
| Inventory GL (for inventory lines at post time) | `1310` | Looked up by code at post time |
| Fallback expense account (cash-basis JE) | `6000` | Looked up by code at pay time when invoice/line has no expense_account_id |

If any of these GL accounts don't exist yet, the relevant handler returns a 400 with a clear message ("seed gl_accounts.code='1310'") so the accountant can create the row in the COA panel first.

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `Cannot edit invoice in gl_status='posted'` | PATCH attempted on a non-draft invoice | Use Void or post a credit-memo |
| `Cannot delete invoice in gl_status='posted'` | DELETE only allowed on draft | Use Void |
| `Overpayment rejected: paid X + new Y > total Z` | Pay would exceed total | Reduce amount or check existing payments |
| `Approvals gate failed: missing_kind` | requestIfRequired called with bad ctx | Bug — file an issue |
| `AP account is not configured` | No `ap_account_id` on invoice and no `default_ap_account_id` on entity | Set on invoice or seed entity default + `gl_accounts.code='2010'` |
| `Inventory has lines but no inventory GL account is configured` | Inventory line at post time and no `gl_accounts.code='1310'` | Create the inventory account in COA panel |

## Notifications fired

| Kind | When | Recipients (roles) |
|---|---|---|
| `ap_invoice_approval_requested` | Approval rule matches at Post | admin |
| `ap_invoice_posted` | After successful GL post | accountant, admin |
| `ap_invoice_paid` | After payment row + JE post | accountant, admin |
| `ap_invoice_voided` | After void completes | accountant, admin |

Recipients can opt out per (kind, channel) via the **Notification preferences** panel.

## Source files

- `api/_handlers/internal/ap-invoices/index.js` — list + create draft
- `api/_handlers/internal/ap-invoices/[id].js` — get / patch / delete
- `api/_handlers/internal/ap-invoices/post.js` — promote to posted + approval gate
- `api/_handlers/internal/ap-invoices/pay.js` — record payment + cash JE
- `api/_handlers/internal/ap-invoices/void.js` — void + reverse
- `api/_handlers/internal/ap-payments/index.js` — read-only ledger
- `src/tanda/InternalAPInvoices.tsx` — list panel + add/edit modal + pay sub-modal
- `src/tanda/InternalAPPayments.tsx` — read-only ledger panel
- `api/_lib/accounting/posting/rules/apInvoiceReceived.js` — posting rule (P3-1)
- `api/_lib/accounting/posting/rules/apInvoicePaid.js` — payment rule (P3-1)
- `api/_lib/accounting/posting/rules/apInvoiceVoided.js` — void/reverse rule (P3-1)
- `api/_handlers/ap/sync-bills.js` — Xoro real-bill ingest (`source='xoro_ap'`, supersede)
- `api/_lib/ap-bill-sync.js` — pure CSV→bill parsing/mapping core (+ `__tests__/ap-bill-sync.test.js`)
