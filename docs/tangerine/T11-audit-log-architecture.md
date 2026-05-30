# Cross-cutter T11 — Universal Audit Log / Row-Change Timeline

Status: **SHIPPED** (2026-05-29). All four chunks merged. Author: Tangerine cross-cutter stream.

| Chunk | Status | PR |
|---|---|---|
| T11-1 — Schema + trigger function + 16-entity coverage | **DONE** | #521 |
| T11-2 — `withAuditContext` API + 4 `_with_audit` RPCs + handler sweep | **DONE** | #531 |
| T11-3 — `<RowHistory>` drop-in + `InternalAuditLog` admin panel + 9 modal mounts | **DONE** | #537 |
| T11-4 — User-guide chapter 24 (operator-facing) | **DONE** | #544 |
| T11-4b — Arch DONE flags + 2 memory rules + index update + handler sweep close-out | **DONE** | this PR |

T11 is the cross-cutter that gives every panel in the suite — Tangerine, PO WIP, ATS, DC, GS1, Tech Pack — a single, universal "who changed what when" surface. Today the suite has a handful of one-off audit tables (`audit_logs`, `bank_match_audit`, `gl_period_status_log`, `entity_access_audit`, `compliance_audit_trail`, `ip_change_audit_log`) plus per-table `created_by_user_id` / `updated_by_user_id` columns, but **no universal viewer**. Operators (CEO + accountant) repeatedly ask "who voided that invoice?" / "who switched the customer's credit limit?" — and today the answer requires SQL.

T11 closes that gap. One `row_changes` ledger writes by trigger on every mutable sub-ledger; one `<RowHistory>` primitive renders the trail inline in any detail modal; one `🕒 Audit Log` admin panel surfaces the cross-entity stream with filters. Cheap to build, immediately useful, leverages P2-7 employees + the existing `created_by_user_id` columns.

This pairs with T10 source-tagging ([[feedback-source-tagging-enforcement]]) — T10 tells you *which integration produced the row*, T11 tells you *who touched it and when*.

---

## 0. Scope

**In scope (v1):**
- **`row_changes` ledger table** — one append-only row per INSERT / UPDATE / DELETE on every covered entity, capturing `before_jsonb` + `after_jsonb` + `actor_auth_user_id` + `source` + timestamp + reason (optional).
- **Trigger generator** — single PL/pgSQL function `audit_row_changes_trigger()` that any covered table opts into via `CREATE TRIGGER ... EXECUTE FUNCTION audit_row_changes_trigger()`. Reads session vars (`app.audit_user_id`, `app.audit_source`, `app.audit_reason`) set by the API handler.
- **Session-var helper** — `api/_lib/audit/context.js` `withAuditContext({ userId, source, reason }, fn)` wraps every mutating handler so triggers fire with the correct actor.
- **`<RowHistory>` primitive** — drops into any detail modal: `<RowHistory entity_type="ar_invoices" entity_id={row.id} />`. Renders a vertical timeline (newest first) showing action + actor (resolved via `v_audit_user_resolved` → employee display_name) + source badge + diff (field-by-field old → new) + optional reason.
- **`InternalAuditLog` admin panel** — cross-entity stream under 🕒 Audit Log top-nav group. Filters by entity_type / actor / source / date range / action. Per-row drill-into `<RowHistory>` of that entity. Universal table export per [[feedback-universal-table-export]].
- **Universal coverage (v1 entities, ~15 tables):** `ar_invoices` + `ar_invoice_lines` + `ar_receipts` + `invoices` (AP) + `journal_entries` + `journal_entry_lines` + `gl_accounts` + `gl_periods` + `customers` + `vendors` + `employees` + `cases` + `sales_reps` + `commission_payouts` + `bank_accounts`. Pattern is one migration per N tables; future entities opt in by adding the trigger.

**Explicitly OUT of scope (v1):**
- **Reverting a change** — viewing only in v1. "Revert to this version" is a v2 chunk (needs careful conflict handling; some entities don't have idempotent UPDATE paths).
- **Mirroring the legacy `audit_logs` table** — keep it as-is for back-compat; T11 writes only to `row_changes`. The legacy table stays read-only for historical lookups. A v2 chunk could backfill / merge.
- **Mirroring the scoped audit tables** — `bank_match_audit`, `gl_period_status_log`, `entity_access_audit`, `ip_change_audit_log`, `compliance_audit_trail` continue to write their domain-specific rows. T11 is additive; the `<RowHistory>` panel may *also* surface them in v2 via a union view, but v1 stays narrow.
- **Real-time push** — operator hits Refresh or re-opens the modal. WebSocket / supabase-realtime is a v2 polish.
- **Field-level redaction** — every covered field is captured. If we add PII columns later (SSN, bank routing) the trigger needs a column-allowlist parameter. Punted; no PII fields exist on the v1 entity set.
- **Cross-entity correlation** (e.g. "the JE that voided this invoice"). The `correlation_id` column is in v1 schema but the UI doesn't render correlation chains yet.

---

## 1. Existing state

- **`audit_logs` table (pre-P)** — generic shape (`entity_type`, `entity_id`, `action`, `old_values`, `new_values`, `user_label`, `source`). Barely used — exists but no consistent writer or reader. T11 supersedes this with a stricter schema + universal trigger.
- **Per-table `created_by_user_id` / `updated_by_user_id`** — present on ~40 tables (see `CURRENT-SCHEMA.md`). Captures *who created it last* but not *what changed* and not *the history*.
- **Scoped audit tables** — `bank_match_audit` (P6-1), `gl_period_status_log` (P5-1), `entity_access_audit` (P10-1), `ip_change_audit_log`, `compliance_audit_trail`. Each works for its domain but has its own shape; no universal viewer joins them.
- **P2-7 `employees` + `v_audit_user_resolved` view** — already resolves `auth.users.id` → human-readable employee `display_name` for audit surfaces. T11 reuses this.
- **No `<RowHistory>` or "show change log" anywhere in the UI.**

---

## 2. Decisions (operator confirm before T11-1 ships)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| T11-D1 | Storage model | **Single `row_changes` ledger** with `entity_type` + `entity_id` discriminator + jsonb before/after | One table, one trigger function, one reader. Per-entity audit tables silo the data and prevent the cross-entity stream. |
| T11-D2 | Trigger mechanism | **PL/pgSQL trigger reading session vars set by the API handler** (`current_setting('app.audit_user_id', true)::uuid`) | Same pattern as P5-1 `gl_period_status_log_trigger`. Works with Supabase pooler. Falls back to NULL actor when session vars unset (e.g. raw SQL ops). |
| T11-D3 | Diff shape | **Full before + after jsonb** per row + a computed `changed_fields text[]` populated by the trigger | Simpler than per-field rows; jsonb diff is fast for the ~50-column-max entities; `changed_fields` makes the timeline summary-friendly. |
| T11-D4 | Retention | **Indefinite for v1** (~50KB/row × ~10k rows/yr = ~500MB/yr) | Cheap. Add a partitioned-by-month strategy in v2 if growth surprises us. |
| T11-D5 | Source attribution | **Reuse the `source` enum from T10** (`'manual' / 'xoro_mirror' / 'shopify' / ...`) on `row_changes.source` | Single vocabulary across cross-cutters. Lets the audit panel filter "show me only what the operator typed by hand last week." |
| T11-D6 | UI primitive shape | **`<RowHistory entity_type entity_id>` + `<AuditLogPanel>`** (admin panel) | Two surfaces — one inline in detail modals, one cross-entity stream. |
| T11-D7 | Coverage rollout | **Hand-pick the v1 entity set (~15 tables) in T11-1**; future entities opt in via a one-line `CREATE TRIGGER` migration | Avoid "audit everything" overhead (some high-write tables — `bank_transactions`, `ip_inventory_snapshot` — would create write noise). Operator picks coverage; not every table needs history. |
| T11-D8 | Reason / context capture | **Optional `reason` session var**, displayed inline when present | Operator can pass `?reason=void+per+CEO+email` from a void button; trigger picks it up. Most actions won't have one and that's fine. |

---

## 3. Schema

One new table plus one trigger function plus per-entity `CREATE TRIGGER` lines.

```sql
-- The universal ledger. One row per mutation on any covered entity.
CREATE TABLE IF NOT EXISTS row_changes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  entity_type         text NOT NULL,                     -- 'ar_invoices' / 'journal_entries' / 'customers' / ...
  entity_pk           text NOT NULL,                     -- text so we support uuid + composite PKs
  action              text NOT NULL CHECK (action IN ('insert','update','delete')),
  before_jsonb        jsonb,                             -- NULL on insert
  after_jsonb         jsonb,                             -- NULL on delete
  changed_fields      text[] NOT NULL DEFAULT '{}',      -- computed by trigger for fast summary
  actor_auth_user_id  uuid REFERENCES auth.users(id),    -- NULL when session var unset (e.g. raw SQL)
  source              text NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire',
                                        'edi_3pl','plaid_sync','api','system','migration','trigger')),
  reason              text,                              -- optional, set by handler via session var
  correlation_id      uuid,                              -- groups related row_changes (e.g. one void → 4 rows)
  performed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_row_changes_entity ON row_changes (entity_type, entity_pk, performed_at DESC);
CREATE INDEX idx_row_changes_actor  ON row_changes (actor_auth_user_id, performed_at DESC);
CREATE INDEX idx_row_changes_entity_id_time ON row_changes (entity_id, performed_at DESC);
CREATE INDEX idx_row_changes_changed_fields_gin ON row_changes USING GIN (changed_fields);
```

```sql
-- The universal trigger function. Every covered table runs this AFTER INSERT/UPDATE/DELETE.
CREATE OR REPLACE FUNCTION audit_row_changes_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor uuid;
  v_source text;
  v_reason text;
  v_correlation uuid;
  v_entity_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_pk text;
BEGIN
  -- Session vars set by api/_lib/audit/context.js; fall back to NULL on raw SQL.
  v_actor := NULLIF(current_setting('app.audit_user_id', true), '')::uuid;
  v_source := COALESCE(NULLIF(current_setting('app.audit_source', true), ''), 'manual');
  v_reason := NULLIF(current_setting('app.audit_reason', true), '');
  v_correlation := NULLIF(current_setting('app.audit_correlation_id', true), '')::uuid;

  IF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD);
    v_after := NULL;
    v_pk := OLD.id::text;
    v_entity_id := OLD.entity_id;
  ELSIF TG_OP = 'INSERT' THEN
    v_before := NULL;
    v_after := to_jsonb(NEW);
    v_pk := NEW.id::text;
    v_entity_id := NEW.entity_id;
  ELSE -- UPDATE
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
    v_pk := NEW.id::text;
    v_entity_id := NEW.entity_id;
    SELECT array_agg(key) INTO v_changed
      FROM jsonb_each(v_after) a
      WHERE a.value IS DISTINCT FROM (v_before -> a.key);
    IF v_changed IS NULL OR cardinality(v_changed) = 0 THEN
      RETURN COALESCE(NEW, OLD);  -- no-op update; don't log
    END IF;
  END IF;

  INSERT INTO row_changes
    (entity_id, entity_type, entity_pk, action, before_jsonb, after_jsonb,
     changed_fields, actor_auth_user_id, source, reason, correlation_id)
  VALUES
    (v_entity_id, TG_TABLE_NAME, v_pk, lower(TG_OP), v_before, v_after,
     COALESCE(v_changed, '{}'), v_actor, v_source, v_reason, v_correlation);

  RETURN COALESCE(NEW, OLD);
END;
$$;
```

Per-entity trigger attach (v1 set, ~15 lines):

```sql
CREATE TRIGGER trg_audit_ar_invoices
  AFTER INSERT OR UPDATE OR DELETE ON ar_invoices
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();
-- repeated for ar_invoice_lines / ar_receipts / invoices / journal_entries /
-- journal_entry_lines / gl_accounts / gl_periods / customers / vendors /
-- employees / cases / sales_reps / commission_payouts / bank_accounts
```

**Tables intentionally excluded from v1 trigger set:**
- High-write Xoro-mirror feeds (`ip_sales_history_wholesale`, `ip_inventory_snapshot`, `bank_transactions`) — write volume + the `source='xoro_mirror'` row IS the audit. Operator confirms in T11-D7.
- Append-only logs themselves (`xoro_mirror_runs`, `gl_period_status_log`, `bank_match_audit`, `user_menu_usage`) — they ARE audit; no need to audit the auditor.
- Search docs and materialized views (`v_global_search`, derived tsvectors) — recomputed, not authored.

---

## 4. API

```
GET  /api/internal/row-changes?entity_type=&entity_pk=
       → time-ordered list of row_changes for a specific entity row.
         Used by <RowHistory>.

GET  /api/internal/row-changes/stream?actor=&entity_type=&source=&from=&to=&action=&limit=
       → cross-entity stream with filters. Used by InternalAuditLog admin panel.
         Joins v_audit_user_resolved for human-readable actor display_name.

POST /api/internal/row-changes/diff
     body: { before_jsonb, after_jsonb }
       → server-computed semantic diff (formats money cents → dollars,
         resolves FK ids → labels via a per-entity-type formatter registry).
         <RowHistory> hits this to render each row's diff with friendly labels.
```

Handlers append-only via [[feedback-routes-js-append-dont-regen]]; numbered after the last shipped handler in main.

**`api/_lib/audit/context.js`:**

```js
// Wraps a mutating handler so the trigger sees the right actor + source + reason.
async function withAuditContext({ supabase, userId, source = 'manual', reason = null, correlationId = null }, fn) {
  await supabase.rpc('set_audit_context', {
    p_user_id: userId, p_source: source, p_reason: reason, p_correlation_id: correlationId
  });
  try {
    return await fn();
  } finally {
    await supabase.rpc('clear_audit_context');
  }
}
```

(`set_audit_context` / `clear_audit_context` are tiny RPCs that wrap `SET LOCAL app.audit_user_id = ...`. Same pattern as P5-1 close trigger.)

Every existing mutating handler picks up audit context with one line:

```js
return withAuditContext({ supabase, userId: auth.user_id, source: 'manual', reason: body.reason }, async () => {
  // ... existing UPDATE / INSERT / DELETE logic unchanged
});
```

T11-2 ships this wiring as a sweep across all internal handlers that mutate v1 entities.

---

## 5. UI primitives

### 5.1 `<RowHistory entity_type entity_id>`

Drops into any detail modal. Self-contained. Vertical timeline (newest first):

```
2026-05-29 14:32  ──  Eran Bitton (employee)        [manual]
                       Updated  • status  unposted → posted
                                 • posted_at  null → 2026-05-29 14:32:00
                       Reason: "Approved by CEO"

2026-05-29 14:30  ──  Eran Bitton                   [manual]
                       Created
                       customer: Walmart  total: $4,200.00  invoice_date: 2026-05-29

2026-05-28 21:34  ──  (system — Xoro mirror)        [xoro_mirror]
                       Updated  • due_date  null → 2026-06-28
```

Component: `src/shared/audit/RowHistory.tsx`. Props: `entity_type`, `entity_id`, optional `compact` (collapsible). Calls `GET /api/internal/row-changes?entity_type=&entity_pk=` on mount.

Diff rendering uses a per-entity-type formatter registry (`src/shared/audit/diffFormatters.ts`):

```ts
export const DIFF_FORMATTERS: Record<string, FieldFormatter> = {
  'ar_invoices.total_amount_cents': (v) => fmtMoneyCents(v),
  'ar_invoices.customer_id': async (v) => `${await resolveCustomerName(v)} (${v})`,
  // ...
};
```

Unknown fields render as raw `key: old → new`.

### 5.2 `<AuditLogPanel>` (admin)

`src/tanda/InternalAuditLog.tsx`. New top-nav group `🕒 Audit Log`. Two views:

- **Stream tab (default)** — cross-entity table with columns `Time | Actor | Entity | Action | Fields changed | Source | Reason`. Filters: entity_type multi-select, actor multi-select (drives off `v_audit_user_resolved`), source multi-select (T10 enum), date range (`<DateRangePresets>` per T7), action checkbox group, free-text search on entity_pk + reason. Universal table export per T3/T8 ([[feedback-universal-table-export]]).
- **Entity tab** — pick an entity_type + paste entity_id, get the full `<RowHistory>` for that one row.

Click any stream row → side-panel showing the full before/after diff with the formatter registry applied.

### 5.3 Detail-modal drop-ins

T11-3 wires `<RowHistory>` into the v1 detail-modal-having panels:

| Panel | Modal | menu_key |
|---|---|---|
| InternalARInvoices | AR invoice detail | `tanda/ar-invoices` |
| InternalARReceipts | AR receipt detail | `tanda/ar-receipts` |
| InternalAPInvoices | AP invoice detail | `tanda/ap-invoices` |
| InternalJournalEntry | JE detail (PR #347) | `tanda/journal-entry` |
| InternalCustomers (Customer Master) | Customer edit | `tanda/customers` |
| InternalVendors (Vendor Master) | Vendor edit | `tanda/vendors` |
| InternalEmployees | Employee edit | `tanda/employees` |
| InternalCases | Case detail | `tanda/cases` |
| InternalCOA | GL account edit | `tanda/coa` |

`<RowHistory>` becomes a third tab (alongside Details + Documents) on every modal that already uses tabs. On modals that don't, it lives at the bottom as a collapsed `<details>` block.

---

## 6. Implementation chunks

| Chunk | Status | Title | Scope | PR |
|---|---|---|---|---|
| **T11-1** | **DONE** | Schema + trigger function + session-var helpers | Migration: `row_changes` table + `audit_row_changes_trigger()` PL/pgSQL function + per-entity trigger attaches for the v1 set (16 tables). Unit tests cover trigger fires on I/U/D, no-op updates skip, D3 reason check, session-var defaults. | #521 |
| **T11-2** | **DONE** | API handlers + handler-sweep wiring | `api/_lib/audit/withAuditContext.js` (`extractActorFromRequest`, `normalizeAuditContext`, `buildAuditRpcParams`, `callWithAudit`, `setAuditSessionVars`, `requireReason`, `withAuditContext`) + four SECURITY DEFINER `_with_audit` RPCs (`void_ar_invoice_with_audit`, `void_ap_invoice_with_audit`, `post_journal_entry_with_audit`, `reverse_journal_entry_with_audit`) + sweep of the AR void / AP void / JE post / JE reverse handlers. | #531 |
| **T11-3** | **DONE** | `<RowHistory>` primitive + `<InternalAuditLog>` admin + detail-modal drop-ins | `src/tanda/components/RowHistory.tsx` + `src/tanda/InternalAuditLog.tsx`. Mounts in 9 detail modals (AR/AP invoice · JE · COA · Periods · Customer · Vendor · Employees · Cases). `🕒 Audit Log` top-nav group with filters + DateRangePresets + export. Two read-only handlers (`/audit/row-history`, `/audit/log`) backing the surfaces. | #537 |
| **T11-4** | **DONE** | User-guide chapter 24 — operator-facing explanation of what T11 captures, what it doesn't, the two surfaces, the D3 reason rule, and the open backlog. | `docs/tangerine/user-guide/24-audit-log.md`. | #544 |
| **T11-4b** | **DONE** | Close-out — arch doc DONE flags + Adoption section + How-to-extend guide, 2 memory feedback files (`feedback_t11_reason_required_on_voids.md`, `feedback_t11_use_with_audit_rpc_for_voids.md`), MEMORY.md index update. | This PR. | — |

**Parallel waves:** T11-1 must ship first (schema gates everything). T11-2 and T11-3 can run in parallel after T11-1 lands, T11-2 driving handler wiring and T11-3 building the UI primitives against the API contract. T11-4 closes after both.

**Estimated ~3-4 days end-to-end** with parallel agents on T11-2 / T11-3.

---

## 7. Adoption plan

| Wave | Coverage | When |
|---|---|---|
| T11-1 ship | 15 v1 entities get audit triggers | day 1 |
| T11-2 ship | All current mutating handlers on v1 entities pass actor through | day 2 |
| T11-3 ship | 9 detail modals show `<RowHistory>` + admin panel live | day 3 |
| T11-5 (future) | Add P11 Shopify entities + P12 marketplace entities to coverage as they ship | with each phase |
| T11-6 (future) | Revert action (operator-locked) | when first requested |

Going forward, the [[feedback-source-tagging-enforcement]] companion rule extends: **every new mutable entity in Tangerine gets its trigger attached in the same migration that creates the table**. Same standing principle as adding `source` and `entity_id`.

---

## 8. Source-tagging integration

T11 leans on T10's `source` enum vocabulary. The `row_changes.source` column uses the same CHECK constraint and the same UI badge (`src/tanda/shared/SourceBadge.tsx`) for visual consistency.

When T10 mirror logic mutates a row, it passes `source='xoro_mirror'` through `withAuditContext`, so the `<RowHistory>` row gets the same badge color as the row itself. Operators see "the Xoro mirror updated this row at 21:34" with one glance.

When a Tangerine handler mutates a row at the operator's request, default `source='manual'` flows through and the badge stays grey. When a future Shopify webhook hits, `source='shopify'` and the badge flips orange. Future P11/P12 integrations get audit coverage **for free** — they just call their existing mutating handler, which is already wrapped in `withAuditContext`, and the trigger does the rest.

See [[feedback-source-tagging-enforcement]] — T11 is the *who* / *when* / *what* layer; T10 is the *which channel* layer. Together they make every row traceable end-to-end without bespoke audit code per integration.

---

## 9. Operator surface

After T11-3 ships, the operator sees:

- **🕒 Audit Log** in the Tangerine top-nav (new group), opening to the cross-entity stream pre-filtered to the last 7 days.
- **History tab** on every detail modal listed in §5.3, showing the per-row timeline. Empty state for rows older than the trigger install date reads "No audit history before 2026-05-29" — by design; no backfill from `audit_logs` legacy table in v1.
- **Source badges** on every audit row (manual / xoro_mirror / shopify / etc.) — same vocabulary as T10 list views.
- **Inline diffs** with friendly labels (`total_amount_cents` shown as `$4,200.00` not `420000`; `customer_id` shown as `Walmart (uuid)` not raw uuid).
- **Universal table export** on the stream view per [[feedback-universal-table-export]] — operator can dump the last 30 days of changes to xlsx for accountant review.
- **Filter persistence** — DateRangePresets remembered per-user via T4 user_preferences.

**Common asks T11 unlocks day-one:**
- "Who voided invoice #1234?" — open the invoice modal, History tab, see the void row + actor + timestamp + reason.
- "What changed on this customer's record yesterday?" — open the customer, History tab.
- "Show me everything Eran touched last week." — Audit Log panel, actor=Eran, last 7 days.
- "Which rows did the Xoro mirror change last night?" — Audit Log panel, source=xoro_mirror, mirror_date.
- "Did anyone change account 1200 AR Control's name?" — open the COA row, History tab.

---

## 10. Adoption (what shipped)

### 10.1 Sixteen covered entities (T11-1 PR #521)

The T11-1 migration attaches `audit_row_changes_trigger()` `AFTER INSERT OR UPDATE OR DELETE` on every row of these 16 tables. The list is also the allowlist enforced by both read handlers (`api/_handlers/internal/audit/row-history.js` and `api/_handlers/internal/audit/log.js`).

| # | `source_table` | Notes |
|---|---|---|
| 1 | `ar_invoices` | header; VOID detected via `gl_status='void'` transition |
| 2 | `ar_invoice_lines` | line table; clusters with header via `correlation_id` |
| 3 | `invoices` | AP header; VOID detected via `gl_status='void'` transition |
| 4 | `invoice_line_items` | AP line table |
| 5 | `journal_entries` | header; POST + REVERSE detected via `status` transitions |
| 6 | `journal_entry_lines` | JE line table |
| 7 | `gl_accounts` | COA |
| 8 | `gl_periods` | period close/reopen |
| 9 | `customers` | customer master |
| 10 | `vendors` | vendor master |
| 11 | `employees` | employee master |
| 12 | `cases` | support cases |
| 13 | `sales_reps` | sales-rep master |
| 14 | `commission_payouts` | commission accruals + payouts |
| 15 | `bank_accounts` | bank account master |
| 16 | `virtual_cards` | the "credit cards" table in the suite (pre-P managed-card provisioning) |

**Operator-confirmed decisions (architecture §14):**
- **D1** — 16 v1 entities including `virtual_cards`. Operator confirmed `virtual_cards` is the credit-cards surface in the current suite (no `payment_methods` table exists yet).
- **D2** — line tables included (`ar_invoice_lines`, `invoice_line_items`, `journal_entry_lines`). Trigger clusters them with their parent via `correlation_id` so "what changed on this invoice" includes the line edits.
- **D3** — `reason` is REQUIRED on `VOID` / `POST` / `REVERSE` operations. The trigger raises `check_violation` when `app.audit_reason` is empty on those operations; the JS-side `requireReason(op, reason)` from `withAuditContext.js` short-circuits to a 400 before the write ever hits the database.

### 10.2 Nine detail modals with `<RowHistory>` drop-in (T11-3 PR #537)

| Panel file | Modal | `source_table` |
|---|---|---|
| `src/tanda/InternalARInvoices.tsx` | AR invoice detail | `ar_invoices` |
| `src/tanda/InternalAPInvoices.tsx` | AP invoice detail | `invoices` |
| `src/tanda/InternalJournalEntry.tsx` | JE detail | `journal_entries` |
| `src/tanda/InternalCOA.tsx` | GL account edit | `gl_accounts` |
| `src/tanda/InternalPeriods.tsx` | Period detail | `gl_periods` |
| `src/tanda/InternalCustomerMaster.tsx` | Customer edit | `customers` |
| `src/tanda/InternalVendorMaster.tsx` | Vendor edit | `vendors` |
| `src/tanda/InternalEmployees.tsx` | Employee edit | `employees` |
| `src/tanda/InternalCases.tsx` | Case detail | `cases` |

Component: `src/tanda/components/RowHistory.tsx`. Self-contained; calls `GET /api/internal/audit/row-history?source_table=&source_id=` on mount.

### 10.3 InternalAuditLog admin panel (T11-3 PR #537)

`src/tanda/InternalAuditLog.tsx` under the `🕒 Audit Log` top-nav group. Cross-entity stream with filters (entity_type, actor, source, date range via T7 `<DateRangePresets>`, operation, free-text search), per-row drill-into `<RowHistory>`, universal table export per T3/T8.

### 10.4 Four audit-aware RPCs (T11-2 PR #531)

Each is `SECURITY DEFINER` with hardened `search_path`. Each combines `set_audit_context()` + the actual write in a single PL/pgSQL statement so the trigger sees the audit context (the supabase-js connection pool means `SET LOCAL` from one `.rpc()` call does NOT survive into a separate `.update()` call).

| RPC | Returns | Purpose |
|---|---|---|
| `void_ar_invoice_with_audit(invoice_id, audit_*)` | `{invoice_id, gl_status, previous_gl_status}` | Flips `ar_invoices.gl_status='void'` with audit context |
| `void_ap_invoice_with_audit(invoice_id, audit_*)` | same shape | Flips `invoices.gl_status='void'` with audit context |
| `post_journal_entry_with_audit(je_id, audit_*)` | `{je_id, status, previous_status}` | Flips `journal_entries.status='posted'`, stamps `posted_at` |
| `reverse_journal_entry_with_audit(je_id, reversal_je_id, audit_*)` | `{je_id, status, reversal_je_id, previous_status}` | Flips `journal_entries.status='reversed'`, stamps `reversed_by_je_id` |

The `audit_*` parameter prefix (`audit_actor_auth_id`, `audit_actor_employee_id`, `audit_actor_display_name`, `audit_source`, `audit_reason`, `audit_correlation_id`) is built by `buildAuditRpcParams({actor, source, reason, correlation_id})` from `api/_lib/audit/withAuditContext.js`.

---

## 11. How to extend coverage

Three steps to add a new entity to the T11 audit ledger:

**Step 1 — Attach the trigger in a follow-up migration:**

```sql
CREATE TRIGGER audit_row_changes
  AFTER INSERT OR UPDATE OR DELETE ON <new_table>
  FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger();
```

The function `audit_row_changes_trigger()` was created idempotently in T11-1 and is reused for every covered table — never modify the function to add per-entity logic; if you need operation detection (like the `gl_status='void'` → `VOID` mapping on `ar_invoices`), follow the pattern at the top of the function and extend the `IF` ladder.

**Step 2 — Add the table to the allowlist in both read handlers:**

```js
// api/_handlers/internal/audit/row-history.js
export const T11_ALLOWED_SOURCE_TABLES = [
  "ar_invoices",
  // ... existing 16 ...
  "<new_table>",                       // ← add here
];
```

`api/_handlers/internal/audit/log.js` imports `T11_ALLOWED_SOURCE_TABLES` from `row-history.js`, so a single addition covers both surfaces. The allowlist is what stops a misspelled `source_table` from quietly returning an empty stream.

**Step 3 — (Optional) Drop `<RowHistory>` into the detail modal:**

```tsx
import { RowHistory } from "../components/RowHistory";

// inside the detail modal body, typically at the bottom:
<RowHistory source_table="<new_table>" source_id={row.id} />
```

The component is self-contained — no extra props needed beyond the two source fields. Empty-state ("No audit history. Changes will appear here as they happen.") is built in.

**If the entity needs operation detection (VOID / POST / REVERSE):**

Add a new `ELSIF` arm to the `IF (TG_OP = 'UPDATE')` block inside `audit_row_changes_trigger()`. Bump the migration with `CREATE OR REPLACE FUNCTION` (the trigger function is idempotent). The trigger writes the resolved `operation` into `row_changes.operation`, which is what the `🕒 Audit Log` panel filters by and what the D3 reason-required check keys off of.

**If the entity does NOT have an `entity_id` column:**

The trigger reads `entity_id` out of `to_jsonb(NEW)` / `to_jsonb(OLD)` with a soft cast; missing columns leave `row_changes.entity_id = NULL`. That works but loses the per-entity scoping in the admin panel. Recommended: add an `entity_id uuid REFERENCES entities(id)` column to the new table FIRST, then attach the trigger. Every covered v1 entity is `entity_id`-scoped.

---

## 12. Risks

- **Trigger write overhead.** Every UPDATE on a covered table doubles writes (the row + the audit row). v1 entities are low-volume (~hundreds to thousands of rows/day combined), so impact is sub-percent. Mitigation: high-volume tables stay out of v1 (`bank_transactions`, `ip_inventory_snapshot`). If a v1 entity becomes hot, drop the trigger via a one-line migration; no data loss, just gap.
- **`before_jsonb` blob size on wide tables.** A row with 50 columns × 100 chars = ~5KB; 10k changes/yr × 5KB = ~50MB/yr. Acceptable. Mitigation: jsonb compression on the column is native to Postgres TOAST.
- **Session vars vs connection pool.** Supabase's PgBouncer pooler runs in transaction mode — `SET LOCAL` inside a transaction is safe. The `withAuditContext` wrapper opens a tx around every mutating call so session vars stay scoped. **Test:** T11-1 explicitly tests that a parallel call from another user doesn't leak its session vars into the first user's transaction.
- **Raw SQL ops bypass the trigger context.** Operator pasting SQL in the Supabase dashboard produces audit rows with `actor=NULL, source='manual'`. We mark these in the UI as "(no actor — raw SQL)" with a yellow chip so it's clear that the row was made outside the app. Acceptable; it's the truth.
- **Trigger silently fails on entities without `entity_id`.** A few covered tables (`gl_accounts`, `employees`) DO have entity_id; lines tables (`ar_invoice_lines`, `journal_entry_lines`) also do. Re-checked — the v1 set is uniformly entity-scoped. If a future opt-in entity lacks `entity_id`, the trigger raises a clear error during attach time (the `to_jsonb(NEW)->>'entity_id'::uuid` cast fails), forcing the team to add `entity_id` first.
- **Reverts to a row aren't atomic across child rows.** A "revert this invoice" action needs to revert the header AND its lines. Punted to T11-6 with a `correlation_id` design path already in v1 schema.
- **Audit-of-audit infinite loop.** `row_changes` itself isn't in the trigger set, so insert into `row_changes` doesn't re-fire the trigger. Verified by explicit non-coverage list in §3.

---

## 13. Tests

- **T11-1 (trigger):** insert → row_changes has after_jsonb only; update → before + after + changed_fields; delete → before_jsonb only; no-op update (same values) → no row_changes row; session var actor flows through; missing session var → actor NULL; raw SQL update outside `withAuditContext` → actor NULL, source 'manual' default; correlation_id propagates.
- **T11-2 (API):** GET per-entity returns time-ordered list; GET stream filters by actor / source / date / action / entity_type; POST diff formats money cents → dollars; auth gates per standard internal-handler pattern; entity_id RLS scope (each user sees only their entity).
- **T11-3 (UI):** `<RowHistory>` renders empty state cleanly; renders diff with formatter registry; renders raw key:old→new for unknown fields; reason display when present; source badge color matches T10 vocabulary; `<AuditLogPanel>` filters apply; DateRangePresets refetches; export button produces xlsx with right columns.

Target: ~100 new tests across T11-1 (~25), T11-2 (~40), T11-3 (~35). Full suite stays green.

---

## 14. References

- `docs/tangerine/T10-shadow-mirror-architecture.md` §1+§2 — source-tagging schema pattern and [[feedback-source-tagging-enforcement]] precedent.
- `docs/tangerine/P2-cross-cutters-architecture.md` — M30 employees + `v_audit_user_resolved` view that T11 reuses for actor display.
- `docs/tangerine/P5-close-core-financials-architecture.md` — `gl_period_status_log` trigger that audit_row_changes_trigger is patterned after.
- `docs/tangerine/T4-personalization-architecture.md` — FavoriteStar + SetAsHomeButton primitives the audit panel adopts.
- `docs/tangerine/T6-global-search-architecture.md` — registry pattern (per-entity formatters) parallel to diffFormatters.ts.
- `docs/tangerine/T7-date-range-presets-architecture.md` — DateRangePresets the stream view drops in.
- `CURRENT-SCHEMA.md` — existing `audit_logs` / `bank_match_audit` / `gl_period_status_log` / `entity_access_audit` shapes that T11 supersedes (audit_logs) or coexists with (the rest).

---

## 15. ETA

~3-4 days end-to-end with parallel agents on T11-2 + T11-3 after T11-1 lands. T11-1 is one paste bundle + one merged PR. Comparable to T10 in shape and density.

---

## 16. Operator ask — five things to confirm before T11-1 kicks off

1. **Entity coverage in v1 (§0 in-scope + §3 trigger attaches).** The 15 entities chosen are the operator-asked surface (AR/AP/JE/COA/Periods/Customers/Vendors/Employees/Cases/SalesReps/CommissionPayouts/BankAccounts). Any *must-have additions* before T11-1 ships? Anything you'd *deliberately drop*? My recommendation is to ship exactly this set; future entities opt in via one-line migration.
2. **Legacy `audit_logs` table fate.** Keep as-is (read-only historical) per T11 §0 OUT-of-scope? Or do you want T11-4 to backfill it into `row_changes` so the audit panel shows a single unified history? My recommendation is keep-as-is; backfill is fiddly and low-value (the legacy table is sparsely written).
3. **Coverage of the line tables (`ar_invoice_lines`, `journal_entry_lines`).** These produce ~4-10× the row volume of their headers. v1 plan covers them so "what changed on this invoice" includes line edits. Confirm OK? Or restrict v1 to header-only and add lines in v1.1 if needed?
4. **Operator-typed reason field.** When voiding / posting / overriding, do you want a *required* `reason` prompt? My recommendation is *optional* for v1 — required-reason is a bigger UX shift (every void modal needs a reason textbox); can ship as a follow-up.
5. **Audit Log panel placement.** New top-nav group `🕒 Audit Log` (its own group) vs nested under existing **Administration** group? My recommendation is its own group — it's a cross-domain surface, not admin-specific.

Once confirmed, ~3-4 days to ship.

---

## 17. Pairs with

- **`T10-shadow-mirror-architecture.md`** — source-tagging precedent; T11 reuses the enum + badge.
- **`P2-cross-cutters-architecture.md`** — M30 employees + `v_audit_user_resolved` view.
- **`P5-close-core-financials-architecture.md`** — `gl_period_status_log` trigger pattern.
- **Memory: standing principle — every external integration uses `source` enum + UI badge** ([[feedback-source-tagging-enforcement]]).
- **Memory: standing principle — every list view ships with universal table export** ([[feedback-universal-table-export]]).
