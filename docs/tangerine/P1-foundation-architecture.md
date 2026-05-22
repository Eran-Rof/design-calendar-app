# Tangerine P1 — Foundation Architecture Pass

**Codename:** Tangerine
**Phase:** P1 Foundation
**Modules:** M1 Tenancy · M2 GL (dual-basis) · 5-dim Matrix Data Model · M34 Product/Style Master · M35 Vendor Master · M36 Customer Master
**Status:** Architecture only — no code yet. Per `feedback_plan_approval_not_implementation`, this document is the deliverable.
**Date:** 2026-05-21
**Inputs:** [`project_erp_build_roadmap`](../../../.claude/...) + 7 locked decisions (USD only, dual-basis accrual+cash, 5yr AR backfill, accountant identity deferred, 2-month $-tolerance decom, all 5 matrix dims at launch, all 4 cross-cutters in P2).

---

## 0. Scope guardrails

This pass produces:

1. Concrete table schemas (columns, types, FKs, indexes) for every new table P1 adds.
2. Concrete extensions to existing tables (`entities`, `vendors`, `ip_item_master`, `tanda_pos`, etc.).
3. The canonical RLS policy template P1 will use.
4. The dual-basis posting service skeleton.
5. The matrix React primitive design.
6. A precise list of files to create / extend and in which order.
7. Verification criteria — what proves P1 is "done."

This pass does **not** produce:

- Any SQL migration file (P1 implementation is a separate pass).
- Any TypeScript code.
- Sub-module decisions deferred to later passes (Xoro decom $-tolerance, doc storage backend, etc.).

---

## 1. Existing state (one-paragraph map)

`entities` exists with `parent_entity_id` self-ref and a "Ring of Fire" seed row. Multi-entity is scaffolded but **no transactional table has `entity_id` yet** — `tanda_pos`, `invoices`, `receipts`, `shipments`, `ip_*` all need it. Two parallel vendor tables exist: `vendors` (portal-facing, used by `vendor_users`/`invoices`/`shipments`) and `ip_vendor_master` (planning-side, joined to `vendors` via `portal_vendor_id`). `ip_customer_master` exists planning-side; no canonical M36. `ip_item_master` has `style_code` (text), `color`, `size`, an `attributes` JSONB, and a single-level `ip_category_master` — no explicit inseam/length/fit columns, no `style_master`. No GL anywhere. RLS pattern is consistent: anon-permissive for internal SPAs + authenticated-scoped via junction subqueries for vendor portal. Migrations are timestamped `YYYYMMDDhhmmss_description.sql`.

---

## 2. Decisions feeding this pass (recap)

| # | Decision | Impact |
|---|---|---|
| 1 | USD-only functional currency | `currency` columns kept (for invoice display + future) but no FX schema |
| 2 | **Dual accrual + cash books** | `basis` discriminator on every journal entry + line; posting service produces both |
| 3 | 5-year AR backfill | Drives M4 in P4; P1 sizes `journal_entries` indexes for ~5yr depth |
| 4 | Accountant identity deferred | M1 designed single-user-capable, firm-mode-upgradeable |
| 5 | Decom = 2 months within $X | No P1 schema impact; flag for P9 |
| 6 | **All 5 matrix dims required at launch** | Explicit `inseam`, `length`, `fit` columns; apparel-flag on style_master to enforce |
| 7 | All 4 cross-cutters in P2 | No P1 schema impact, but P1 must not block them (e.g. `created_by_user_id` on every table) |

---

## 3. M1 Tenancy

### 3.1 `entities` — extensions

Keep the existing table. Add:

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `code` | text | NOT NULL UNIQUE | Short code (e.g. `ROF`, `XORO`) for use in PO/SO/invoice numbering prefixes. Backfill `ROF` for seed row. |
| `functional_currency` | char(3) | NOT NULL DEFAULT `'USD'` | Even though USD-only at launch, schema-future-proofs M2. |
| `fiscal_year_start_month` | smallint | NOT NULL DEFAULT `1` | Drives `gl_periods` generator. Check `1 ≤ value ≤ 12`. |
| `accounting_basis_primary` | text | NOT NULL DEFAULT `'ACCRUAL'` | One of `ACCRUAL` / `CASH`. The "primary" set of books for reporting. Both books always exist (dual-basis) — this is the reporting default. |
| `posting_locked_through` | date | NULL | Periods on/before this date are locked. Sub-period grain comes from `gl_periods`. |
| `country` | char(2) | NULL | ISO; informational at launch, drives M20 1099 / M21 tax later. |
| `metadata` | jsonb | NOT NULL DEFAULT `'{}'::jsonb` | Free-form (branding flags, integration toggles). |

**Constraint:** `parent_entity_id` self-ref stays; no hierarchical roll-up logic in P1 — flat orgs only.

### 3.2 `entity_id` propagation — every transactional table

P1 migrations add `entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT` to:

- `tanda_pos`, `po_line_items`
- `invoices`, `invoice_line_items`
- `shipments`, `shipment_lines`, `shipment_events`
- `receipts`, `receipt_line_items`
- `ip_item_master`, `ip_category_master`, `ip_vendor_master`, `ip_customer_master`
- `vendors` *(via `entity_vendors` junction — already exists; do not add `entity_id` directly to `vendors` since one vendor may serve many entities)*

**Backfill strategy:** since there is one production entity ("Ring of Fire") today, every existing row backfills to that UUID in a single statement before the column is set NOT NULL. Migrations:

1. `ALTER TABLE … ADD COLUMN entity_id uuid NULL REFERENCES entities(id) …`
2. `UPDATE … SET entity_id = '<ROF uuid>'` (executed against `code='ROF'`)
3. `ALTER TABLE … ALTER COLUMN entity_id SET NOT NULL`

Index on every `entity_id` column: `CREATE INDEX <table>_entity_id_idx ON … (entity_id)`.

### 3.3 Canonical RLS template (P1 standard)

Every entity-scoped table follows this exact 4-policy shape. Vendor-readable tables add the vendor-isolation policy on top.

```sql
-- 1. Internal apps (anon key) — full access. Pattern preserved from existing tables.
CREATE POLICY "anon_all_<table>" ON <table>
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- 2. Internal authenticated users (accountant, internal staff) — scoped to entities they belong to.
CREATE POLICY "auth_internal_<table>" ON <table>
  FOR ALL TO authenticated
  USING (entity_id IN (
    SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()
  ))
  WITH CHECK (entity_id IN (
    SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()
  ));

-- 3. Vendor authenticated users — scoped to their vendor + entities the vendor is linked to.
--    (Only added to tables vendors can read: invoices, shipments, POs they own.)
CREATE POLICY "auth_vendor_<table>_select" ON <table>
  FOR SELECT TO authenticated
  USING (
    vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    AND entity_id IN (
      SELECT ev.entity_id FROM entity_vendors ev
      JOIN vendor_users vu ON vu.vendor_id = ev.vendor_id
      WHERE vu.auth_id = auth.uid()
    )
  );

-- 4. Vendor write paths (e.g. invoices INSERT/UPDATE while status='submitted') —
--    add policy-by-policy as today's vendor-portal pattern dictates.
```

**New table for this pattern:** `entity_users` — junction of `auth.users` → `entities` for internal staff and the deferred-identity accountant. Schema:

```
entity_users (
  id uuid PK,
  auth_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role text NOT NULL,           -- 'admin' | 'accountant' | 'staff' | 'readonly'
  created_at timestamptz DEFAULT now(),
  UNIQUE (auth_id, entity_id)
)
```

This is the cleanest place to model the deferred "single contractor vs CPA firm" decision: `role='accountant'` rows can be 1 or many; flipping to firm-mode is purely a data change. No schema migration required later.

### 3.4 `auth.users` migration (accountant access)

The accountant logs into a normal internal SPA (not the vendor portal). Their Supabase Auth row is plain; their permissions come from an `entity_users.role='accountant'` row. RLS template (3) above already covers them. No new auth provider needed.

---

## 4. M2 General Ledger — dual-basis

### 4.1 Tables

#### `gl_accounts` — chart of accounts

```
id                 uuid PK
entity_id          uuid NOT NULL FK→entities(id)
code               text NOT NULL          -- '1000', '4000-WHOLESALE', etc.
name               text NOT NULL
account_type       text NOT NULL          -- 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'contra_asset' | 'contra_revenue'
account_subtype    text NULL              -- 'current_asset' | 'inventory' | 'ar' | 'ap' | 'cogs' | 'sga' | ...
parent_account_id  uuid NULL FK→gl_accounts(id)
normal_balance     text NOT NULL          -- 'DEBIT' | 'CREDIT' (derived from account_type; stored for posting validation)
is_postable        boolean NOT NULL DEFAULT true    -- false = roll-up parent only
is_control         boolean NOT NULL DEFAULT false   -- AR/AP/Inventory must be true; only subledger writes
status             text NOT NULL DEFAULT 'active'   -- 'active' | 'inactive'
created_at, updated_at, created_by_user_id
UNIQUE (entity_id, code)
INDEX (entity_id, account_type), (parent_account_id)
```

**Hard-wired seed COAs** for the RoF entity ship with P1 migrations: a baseline 4-digit COA matching what the accountant expects (1000s assets, 2000s liabilities, 3000s equity, 4000s revenue, 5000s COGS, 6000s SG&A). Exact list deferred to implementation pass — captured in a fixture file.

#### `gl_periods`

```
id                 uuid PK
entity_id          uuid NOT NULL FK→entities(id)
fiscal_year        smallint NOT NULL
period_number      smallint NOT NULL    -- 1..12 (locked at 12 calendar months per decision)
starts_on          date NOT NULL
ends_on            date NOT NULL
status             text NOT NULL DEFAULT 'open'   -- 'open' | 'soft_close' | 'closed'
soft_closed_at, closed_at, closed_by_user_id
UNIQUE (entity_id, fiscal_year, period_number)
INDEX (entity_id, status), (starts_on, ends_on)
CHECK (period_number BETWEEN 1 AND 12)
CHECK (ends_on > starts_on)
```

**Generator:** one-time bootstrap inserts 5 historical + 5 forward years × 12 periods per entity. Period status flow: `open` → `soft_close` (entries blocked but adjustments allowed by accountant) → `closed` (no writes).

#### `journal_entries` — dual-basis

```
id                 uuid PK
entity_id          uuid NOT NULL FK→entities(id)
period_id          uuid NOT NULL FK→gl_periods(id)
basis              text NOT NULL          -- 'ACCRUAL' | 'CASH'
journal_type       text NOT NULL          -- 'manual' | 'ap_invoice' | 'ap_payment' | 'ar_invoice' | 'ar_receipt' | 'inventory' | 'adjustment' | 'fx' | 'close' | ...
posting_date       date NOT NULL
source_module      text NOT NULL          -- 'ap' | 'ar' | 'inventory' | 'manual' | 'close' | ...
source_id          text NULL              -- e.g. invoice uuid, payment uuid (text, polymorphic)
source_table       text NULL              -- e.g. 'invoices' (paired with source_id)
description        text NOT NULL
status             text NOT NULL DEFAULT 'draft'   -- 'draft' | 'posted' | 'reversed'
posted_at          timestamptz NULL
posted_by_user_id  uuid NULL FK→auth.users(id)
reversed_by_je_id  uuid NULL FK→journal_entries(id)
reverses_je_id     uuid NULL FK→journal_entries(id)
sibling_je_id      uuid NULL FK→journal_entries(id)   -- ★ the other-basis twin
created_at, updated_at
INDEX (entity_id, basis, posting_date)
INDEX (period_id, basis, status)
INDEX (source_table, source_id)
INDEX (sibling_je_id)
CHECK (basis IN ('ACCRUAL', 'CASH'))
CHECK (status IN ('draft', 'posted', 'reversed'))
```

#### `journal_entry_lines`

```
id                 uuid PK
journal_entry_id   uuid NOT NULL FK→journal_entries(id) ON DELETE CASCADE
line_number        smallint NOT NULL
account_id         uuid NOT NULL FK→gl_accounts(id)
debit              numeric(18,2) NOT NULL DEFAULT 0
credit             numeric(18,2) NOT NULL DEFAULT 0
memo               text NULL
subledger_type     text NULL              -- 'vendor' | 'customer' | 'item' | NULL
subledger_id       uuid NULL              -- polymorphic FK target (no actual FK; integrity enforced at posting service)
created_at
UNIQUE (journal_entry_id, line_number)
INDEX (journal_entry_id), (account_id), (subledger_type, subledger_id)
CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
```

**Posting-service-enforced invariants** (also enforced via trigger when JE flips to `status='posted'`):

1. Σ(debit) = Σ(credit) per journal_entry.
2. Posting date must fall inside an `open` period for the entity.
3. Lines hitting a `gl_accounts.is_control=true` account must include `subledger_type` + `subledger_id`.
4. Lines hitting an `is_postable=false` account are rejected.

#### `gl_subledger_balances` — running balance cache (optional in P1)

Computed view in P1 (no physical table) — promote to materialized view if performance demands once AR backfill loads. View shape:

```
gl_subledger_balances_v (
  entity_id, account_id, basis, subledger_type, subledger_id,
  balance_debit, balance_credit, net_balance, as_of_date
)
```

### 4.2 Dual-basis design

**Every transactional event** that produces a journal entry produces a **pair** — one ACCRUAL JE and one CASH JE — joined by `sibling_je_id` pointing at each other. Either or both may be empty if the basis-specific posting rule says nothing happens on that basis. Examples:

| Event | Accrual JE | Cash JE |
|---|---|---|
| Vendor bill received | DR Expense / CR AP | (none) |
| Vendor bill paid | DR AP / CR Cash | DR Expense / CR Cash |
| Customer invoice sent | DR AR / CR Revenue | (none) |
| Customer payment received | DR Cash / CR AR | DR Cash / CR Revenue |
| Inventory receipt | DR Inventory / CR GR-IR | (none) |
| Inventory adjustment | DR/CR Inventory / Adj | DR/CR Inventory / Adj |

When only one basis produces a journal, the field stays NULL on the sibling side. **No phantom rows** — basis-specific reports filter `WHERE basis = ?` and ignore NULLs.

### 4.3 Posting service skeleton

```
src/server/accounting/posting/
  index.ts                        # postEvent(payload) — public entrypoint
  types.ts                        # PostingEvent, JournalEntry, JournalLine, PostingResult
  rules/
    apInvoiceReceived.ts          # rule: (event) -> { accrual?: JE, cash?: JE }
    apInvoicePaid.ts
    arInvoiceSent.ts
    arPaymentReceived.ts
    inventoryReceipt.ts
    inventoryAdjustment.ts
    manualEntry.ts                # accountant-authored
  guards/
    balanced.ts                   # Σ(D)=Σ(C)
    periodOpen.ts                 # period status check
    controlAccountSubledger.ts    # control accounts require subledger
    accountPostable.ts            # is_postable check
    accountExistsInEntity.ts      # cross-entity leak guard
  persist.ts                      # transactional insert (JE + lines + sibling link)
  reverse.ts                      # reverse(jeId) -> new JE with negated lines
```

**Public API:**

```ts
postEvent(event: PostingEvent): Promise<PostingResult>
// PostingEvent is a discriminated union by `kind`:
//   { kind: 'ap_invoice_received', invoice_id, ... }
//   { kind: 'ap_invoice_paid', payment_id, ... }
//   { kind: 'manual', entity_id, basis, lines: [...] }
// PostingResult: { accrualJeId?: uuid, cashJeId?: uuid }
```

Posting service runs inside a **single transaction**: rule produces 0/1/2 candidate JEs → each runs through all guards → both inserted → siblings linked → period close-status double-checked at commit time. Idempotency key: `(source_table, source_id, basis)` — a unique partial index on `journal_entries (source_table, source_id, basis) WHERE source_id IS NOT NULL` prevents duplicate posting from retries.

### 4.4 GL RLS

GL tables use template policies (1) and (2) only — vendors never see GL data. Add an extra `gl_period_lock` policy denying UPDATE/DELETE on `journal_entries` whose `period_id` has `status='closed'`.

---

## 5. Matrix Data Model (5 dimensions)

### 5.1 Decision: explicit columns, not JSONB

The 5 dimensions are stored as **first-class columns** on `ip_item_master` (and any other table referencing a specific variant), not buried in `attributes` JSONB. Reasons:

- All ERP modules (allocation grid, SO entry, inventory snapshot, reports) join/filter on dims; JSONB-indexed extracts cripple query planner.
- Matrix React primitive renders 5-D grid — explicit columns let the component query by dim directly.
- The `attributes` JSONB stays for genuinely free-form attrs (fiber content, MOQ tier, supplier-specific codes).

### 5.2 `ip_item_master` extensions

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `gender_code` | text | NULL | Already implied by operator-prefix rules (M/W/B/C/G); make explicit. Backfill from rof_xoro `daily_check.py` conformance source. CHECK in `('M','WMS','B','C','G','U')`. |
| `inseam` | text | NULL | Free text (e.g. `'30'`, `'32'`, `'XL'` for jackets w/o inseam → NULL). Required for apparel rows (see 5.5). |
| `length` | text | NULL | `'REGULAR'`, `'LONG'`, `'PETITE'`, `'TALL'`. NULL for non-apparel. |
| `fit` | text | NULL | `'SKINNY'`, `'SLIM'`, `'STRAIGHT'`, `'RELAXED'`, `'CURVY'`, etc. NULL for non-apparel. |
| `style_id` | uuid | NULL → NOT NULL after backfill | FK→`style_master(id)`. Today `style_code` is text; promote to FK. |
| `is_apparel` | boolean | NOT NULL DEFAULT true | True forces non-NULL color/size/inseam/length/fit per 5.5. |

**Existing columns kept as-is:** `color`, `size`, `style_code` (denormalized for backward compat; trigger keeps in sync with `style_master.style_code`).

**Indexes added:**
- `(entity_id, style_id)`
- `(entity_id, gender_code)`
- `(entity_id, style_id, color, size)` — the most common matrix lookup

### 5.3 Apparel vs non-apparel enforcement

A CHECK constraint at the row level:

```sql
ALTER TABLE ip_item_master ADD CONSTRAINT apparel_dims_required
  CHECK (
    NOT is_apparel
    OR (color IS NOT NULL AND size IS NOT NULL
        AND inseam IS NOT NULL AND length IS NOT NULL AND fit IS NOT NULL)
  );
```

Accessories (`is_apparel=false`) bypass the constraint entirely. The accountant + buyer never see length/fit fields on non-apparel rows in the matrix React primitive.

### 5.4 Matrix React primitive

```
src/shared/matrix/
  MatrixGrid.tsx                  # generic 2..5-D grid (rows × cols × layers)
  MatrixCell.tsx                  # editable cell (display/input/disabled)
  MatrixHeader.tsx                # dim label + axis-pivot dropdown
  MatrixPivotControl.tsx          # lets user pivot which 2 of 5 dims display on axes
  hooks/
    useMatrixData.ts              # (items, axisRow, axisCol, fixedFilters) → cells
    useMatrixPivot.ts             # state for which dims are axes / filters / collapsed
  types.ts                        # MatrixAxis = 'color'|'size'|'inseam'|'length'|'fit'
```

**Behaviour:**

- Default view: **2-D** (color × size). Other 3 dims are filter chips above the grid (default "all").
- Pivot control lets user pick which 2 dims to display; the other 3 become filter chips.
- When a filter is set to multi-value, layered tabs render (e.g. one grid per inseam value).
- Empty cells (no SKU exists for that combination) display dash, not 0.
- Single-cell editing dispatches a callback — parent owns persistence.
- Read-only mode renders the same component with editing disabled — used in reports.

**Reuse targets (each gets its own architecture pass when scheduled):**

- ATS allocation grid (E4) — replace bespoke grid in P1's M31 extension (P17)
- SO entry line (P16 M10)
- PO entry line (P13 M11)
- Inventory snapshot panel
- RMA line entry (P19 M23)
- Showroom/Line Review (P8 M25)

### 5.5 Why a separate `style_master` vs only the existing `style_code`

`ip_item_master.style_code` (text, nullable, no FK) is sufficient to *group* SKUs but cannot host style-level attributes that belong to the design, not the variant: season, design year, base fabric, gender (often), launch date, lifecycle, PLM links. Adding all of these to `ip_item_master` would denormalize 5–20 columns per SKU; better to lift to `style_master` once and FK from item_master.

---

## 6. M34 Product/Style Master

### 6.1 New `style_master` table

```
id                 uuid PK
entity_id          uuid NOT NULL FK→entities(id)
style_code         text NOT NULL                  -- the human style code (e.g. 'RY1234')
description        text NOT NULL
category_id        uuid NULL FK→ip_category_master(id)
gender_code        text NULL                      -- redundant with item; canonical at style level
season             text NULL                      -- 'FW26' etc.
design_year        smallint NULL
is_apparel         boolean NOT NULL DEFAULT true
launch_date        date NULL
lifecycle_status   text NOT NULL DEFAULT 'active' -- 'active'|'phased_out'|'discontinued'|'core'
planning_class     text NULL                      -- 'core'|'seasonal'|'fashion'
base_fabric        text NULL
attributes         jsonb NOT NULL DEFAULT '{}'
created_at, updated_at, created_by_user_id
deleted_at         timestamptz NULL               -- soft delete
UNIQUE (entity_id, style_code) WHERE deleted_at IS NULL
INDEX (entity_id, gender_code), (entity_id, lifecycle_status), (category_id)
```

### 6.2 3-level category taxonomy — extend `ip_category_master`

Today `ip_category_master` is single-level. P1 adds:

| Column | Type | Notes |
|---|---|---|
| `parent_category_id` | uuid NULL FK→`ip_category_master(id)` | Self-ref |
| `level` | smallint NOT NULL CHECK BETWEEN 1 AND 3 | 1 = top, 3 = leaf |
| `path` | text | Materialized e.g. `'Apparel > Bottoms > Jeans'` for display & search |
| `entity_id` | uuid NOT NULL | Already in propagation list above |

Constraint: `level=1 ⇔ parent_category_id IS NULL`; otherwise `parent.level = child.level - 1`. Maintained via trigger.

Existing rows backfill: every current category becomes `level=1` with `parent_category_id=NULL`; merchandiser does a one-time pass to add levels 2 + 3.

### 6.3 Migration path from current state

| Step | Action |
|---|---|
| 1 | Add `style_master` table. |
| 2 | INSERT INTO `style_master` SELECT DISTINCT `(entity_id, style_code, description, …)` FROM `ip_item_master` WHERE `style_code` IS NOT NULL. |
| 3 | Add `ip_item_master.style_id uuid NULL FK→style_master(id)`. |
| 4 | UPDATE `ip_item_master` SET `style_id = (lookup)`. |
| 5 | NOT NULL constraint on `style_id` (allow NULL for non-apparel ad-hoc SKUs). Make conditional via CHECK. |
| 6 | Trigger: keep `ip_item_master.style_code` in sync with `style_master.style_code` for backward compat with rof_xoro scripts. |

---

## 7. M35 Vendor Master

### 7.1 Unification strategy

Today there are **two vendor tables** — `vendors` (portal-facing, FK target for `vendor_users`, `invoices`, `shipments`) and `ip_vendor_master` (planning-side, joined to `vendors` via `portal_vendor_id`). This is the same entity modeled twice, which guarantees drift.

**P1 decision: `vendors` becomes the canonical M35 table.** `ip_vendor_master` is converted to a view over `vendors` to keep planning code working without rewrite, then deleted in a later phase.

Reasons:
- `vendors` already has all FKs from the transactional tables that matter (POs, invoices, shipments).
- Vendor portal auth is wired to `vendors.id` via `vendor_users.vendor_id` — moving canonical to `ip_vendor_master` would break auth.
- `ip_vendor_master.portal_vendor_id` is exactly the kind of cross-ref column that signals the wrong table is canonical.

### 7.2 `vendors` extensions for ERP-grade data

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `code` | text | NOT NULL | Vendor code (e.g. `'V0042'`); unique per entity context via `entity_vendors.vendor_code` (see below) |
| `tax_id` | text | NULL | EIN / VAT — encrypted at rest (CLAUDE.md security rule for PII) |
| `payment_terms` | text | NULL | `'NET30'`, `'2/10 NET30'`, etc. Free text in P1; structured in P14. |
| `default_currency` | char(3) | NOT NULL DEFAULT `'USD'` | |
| `default_gl_ap_account_id` | uuid | NULL FK→`gl_accounts(id)` | Override of entity-level AP account |
| `default_gl_expense_account_id` | uuid | NULL FK→`gl_accounts(id)` | For bills without explicit account-coding |
| `status` | text | NOT NULL DEFAULT `'active'` | `'active'`, `'on_hold'`, `'inactive'` |
| `is_1099_vendor` | boolean | NOT NULL DEFAULT false | Pre-flags M20 in P25 |
| `legal_name` | text | NULL | Distinct from `name` (DBA) |
| `address` | jsonb | NULL | `{ street, city, state, postal, country }` |
| `bank_account_encrypted` | bytea | NULL | AES-256, only populated if vendor opts into ACH; never logged |
| `created_by_user_id`, `updated_by_user_id` | uuid | NULL FK→`auth.users(id)` | |

**`entity_vendors` extensions:** add `vendor_code` (text, unique per entity_id), so one vendor can be `V0042` for RoF and `XV-42` for another entity.

### 7.3 RLS

Vendors table itself remains internal-only-readable on the anon path (existing pattern). Add the `auth_internal_vendors` policy from template (2). Vendor portal users already see their own vendor via `vendor_users` join — pattern preserved.

---

## 8. M36 Customer Master

### 8.1 Strategy

`ip_customer_master` exists planning-side only — no transactional table currently FKs to a customer. **P1 promotes `ip_customer_master` to canonical M36** (renamed `customers` for symmetry with `vendors`, with a `ip_customer_master` view kept for backward compat) and extends it with ERP-grade columns.

Reasons:
- No portal-facing customer auth exists today (B2B portal is P18), so there's no "two tables" problem to resolve — only one canonical home.
- Planning already reads from `ip_customer_master`; the view alias keeps that code working.

### 8.2 `customers` schema (extends `ip_customer_master`)

| Column | Type | Notes |
|---|---|---|
| (carry over) `id`, `name`, channel-related cols | existing | |
| `entity_id` | uuid NOT NULL FK→`entities(id)` | New |
| `code` | text NOT NULL | Customer code; UNIQUE per entity |
| `customer_type` | text NOT NULL | `'wholesale'`, `'ecom'`, `'showroom'`, `'employee'`, `'other'` |
| `default_gl_ar_account_id` | uuid NULL FK→`gl_accounts(id)` | |
| `default_gl_revenue_account_id` | uuid NULL FK→`gl_accounts(id)` | |
| `payment_terms` | text NULL | |
| `default_currency` | char(3) NOT NULL DEFAULT `'USD'` | |
| `tax_exempt` | boolean NOT NULL DEFAULT false | |
| `tax_exempt_certificate` | text NULL | |
| `credit_limit` | numeric(14,2) NULL | |
| `status` | text NOT NULL DEFAULT `'active'` | |
| `billing_address`, `shipping_address` | jsonb NULL | |
| `parent_customer_id` | uuid NULL FK→`customers(id)` | For corporate parent / store hierarchies |
| `attributes` | jsonb NOT NULL DEFAULT `'{}'` | |
| `created_at`, `updated_at`, `deleted_at`, audit user FKs | | |

Unique: `(entity_id, code) WHERE deleted_at IS NULL`. Indexes on `(entity_id, customer_type)`, `(entity_id, status)`.

### 8.3 Existing FKs to backfill

None today — no transactional table FKs to a customer yet (SO is P16, ATS uses `channel_id`). M36 prepares the schema; FKs land when M10 (SO) lands in P16.

---

## 9. Files to create / extend (implementation roadmap)

Once this architecture is approved, the implementation pass will create files in this order. Each line is one migration or one source file.

### 9.1 Supabase migrations (folder `supabase/migrations/`)

| # | Filename | What |
|---|---|---|
| 1 | `20260522000000_p1_entities_extensions.sql` | Add `code`, `functional_currency`, `fiscal_year_start_month`, `accounting_basis_primary`, `posting_locked_through`, `country`, `metadata` to `entities`. Backfill `code='ROF'`. |
| 2 | `20260522000100_p1_entity_users.sql` | Create `entity_users` table + RLS. |
| 3 | `20260522000200_p1_entity_id_propagation.sql` | Add nullable `entity_id` to all 14 transactional tables. Backfill to ROF uuid. Set NOT NULL. Indexes. |
| 4 | `20260522000300_p1_rls_entity_scope.sql` | Apply canonical RLS template (policies 1–3) to all entity-scoped tables. Drop old policies they supersede. |
| 5 | `20260522001000_p1_gl_accounts.sql` | Create `gl_accounts` + seed RoF COA. |
| 6 | `20260522001100_p1_gl_periods.sql` | Create `gl_periods` + bootstrap 10 years × 12 periods for RoF. |
| 7 | `20260522001200_p1_journal_entries.sql` | Create `journal_entries`, `journal_entry_lines`, indexes, balanced-entry trigger, period-lock trigger, sibling-link constraint. |
| 8 | `20260522001300_p1_gl_subledger_balances_view.sql` | Define `gl_subledger_balances_v` view. |
| 9 | `20260522001400_p1_gl_rls.sql` | GL-specific RLS (internal-only) + closed-period guard. |
| 10 | `20260522002000_p1_style_master.sql` | Create `style_master`, backfill from `ip_item_master.style_code` distinct values. |
| 11 | `20260522002100_p1_ip_item_master_matrix.sql` | Add `gender_code`, `inseam`, `length`, `fit`, `style_id`, `is_apparel`. Backfill. Add `apparel_dims_required` CHECK. Trigger to keep `style_code` in sync. |
| 12 | `20260522002200_p1_category_3level.sql` | Add `parent_category_id`, `level`, `path` to `ip_category_master`. Backfill all rows as `level=1`. Trigger for `path` maintenance. |
| 13 | `20260522003000_p1_vendors_erp_extensions.sql` | Add `code`, `tax_id`, `payment_terms`, `default_currency`, GL FK columns, `status`, `is_1099_vendor`, `legal_name`, `address`, `bank_account_encrypted`, audit cols to `vendors`. |
| 14 | `20260522003100_p1_entity_vendor_code.sql` | Add `vendor_code` to `entity_vendors`. |
| 15 | `20260522003200_p1_ip_vendor_master_view.sql` | Convert `ip_vendor_master` to a view over `vendors`. |
| 16 | `20260522004000_p1_customers.sql` | Promote `ip_customer_master` to `customers` with all M36 extensions; create `ip_customer_master` as a view alias for backward compat. |

### 9.2 New React / TS code (folder `src/`)

| Path | Purpose |
|---|---|
| `src/shared/matrix/MatrixGrid.tsx` | Generic N-D matrix grid component |
| `src/shared/matrix/MatrixCell.tsx`, `MatrixHeader.tsx`, `MatrixPivotControl.tsx` | Sub-components |
| `src/shared/matrix/hooks/useMatrixData.ts`, `useMatrixPivot.ts` | Data + pivot state hooks |
| `src/shared/matrix/types.ts` | `MatrixAxis`, etc. |
| `src/shared/matrix/__tests__/MatrixGrid.test.tsx` | Pivot, layering, empty cells, read-only |
| `src/server/accounting/posting/index.ts` | `postEvent` entrypoint |
| `src/server/accounting/posting/types.ts` | Posting types |
| `src/server/accounting/posting/rules/*.ts` | One file per event type (5–7 initial) |
| `src/server/accounting/posting/guards/*.ts` | Balanced, period-open, control-account-subledger, postable, cross-entity |
| `src/server/accounting/posting/persist.ts` | Transactional insert + sibling link |
| `src/server/accounting/posting/reverse.ts` | Reversal helper |
| `src/server/accounting/posting/__tests__/*.test.ts` | Per-rule + per-guard tests, plus an end-to-end dual-basis case |
| `src/server/accounting/coa/seed.ts` | RoF COA fixture used by migration #5 |
| `src/server/master/styleMaster.ts`, `productMaster.ts`, `vendorMaster.ts`, `customerMaster.ts` | Read/write helpers used by UI |
| `src/admin/master-data/StyleMasterPanel.tsx` | Internal admin UI for style_master CRUD |
| `src/admin/master-data/VendorMasterPanel.tsx`, `CustomerMasterPanel.tsx` | Same |
| `src/admin/accounting/COAPanel.tsx`, `PeriodsPanel.tsx`, `JournalEntryPanel.tsx` | Accountant UI |

### 9.3 Modified existing files

| Path | Change |
|---|---|
| `src/tanda/*` (PO WIP) | Inject `entity_id` filter from session-scoped entity; update query helpers. |
| `src/vendor/*` (Vendor Portal) | No code change — RLS update is transparent at the data layer. |
| `src/inventory-planning/*` | Switch reads from `ip_vendor_master` to the new view (no code change if column names preserved). |
| `src/ats/*` | Add 5-D matrix awareness to the allocation grid (cosmetic at P1; full replacement in P17). |
| `scripts/` (rof_xoro) | None for P1 — these scripts already write to `ip_item_master`; new columns are nullable for non-apparel. |

### 9.4 Documentation / fixtures

| Path | Content |
|---|---|
| `docs/tangerine/P1-foundation-architecture.md` | This document. |
| `docs/tangerine/coa-seed-rof.md` | The hard-wired chart of accounts as a reviewed list. |
| `docs/tangerine/posting-rules-matrix.md` | The accrual-vs-cash JE shape for every event type (the table in §4.2 expanded). |

---

## 10. Verification criteria — "P1 is done" gate

Implementation pass is **not** complete until all of the following pass:

1. **Schema:** All 16 migrations apply cleanly against a fresh DB and against a current-prod clone. `prisma db pull` / introspect produces the expected schema.
2. **Entity propagation:** Every row in every transactional table has `entity_id IS NOT NULL`; no orphans.
3. **RLS coverage:** A vendor user authenticated as Vendor A sees zero rows from Vendor B's data on every transactional + GL table (negative test via Supabase JS client).
4. **GL posting service:**
   - Posting a balanced manual JE in an open period succeeds and inserts both lines.
   - Posting an unbalanced JE returns the `balanced` guard error.
   - Posting against a closed period returns the `periodOpen` guard error.
   - Posting against a control account without subledger returns the `controlAccountSubledger` guard error.
   - Posting an `ap_invoice_paid` event inserts both accrual and cash JEs with linked `sibling_je_id`.
   - Idempotency: same `(source_table, source_id, basis)` triggers no duplicate.
5. **Dual-basis report parity:** A quick `SELECT … WHERE basis='ACCRUAL'` vs `WHERE basis='CASH'` over a seeded fixture day produces the two distinct ledgers expected by the matrix in §4.2.
6. **Matrix primitive:** Storybook (or equivalent) renders a 2-D color × size grid with 3 filter chips, a 3-D layered view, and an empty-cell case. Read-only mode disables editing.
7. **Master data CRUD:** Style / Vendor / Customer admin panels support create + edit + soft-delete + restore for the new fields without breaking existing reads.
8. **Backward compat:** `ip_vendor_master` and `ip_customer_master` views satisfy all existing planning code without modification (smoke-test the inventory-planning dashboards).
9. **rof_xoro nightly:** `post_master_data.py` continues to insert into `ip_item_master` with new nullable columns absent (default NULL); compliance check passes ≥99%.
10. **CLAUDE.md rules:** No money/decimal stored as float; passwords never stored plaintext; AES-256 on `bank_account_encrypted`; FK indexes everywhere; no plaintext PII in logs; SQL parameterized end-to-end (confirmed by grep).

---

## 11. Sub-decisions deferred to later passes

These are intentionally **not** decided in P1 — flagged here so they don't get lost:

| # | Sub-decision | Resolve in |
|---|---|---|
| 1 | Xoro decom $-tolerance number ($X) | P9 parallel-run planning |
| 2 | Document storage backend (Supabase Storage vs S3) | P2 M29 architecture pass |
| 3 | Approval-rule MVP types (PO threshold, JE > $X, etc.) | P2 M27 architecture pass |
| 4 | Notification channels (in-app, email, push, digest rules) | P2 M28 architecture pass |
| 5 | Exact seed COA codes | P1 implementation pass (with accountant review) |
| 6 | Whether `is_apparel=false` rows skip the matrix UI entirely or render a 2-D view | P1 implementation pass |
| 7 | `entity_users.role` enum vs role table | P1 implementation pass — recommend keeping as text + CHECK for now |
| 8 | Whether to add `gl_subledger_balances` as physical materialized view or keep view-only | After AR backfill load tests (P4) |

---

## 12. Risk register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Dual-basis posting doubles write volume + storage | High | Med | Index `(entity_id, basis, posting_date)` aggressively; sibling-link is cheap; reporting always filters by basis. Cost is real but linear, not exponential. |
| Backfilling `entity_id` on a production table with active vendor traffic | Med | High | Run during low-traffic window with a `NULL → backfill → NOT NULL` 3-step migration in separate transactions. Pre-flight with `EXPLAIN ANALYZE`. |
| `ip_vendor_master → view` breaks an inventory-planning code path we haven't found | Med | Med | Pre-flight: enumerate every reference (`grep -r ip_vendor_master src/`) before the migration; if any code WRITES to it, it must be updated first. |
| 5-dim matrix enforcement on `ip_item_master` rejects legacy rows missing inseam/length/fit | High | Med | Backfill `is_apparel=false` for all non-bottoms categories before NOT NULL constraint goes live. Bottoms category SKUs get a one-time data-cleanup pass with the merchandiser. |
| Accountant identity later shifts from "single contractor" to "CPA firm" | Med | Low | `entity_users` already supports multi-row; pure data change. |
| `journal_entries` index bloat at 5yr × dual-basis × all events | Low | Med | Plan partial indexes scoped to `basis` and `status='posted'`; revisit at AR backfill load test. |
| Existing `style_code` text values include leading/trailing whitespace or case drift, breaking the DISTINCT extraction into `style_master` | High | Low | Pre-flight `SELECT DISTINCT TRIM(UPPER(style_code))` to dedupe; merchandiser approves the canonical list before migration. |

---

## 13. What this pass does NOT cover (explicit non-scope)

- AP invoice ingestion UI (M3, P3)
- AR invoice generation (M4, P4)
- FIFO inventory layers (M5, P3)
- Bank/CC feeds (M7, P6)
- Reconciliation engine (M8, P6)
- Any planning / forecasting changes (M31, P17)
- Multi-currency / FX (locked to USD-only by decision)
- The accountant-facing JE entry UI is *scaffolded* in §9.2 but full WYSIWYG behaviour is iterated in P3
- B2B customer portal auth (P18)

---

## 14. Approval handshake

Per `feedback_plan_approval_not_implementation`: implementation cannot start until this document is explicitly approved. On approval, the next step is the **P1 implementation pass** — executing migrations 1–16 from §9.1 in order, then building the §9.2 code, with each chunk reviewed individually.
