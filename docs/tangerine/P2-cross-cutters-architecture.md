# Tangerine P2 — Cross-Cutters Architecture Pass

**Codename:** Tangerine
**Phase:** P2 Cross-Cutters
**Modules:** M27 Workflow/Approvals · M28 Notifications · M29 Document Management · M30 HR/Employee Master
**Status:** Architecture only — no code yet. Per [[feedback-plan-approval-not-implementation]], this document is the deliverable. Wait for explicit operator approval before kicking off chunks.
**Date:** 2026-05-27
**Inputs:** P1 Foundation merged + applied to prod 2026-05-26 (see `P1-foundation-architecture.md` and `project_tangerine_progress.md`). Per locked decision #7 from the roadmap, all four cross-cutters ship together in P2.

---

## 0. Scope guardrails

This pass produces:

1. Concrete table schemas (columns, types, FKs, indexes) for every new table P2 adds.
2. Concrete extensions to existing tables (`entity_users`, future M3/M4 tables anticipated).
3. The canonical RLS policy reuse — P2 follows P1's `anon_all` + `auth_internal_*` template (no new pattern).
4. Hook contracts: how downstream modules (M3 AP, M4 AR, M11 PO, etc.) wire INTO approvals and notifications.
5. Document storage backend decision (Supabase Storage — backed below).
6. A precise list of files to create / extend and in which order.
7. Verification criteria — what proves P2 is "done."

This pass does **not** produce:

- Any SQL migration file (P2 implementation is a separate pass per chunk).
- Any TypeScript code.
- The full approval-rule DSL — only the data model + MVP rule shapes. Rule authoring UI is a P2 follow-up.
- Notification channel decisions beyond in-app + email at launch (push/SMS deferred).
- HR payroll / benefits / time tracking (those are stretch-post-launch per roadmap §41).

---

## 1. Existing state (one-paragraph map)

Tangerine P1 lives at `/tangerine` with MS-OAuth gate. 6 admin modules wired (Style/Vendor/Customer Master + COA + Periods + Journal Entry) using the `Internal*.tsx` panel pattern. `entities` extended with code/currency/fiscal_year_start_month/posting_locked_through. `entity_users(entity_id, user_id, role, is_active)` junction is the SOURCE OF TRUTH for who can see what — referenced by every `auth_internal_*` RLS policy in P1. **There is no employee record today** — `entity_users.user_id` points to `auth.users(id)` but carries no name/email/title/manager/department metadata. There is no approval routing, no notification log, no document attachment table anywhere. `pi_documents` and `pi_document_versions` exist on the planning side but are scoped to PO documents only (PDFs + packing lists). No reusable doc-management abstraction. Every transactional table has `created_by_user_id` from P1 (per arch §2 row 7), so authorship is already in place — but display-name resolution requires the M30 table.

---

## 2. Decisions feeding this pass

| # | Decision | Source | Impact |
|---|---|---|---|
| 1 | All 4 cross-cutters ship together in P2 | Roadmap locked-decision §7 | One arch pass, four migration chunks |
| 2 | Document storage backend: **Supabase Storage** | This doc §6.2 | No external S3 contract; keep storage co-located with auth + RLS |
| 3 | Notification channels at launch: **in-app + email only** | This doc §5.2 | Defer push/SMS; one `notification_channel` enum value per row |
| 4 | Approval rule MVP types: **threshold-based + role-based**, additive (any rule that matches fires) | This doc §4.2 | DSL is JSONB-rule-spec (no DSL parser MVP) |
| 5 | M30 stores employees as Tangerine-owned rows; `auth.users` link is optional | This doc §7.1 | An employee can exist without an auth account (contractor, future hire). `auth.users` is for login binding only. |
| 6 | All 4 modules ride on **P1's RLS template** | P1 §3.3 | No new policy pattern. `anon_all` + `auth_internal_*` via `entity_users` subquery. |
| 7 | Approvals are **synchronous request → async decision**, not a state machine engine | This doc §4.1 | Each `approval_requests` row carries its own context; no global workflow runtime. Easy to extend; no engine to maintain. |
| 8 | All 4 modules expose **hooks contract**, not direct foreign keys from M3/M4 | This doc §8 | Posting service in M3/M4 calls `approvalsAPI.requestIfRequired(...)` — does not depend on the schema. Loose coupling. |

---

## 3. Why these four belong together in P2

These modules are all **horizontal infrastructure** — every accounting / sales / procurement module after P2 reads from or writes to them. Shipping them after the accounting core (P3+) would force schema churn into every transactional table. Shipping them BEFORE accounting core ensures:

- M3 AP can call `approvalsAPI.requestIfRequired({ kind: 'ap_invoice', amount, ... })` from day one
- M4 AR can attach documents (signed contracts, deposit confirmations) without bolting on `document_id` later
- Every posting event can fire a `notifications.enqueue({ event, recipients, ... })` call so the accountant + CEO get pings without polling
- Every audit log entry can resolve `created_by_user_id` to a real human name via `employees`

The cost of putting cross-cutters in P2 (delaying AP/AR by ~4-6 weeks) is paid back ~10× across P3–P25.

---

## 4. M27 Workflow/Approvals

### 4.1 Conceptual model

A **request** is a "this needs approval before it can proceed" record. It does NOT lock the underlying entity — the calling code decides whether to allow soft-save vs hard-block. Each request carries:

- `kind` (text discriminator: `ap_invoice`, `je_post`, `po_release`, `customer_credit_limit`, etc.)
- `context_table` + `context_id` (which row this is about)
- `requested_amount` (NULL for non-monetary requests; cents BIGINT for monetary)
- A rules-resolved list of **steps** — each step is one or more approvers in a `required` (all) or `any` (one of) mode
- `status`: `pending` / `approved` / `rejected` / `cancelled` / `expired`
- A `decisions[]` audit trail of who approved/rejected what at what time

The engine is intentionally **flat** — no Petri nets, no BPMN. Each step is a row in `approval_request_steps` with a `step_order` int. The first unfulfilled step is the "current" step. When the last step fulfills, the request flips to `approved`.

### 4.2 MVP rule shapes (additive, JSONB-typed)

```jsonc
// ap_invoice: any invoice > $5k requires CFO approval (single approver)
{
  "kind": "ap_invoice",
  "match": { "min_amount_cents": 500000 },
  "steps": [
    { "step_order": 1, "mode": "any", "role_required": "cfo" }
  ]
}

// je_post: any manual JE requires CEO + CFO both
{
  "kind": "je_post",
  "match": { "source_kind": "manual" },
  "steps": [
    { "step_order": 1, "mode": "any", "role_required": "ceo" },
    { "step_order": 2, "mode": "any", "role_required": "cfo" }
  ]
}

// po_release: any PO > $25k OR with vendor flagged as new requires CEO
{
  "kind": "po_release",
  "match": { "or": [{ "min_amount_cents": 2500000 }, { "vendor_new": true }] },
  "steps": [
    { "step_order": 1, "mode": "any", "role_required": "ceo" }
  ]
}
```

Rules live in `approval_rules` rows (one per JSONB spec). On `approvalsAPI.requestIfRequired({...})`, every matching rule contributes its steps; if any rule matched, a `approval_requests` row is created with those steps in `step_order` order (deduped by role + mode). If no rule matched, the call returns `{ required: false }` and the caller proceeds.

**Why JSONB rules instead of a tabular rule schema:** rule complexity is open-ended (amount AND vendor AND department, etc.). A JSONB spec with a small set of supported operators (`min_amount_cents`, `max_amount_cents`, `vendor_new`, `entity_id`, `or`, `and`) covers Phase 1 needs without committing to a tabular shape that breaks at the next requirement.

### 4.3 Schema

#### `approval_rules`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | `gen_random_uuid()` |
| `entity_id` | uuid FK entities(id) | NOT NULL | RLS scope |
| `kind` | text | NOT NULL | Discriminator. CHECK against known list (extended via migration when new kinds added). |
| `name` | text | NOT NULL | Human label ("CFO approval > $5k") |
| `match` | jsonb | NOT NULL DEFAULT `'{}'::jsonb` | Match spec; empty = match all |
| `steps` | jsonb | NOT NULL | Array of `{step_order, mode, role_required}` |
| `is_active` | boolean | NOT NULL DEFAULT `true` | Inactive rules are skipped at match-time |
| `created_at` / `updated_at` / `created_by_user_id` | std | — | Audit |

Index: `(entity_id, kind, is_active)` partial WHERE `is_active = true`.

#### `approval_requests`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `entity_id` | uuid FK entities(id) | NOT NULL | RLS |
| `kind` | text | NOT NULL | Mirrors rule.kind |
| `context_table` | text | NOT NULL | e.g. `invoices`, `journal_entries` |
| `context_id` | uuid | NOT NULL | Row id in `context_table` |
| `requested_amount_cents` | bigint | NULL | NULL for non-monetary |
| `currency` | char(3) | NOT NULL DEFAULT `'USD'` | |
| `status` | text | NOT NULL DEFAULT `'pending'` | CHECK in (`pending`,`approved`,`rejected`,`cancelled`,`expired`) |
| `final_decided_at` | timestamptz | NULL | Set when `status != 'pending'` |
| `expires_at` | timestamptz | NULL | Optional; nightly job moves `pending → expired` past this |
| `payload` | jsonb | NOT NULL DEFAULT `'{}'::jsonb` | Snapshot of the requesting row for audit (so deletes/edits don't lose context) |
| `created_at` / `created_by_user_id` | std | — | |

Indexes: `(entity_id, status)`, `(context_table, context_id)`, `(kind, status)` partial.

#### `approval_request_steps`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `request_id` | uuid FK approval_requests(id) ON DELETE CASCADE | NOT NULL | |
| `step_order` | smallint | NOT NULL | 1-based |
| `mode` | text | NOT NULL | `any` or `all` (CHECK) |
| `role_required` | text | NOT NULL | Resolved against `entity_users.role` at decision time |
| `fulfilled_at` | timestamptz | NULL | NULL = current/pending |
| `fulfilled_by_user_id` | uuid FK auth.users(id) | NULL | |
| `notes` | text | NULL | Approver comment |

UNIQUE `(request_id, step_order)`.

#### `approval_decisions`

Append-only audit. Even when a step is "fulfilled by user X," there may have been earlier rejections / re-routes; this table preserves the full trace.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `request_id` | uuid FK approval_requests(id) ON DELETE CASCADE | NOT NULL | |
| `step_id` | uuid FK approval_request_steps(id) | NOT NULL | |
| `decision` | text | NOT NULL | `approve` / `reject` / `request_changes` |
| `decided_by_user_id` | uuid FK auth.users(id) | NOT NULL | |
| `decided_at` | timestamptz | NOT NULL DEFAULT `now()` | |
| `notes` | text | NULL | |

Index: `(request_id, decided_at DESC)`.

### 4.4 Posting trigger guard (M2 GL hook)

The existing `journal_entries` posting trigger (Chunk 2) gets one new guard:

```
IF NEW.status = 'posted' AND EXISTS (
  SELECT 1 FROM approval_requests
   WHERE context_table = 'journal_entries'
     AND context_id = NEW.id
     AND status = 'pending'
) THEN
  RAISE EXCEPTION 'JE % cannot post while approval request is pending', NEW.id
    USING ERRCODE = '23514';
END IF;
```

Same shape for AP invoice posting, PO release, etc. — each posting trigger picks up a `pending_approval_gate` defense.

### 4.5 API surface (preview — finalized in implementation pass)

```js
// api/_lib/approvals/index.js
approvalsAPI.requestIfRequired({ kind, entity_id, context_table, context_id, amount_cents, payload })
  // → { required: false } | { required: true, request_id, current_step }

approvalsAPI.decide({ request_id, step_id, decision, notes }, { actor_user_id })
  // → { request: ApprovalRequest, finalized: boolean }

approvalsAPI.cancel({ request_id }, { actor_user_id })
  // → { request: ApprovalRequest }
```

### 4.6 Admin UI surface

- `src/tanda/InternalApprovalRules.tsx` — CRUD on `approval_rules` (kind/name/match/steps editor, active toggle)
- `src/tanda/InternalApprovalRequests.tsx` — pending request inbox for the current user (filtered by `role_required` match against their `entity_users.role`). Approve/reject inline.

Wired into Tangerine.tsx as two new module buttons under a single "Approvals" group.

---

## 5. M28 Notifications

### 5.1 Conceptual model

Notifications are events fanned out to recipients via channels. The schema separates the **event** (what happened, immutable) from the **dispatch** (one row per channel per recipient, mutable status). This lets us replay a missed email, change channel preferences, or query "who saw what when" without re-deriving the event.

### 5.2 Channels at launch

- `in_app` — surfaced in a top-nav badge on `/tangerine` (poll every 60s or use Supabase Realtime subscription)
- `email` — via the existing SMTP plumbing in `rof_xoro_project` (or a new Tangerine-owned sender; see §5.5)

Deferred: `push` (web push API), `sms` (Twilio etc.), `digest` (daily roll-up).

### 5.3 Schema

#### `notification_events`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `entity_id` | uuid FK entities(id) | NOT NULL | RLS |
| `kind` | text | NOT NULL | e.g. `ap_invoice_approved`, `je_posted`, `period_closed`, `approval_requested` |
| `severity` | text | NOT NULL DEFAULT `'info'` | CHECK in `info`/`warn`/`error` |
| `subject` | text | NOT NULL | Short headline |
| `body` | text | NOT NULL | Markdown |
| `context_table` | text | NULL | Optional link target |
| `context_id` | uuid | NULL | |
| `payload` | jsonb | NOT NULL DEFAULT `'{}'::jsonb` | For template substitution + audit |
| `created_at` / `created_by_user_id` | std | — | |

Index: `(entity_id, kind, created_at DESC)`.

#### `notification_dispatches`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `event_id` | uuid FK notification_events(id) ON DELETE CASCADE | NOT NULL | |
| `recipient_user_id` | uuid FK auth.users(id) | NOT NULL | |
| `channel` | text | NOT NULL | `in_app` / `email` (CHECK) |
| `status` | text | NOT NULL DEFAULT `'pending'` | `pending`/`sent`/`read`/`failed` |
| `sent_at` | timestamptz | NULL | |
| `read_at` | timestamptz | NULL | `in_app` only |
| `error_message` | text | NULL | |

Indexes: `(recipient_user_id, status, channel)` partial WHERE `status IN ('pending','sent')`, `(event_id)`.

#### `notification_preferences`

Per-user opt-in/out per `(kind, channel)`. Defaults to opt-in for all kinds the user has visibility into (via `entity_users.role`).

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `user_id` | uuid FK auth.users(id) ON DELETE CASCADE | NOT NULL | |
| `kind` | text | NOT NULL | |
| `channel` | text | NOT NULL | |
| `enabled` | boolean | NOT NULL DEFAULT `true` | |
| PRIMARY KEY | `(user_id, kind, channel)` | | |

### 5.4 Fan-out logic

```js
// api/_lib/notifications/index.js
notificationsAPI.enqueue({
  entity_id, kind, severity, subject, body, context_table, context_id, payload,
  recipients,         // explicit list of user_ids
  recipient_roles,    // optional: also fan out to anyone in entity_users with these roles
})
```

Insert one `notification_events` row + one `notification_dispatches` row per (recipient × enabled channel). Dispatch rows start `status='pending'`; a worker (Vercel cron or Supabase Edge Function) picks up pending email rows and sends. `in_app` rows are marked `sent` synchronously since they just need to exist for the UI to query.

### 5.5 Email delivery

Two options, decided in implementation pass:
- **(A) Reuse `rof_xoro_project` SMTP plumbing.** Same Office365 sender, same per-mailbox auth. Pro: zero new config. Con: cross-process coupling.
- **(B) Tangerine-owned email via Resend / Supabase SMTP.** Clean separation, native to the app, dedicated sender domain (e.g. `notifications@ringoffireclothing.com`). Recommend B for hygiene.

### 5.6 Admin UI surface

- `src/tanda/InternalNotificationCenter.tsx` — user's in-app inbox (filterable by kind/severity/read state)
- `src/tanda/InternalNotificationPreferences.tsx` — user's per-(kind,channel) opt-in/out matrix
- (No admin-of-all-notifications panel — that's BI/observability, deferred to P24)

---

## 6. M29 Document Management

### 6.1 Conceptual model

A reusable attachment system: any row in any table can have any number of documents linked. A document has versions; the latest version is the canonical one. Stored bytes live in Supabase Storage; the DB only stores metadata + URLs.

### 6.2 Storage backend: Supabase Storage

**Rationale:**
- Already in the stack — no new vendor.
- RLS policies on the bucket can mirror our `entity_users` template directly.
- Signed URLs (short-TTL) protect against link sharing outside the app.
- The existing `pi_documents` PO doc system has proven the pattern (PDF + packing list uploads from vendor portal). M29 generalizes it.

**Buckets:**
- `tangerine-documents` — primary bucket for all P2+ attachments. Folder structure: `<entity_id>/<context_table>/<context_id>/<version_id>.<ext>`
- Pre-existing `pi-documents` bucket stays for backward compat; M29 does NOT migrate it. Future cleanup task.

### 6.3 Schema

#### `documents`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `entity_id` | uuid FK entities(id) | NOT NULL | RLS |
| `context_table` | text | NOT NULL | `invoices`, `customers`, `vendors`, `journal_entries`, etc. |
| `context_id` | uuid | NOT NULL | |
| `kind` | text | NOT NULL | `contract`, `invoice_pdf`, `signed_po`, `packing_list`, `compliance_doc`, free-form text |
| `title` | text | NOT NULL | Human label |
| `current_version_id` | uuid FK document_versions(id) DEFERRABLE | NULL | NULL until first version uploaded; FK cycle handled with DEFERRABLE |
| `is_archived` | boolean | NOT NULL DEFAULT `false` | Soft delete |
| `created_at` / `created_by_user_id` | std | — | |

Indexes: `(entity_id, context_table, context_id)`, `(kind)`.

#### `document_versions`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `document_id` | uuid FK documents(id) ON DELETE CASCADE | NOT NULL | |
| `version_number` | int | NOT NULL | Auto-increment via trigger per `document_id` |
| `storage_path` | text | NOT NULL | Path in Supabase Storage bucket |
| `mime_type` | text | NOT NULL | |
| `byte_size` | bigint | NOT NULL | |
| `sha256_hex` | text | NOT NULL | For dedup detection; not unique-constrained (different doc IDs can legitimately share bytes) |
| `notes` | text | NULL | |
| `created_at` / `created_by_user_id` | std | — | |

UNIQUE `(document_id, version_number)`.

### 6.4 API surface

```js
// api/_lib/documents/index.js
documentsAPI.attach({ entity_id, context_table, context_id, kind, title }, fileStream, { mime, byteSize })
  // → { document, version }   uploads bytes + creates document + version row, updates current_version_id

documentsAPI.list({ entity_id, context_table, context_id })       // → [{document, current_version}]
documentsAPI.signedUrl({ document_id, ttl_seconds = 300 })        // → signed Supabase Storage URL
documentsAPI.archive({ document_id })                              // → { document }
documentsAPI.uploadVersion(document_id, fileStream, { mime, byteSize, notes })
  // → { version }   sets new current_version_id atomically
```

### 6.5 UI surface

`src/shared/documents/DocumentAttachmentList.tsx` — reusable React component: list + upload + version history + download (signed-URL fetch). Drops into any panel (Vendor master, Invoice editor, JE editor, etc.) via:

```jsx
<DocumentAttachmentList contextTable="vendors" contextId={vendor.id} kinds={['contract','w9','coa']} />
```

No top-nav "Documents" module — this is purely embedded inside other panels.

---

## 7. M30 HR/Employee Master

### 7.1 Conceptual model

`employees` is a Tangerine-owned record per person (employee, contractor, vendor contact who logs in). The link to `auth.users` is optional — an employee can exist without a login. This matters because:

- Future hires can be pre-seeded with manager + department + start date before their account is provisioned
- Contractors / consultants may have audit-trail references (`created_by_employee_id`) without having app access
- One person ≠ one auth user in firm-mode (CPA accountant may have multiple seat users; one employee record per accountant individual)

### 7.2 Schema

#### `employees`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `entity_id` | uuid FK entities(id) | NOT NULL | RLS |
| `auth_user_id` | uuid FK auth.users(id) ON DELETE SET NULL | NULL | Optional binding to Supabase Auth account |
| `code` | text | NOT NULL | Short identifier (e.g. `EB001`); UNIQUE per `entity_id` |
| `first_name` | text | NOT NULL | |
| `last_name` | text | NOT NULL | |
| `display_name` | text | GENERATED ALWAYS AS (first_name \|\| ' ' \|\| last_name) STORED | Convenience for joins/UI |
| `email` | text | NOT NULL | UNIQUE per `entity_id` |
| `title` | text | NULL | |
| `department` | text | NULL | Free-form for now; convert to FK later if a `departments` table emerges |
| `manager_employee_id` | uuid FK employees(id) ON DELETE SET NULL | NULL | Self-ref for reporting chain |
| `hire_date` | date | NULL | |
| `termination_date` | date | NULL | Soft-end |
| `is_active` | boolean | NOT NULL DEFAULT `true` | Manually toggled or auto-flipped on termination |
| `phone` | text | NULL | |
| `metadata` | jsonb | NOT NULL DEFAULT `'{}'::jsonb` | Extension point |
| `created_at` / `updated_at` / `created_by_user_id` | std | — | |

UNIQUE `(entity_id, code)`, UNIQUE `(entity_id, email)`. Index `(entity_id, is_active)`, `(auth_user_id)` partial WHERE NOT NULL.

CHECK: `(termination_date IS NULL) OR (termination_date >= hire_date)`.

#### `employee_roles` (junction; OPTIONAL — may collapse into `entity_users` instead)

The roadmap has `entity_users` already carrying `role`. We have two options:

- **(A)** Keep roles on `entity_users` as today. `employees.auth_user_id` joins to `auth.users.id`, which joins to `entity_users.user_id` → role visible. **Pro:** no new table. **Con:** an employee without an `auth_user_id` has no role record anywhere.
- **(B)** Add `employee_roles(employee_id, entity_id, role, is_active)`. Decouples role from auth account. **Pro:** future-proof. **Con:** dual source of truth — risk of `entity_users.role` and `employee_roles.role` drifting.

**Recommendation:** Option A for P2. Defer (B) to a future chunk if firm-mode actually lands and demands it.

### 7.3 Backfill

One-time data migration when M30 lands:

1. Insert one `employees` row per known internal user (CEO = Eran, accountant TBD, etc.). The seed is small (single-digit count today).
2. Set `auth_user_id` from `auth.users.id` via email match.
3. Leave `manager_employee_id` NULL; set after operator review.

### 7.4 Display-name resolution view

Every `created_by_user_id` in the schema becomes joinable to a display name via:

```sql
CREATE VIEW v_audit_user_resolved AS
SELECT u.id            AS user_id,
       u.email         AS email,
       e.display_name  AS display_name,
       e.code          AS employee_code,
       e.title         AS title
  FROM auth.users u
  LEFT JOIN employees e ON e.auth_user_id = u.id;
```

This view is read everywhere we need to render "Eran Bitton" instead of a UUID. RLS-respecting via cascading policies on `employees`.

### 7.5 Admin UI surface

- `src/tanda/InternalEmployees.tsx` — full CRUD: list, search, add, edit, activate/deactivate, manager-chain editor (dropdown of other employees)
- No payroll fields. No time tracking. No benefits. Those are stretch-post-launch (roadmap §41).

---

## 8. Hooks contract (how downstream modules wire in)

The four cross-cutters expose **API-only** interfaces. Downstream modules (M3 AP, M4 AR, etc.) call those APIs and do NOT take direct foreign keys on `approval_requests`, `notification_events`, or `documents`. This is critical for loose coupling.

### 8.1 Approvals hook

```js
// In M3 AP invoice persist:
const approvalCheck = await approvalsAPI.requestIfRequired({
  kind: 'ap_invoice',
  entity_id: invoice.entity_id,
  context_table: 'invoices',
  context_id: invoice.id,
  amount_cents: invoice.total_cents,
  payload: { vendor_id: invoice.vendor_id, vendor_name: invoice.vendor_name },
});

if (approvalCheck.required) {
  // Save invoice in 'pending_approval' status; do not post to GL yet
  return { invoice, approval_request_id: approvalCheck.request_id };
} else {
  // Proceed with GL posting
}
```

When the approval resolves, a webhook (or DB trigger fan-out) flips the invoice's status and posts to GL.

### 8.2 Notifications hook

```js
// On JE posted:
await notificationsAPI.enqueue({
  entity_id: je.entity_id,
  kind: 'je_posted',
  severity: 'info',
  subject: `JE ${je.entry_number} posted ($${formatCents(je.total_cents)})`,
  body: `...`,
  context_table: 'journal_entries',
  context_id: je.id,
  recipient_roles: ['ceo','cfo','accountant'],
});
```

### 8.3 Documents hook

```jsx
// In VendorMasterPanel detail view:
<DocumentAttachmentList
  contextTable="vendors"
  contextId={vendor.id}
  kinds={['contract','w9','coa','insurance']}
/>
```

### 8.4 Employee hook

```js
// Any time we render an audit author:
SELECT v.display_name FROM v_audit_user_resolved v WHERE v.user_id = $created_by_user_id
```

---

## 9. RLS — reuse P1 template

No new RLS pattern. Each new table follows P1 §3.3:

```sql
CREATE POLICY "anon_all_<table>" ON <table>
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_<table>" ON <table>
  FOR ALL TO authenticated
  USING (entity_id IN (SELECT entity_id FROM entity_users WHERE user_id = auth.uid() AND is_active = true))
  WITH CHECK (entity_id IN (SELECT entity_id FROM entity_users WHERE user_id = auth.uid() AND is_active = true));
```

Exceptions:
- `notification_preferences` is keyed on `user_id`, not `entity_id` — its `auth_internal_*` policy uses `user_id = auth.uid()`.
- `approval_decisions` is append-only — `auth_internal_*` allows INSERT but not UPDATE/DELETE (separate policies per command).
- Supabase Storage policies on `tangerine-documents` bucket: `auth.uid() IN (SELECT user_id FROM entity_users WHERE entity_id = (storage.foldername(name))[1]::uuid)`.

---

## 10. Chunk split (implementation pass — DO NOT START until approved)

Mirroring the P1 chunking pattern (one migration + one handler + one panel per chunk):

- **Chunk P2-1 — M27 schema + posting trigger guard**
  - Migration: `approval_rules`, `approval_requests`, `approval_request_steps`, `approval_decisions` + indexes + RLS
  - Migration: `journal_entries` posting trigger: add `pending_approval_gate`
  - `api/_lib/approvals/index.js` (requestIfRequired / decide / cancel)
  - 20+ unit tests for matcher logic
- **Chunk P2-2 — M27 admin UI**
  - `api/_handlers/internal/approval-rules/` (h26x/h26x)
  - `api/_handlers/internal/approval-requests/` (h26x/h26x)
  - `src/tanda/InternalApprovalRules.tsx`
  - `src/tanda/InternalApprovalRequests.tsx`
  - Tangerine.tsx nav wiring
  - User-guide chapter
- **Chunk P2-3 — M28 schema + dispatcher**
  - Migration: `notification_events`, `notification_dispatches`, `notification_preferences` + indexes + RLS
  - `api/_lib/notifications/index.js` (enqueue + per-channel dispatchers)
  - Vercel cron worker to drain pending email dispatches (or Supabase Edge Function — TBD)
  - Smoke tests for the email plumbing
- **Chunk P2-4 — M28 admin UI**
  - `api/_handlers/internal/notifications/` (h26x/h26x)
  - `src/tanda/InternalNotificationCenter.tsx`
  - `src/tanda/InternalNotificationPreferences.tsx`
  - Top-nav badge in Tangerine.tsx
  - User-guide chapter
- **Chunk P2-5 — M29 schema + storage**
  - Migration: `documents`, `document_versions` + indexes + RLS
  - Supabase Storage bucket `tangerine-documents` + bucket policies
  - `api/_lib/documents/index.js` (attach/list/signedUrl/archive/uploadVersion)
  - 15+ unit tests
- **Chunk P2-6 — M29 reusable component**
  - `src/shared/documents/DocumentAttachmentList.tsx` (+ minor subcomponents)
  - Drop into existing Internal*.tsx panels where relevant (Vendor, Customer, JE — about 3 sites)
  - User-guide chapter
- **Chunk P2-7 — M30 schema + view**
  - Migration: `employees` + indexes + RLS + `v_audit_user_resolved` view
  - Seed: insert one row per known internal user
- **Chunk P2-8 — M30 admin UI**
  - `api/_handlers/internal/employees/` (h26x/h26x)
  - `src/tanda/InternalEmployees.tsx`
  - Tangerine.tsx nav wiring
  - User-guide chapter

Each chunk is **its own PR with CI gate**. Use the isolated-worktree pattern (see [[feedback-isolated-worktree-for-tangerine]]). Per [[feedback-memorize-each-chunk]], project memory and the user guide update in the SAME PR.

---

## 11. Verification criteria — what proves P2 is "done"

1. **M27 schema:** every table exists with the documented columns + indexes + RLS policies. `\d+ approval_*` matches the spec.
2. **M27 guard fires:** `INSERT INTO journal_entries (status, ...) VALUES ('posted', ...)` raises when a pending approval request exists for that JE.
3. **M27 API loop:** seed an `ap_invoice > $5k` rule, call `requestIfRequired()` against a fake $7k invoice → returns `required: true` + creates a request + a step. Call `decide()` with the right role → request flips to `approved`.
4. **M28 enqueue:** call `notificationsAPI.enqueue({...})` against a real user — `notification_events` row exists, `notification_dispatches` rows exist per channel, `in_app` rows mark `sent` synchronously.
5. **M28 email dispatch:** the email worker drains pending rows, sends, marks `sent_at`. End-to-end test mails to a controllable inbox.
6. **M28 prefs respected:** flipping `notification_preferences.enabled = false` for `(kind, channel)` prevents future dispatch creation.
7. **M29 attach + version:** upload v1 of a contract → row in `documents` + `document_versions` + bytes in bucket. Upload v2 → new `document_versions` row, `current_version_id` updated atomically.
8. **M29 signed URL:** signed URL returns 200 within TTL, 403 after TTL expires, 403 from a user outside the entity.
9. **M30 view:** `SELECT display_name FROM v_audit_user_resolved WHERE user_id = '<uuid>'` returns a name for every known internal user.
10. **M30 self-ref:** setting `manager_employee_id` on employee A pointing to employee B, then deleting B, sets A's column to NULL (ON DELETE SET NULL).
11. **Hooks contract:** grep confirms no downstream module file imports schema types from approvals/notifications/documents — only the API surfaces.
12. **User guide:** four new chapters under `docs/tangerine/user-guide/` (or four updated existing chapters) with prose + Mermaid + screenshot targets.
13. **CLAUDE.md rules:** no PII leakage in `notification_dispatches.body` (templating sanitizer is in place); document bytes never logged; AES-256-equiv at rest in Supabase Storage by default.

---

## 12. Sub-decisions deferred to implementation passes

| # | Sub-decision | Resolve in |
|---|---|---|
| 1 | Email sender: reuse rof_xoro SMTP vs Tangerine-owned Resend | P2-3 chunk kickoff |
| 2 | In-app notification poll vs Supabase Realtime subscription | P2-4 chunk |
| 3 | Whether to migrate `pi_documents` into M29 | Deferred to P-future (post-Xoro decom) |
| 4 | Approval-rule editor: free-text JSONB editor vs structured form for MVP | P2-2 chunk; recommend structured form for the 3 MVP rule shapes, free-text fallback for advanced |
| 5 | Whether `employee_roles` table (option B in §7.2) lands now or later | Stay with Option A through firm-mode introduction; revisit when CPA firm is contracted |
| 6 | Notification digest mode (daily roll-up) | Out of P2 scope; add in P24 reporting phase if demand exists |
| 7 | Approval-request expiry rules + nightly job | P2-1 chunk; default expiry NULL (never), nightly job lands in P2-2 |

---

## 13. Risk register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Approval rule JSONB schema drifts ad-hoc | Med | Med | Validate every `rules.match` and `rules.steps` against a single source-of-truth Zod (or equiv) schema in `api/_lib/approvals/schema.js` — reject on rule create + on match |
| Notification fan-out floods email | Med | Med | Per-kind rate limit at the dispatcher level (e.g. max 50 emails/recipient/hour); coalesce identical kind+context within a 5-min window |
| Supabase Storage bucket policies misconfigured → cross-entity leak | Low | High | Pre-flight policy test in the migration itself: as a non-entity user, attempt to read a doc from another entity — must 403. Block migration on failure. |
| `documents.current_version_id` cyclic FK breaks migration | Med | Low | Define FK as DEFERRABLE INITIALLY DEFERRED; create both tables, then add FK, then create initial version row in two steps |
| Employee email collisions with existing `auth.users.email` confuse the `auth_user_id` link | Med | Low | Seed migration normalizes lowercase; uniqueness only enforced within an `entity_id` |
| Posting trigger guard rejects ALL JEs once any pending approval exists | Low | High | Guard checks for THIS JE's request specifically (`context_id = NEW.id`), not "any pending"; covered by unit test |
| Cron worker drift / silent email failures | Med | Med | `notification_dispatches.status = 'failed'` + error_message + alert via the system itself (severity='error') |

---

## 14. What this pass does NOT cover (explicit non-scope)

- M3 AP / M4 AR / M5 inventory implementation (P3, P4)
- The accountant identity choice (still deferred per locked decision §4)
- Payroll, time tracking, benefits (stretch-post-launch)
- Push / SMS / digest notifications (post-P2)
- The "rules engine" mini-language — JSONB spec only at MVP
- Approval re-routing UI (escalation when current approver is OOO) — Phase 1 lets the operator cancel + recreate
- Audit log search UI — implicit via `approval_decisions` and `notification_events` tables, no dedicated panel
- BI / analytics on notification volume, approval throughput — defer to P24

---

## 15. Approval handshake

**Per [[feedback-plan-approval-not-implementation]], do NOT start implementing P2 chunks until the operator has reviewed this doc and given explicit approval.**

When ready, the kickoff sequence is:

1. Operator reads §10 chunk split, confirms or adjusts
2. Operator chooses email sender (sub-decision §12.1)
3. Operator approves Supabase Storage as doc backend (already recommended here)
4. Chunk P2-1 opens as the first PR

Until then, this doc is the deliverable. No code.
