# 3. Accounting — Chart of Accounts, Periods, Journal Entries

These three panels form the accountant's daily / monthly workflow. The order matters: **Chart of Accounts must be populated before Journal Entries can be posted**, because every JE line references an account.

## 📒 Chart of Accounts (COA)

### Concept

The COA is the canonical list of every postable or roll-up account, scoped to the entity (currently RoF only). Each account carries:

- A **code** (e.g. `1100`, `4000-WHOLESALE`) — unique per entity, the accountant's number scheme.
- A **name** — human-readable label.
- An **account_type** — one of: `asset`, `liability`, `equity`, `revenue`, `expense`, `contra_asset`, `contra_revenue`.
- A **normal_balance** — `DEBIT` or `CREDIT`. **Auto-derived from `account_type`** (you can override but rarely should):

```mermaid
flowchart LR
    AT["account_type"] --> A["asset"]
    AT --> E["expense"]
    AT --> CR["contra_revenue"]
    AT --> L["liability"]
    AT --> EQ["equity"]
    AT --> R["revenue"]
    AT --> CA["contra_asset"]

    A --> DEBIT["normal_balance = DEBIT"]
    E --> DEBIT
    CR --> DEBIT
    L --> CREDIT["normal_balance = CREDIT"]
    EQ --> CREDIT
    R --> CREDIT
    CA --> CREDIT

    style DEBIT fill:#bfdbfe
    style CREDIT fill:#fed7aa
```

- An **is_postable** flag — `true` for accounts JEs can hit directly; `false` for roll-up parent accounts that exist only for hierarchy / reporting.
- An **is_control** flag — `true` for AR / AP / Inventory accounts. **Control accounts require subledger pairing on every JE line** (a vendor ID for AP, customer ID for AR, item ID for Inventory).
- An optional **parent_account_id** — self-FK for tree-shaped chart of accounts.

### Seeding the COA

The COA arrives **empty**. The accountant supplies the canonical list (per the email draft at `docs/tangerine/accountant-coa-request-email.md`). Until they reply:

1. You can manually add a handful of accounts via the **+ Add account** modal for testing.
2. Once their CSV/spreadsheet arrives, a data-only migration loads the full COA in one batch (Chunk 6.5 / accountant-COA-seed task, queued).

### List view

Columns: **Code, Name, Type, Subtype, Balance, Status, Postable, Control**, plus per-row Edit / Delete buttons.

Filters above the table:

- **Search** — code or name (ilike)
- **Type dropdown** — narrow to one account type
- **Show inactive** — by default, the list shows only `status=active` accounts

![Chart of Accounts list view](screenshots/03-coa-list.png)
<!-- screenshot needed: COA list with several seeded accounts -->

### Add modal

| Field | Required? | Locked after creation? | Notes |
|---|---|---|---|
| Code | yes | **yes** | Uppercased + trimmed. Unique per entity. |
| Name | yes | no | Free text |
| Account type | yes | **yes** | The 7 enum values |
| Normal balance | required (auto-fills) | **yes** | Changes when you change account_type; you can manually override before save |
| Subtype | no | no | Free text (e.g. `current_asset`, `ar`, `cogs`) |
| Parent account | no | no | Dropdown of all current accounts (excluding self in Edit). Restricted to same entity. |
| Postable | checkbox, default true | no | When false, JEs cannot hit this account directly |
| Control | checkbox, default false | no | When true, JE lines targeting this account MUST include subledger_type + subledger_id |
| Status | required, default active | no | active / inactive |
| Description | no | no | Free text |

![COA Add modal showing auto-derived normal_balance](screenshots/03-coa-add-modal.png)
<!-- screenshot needed: Add modal mid-creation, showing the normal_balance auto-fill -->

### Locked fields on Edit

`code`, `account_type`, `normal_balance`, and `entity_id` are immutable after creation. The Edit modal shows them as read-only (grayed-out). To change them, you'd need to soft-delete and recreate — but that's almost always wrong because historical JEs reference the account ID, not the code.

### Deleting accounts

Click **Delete** to hard-delete. The handler **rejects with 409 if any `journal_entry_lines` row references the account**:

> Account has posted journal entry lines; mark it inactive via PATCH status='inactive' instead of deleting.

For accounts with history, the right move is to PATCH `status='inactive'`. The account stays in the database (historical JEs remain valid), but it disappears from the default `status=active` list and from the JE entry account picker.

![COA Delete-blocked error](screenshots/03-coa-delete-blocked.png)
<!-- screenshot needed: alert showing the 409 error message -->

## 🗓️ Periods

### Concept

Periods are 12 calendar-month accounting buckets per fiscal year per entity. They were bootstrapped by migration: **FY 2021–2030, 12 periods each = 120 rows** for RoF. You don't create or delete periods — only their **status** changes.

```mermaid
stateDiagram-v2
    direction LR
    open: open<br/>(all JE writes accepted)
    soft_close: soft_close<br/>(only adjustment + close JEs)
    closed: closed<br/>(no writes)

    [*] --> open
    open --> soft_close: soft-close
    open --> closed: close (skip soft)
    soft_close --> closed: close
    soft_close --> open: reopen
    closed --> soft_close: partial reopen
    closed --> open: full reopen
```

All transitions are allowed in both directions. Reopening a closed period is unusual but supported (e.g. accountant discovers a missed entry during audit).

### What each status blocks

| Status | JE INSERT | JE UPDATE | Notes |
|---|---|---|---|
| `open` | ✅ all | ✅ all | Default working state |
| `soft_close` | ✅ only journal_type IN (`adjustment`, `close`) | ✅ same restriction | The Chunk 2 DB trigger enforces this server-side |
| `closed` | ❌ blocked | ❌ blocked | Hard wall. Trigger raises an exception. |

### List view

Periods group by fiscal year (collapsible cards). Each row shows:

- Period number (1–12) + month name
- `starts_on` and `ends_on` dates
- `posted_je_count` (live aggregate of posted JEs in this period — useful to know what you're closing)
- Color-coded status badge: 🟢 green=open, 🟡 yellow=soft_close, 🔴 red=closed
- Inline status dropdown — change status with a confirm modal

Filters above the table:

- **Fiscal year** — narrow to one FY
- **Status** — narrow to one status

![Periods view with one FY card expanded](screenshots/03-periods-list.png)
<!-- screenshot needed: Periods list with FY 2026 card showing 12 rows -->

### Changing status

Click the status dropdown in the row, pick the target status, confirm the prompt:

> Change FY2026 period 5 (May) from "open" to "soft_close"?

The handler validates the transition (impossible state changes are blocked with a 400) and auto-maintains `soft_closed_at` / `closed_at` timestamps + clears them on reopen.

## 📓 Journal Entries

### Concept

A journal entry (JE) is one accounting transaction — header + 2 or more lines, balanced (sum of debits = sum of credits). Every JE has a **basis** (`ACCRUAL` or `CASH`). The system maintains **two parallel books** in dual-basis mode (the locked P1 decision):

```mermaid
flowchart LR
    Event["Business event<br/>(invoice, payment, etc.)"] --> Rule["Posting rule<br/>(api/_lib/accounting/posting/rules/)"]
    Rule --> Accrual["ACCRUAL JE<br/>(some events)"]
    Rule --> Cash["CASH JE<br/>(other events)"]
    Rule --> Both["Both JEs<br/>(many events emit both)"]

    Both --> Link["gl_link_sibling_je<br/>(bidirectional link)"]
    Link --> Accrual2["ACCRUAL JE.sibling_je_id ← CASH JE.id"]
    Link --> Cash2["CASH JE.sibling_je_id ← ACCRUAL JE.id"]

    style Accrual fill:#bfdbfe
    style Cash fill:#fed7aa
```

For a manual JE you post yourself, you choose the basis: `ACCRUAL`, `CASH`, or `BOTH` (posts a sibling pair).

### List view

Columns: **Posting date, Type, Basis, Description, Source, Status**. Reversed JEs and drafts show grayed out.

Filters:

- **Basis** — all / ACCRUAL / CASH
- **Include drafts** — drafts are normally hidden (the system only inserts `status='posted'` rows; drafts can exist transiently mid-RPC)

Each posted row has a **Reverse** button on the right.

![Journal Entries list](screenshots/03-je-list.png)
<!-- screenshot needed: JE list with mix of posted/reversed rows -->

### Posting a manual JE

Click **+ Post manual JE** to open the modal.

```mermaid
flowchart TB
    UI["User opens<br/>Post manual JE modal"] --> Form["Fill header:<br/>basis, journal_type,<br/>posting_date, description"]
    Form --> Lines["Add 2+ lines:<br/>account, debit OR credit,<br/>memo, subledger (if control acct)"]
    Lines --> Balance{"Live balance<br/>check"}
    Balance -->|Out of balance| RedFooter["Red footer:<br/>'Out of balance by X.XX'<br/>Post button DISABLED"]
    Balance -->|Balanced| GreenFooter["Green footer:<br/>'● Balanced'<br/>Post button ENABLED"]
    GreenFooter --> Click["Click Post"]
    Click --> Validate["validateManualPost<br/>(handler-side BigInt cents check)"]
    Validate -->|Fail| Error1["Modal error banner"]
    Validate -->|Pass| RPC["gl_post_journal_entry RPC<br/>(atomic, transactional)"]
    RPC --> Trigger["DB triggers fire:<br/>balanced, period_open,<br/>control_subledger,<br/>account_postable,<br/>account_in_entity"]
    Trigger -->|Any guard fails| Rollback["Whole transaction<br/>rolls back; error surfaces"]
    Trigger -->|All pass| Posted["JE inserted at<br/>status='posted'"]
    Posted --> Both{"basis=BOTH?"}
    Both -->|yes| Sibling["Second RPC call<br/>+ gl_link_sibling_je"]
    Both -->|no| Done["Done"]
    Sibling --> Done

    style RedFooter fill:#fecaca
    style GreenFooter fill:#bbf7d0
    style Rollback fill:#fecaca
    style Posted fill:#bbf7d0
```

#### Modal fields

**Header row:**

| Field | Notes |
|---|---|
| Basis | `ACCRUAL`, `CASH`, or `BOTH` (sibling pair). For most accountant adjustments, choose ACCRUAL. |
| Journal type | `manual` (default) or `adjustment`. Use `adjustment` if posting into a soft-closed period. |
| Posting date | Date the entry hits the books. Must fall inside a non-closed period for the chosen basis. |
| Description | Free text, e.g. "Adjusting entry for accrued rent" |

**Lines table** (start with 2; add more with + Add line):

| Column | Notes |
|---|---|
| # | Line number (auto) |
| Account | Dropdown filtered to `status=active AND is_postable=true` accounts. Shows `<code> — <name> [control]` if it's a control account. |
| Debit | Decimal. Mutually exclusive with Credit on the same line — typing in one clears the other. |
| Credit | Same. |
| Memo | Free text per line |
| Sub type | `vendor`, `customer`, `item`, or (none). **Required if the account is a control account.** |
| Sub id | UUID of the subledger entity. Currently raw UUID input — picker UX is planned but not built. |

**Footer** shows live totals and balance status. The **Post** button is disabled until: lines balance AND description is non-empty.

![Manual JE post modal with multi-line table and balanced footer](screenshots/03-je-post-modal-balanced.png)
<!-- screenshot needed: post modal mid-entry, green balanced footer -->

![Manual JE post modal with out-of-balance footer](screenshots/03-je-post-modal-unbalanced.png)
<!-- screenshot needed: post modal with red unbalanced footer -->

### Viewing a JE (detail modal)

Click any row in the JE list to open the read-only **JE detail modal**. The header carries the JE id; the body is divided into four sections.

```mermaid
flowchart TB
    Row["Click row in JE list"] --> Fetch["GET /api/internal/journal-entries/:id<br/>(returns header + lines)"]
    Fetch --> Lookup["GET /api/internal/gl-accounts<br/>(code+name lookup for lines)"]
    Fetch --> Approvals["GET /api/internal/approval-requests<br/>?context_table=journal_entries<br/>&context_id=:id"]
    Fetch --> Docs["GET /api/internal/documents<br/>?context_table=journal_entries<br/>&context_id=:id<br/>(DocumentAttachmentList widget)"]
    Approvals -.->|empty / error| NoHistory["'No approval history' line<br/>(modal still renders)"]

    style NoHistory fill:#fef3c7
```

**Sections** (top to bottom):

1. **Header** — posting_date, journal_type, basis, source_module, source_table/source_id, posted_at, sibling_je_id (for ACCRUAL↔CASH pairs), and reverses_je_id / reversed_by_je_id cross-links. All read-only.
2. **Description** — the free-text label entered at post time.
3. **Lines** — full line table with account code+name (joined from the COA lookup), debit, credit, memo, and subledger pairing. Totals row at the bottom shows Σ debit and Σ credit (which match by construction for any posted JE).
4. **Approval history** — best-effort lookup against `approval_requests` where `context_table='journal_entries' AND context_id=<this JE>`. Renders each request's status, kind, and step decisions. If no matching approval exists (or the lookup fails), shows **"No approval history"** — the rest of the modal still renders.
5. **Supporting documents** — the reusable `<DocumentAttachmentList>` widget bound to this JE. **This is the only writable area of the modal.** Documents can be uploaded, downloaded (via short-lived signed URL), or archived (soft-delete). Seeded kinds dropdown: `supporting_doc`, `approval_correspondence`, `receipt`, `other`.

```tsx
<DocumentAttachmentList
  contextTable="journal_entries"
  contextId={je.id}
  kinds={["supporting_doc","approval_correspondence","receipt","other"]}
/>
```

The modal has two footer buttons:

- **Close** — dismiss without any change.
- **Reverse** — only enabled when `status='posted'` AND `reversed_by_je_id` is null. Delegates to the same reverse flow as the row-level Reverse button (prompt for posting_date, then `POST /api/internal/journal-entries/:id/reverse`).

> Why is the rest of the modal read-only? Posted JEs are immutable by design (see the next section). The detail modal is intentionally a **viewer** — the only thing that can be changed about a posted JE after the fact is the set of supporting documents pinned to it.

### Reversing a posted JE

Click **Reverse** on any `status=posted` row.

The system creates a **new** JE with negated lines (debit ↔ credit), flips the original to `status=reversed`, and cross-links them via `reverses_je_id` (new → original) and `reversed_by_je_id` (original → new). The original's lines are never modified — posted lines are immutable per the Chunk 3 DB trigger.

You're prompted for an optional `YYYY-MM-DD` posting date for the reversal — leave blank to default to today.

The reversal entry lands in an **open** period. If today's period is closed, you must pick a date in an open period or first reopen the closed period.

### Why posted JEs can't be edited or deleted

Once `status='posted'`, the JE is immutable by design. PATCH and DELETE on `/api/internal/journal-entries/:id` return 405. The only undo path is reversal. This protects audit integrity — the GL always tells the truth about what was posted and when.

## Going further

- **Concepts** (dual-basis, control accounts, subledgers, audit immutability): [04-concepts.md](04-concepts.md)
- **Workflows** (month-end close, manual adjustment, AP invoice manual entry): [05-workflows.md](05-workflows.md)
- **Troubleshooting** (period closed, unbalanced, missing subledger, account not found): [06-troubleshooting.md](06-troubleshooting.md)

---

## Period close (P5-1, 2026-05-27)

The Periods panel ships with a 3-status state machine — `open` → `soft_close` → `closed` — and P5-1 adds a fourth terminal status (`closed_with_closing_jes`) that is set only by the year-end close RPC (P5-6). The full layout:

```
            ┌──────────────────┐
            ▼                  │
          open ──► soft_close ─┤──► closed
                                    │
                                    ▼
                          closed_with_closing_jes (TERMINAL)
```

### Soft-closing a period

`POST /api/internal/gl-periods/:id/close` with `body = { target_status: 'soft_close', actor_user_id, reason? }`. The reason is optional but recommended; it's recorded in the new `gl_period_status_log` audit table.

A soft-closed period blocks new manual journal entries but still accepts AP/AR/inventory operations (they're operationally idempotent and posting them late is fine).

### Hard-closing

Same endpoint, `target_status: 'closed'`. Blocks all posting (manual JE + AP + AR + inventory). The only exception is historical-backfill writes (`journal_type='*_historical'`), which still bypass via the trigger logic established in P4-1.

If an active `approval_rules` row exists with `kind='gl_period_close'`, the handler routes the close through M27 approvals before applying — returns `202 {requires_approval: true, approval_request_id}` and the operator must approve before the period flips. Without a rule, the close lands immediately.

A `gl_period_closed` (or `_soft_closed`) notification is enqueued to `recipient_roles=['admin','accountant']` on success.

### Reopening a closed period

`POST /api/internal/gl-periods/:id/reopen` with `body = { actor_user_id, reason }`. **Both fields required.** Caller must hold `role='admin'` on the entity (returns 403 otherwise). Status flips back to `soft_close`. The reason is captured in the audit log and the `gl_period_reopened` notification body.

Periods in `closed_with_closing_jes` cannot be reopened — that status is reserved for year-end close (P5-6) and is the one situation where corrections must instead be filed as adjustment JEs in the next FY's opening period.

### Audit log

Every status transition writes one row to `gl_period_status_log` (entity_id, period_id, from_status, to_status, reason, actor_user_id, performed_at). The audit row is populated by an `AFTER UPDATE` trigger reading session-local vars set by the `gl_period_transition_status` RPC — so the actor + reason are captured atomically with the status flip.

---

## Trial Balance (P5-2)

The **Trial Balance** is the foundation report for every other financial statement (Income Statement, Balance Sheet, Cash Flow). It rolls up every posted journal entry line per account and tells you — for the date window you choose — the total debit, total credit, and the net in either direction.

Open it from **💼 Accounting → 📊 Trial Balance**.

### What it shows

One row per account that has been touched by a posted JE in the window:

- **Code / Name** — from the COA.
- **Type** (asset / liability / equity / revenue / expense / contra_*) and **Normal** (DEBIT / CREDIT) — same source.
- **Debit** — `SUM(journal_entry_lines.debit)` across posted JEs in the window.
- **Credit** — `SUM(journal_entry_lines.credit)` across posted JEs in the window.
- **Net** — `Debit − Credit`. Positive (green) means the account has net debits; negative (yellow) means net credits.

Rows are grouped by account type with a per-group subtotal row and one grand-total footer row.

### Operator workflow

1. Pick **Basis** — `ACCRUAL` for the audited book (recommended default), `CASH` to see only cash-basis posting impact.
2. Set **From** and **To** dates. The default range is the last 90 days; widen for a year-end review, narrow for a single-period check.
3. Click **Refresh**. The grid loads.
4. Scan each account type's subtotal row — does the asset total match what you expect? Did revenue land where it should?

### Key invariant — the grand-total must net to $0.00

A trial balance proves out double-entry. If every posted JE is internally balanced (debits = credits), then summing across all of them MUST also balance — every dollar debited to one account is credited to another.

**The grand-total Net row should always read $0.00.**

If it doesn't, the variance row is rendered in red with a warning. That means an unbalanced JE somehow slipped past the P1 posting guard (which is supposed to reject unbalanced inserts at the trigger level). It's a corruption indicator — investigate by querying `journal_entry_lines` for the date range and looking for any `journal_entry_id` where `SUM(debit) ≠ SUM(credit)`.

In practice this should never happen — the trigger guard catches it. The variance row is defense in depth so a bug in the trigger doesn't silently corrupt downstream reports.

### API surface

`GET /api/internal/trial-balance?basis=ACCRUAL|CASH&from=YYYY-MM-DD&to=YYYY-MM-DD`

- `basis` (required) — `ACCRUAL` or `CASH`.
- `from` / `to` (both-or-neither) — if both provided, calls the `trial_balance(entity_id, basis, from, to)` RPC. If both omitted, reads the view `v_trial_balance` (cumulative across all posted history).

Response: `{ basis, from, to, rows: [...] }` sorted by account code ASC.
