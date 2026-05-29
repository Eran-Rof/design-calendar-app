# 24. Audit Log (Cross-cutter T11 — Universal Row-Change Timeline)

> **T11 status (2026-05-29):** all 4 chunks shipped. PRs #521 (schema + trigger) · #531 (withAuditContext + 4 audit-aware RPCs + handler sweep) · #537 (RowHistory drop-in + InternalAuditLog admin panel + 9 modal mounts) · this PR (close-out + memory rules).

T11 closes the "who changed what when" gap that operators (CEO + accountant) repeatedly hit before this cross-cutter shipped — "who voided invoice #1234?", "what changed on this customer's credit limit yesterday?", "show me everything Eran touched last week." Before T11 the answer was SQL; after T11 it's two clicks.

One universal `row_changes` ledger captures every INSERT / UPDATE / DELETE / VOID / POST / REVERSE on 16 covered entities. One `<RowHistory>` primitive renders the per-row timeline inline in every detail modal. One `🕒 Audit Log` admin panel surfaces the full cross-entity stream with filters + export. Pairs with T10 source-tagging (see chapter 22) — T10 tells you *which channel produced the row*, T11 tells you *who touched it and when*.

---

## 24.1 What it is

The audit log is a single append-only table (`row_changes`) that a PL/pgSQL trigger writes one row to every time a covered entity is mutated. Every audit row captures:

- **The mutation itself** — `before_jsonb` + `after_jsonb` + `changed_columns` (the trigger computes which columns actually changed; a no-op UPDATE that touches no values produces no audit row).
- **The actor** — `actor_auth_id` (auth.users.id) + `actor_employee_id` (employees.id) + `actor_display_name` (cached at write time so the timeline still reads cleanly even if the employee row is later renamed).
- **The source** — same T10 enum used everywhere else (`manual` / `xoro_mirror` / `shopify` / `fba` / `walmart` / `faire` / `edi_3pl` / `plaid_sync` / `api` / `system`). Lets the audit panel filter "show me only what the operator typed by hand last week."
- **The reason** — operator-typed free text on VOID / POST / REVERSE operations. Required (see §24.4).
- **The correlation ID** — request_id / batch_id so all the rows from a single void cascade (header + lines) cluster on the timeline.
- **The timestamp** — `changed_at`, indexed for fast reverse-chronological reads.

The trigger fires AFTER the business write commits, so the audit row reflects the post-write state of the row exactly.

---

## 24.2 What it does NOT do

- **Does NOT revert a change.** v1 is read-only — viewing the timeline only. "Revert to this version" is a backlog item; some entities (multi-row cascades like void → lines → JE reversal) don't have idempotent UPDATE paths and need careful design before they get a revert button.
- **Does NOT backfill the legacy `audit_logs` table.** Anything written before T11-1 shipped (PR #521 merged 2026-05-29) is not in `row_changes`. The legacy `audit_logs` table stays read-only for historical lookups; T11 writes only to `row_changes`.
- **Does NOT cover high-write Xoro-mirror feeds.** `ip_sales_history_wholesale`, `ip_inventory_snapshot`, `bank_transactions` are intentionally OUT of T11 coverage — the write volume would dwarf operator-typed changes and the `source='xoro_mirror'` row IS the audit for those tables.
- **Does NOT redact PII.** Every covered column is captured in the before/after blobs. The v1 entity set has no PII columns (vendor `tax_id` / `bank_account_encrypted` and customer `tax_exempt_certificate` live on tables that are covered, but those columns are NULL in production today; if PII fields ever get populated, T11 will need a column allowlist before then).
- **Does NOT push in real-time.** Operator hits Refresh or re-opens the modal to see new rows. WebSocket / supabase-realtime is a backlog polish.

---

## 24.3 Two surfaces — `<RowHistory>` and `🕒 Audit Log`

The audit log surfaces twice in the UI: inline in detail modals, and cross-entity in a dedicated admin panel.

### 24.3.1 `<RowHistory>` — per-row timeline in detail modals

Every detail modal listed below shows a per-row audit trail at the bottom. Click any row in the trail to expand its changed-columns chips + before/after JSON preview side-by-side. Each row shows the actor display name + operation badge (color-coded — green INSERT, blue UPDATE, red DELETE / VOID / REVERSE, amber POST) + relative time + reason (when present).

| Panel | Modal | `source_table` covered |
|---|---|---|
| 💼 AR Invoices | AR invoice detail | `ar_invoices` |
| 💼 AP Invoices | AP invoice detail | `invoices` |
| 📓 Journal Entries | JE detail | `journal_entries` |
| 📒 Chart of Accounts | GL account edit | `gl_accounts` |
| 🗓️ Periods | Period detail | `gl_periods` |
| 🤝 Customer Master | Customer edit | `customers` |
| 🏭 Vendor Master | Vendor edit | `vendors` |
| 👥 Employees | Employee edit | `employees` |
| 🛠️ Cases | Case detail | `cases` |

(Line tables — `ar_invoice_lines`, `invoice_line_items`, `journal_entry_lines` — get audit coverage but render through their parent's `<RowHistory>` because line mutations are typically part of a parent void / post; the `correlation_id` clusters them together in the timeline.)

If a row has no audit history (it was created before T11-1 shipped, or before the trigger was attached to its table) the timeline shows an empty state: "No audit history. Changes will appear here as they happen."

### 24.3.2 `🕒 Audit Log` admin panel — cross-entity stream

A new top-nav group **`🕒 Audit Log`** opens to the universal stream — every audit row across all 16 covered entities, sorted newest first.

**Filters** (every filter is optional; combining them narrows the stream):

| Filter | Notes |
|---|---|
| **Date range** | T7 `DateRangePresets` — 12 presets (last 7 / 30 / 90 days, this month, last month, …) + custom range |
| **Entity type** | dropdown of the 16 covered tables (`ar_invoices` / `journal_entries` / etc.) |
| **Actor** | T9 `SearchableSelect` over the employees list |
| **Operation** | checkbox set — INSERT / UPDATE / DELETE / VOID / POST / REVERSE |
| **Source** | T10 enum dropdown — manual / xoro_mirror / shopify / etc. |
| **Search** | free text over `entity_pk` + `reason` |

**Export** — universal `<ExportButton>` per the [universal table export rule](18-table-export.md). Operator can dump the visible stream to xlsx for accountant review.

**Side panel** — click any row → a side panel opens showing the full before/after diff with changed columns highlighted. Useful when the inline `changed_columns` chips aren't enough context.

**Pagination** — Prev / Next buttons; 50 rows per page. Filters survive page navigation.

---

## 24.4 The reason requirement on voids / posts / reverses

Operator-confirmed decision **D3**: every VOID / POST / REVERSE operation on a covered entity MUST carry a non-empty operator-typed reason. The trigger enforces this at the database layer — a void or post without a reason fails with a clean CHECK violation; the handler layer catches the violation earlier and returns a 400 with a friendly message.

**Why this matters:** voids and posts are irreversible-in-spirit (you can re-post or re-void, but the audit trail still shows the toggle). When the accountant comes back six months later asking "why was this invoice voided?", the reason field is the answer. Without it, you're guessing from context.

**When the reason prompt pops up:**

- AR invoice void → "Reason for voiding this invoice"
- AP invoice void → same
- JE post → "Reason for posting this entry" (typically "Approved by CEO" / "Monthly close — approved" / "Vendor bill paid — auto-post")
- JE reverse → "Reason for reversing this entry"

**What makes a useful reason:** short, specific, and reads cleanly six months later. Bad: "fix" / "test" / "n/a". Good: "Customer cancelled order #SO-12345 per CEO email 2026-05-29" / "Duplicate of invoice #4567 from Vendor X" / "Approved at close meeting 2026-05-31".

**Why the trigger enforces this and not just the UI:** belt-and-suspenders. The UI modal blocks Save with an empty reason field, but if anyone ever wires a void through raw SQL / a script / a future API integration without going through the UI, the trigger still catches it. D3 is non-negotiable across all paths.

---

## 24.5 Limitations

### 24.5.1 Trigger failures never block business writes

The trigger is wrapped in an EXCEPTION handler that re-raises only the D3 reason-required CHECK violation. Any other failure (e.g. a column type mismatch on a freshly-altered table that the trigger hasn't been updated to handle, a serialization conflict, a transient pg internal error) is **swallowed** so the parent INSERT/UPDATE/DELETE always succeeds.

When the trigger swallows a failure, it inserts a single row into `row_changes` with `source='audit_trigger_failure'` capturing the SQLSTATE + SQLERRM, so the failure is visible without breaking the parent write. This is the right tradeoff: an operator typing a customer record edit should never see "Save failed — audit trigger error" when the actual customer write would have succeeded.

**What to do if you see `audit_trigger_failure` rows:**

1. Open the `🕒 Audit Log` admin panel and filter by `source='audit_trigger_failure'`.
2. Each failure row's `after_jsonb` field has `{ audit_trigger_error: <SQLERRM>, sqlstate: <code> }`.
3. The fix is almost always a schema drift — the trigger function expects a specific column shape on the covered tables, and a recent migration changed it without updating the trigger.
4. File a Github issue against `design-calendar-app` with the SQLERRM + SQLSTATE + the `source_table` of the failure row. The developer ships a migration that updates the trigger function.
5. **There is no operator action that fixes an `audit_trigger_failure` row.** The row stays as a marker that "the trigger had a bad day on this table at this time"; the underlying business row (the invoice / JE / customer) is still consistent.

### 24.5.2 Raw SQL operations have NULL actor + 'manual' source

If an operator (or developer) pastes SQL directly into the Supabase dashboard or runs a one-off script outside the Tangerine API, the audit row gets `actor_auth_id = NULL`, `actor_employee_id = NULL`, `actor_display_name = NULL`, `source = 'manual'` (the default). The `🕒 Audit Log` panel renders these as "(no actor — raw SQL or script)" with a yellow chip so it's clear the change came from outside the app.

This is by design. The truth is "we don't know who did this"; pretending otherwise would be worse than admitting it.

### 24.5.3 No retroactive backfill

The trigger only captures changes made AFTER it was attached (PR #521 merged 2026-05-29). Anything that happened before that date is invisible to `<RowHistory>` — the modal will say "No audit history before 2026-05-29." Historical lookups still go through the legacy `audit_logs` table or raw SQL against the entity's `updated_at` / `created_by_user_id` columns.

### 24.5.4 Multi-row cascades cluster via `correlation_id` but render separately

When one operator action mutates multiple rows (e.g. voiding an AR invoice voids the header + reverses the accrual JE + reverses any cash JE), each row gets its own `row_changes` entry. They share a `correlation_id` so the admin panel can group them, but each detail modal's `<RowHistory>` only shows that modal's row. The cross-references are visible via the admin panel.

---

## 24.6 Common workflows the audit log unlocks day-one

| Operator ask | Click path |
|---|---|
| "Who voided invoice #1234?" | AR Invoices → open #1234 → scroll to Audit trail → see the VOID row + actor + timestamp + reason |
| "What changed on this customer's record yesterday?" | Customer Master → open the customer → Audit trail |
| "Show me everything Eran touched last week." | 🕒 Audit Log → Actor=Eran + DateRangePresets=Last 7 Days |
| "Which rows did the Xoro mirror change last night?" | 🕒 Audit Log → Source=xoro_mirror + DateRangePresets=Yesterday |
| "Did anyone change account 1200 AR Control's name?" | Chart of Accounts → open 1200 AR Control → Audit trail |
| "Why was JE #98765 reversed?" | Journal Entries → open #98765 → Audit trail → REVERSE row's reason field |
| "Export the last 30 days of audit changes for the accountant." | 🕒 Audit Log → DateRangePresets=Last 30 Days → Export → xlsx |

---

## 24.7 Code map

| Layer | File / chunk |
|---|---|
| Architecture | `docs/tangerine/T11-audit-log-architecture.md` |
| T11-1 — Schema + trigger (16 tables) | `supabase/migrations/20260629900000_t11_chunk1_audit_log.sql` (PR #521) |
| T11-2 — `withAuditContext` helper + `set_audit_context` RPC + 4 `_with_audit` RPCs + handler sweep | `api/_lib/audit/withAuditContext.js` + `supabase/migrations/20260629B00000_t11_chunk2_audit_rpc.sql` (PR #531) |
| T11-3 — `<RowHistory>` drop-in + `<InternalAuditLog>` admin panel + 9 modal mounts | `src/tanda/components/RowHistory.tsx` + `src/tanda/InternalAuditLog.tsx` (PR #537) |
| T11-4 — User guide + memory rules (this PR) | `docs/tangerine/user-guide/24-audit-log.md` + 2 new memory feedback rules |

---

## 24.8 Pairs with

- **Chapter 22 (Shadow Mirror / T10)** — source-tagging precedent; T11 reuses the enum + badge.
- **Chapter 10 (Employees / M30)** — `v_audit_user_resolved` view that resolves auth_id → display_name.
- **Chapter 18 (Table Export / T3)** — universal `<ExportButton>` on the audit stream view.
- **Chapter 23 (Searchable Dropdowns / T9)** — actor picker on the admin panel.
- **Memory: standing rule — every void/post/reverse handler must pass a non-empty reason** (`feedback_t11_reason_required_on_voids.md`).
- **Memory: standing rule — prefer `_with_audit` RPCs over raw UPDATE on void/post/reverse** (`feedback_t11_use_with_audit_rpc_for_voids.md`).
