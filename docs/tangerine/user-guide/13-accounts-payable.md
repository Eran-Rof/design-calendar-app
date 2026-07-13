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
- **DR the bill line's own Xoro GL account** (#xoro-account-truth, 2026-07-11) for non-item lines whose `Expense Account` resolved to a ROF account at ingest — one JE line per distinct account. Precedence for the expense side: **bill line's Xoro account → vendor default expense account → 8007**,
- **DR 8007 Uncategorized Expense** for unresolved non-item lines plus the tax/rounding remainder (re-route from the JE as needed — nothing silently disappears). If the vendor has a **default expense account** set (Vendor Master → `default_gl_expense_account_id`), that account is used for this line instead of 8007 (the account must exist, be postable, active, and non-control — otherwise the sweep falls back to 8007),
- **CR 2000 Accounts Payable** for the bill total, **subledgered to the vendor** — so the AP control account ties out to the bill ledger by construction. Credit memos post with the directions flipped.

The sweep runs automatically at the end of every `POST /api/ap/sync-bills` ingest and can be run by hand via **`POST /api/internal/ap-backfill/run`** `{ dry_run?: true, limit? }` (internal token; idempotent — only `gl_status='unposted'` bills are touched, and a duplicate post heals the bill row instead of erroring). Posted bills get `gl_status='posted'` + `accrual_je_id`, which lights up the status badge → JE drill in the AP Invoices panel. `journal_type='ap_invoice_historical'` rides the period-lock bypass so older bills backfill cleanly. **Not yet covered:** payment-side JEs (the CSV carries only a paid/unpaid status, no payment dates or amounts) — cash application for Xoro bills is a follow-up alongside the bank-feed work.

### 8007 Uncategorized Expense cleanup — vendor default expense accounts (2026-07-10)

Historically ~$8.88M of non-item bill charges landed in **8007 Uncategorized Expense** (the fallback above), so the P&L showed one lump instead of real expense categories. The cleanup has two halves:

1. **Go-forward** (already live since #1666): set the vendor's **Default expense account** in Vendor Master (Edit → "Default expense account", shown as "code — name"). Every future bill's non-item/tax slice posts there instead of 8007.
2. **History**: `node scripts/reclass-8007.mjs` reclasses what already sits in 8007, one JE per **(vendor, month)** — `DR` the vendor's default expense account / `CR 8007` for that month's 8007 activity, **dated to the source month** (month-end; the in-flight current month uses its latest source-line date). Phases: `report` (read-only shape + writes the review CSV), `set-defaults` (applies the HIGH-confidence name→account mapping, never overwriting an operator-set default), `reclass`, `verify`. All phases support `--dry-run`.

Posting hygiene: `journal_type='vendor_expense_reclass'` (or `'vendor_inventory_reclass'` for CEO-confirmed inventory vendors — see below), `source_module='ap'`, `source_table='vendor_expense_reclass'`, `source_id='<vendor_id>:<YYYY-MM>'` (the source-key unique index makes re-runs idempotent), audit reason on every JE. **The reclass never touches AP 2000** — `verify` counts reclass lines on 2000 and requires zero.

**What was moved:**

- **First run (2026-07-10, #1675):** 523 JEs, **$5,224,663.22** into 39 real expense accounts across 70 vendors. 8007 $8,875,418.82 → $3,650,755.60.
- **Rosenthal decision (2026-07-10, #1679):** CEO ruled the controller-reconciled Xoro AP bills are the factoring-cost source of truth; the 12 statement-derived #1670 `factor_cost` JEs ($515,690.72) were deleted, Rosenthal's default was set to **6802 Factor Commissions**, and its **$859,158.88** swept out of 8007 (21 JEs). The script's Rosenthal exclusion is lifted.
- **CEO-authorized auto-set expansion + Factory 1 inventory (2026-07-10):** 145 more vendor defaults set from name classification ("auto set the vendor expense accounts for the vendors you have bills for"), and **Factory 1 confirmed as inventory** — its **$623,414.04** reclassed **DR 1201 Inventory / CR 8007** (17 monthly JEs, `journal_type='vendor_inventory_reclass'`; rationale: those goods' sales already relieved 1201 via the AR COGS legs at average cost, so the missing purchase-side DR understated inventory). This run: 576 new JEs, **$1,401,163.16**. **8007 now $1,390,433.56.** Verified: trial-balance imbalance $0.00, 1,120/1,120 reclass JEs balanced, 0 reclass lines on 2000.

- **Vendor deposits (2026-07-10):** the CEO flagged that some confirm-list entries "look like prepayments prior to receiving the invoice." Register evidence was probed for every suspect (round amounts, cash-paid-in-full, vendor bill ref = the payment date, no absorbing invoice, and the register's `prepayments`/`credits` relief columns). Findings and treatment:
  - **OPEN deposits → 1308 Vendor Prepayments & Deposits (asset).** United Aryan $80,000.00 (paid 2025-12-05) and The Luxury Collection $25,000.00 (paid 2026-02-25) reclassed **DR 1308 / CR 8007** (`journal_type='vendor_prepayment_reclass'`, `PREPAYMENT_OPEN` script tier). They sit in 1308 until the merchandise invoice arrives and the controller applies them — worklist in **`docs/tangerine/ap-vendor-deposits.csv`**. (No new COA account needed: 1308 already exists from #1668, postable + non-control.)
  - **APPLIED deposits — no double-count, nothing to fix.** CNX America's two big bills are the GOODS invoices, not deposits: B005513 $209,690.17 absorbed a $25,000 deposit and B005662 $136,913.72 was fully deposit-settled — and the #1668 relief JEs already **CR'd 1308** for exactly those applications ($25,000 + $136,913.72 verified on prod), so the invoice's 8007 DR carries the goods cost exactly once. The deposit wires themselves live in 1308's pre-existing clearing balance, not in AP.
  - **NET-ZERO rows (not posted):** Dynamic Full $40,000.00, Anhui Taihe $14,012.64, NEXT ELEVATION $79,083.30 (2 of its 3 bills), Mass Apparel $0.70 were fully settled by vendor credits/discounts — their 8007 DR is exactly offset by the same bill's relief CR to 5005, so net P&L is already zero. Whether the "credit" was a true credit (no cost) or a deposit application Xoro recorded as a credit (cost real) is a controller call — flagged in the review CSV, never auto-posted.
  - **Go-forward:** deposit-looking bills in the nightly feed carry no reliable marker (no description, ref = date is a weak signal), so deposit routing to 1308 stays a **manual** step — do NOT set a goods vendor's default to 1308, or its real invoices would auto-route to the asset account.

**What remains in 8007 — $1,285,433.56** (see `docs/tangerine/ap-8007-review.csv` — vendor, monthly totals, suggested account, reason):

- **INVENTORY? $731,701.24 (8 vendors)** — goods-supplier vendors awaiting the CEO's confirm list, now with per-bill register evidence in the CSV (CNX America $355k, Interland $223k, NEXT ELEVATION $103k — $79k of which is net-zero, 2253 Apparel $43k, + tail). Once confirmed, add the name to `INVENTORY_CONFIRMED` in the script and re-run `reclass` — they post DR 1201 like Factory 1. **Never auto-posted without confirmation.**
- **FLAG $496,050.43 (11 vendors)** — related-party / financing rows that may be distributions or loan principal, not P&L: Venbrook $243k (broker — policy split needed), Bitton & Associates $80k, Isaac Bitton $60k, SBA $51k (principal vs 6342 interest), FTB $40k (CPA call), Tao Rodriguez/Maria Villarreal $7k, Valley Bank $4.6k, three life-insurance carriers $10.8k (possible officer life).
- **NET-ZERO $54,013.34 (3 vendors)** — credit/discount-settled bills whose P&L effect already nets to zero against 5005 (see above).
- **LOW $3,668.55 (9 vendors)** — genuinely zero-signal names (IDC, RMS, Daughter Santiago, …).

To finish the cleanup: for expense vendors, set the default in Vendor Master and re-run `node scripts/reclass-8007.mjs reclass` (it picks up **any** vendor with a validated default and posts only the missing (vendor, month) JEs); for inventory vendors, get CEO confirmation and extend `INVENTORY_CONFIRMED`; for deposit applications and the net-zero rows, controller works `ap-vendor-deposits.csv` and the CSV flags.

### Xoro account truth (#xoro-account-truth, 2026-07-11)

**CEO directive (NON-NEG): Xoro's GL is the 100% source of truth for bill classifications — nothing posts from name/pattern heuristics.** One confirmed heuristic error motivated this: The Luxury Collection's $25,000, posted as a vendor deposit (1308) by the name-evidence tier, is per Xoro's GL an auto-lease payment (**6327 Equipment Rental**) — corrected by a JE dated 2026-02-28 (PR #1685).

The pipeline:

1. **Feed** — the nightly `rest_ap_sync.py` (rof_xoro_project) now emits an **`Expense Account`** column (the Xoro GL account path on each bill line, e.g. `5006 General and Administrative:Logistics Warehouse Expense`) and an **`Item Type`** column (`Inventory` = Xoro posts the line to the inventory asset). A `--full-history` mode walks every bill — `bill/getbill` hides paid bills by default; the walk covers status `Open` + `Paid` + `Partially Paid`.
2. **Ingest** — `/api/ap/sync-bills` stores the name verbatim (`invoice_line_items.xoro_expense_account_name`, `xoro_item_type`; header-grain single-name on `invoices.xoro_expense_account_name`) and resolves it to `expense_account_id` via `api/_lib/accounting/xoroAccountMap.js`: **exact, case-insensitive matching on the path's leaf name** (plus the curated `XORO_TO_ROF_CODE` dictionary for differently-worded names like `Rental Equipment` → 6327). **No fuzzy matching** — unresolved names stay name-only and are tallied for the mapping table. Bills from the #1668 register backfill are **enriched in place** (lines + account stamps only; the register header amounts that tie GL 2000 to the cent are never touched).
3. **Go-forward posting** — the AP sweep prefers the bill's own resolved Xoro account over the vendor default (precedence above), so new bills classify themselves.
4. **Recon** — `node scripts/reclass-8007.mjs xoro-verify [--dry-run]` compares every (vendor, month) 8007-origin bucket against the line evidence and buckets the money: **MATCH** (Xoro agrees with the posted placement), **DIFF** (Xoro says a different resolvable account — a correction JE `DR correct / CR wrong` posts, dated to the source month, `source_id '<vendor_id>:<YYYY-MM>:xoro-correction'`), **UNMAPPED** (Xoro name with no ROF COA equivalent — written to `docs/tangerine/xoro-account-name-map.csv` for the CEO; never posted), **NO-SIGNAL** (Xoro's REST API returns header-only data for "expense bills" — no line, no account — so no truth is reachable; stays put and is reported). FLAG (related-party/financing) and NET-ZERO vendors are always report-only. Bucket-grain results land in `docs/tangerine/ap-xoro-verify.csv`.

**Known API limits (probed 2026-07-11):** `bill/getbill` needs `status=Paid` to see paid bills (36 pages vs 2); `bill_number=<n>` fetches a single bill regardless of status; Xoro "expense bills" (e.g. the GPA Logistics API-created bills, United Aryan's $80k deposit bill ROF-B005300) return **no line arrays and no header expense account** on this key — their Xoro classification is unreachable via REST and needs the Xoro UI/GL report. GL/journal REST endpoints do not exist under this key's scope.

**Backfill + recon results (2026-07-11 full-history run):**

- **Coverage:** 3,714 bills walked (Open 2 pages + Paid 36 + Partially Paid 1), 19 chunked POSTs; **3,661 / 3,680 register bills enriched** (19 unreached: unresolvable vendors like LACHMIS INTERNATIONAL + bills absent from `getbill`). 1,092 of 3,720 bills (29.4%) carry line evidence; 26,177 lines are Inventory-typed; 723 lines carry an account name, **610 resolved exactly (84%)** — the ONLY unresolved name in the whole book is **`Other Miscellaneous Expense`** (113 lines, $3,155,886.66), which is Xoro's own catch-all: Xoro provides no better category, so it is a CEO mapping decision (see `docs/tangerine/xoro-account-name-map.csv`), never auto-posted.
- **8007-origin verification (the "how much did we guess wrong" answer):** of the $8.88M 8007-origin book — **MATCH $883,412.66** (Xoro agrees with the name-heuristic placement), **DIFF $949,801.59** (Xoro says a different account — **47 correction JEs posted**, `source_id '<vendor>:<ym>:xoro-correction'`), **UNMAPPED $234,557.56** (the misc catch-all above), **NO-SIGNAL $6,807,647.01** (header-only expense bills — REST exposes no truth; stays put and stays flagged). After corrections the re-run converges: **DIFF $0.00, MATCH $1,833,214.25**.
- **What the corrections moved (net):** 6343 Inventory Adjustments Expense −$813,627.40 → **1201 Inventory +$830,896.61** (Guangzhou Blue Denim $543.7k, Fashion Design $105.4k, Ricowell $56k, Zhejiang Newdan $68.7k, JMG, Access 3898, Bandl — their Xoro lines are Inventory-typed, i.e. Xoro itself posts them to the inventory asset); 5405 Shipping −$32,052.28 → **5403 Freight Out $56,060.90 + 5402 Freight In $522.58** (FedEx/UPS out/in splits); 6718 Website Hosting → **6705 Shopify Transaction Charges $25,484.68**; 6130 Contractors → **6723 Website Ad Creation $9,400.97** (Freelancer) + 5020 Manufacturing Expense Clearing; 6374 → **5023 Ross Price Tickets $2,337.47** (Fineline); **8007 −$41,914.75** (2253 Apparel $39,114.75 + Interland $2,800 → 1201 — the Xoro line evidence IS the inventory confirmation the CEO was going to give by hand).
- **Inventory-suspect vendors:** 2253 Apparel and Interland confirmed inventory by Xoro line evidence for the months that have lines (posted). CNX America's big bills (B005513/B005662) are **header-only via REST** — no line evidence, stay INVENTORY? pending. Same for the FLAG related-party rows (Bitton, SBA, FTB, Venbrook — all header-only, no evidence, nothing posted).
- **Vendor deposits:** United Aryan ROF-B005300 is header-only via REST — the account Xoro posts it to is NOT exposed on this key; stays **PENDING XORO VERIFICATION** in 1308 (needs the Xoro UI/GL check that Luxury got). The Luxury Collection's 6327 correction stands (no contradicting REST evidence; bucket verified at 6327).
- **8007 residual: $1,285,433.56 → $1,243,518.81.** GL invariants after everything: trial-balance imbalance $0.00, GL 2000 $10,061,433.54 unchanged, 0 reclass/correction lines on 2000, **1,170/1,170 reclass-family JEs balanced**.

### Xoro GL transaction mirror (#xoro-gl-truth, 2026-07-12)

**The finale of the account-truth work.** `bill/getbill` returns Xoro "expense bills" **header-only** (no lines, no account), which left **$6.81M of the 8007-origin book NO-SIGNAL** in `xoro-verify` — REST could not reach those bills' classification. Xoro's dedicated GL endpoint solves it: **`accounting/getgltransactions`** (a new private app key, scope **"GL Details"**, keyring service `xoro-api-gl-details`) exposes the **actual posted GL legs of every transaction** — so every bill's expense/asset distribution is visible, header-only or not. This is the 100% truth source the CEO demanded.

**Mirror table `xoro_gl_transactions`** (migration `20260978000000`) — one row per posted GL leg, upserted **delete-then-insert per `TxnId`** (no field combination is unique; a transaction is the atomic unit), with a per-txn `row_seq` ordinal and `deletedTxnNumbers` handling. Full history 2024-08-01 → today ≈ **101,000 transactions**.

Endpoint facts worth knowing:

- **page_size max is 100**, and **pagination is per-transaction, not per-row**: each page returns ALL GL rows for its ≤100 transactions, so rows-per-page varies wildly (637–4,401 observed). `TotalPages = ceil(distinct_txns / page_size)`.
- **Debit/credit convention:** `Amount` / `AmountHomeCurrency` is a single **SIGNED** number per leg — **positive = debit, negative = credit** — and every transaction nets to **$0.00** in home currency. Worked example: Bill ROF-B006546 (Venbrook) posts `+12,742.09` to Rent Expense (debit) and `−12,742.09` to Accounts Payable (credit the 2000 control).

**Pipeline:**

1. **Feed** — `rof_xoro_project/scripts/rest_gl_sync.py` walks the endpoint in **monthly windows** with a resumable **per-window checkpoint** (`.launchd-logs/gl_sync_checkpoint.json`; a crash re-runs only the incomplete window). Modes: nightly increment (today−3d → today; wired into `run_daily`), `--full-history` (the one-off backfill), and `--ref-numbers` (targeted pre-load of specific bills). Rows POST to `/api/xoro/sync-gl` as gzipped JSON.
2. **Ingest** — `/api/xoro/sync-gl` (design-calendar Bearer auth, like `/api/ap/sync-bills`) groups by `TxnId`, deletes the existing rows for those txns, and bulk-inserts the fresh set (raw payload retained in a `raw` jsonb column). Idempotent.
3. **Recon** — `node scripts/reclass-8007.mjs gl-verify [--dry-run]` recons every (vendor, month) 8007-origin bucket against the GL-mirror truth: for each bill it reads the mirror's **debit legs** (`amount_home > 0`, excluding the AP control credit) for the bill's `RefNumber`, resolves each `accounting_name` via `xoroAccountMap.js`, and buckets the money **MATCH / DIFF (`:gl-correction` JEs, DR correct / CR current holder, dated to the source month) / UNMAPPED (`docs/tangerine/xoro-gl-account-name-map.csv`) / NO-SIGNAL (bill absent from the GL mirror)**. Because only debit legs are evidence, **no correction line can ever touch 2000**. Round-2 results append to `docs/tangerine/ap-xoro-verify.csv`; FLAG/NET-ZERO buckets stay report-only.

## Historical bill backfill (`source='xoro_bills_register'`, #1668)

The complete Xoro AP history — **3,680 bills (Oct 2023 → Jul 2026, $51,080,712.61)** from the CEO's Bills register export plus **2,685 bill payments ($41,126,644.78)** from the Payments export — is posted to the GL and frozen as the AP opening history. AP control account **2000 ties to the register to the cent**: GL 2000 = **$9,947,831.51 CR** = the register's Σ Amount Due over Open/Partially-Paid bills.

**Pipeline** (all idempotent — every JE carries a stable `(source_table, source_id, basis)` key):

1. `node scripts/import-bills-register.mjs <register.csv> [--create-vendors]` — parses the export (BOM, `"$ 1,234.19"` money, `-`-as-empty, MM/DD/YYYY) into staging table `ap_bill_register_import`, verifying the register identity on every row: `Total = Paid + Discounts + Credits + Due` (and `Credits = Vendor Credits + Prepayments`). Vendors resolve by payments-staging name → `vendors.name` → `vendors.aliases` (all case-insensitive).
2. `node scripts/post-bills-register.mjs <phase>` with phases `reconcile → link-invoices → accruals → deltas → relief → payments → residuals → verify` (each supports `--dry-run` / `--limit=N`).

**Accounting model:**

| JE | Lines | Date |
|---|---|---|
| Accrual (`ap_invoice_historical`, one per bill) | DR **1201 Inventory** (Vendor Type Suppliers/Manufacturer) or the vendor's default expense account, else **8007** · CR **2000** vendor-subledgered @ Total Amount | Bill Date |
| Relief (`ap_relief_historical`, bills with discounts/credits) | DR **2000** (vendor) · CR **5005 Vendor Discount** (discounts + vendor credits) · CR **1308 Vendor Prepayments & Deposits** (prepayments applied) | bill Modified date (application-date proxy) |
| Payment (`ap_payment_historical`, one per payment doc) | DR **2000** (vendor) · CR the mapped payment account @ **Paid Amount** (cash only) | Payment date |
| Residual / true-ups (`ap_adjustment_historical`) | DR/CR **2000** (vendor) vs **8002** / DR-account | export date / bill date |

**Key decisions (and why):**

- **Cutover 2024-08-31, no opening JE**: no opening-balance JE exists for 2000 and no GL periods exist before 2024-08 (entity hard-lock 2024-07-31), so the **58 bills dated before 2024-08-31 post AT 2024-08-31**; all were fully paid, and their payments ARE in the payments export, so they accrue + relieve normally rather than being skipped. The 108 bills dated exactly 08/31/2024 (dsantiago's Feb-2025 opening-AP backfills) accrue normally — they ARE the opening AP.
- **Payments are cash-only**: the two exports prove Σ(payment `Amount` − `Paid Amount`) = Σ(bills discounts + credits + prepayments applied) **to the cent ($6,229,033.16)** — a payment doc's non-cash slice is exactly the discount/credit/prepayment application. Those post at **bill** level (the register carries the precise 5005-vs-1308 split), and the **133 zero-cash payment docs get no JE**. Crediting banks at full `Amount` would have overstated cash out by $6.23M.
- **1308 Vendor Prepayments & Deposits** (new account, child of 1300 Deposits & Prepaid) carries a **CR $5,062,725.55 clearing balance**: prepayments applied to bills whose original deposit wires predate the GL's bank-cash history. When bank history is backfilled, deposit wires book DR 1308 and the account clears.
- **Xoro→Valley account mapping**: "Bank Leumi" payment accounts map to Valley 1001/1002/1003 (Leumi has no GL accounts of its own); other payment accounts map to 1020 Cash Clearing, 1051 Factor Advances, 2101–2108 credit cards, 3004 Opening Balance Equity — mapping fixed in `ap_payment_import.gl_account_id`.
- **Dedupe vs #1662**: 145 bills already carried per-bill accrual JEs from the Xoro API pull — skipped (`skip_reason='already_posted_1662'`). 24 of them were posted at the API line-sum, not the register header total — trued-up by delta JEs (net −$57,445.72) and the invoice totals aligned, so GL = subledger = register.
- **Frozen from the nightly sync**: register bills land in `invoices` with `source='xoro_bills_register'`, which `sync-bills` treats as foreign and never updates — the AP subledger stays exactly what the register said on 2026-07-08, which is what the GL ties to. Post-export Xoro activity (new bills, new payments) is NOT reflected until a re-export or cutover; new bills syncing in as `xoro_ap` still accrue via the #1662 sweep, but Xoro marking bills paid without Tangerine payment JEs will surface as tie-out drift. Re-import fresh exports at cutover (~2026-07-28) — the **AP AmountPaid delta watcher** (next section) then posts the increments automatically.
- **Porsche residual $6,236.32**: the register says $6,236.32 more was paid on Porsche bills than the payments export applied (payments outside the export) — one per-vendor adjustment JE (DR 2000 / CR 8002 Reconciliation Discrepancies).
- **Control alignment**: a hanging DR $500 from a dry-run-test reversal pair (original excluded as `status='reversed'` while its reversal stayed posted) was neutralized by restoring the original to `posted`; $2,172.00 of `manufacture_service` credits sitting on 2000 with **no vendor bill** — dual-basis siblings, $1,086.00 ACCRUAL + $1,086.00 CASH — were reclassed to 2160 Accrued CMT / Conversion Clearing per basis (2000 is reserved for the vendor-bill subledger the daily tie-out proves; CASH-basis 2000 correctly ends at $0.00).

**Result**: 3,534 accrual JEs + 24 true-ups + 257 relief JEs + 2,552 payment JEs + 1 residual + 3 alignment JEs; the #1665 daily tie-out's AP `pending_payments` waiver lifts (payments now exist) and AP 2000 reports **ok** — GL $9,947,831.51 CR vs subledger $9,947,831.51, diff $0.00, and every top-10 vendor subledger balance matches the register exactly.

## AP AmountPaid delta watcher (nightly 06:30 UTC)

The go-forward guard for the backfill above: bills already imported keep getting paid in Xoro, and without a watcher those `AmountPaid` changes never reach Tangerine — GL 2000 silently drifts off the register.

**Feed mode — register-comparison.** The live nightly bill feed (`rest_ap_sync.py` → `/api/ap/sync-bills`, Xoro `bill/getbill`) carries only a *derived* Paid/Partial/Unpaid status — **no AmountPaid amounts, no payment dates, no payment accounts** — and it deliberately skips register-frozen invoices. Paid-amount truth only arrives via the manual **Bills register + Payments exports**. So the watcher compares the **latest imported staging state** (`ap_bill_register_import` + `ap_payment_import`) against what is posted and processes the deltas. Day to day it is a near-no-op; the moment a fresh register/payments export is imported, the next run posts every increment.

**What a run does** (`/api/cron/ap-paid-delta-watcher`, 06:30 UTC nightly — after the 06:00 tie-out; core in `api/_lib/ap-paid-watcher.js`; all idempotent, re-runs post nothing new):

1. **Payments** — staged payment docs without a JE and with cash applied post exactly like the backfill: DR 2000 (vendor subledger) / CR the mapped payment account @ Paid Amount, `ap_payment_historical`, **dated to the source payment date** (clamped to the 2024-08-31 opening cutover). Same JE key as the backfill script (`ap_payment_import` / payment number), so script and watcher never double-post. Zero-cash docs still get no JE.
2. **Relief deltas** — per bill, discounts + vendor credits → 5005 and prepayments applied → 1308 *beyond* what earlier relief JEs posted go out as an incremental relief JE (DR 2000 / CR 5005 / CR 1308, dated to the bill's Modified date). `invoices.paid_amount_cents` is re-aligned to the register **only to the extent the GL actually moved** — if the vendor's cash drift (below) is non-zero, the uncovered cash slice stays open and the paid baseline does NOT advance, so the subledger only ever moves atomically with the GL. Watcher baselines live on `ap_bill_register_import` (`paid_processed_cents`, `total_processed_cents`, `relief_5005_processed_cents`, `relief_1308_processed_cents`) and are never touched by the import upsert.
3. **Anomalies** (bell+email to admin+accounting, `app_errors` `source='cron'` → daily digest): `paid_decreased` · `total_changed` — the **register** total moved vs the reconciled baseline (run `post-bills-register.mjs deltas`; auto-clears once the invoice total matches the new register total) · `header_drift_repaired` — the register total is unchanged but the **frozen invoice header was rewritten by another process**, so the GL is correct and the subledger drifted; the watcher restores the header to the register total (subledger metadata only, **no JE**) and reports it so the offending writer gets found · `relief_decreased` · `new_bill` (register row never accrued) · `payment_unresolved` (cash doc without vendor/GL account) · `vendor_cash_drift` (register Σ Amount Paid − posted payment cash − posted 8002 residuals ≠ 0 — the classic "register imported without its Payments export"; **stateless, re-alerts nightly until resolved**). Only `header_drift_repaired` is auto-fixed; nothing else auto-posts.

> **Incident (2026-07-12) that added `total_changed`/`header_drift_repaired` split + atomicity.** The #1689/#1695 "Xoro account truth" bill-enrichment window rewrote `invoices.total_amount_cents` on 2,679 register-frozen bills to the REST bill-feed line-sums (header-only bills → 0), collapsing the AP subledger open balance by **$10,129,385.11** while the GL 2000 accruals (posted at register header totals, #1668) stayed correct. Root cause was **not** the watcher — it correctly alerted (2,543 `total_changed`) and posted nothing. The fix: restore the headers from `ap_bill_register_import.total_cents` (data repair, no JEs; `paid_amount_cents` was intact), and teach the watcher a `total_processed_cents` baseline so it distinguishes a register-side change (needs a true-up JE) from invoice-side header corruption (auto-repair from the register, no JE). Posting "relief" JEs against the corrupted subledger would have **double-relieved 2000 by $10.13M** — exactly the wrong move.
4. **Run log + Sync Health** — one `ap_paid_watcher_runs` row per run; the **Sync Health** panel (Admin) shows the `ap_paid_watcher` feed row with last-run time and last-run counts (payments/relief/paid deltas/anomalies), red after 26h of silence.

**Manual trigger after importing a fresh export** (instead of waiting for the cron):

```bash
node scripts/run-ap-paid-watcher.mjs [--dry-run]     # from the repo root, or:
curl -X POST https://apps.ringoffire.com/api/cron/ap-paid-delta-watcher -H "Authorization: Bearer $CRON_SECRET"
```

`--dry-run` (or `?dry_run=1`) previews the postings without writing. Dates are always **source dates** (payment date / bill Modified date), never the run date.

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
