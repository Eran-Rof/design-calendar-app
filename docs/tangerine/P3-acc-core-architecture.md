# Tangerine P3 — Accounting Core Architecture Pass

**Codename:** Tangerine
**Phase:** P3 Accounting Core
**Modules:** M3 Accounts Payable · M5 Inventory FIFO · M37 Inventory Operations · M39 Mobile Scanner
**Status:** Architecture only — no code yet. Doc-only PRs auto-merge per the revised [[feedback-plan-approval-not-implementation]] rule; operator approval is still required before implementation chunks ship.
**Date:** 2026-05-27
**Inputs:** P1 Foundation + P2 Cross-Cutters all merged and applied to prod 2026-05-27. See `P1-foundation-architecture.md`, `P2-cross-cutters-architecture.md`, and `project_tangerine_progress.md`.

---

## 0. Scope guardrails

This pass produces:

1. Concrete schemas for the AP invoice + payment + bill-pay lifecycle (M3).
2. Schema + algorithm for the FIFO inventory cost-layer engine (M5).
3. Inventory-operations table set: adjustments, transfers, cycle counts, bin moves (M37).
4. Mobile scanner data contract: scan events, session state, offline-replay payloads (M39).
5. Posting-service rule additions: which event-kinds in `api/_lib/accounting/posting/rules/` get wired during P3.
6. Hook contracts into P2 cross-cutters: where M3 AP + M5 FIFO call `approvalsAPI.requestIfRequired` / `notificationsAPI.enqueue` / `documentsAPI.attach`.
7. Chunk split + verification criteria + deferred sub-decisions.

This pass does **not** produce:

- AR (M4) — separate phase P4, larger 5-year-backfill scope.
- Bank/CC feeds + reconciliation (M7/M8 in P6).
- Any SQL migration files.
- The full mobile scanner mobile-app stack (this pass defines only the *back-end contract*; the actual iOS/Android shell ships in M39's implementation).
- Multi-warehouse / multi-currency (locked to USD-only single-warehouse-per-entity at launch).

---

## 1. Existing state (one-paragraph map)

After P1 + P2, Tangerine has: dual-basis GL with posting trigger guards, COA / Periods / JE admin UIs, master data for Style/Vendor/Customer, plus cross-cutters (Approvals/Notifications/Documents/Employees) live and ready to be called. **AP lifecycle is half-present:** `invoices` and `invoice_line_items` already exist (legacy planning-side), `vendors` is the canonical M35 vendor master (post-Chunk-6), but there's NO posting service rule for `ap_invoice_received` or `ap_invoice_paid` yet (the rule files exist as stubs from Chunk 3 but are dormant). **Inventory has shape but no cost layers:** `ip_inventory_snapshot` carries on-hand quantities (Xoro feed), `ip_item_master` + `ip_item_avg_cost` give average cost — but no FIFO receipt-layer history exists, so any FIFO-accurate COGS posting is impossible today. **Receiving is partial:** `receipts` + `receipt_line_items` tables exist from earlier work but feed only the PO-WIP UI; they never emit GL entries. **No scanner integration anywhere.**

---

## 2. Decisions feeding this pass (recap from locked decisions + arch context)

| # | Decision | Source | Impact |
|---|---|---|---|
| 1 | USD only | Roadmap locked #1 | No FX schema in P3 |
| 2 | Dual accrual + cash | Roadmap locked #2 | Every M3 / M5 event emits accrual + cash twins where appropriate |
| 3 | FIFO per receipt layer | Roadmap locked #5 | M5 schema centres on `inventory_layers` ordered by receipt date |
| 4 | Accountant identity deferred | Roadmap locked #4 | M3 approval rules support single + multi-user posting paths |
| 5 | Multi-warehouse stretch-only | Roadmap §41 | M37 schema treats `location` as text on launch; convert to FK later |
| 6 | Mobile scanner = native iOS + Android (NOT PWA) | This doc §6 | Back-end is REST-only; tokens via Supabase Auth; offline-replay JSON contract spec'd |

---

## 3. M3 Accounts Payable

### 3.1 Conceptual model

An AP invoice is a vendor's bill received and recorded — independent of whether it has been paid. Payment is a separate event linked back via `invoice_payments`. M3 owns:

- The lifecycle: `draft → posted → paid (partial / full) → void`
- The GL posting: at `posted` (accrual: DR expense or asset, CR AP; cash: deferred); at `paid` (cash: DR AP, CR bank)
- The approval gate: amounts above threshold or new-vendor flag block at `draft → posted` per approval rule
- The document attach point: the vendor's PDF invoice + supporting docs attach to the `invoices` row via M29 `DocumentAttachmentList`

The `invoices` table already exists from the planning-side work; P3 extends it with the missing accounting columns.

### 3.2 `invoices` — extensions

Add to the existing table:

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `invoice_kind` | text | NOT NULL DEFAULT `'vendor_bill'` | CHECK in `vendor_bill`/`vendor_credit_memo`/`expense_report` |
| `gl_status` | text | NOT NULL DEFAULT `'unposted'` | `unposted`/`pending_approval`/`posted`/`reversed`/`void` |
| `expense_account_id` | uuid | NULL | FK gl_accounts(id) — the default debit account (overridable per line) |
| `ap_account_id` | uuid | NULL | FK gl_accounts(id) — the AP control account (defaults to vendor.default_ap_account_id) |
| `due_date` | date | NULL | Computed at insert from posting_date + vendor.payment_terms; overridable |
| `accrual_je_id` | uuid | NULL | FK journal_entries(id) — set at posting time |
| `cash_je_id` | uuid | NULL | FK journal_entries(id) — set at payment time (NULL for pure-accrual) |
| `total_amount_cents` | bigint | NOT NULL | Sum of line items; trigger-maintained |
| `paid_amount_cents` | bigint | NOT NULL DEFAULT `0` | Maintained by `invoice_payments` triggers |

Existing planning-side columns (`vendor_id`, `invoice_number`, `notes`, etc.) stay untouched.

**Indexes added:** `(entity_id, gl_status)` partial WHERE `gl_status='pending_approval'`, `(due_date)` WHERE `paid_amount_cents < total_amount_cents`.

### 3.3 `invoice_line_items` — extensions

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `expense_account_id` | uuid | NULL | Overrides parent invoice's default for this line |
| `inventory_item_id` | uuid | NULL | FK ip_item_master(id) — set for inventory receipts that emit M5 layer rows |
| `quantity` | numeric(18,4) | NULL | For inventory lines |
| `unit_cost_cents` | bigint | NULL | For inventory lines (line_total = quantity × unit_cost_cents) |
| `tax_amount_cents` | bigint | NOT NULL DEFAULT `0` | Reserved — P21 tax module |

### 3.4 New: `invoice_payments`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `entity_id` | uuid FK entities(id) | NOT NULL | |
| `invoice_id` | uuid FK invoices(id) ON DELETE RESTRICT | NOT NULL | |
| `payment_date` | date | NOT NULL | |
| `amount_cents` | bigint | NOT NULL CHECK >0 | |
| `bank_account_id` | uuid FK gl_accounts(id) | NOT NULL | Source bank account (asset) |
| `method` | text | NOT NULL | `ach`/`wire`/`check`/`credit_card`/`cash` (CHECK) |
| `reference` | text | NULL | check number / wire confirmation / card auth |
| `cash_je_id` | uuid FK journal_entries(id) | NULL | Set after posting |
| `notes` | text | NULL | |
| `created_at` / `created_by_user_id` | std | — | |

**Constraint:** `SUM(invoice_payments.amount_cents) ≤ invoices.total_amount_cents` enforced via trigger.

### 3.5 Posting rules wired in P3

Add to `api/_lib/accounting/posting/rules/`:

- `apInvoiceReceived.js` — already stubbed in Chunk 3. P3 fills in the body.
  - **Accrual:** DR expense_account_id (or per-line override) AND inventory layer if `inventory_item_id` set; CR ap_account_id. Total balanced.
  - **Cash:** none (no cash movement at invoice receipt; accrual-only event)
- `apInvoicePaid.js` — already stubbed. P3 fills in.
  - **Accrual:** DR ap_account_id; CR bank_account_id (the payment's source account)
  - **Cash:** DR expense_account_id (deferred from receipt); CR bank_account_id
  - Posts via `gl_link_sibling_je` linking accrual + cash twins.
- `apInvoiceVoided.js` — new file. Reverses the accrual JE if any (per `reverseJournalEntry`). Cash JE only reversed if paid was reversed too.

### 3.6 Approval gate hook (M27)

In the AP posting handler (transition `draft → posted`):
```js
const check = await approvalsAPI.requestIfRequired(supabase, {
  kind: 'ap_invoice',
  entity_id: invoice.entity_id,
  context_table: 'invoices',
  context_id: invoice.id,
  amount_cents: invoice.total_amount_cents,
  payload: { vendor_id: invoice.vendor_id, vendor_code: vendor.code, vendor_new: isNewVendor },
});
if (check.required) {
  await supabase.from('invoices').update({ gl_status: 'pending_approval' }).eq('id', invoice.id);
  return { invoice, approval_request_id: check.request_id };
}
// otherwise proceed to post
```

When the approval flips to `approved` (decided via /tangerine ⚙️ Approval Inbox), a small webhook handler (`/api/internal/approval-requests/:id/post-decide-hook`) re-runs the post path for the still-`pending_approval` invoice.

### 3.7 Notification hooks (M28)

| Event | Triggered when | Recipients |
|---|---|---|
| `ap_invoice_received` | Invoice inserted with `gl_status='unposted'` | `recipient_roles: ['accountant']` |
| `ap_invoice_approval_requested` | Approval gate fires | `recipient_roles: ['admin']` |
| `ap_invoice_posted` | Successful GL post | `recipient_roles: ['accountant','admin']` |
| `ap_invoice_paid` | Payment recorded | `recipient_roles: ['accountant','admin']` |
| `ap_invoice_due_soon` | Daily cron: due in ≤ 7 days, unpaid | `recipient_roles: ['accountant','admin']` |

### 3.8 Admin UI surface

- `src/tanda/InternalAPInvoices.tsx` — list + filter (status / vendor / date range) + Add / Edit modal + Post button + Pay button + Void button.
- `src/tanda/InternalAPPayments.tsx` — view-only ledger of `invoice_payments` rows.
- Documents widget embedded in the AP Invoice edit modal: `kinds=['vendor_invoice_pdf','receipt','approval_correspondence']`.

### 3.9 Payment Terms Master (added 2026-05-27 — P3-9)

The original P3 arch left `vendors.payment_terms` and `customers.payment_terms` as free-text columns and described `invoices.due_date` as "computed at insert from posting_date + vendor.payment_terms". That phrase glossed over a real schema gap: there was no structured way to turn `"Net 30"` into 30 days. This chunk closes the gap.

**New table** `payment_terms` (per-entity reference data):

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `entity_id` | uuid FK entities(id) ON DELETE RESTRICT | NOT NULL | |
| `code` | text | NOT NULL | UNIQUE per entity. Uppercased, letters/digits/underscores |
| `name` | text | NOT NULL | Human-readable label |
| `due_days` | int | NOT NULL CHECK ≥ 0 | Days from anchor date until due |
| `discount_pct` | numeric(5,4) | NOT NULL DEFAULT 0 | CHECK in [0, 1) — early-payment decimal |
| `discount_days` | int | NOT NULL DEFAULT 0 | CHECK ≥ 0 |
| `is_active` | boolean | NOT NULL DEFAULT true | |
| std audit | — | — | created_at / updated_at + touch trigger / created_by_user_id |

**Cross-field CHECK:** `discount_pct = 0 OR discount_days > 0` — no early-payment discount without a window.

**Helper function:**
```sql
CREATE FUNCTION compute_due_date(p_anchor_date date, p_payment_terms_id uuid)
  RETURNS date AS $$ ... $$ LANGUAGE plpgsql IMMUTABLE;
```
Returns `anchor_date + due_days`, or `NULL` if either argument is null or the term doesn't exist. AP and AR posting flows call this when stamping `invoices.due_date`.

**FK columns added** (each idempotent `ADD COLUMN IF NOT EXISTS`):

- `vendors.payment_terms_id` uuid NULL FK `payment_terms(id)` ON DELETE SET NULL
- `customers.payment_terms_id` uuid NULL FK `payment_terms(id)` ON DELETE SET NULL
- `invoices.payment_terms_id` uuid NULL FK `payment_terms(id)` ON DELETE SET NULL — overrides the vendor / customer default for that specific invoice

The legacy free-text `payment_terms` columns on vendors + customers are **retained** for backward-compat display; new writes flow through the FK. A future migration may drop the text column once the operator confirms backfill is complete.

**Seeded defaults for ROF** (skipped if any payment_terms rows already exist):

`COD` (0d) · `DUE_ON_RECEIPT` (0d) · `NET10` · `NET15` · `NET30` · `NET45` · `NET60` · `NET90` · `2_10_NET30` (30d, 2%/10d discount).

**Best-effort backfill** (defensive DO $$ block):
- Iterates `vendors` + `customers` rows where `payment_terms_id IS NULL AND payment_terms IS NOT NULL`.
- Normalizes: `UPPER(strip_whitespace(replace('/', '_'), replace('-', '_')))`. So `"Net 30"` → `NET30`; `"due on receipt"` → `DUE_ON_RECEIPT`; `"2/10 net 30"` → `2_10_NET30`.
- For unambiguous matches, sets the FK automatically.
- For unmatched, leaves NULL with a `RAISE NOTICE` per row so the operator can find + fix them via the UI.

**Admin UI:** `src/tanda/InternalPaymentTerms.tsx` — standard list / search / Add / Edit / Delete pattern (hard-delete rejected with reference detail if any vendors / customers / invoices still reference the row). Wired into Master Data group in Tangerine.tsx.

**Vendor + Customer master UIs updated:** the free-text `payment_terms` input is replaced by a dropdown of active `payment_terms` rows. The legacy text value (if any) shows in italic grey under the dropdown so the operator can verify migration before clearing it. New writes send `payment_terms_id` (the text column is no longer written by the admin UIs).

---

## 4. M5 Inventory FIFO

### 4.1 Conceptual model

Every inventory receipt creates a "layer" — a row recording (item, qty_received, unit_cost, receipt_date, source_invoice_id, remaining_qty). When inventory is consumed (sold, transferred, written off), layers are drawn down in FIFO order (oldest receipt first) until the consumption qty is satisfied. The cost flowing into COGS at sale time is the weighted price drawn from the matching layers.

### 4.2 New: `inventory_layers`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `entity_id` | uuid FK entities(id) | NOT NULL | |
| `item_id` | uuid FK ip_item_master(id) | NOT NULL | |
| `received_at` | timestamptz | NOT NULL | Receipt timestamp — drives FIFO ordering |
| `original_qty` | numeric(18,4) | NOT NULL | Layer creation quantity |
| `remaining_qty` | numeric(18,4) | NOT NULL | Drawn down as consumed; CHECK ≥ 0 |
| `unit_cost_cents` | bigint | NOT NULL | Cost-per-unit at receipt |
| `source_kind` | text | NOT NULL | `ap_invoice`/`adjustment`/`opening_balance`/`transfer_in` |
| `source_invoice_id` | uuid | NULL | FK invoices(id) when source_kind=ap_invoice |
| `source_adjustment_id` | uuid | NULL | FK inventory_adjustments(id) |
| `notes` | text | NULL | |
| `created_at` / `created_by_user_id` | std | — | |

Indexes: `(entity_id, item_id, received_at)` (FIFO scan), `(entity_id, item_id, remaining_qty)` partial WHERE `remaining_qty > 0` (open layers only).

### 4.3 New: `inventory_consumption`

Append-only log of every draw-down. One row per (layer, consumption-event, qty-drawn).

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid PK | NOT NULL | |
| `entity_id` | uuid FK entities(id) | NOT NULL | |
| `layer_id` | uuid FK inventory_layers(id) ON DELETE RESTRICT | NOT NULL | |
| `consumed_at` | timestamptz | NOT NULL | |
| `qty_consumed` | numeric(18,4) | NOT NULL | |
| `cogs_cents` | bigint | NOT NULL | `qty_consumed × layer.unit_cost_cents` |
| `consumer_kind` | text | NOT NULL | `ar_invoice`/`adjustment_decrease`/`transfer_out`/`write_off` |
| `consumer_invoice_id` | uuid | NULL | FK invoices(id) — when M4 AR ships, points at the customer invoice |
| `consumer_adjustment_id` | uuid | NULL | |
| `created_at` / `created_by_user_id` | std | — | |

Indexes: `(entity_id, consumed_at)`, `(layer_id)`.

### 4.4 FIFO consumption algorithm

```pseudocode
function consume(item_id, qty_needed, consumer_kind, consumer_ref_id):
  remaining = qty_needed
  total_cogs_cents = 0
  layers = SELECT * FROM inventory_layers
           WHERE item_id = item_id AND remaining_qty > 0
           ORDER BY received_at ASC, id ASC
           FOR UPDATE
  for layer in layers:
    if remaining <= 0: break
    draw = MIN(layer.remaining_qty, remaining)
    INSERT inventory_consumption (layer_id, qty_consumed=draw, cogs_cents=draw * layer.unit_cost_cents, ...)
    UPDATE inventory_layers SET remaining_qty = remaining_qty - draw WHERE id = layer.id
    total_cogs_cents += draw * layer.unit_cost_cents
    remaining -= draw
  if remaining > 0: RAISE 'Insufficient inventory for item X (short by Y units)'
  return total_cogs_cents
```

The whole sequence runs inside the AR posting RPC (or AP-write-off RPC) for atomicity. `FOR UPDATE` row-locks the layers to prevent concurrent draws on the same item.

### 4.5 Posting integration

- **At AP invoice posting** (M3): for each line with `inventory_item_id` set, INSERT one `inventory_layers` row.
- **At AR invoice posting** (M4, future P4): call `consume(...)` per line; the returned `total_cogs_cents` becomes the COGS-side JE line (DR cogs, CR inventory).
- **At inventory adjustment** (M37): positive adjustments INSERT a new layer with `source_kind='adjustment'`; negative adjustments call `consume(...)`.

### 4.6 Opening balance seed

P3 implementation chunk seeds `inventory_layers` from the current `ip_inventory_snapshot` × `ip_item_avg_cost`:

```sql
INSERT INTO inventory_layers (item_id, received_at, original_qty, remaining_qty, unit_cost_cents, source_kind, ...)
SELECT s.item_id, NOW(), s.qty_on_hand, s.qty_on_hand,
       (a.avg_cost_dollars * 100)::bigint, 'opening_balance', ...
  FROM ip_inventory_snapshot s
  JOIN ip_item_avg_cost a ON a.item_id = s.item_id
 WHERE s.qty_on_hand > 0;
```

One layer per item at the average-cost basis — a known approximation that's acceptable because we don't have receipt-layer history for pre-Tangerine inventory. Subsequent AP receipts create real layers.

### 4.7 Cash-basis side

For cash-book reporting, FIFO COGS posts at the **AR payment** event (not AR invoice). The accrual side posts COGS at invoice; the cash twin defers. Same sibling-JE link pattern as M3.

---

## 5. M37 Inventory Operations

### 5.1 Scope

Adjustments, transfers (location-to-location), cycle counts, and bin moves. Each emits GL impact through M5.

### 5.2 Tables

#### `inventory_adjustments`
| Column | Type | Notes |
|---|---|---|
| `id`, `entity_id`, `created_at`, `created_by_user_id` | std | |
| `item_id` | uuid FK ip_item_master(id) | |
| `adjustment_type` | text | CHECK: `damage`/`shrinkage`/`found`/`correction`/`write_off`/`return_to_vendor` |
| `qty_delta` | numeric(18,4) | Can be negative |
| `unit_cost_cents` | bigint NULL | Required for positive adjustments (new layer); NULL for negative (drawn from FIFO) |
| `reason` | text | Operator notes |
| `gl_account_id` | uuid FK gl_accounts(id) | Counter account — typically an expense (shrinkage) or revenue (recovery) |
| `posted_je_id` | uuid FK journal_entries(id) | Set after posting |

#### `inventory_transfers`
For multi-location later. P3 launch: schema in place, `from_location` + `to_location` as text. Posting impact = move qty between layers (consume one location's layer, create new at destination with same `unit_cost_cents`). At single-location launch, this table stays empty.

| `id`, `entity_id`, std | | |
| `item_id` | FK | |
| `qty` | numeric(18,4) | |
| `from_location` / `to_location` | text | |
| `transfer_date` | timestamptz | |
| `notes` | text | |
| `posted_je_id` | FK journal_entries(id) | Usually NULL — internal transfers between owned locations don't hit GL |

#### `inventory_cycle_counts`
| `id`, `entity_id`, std | | |
| `count_date` | date | |
| `location` | text | |
| `status` | text | `in_progress`/`completed`/`cancelled` |
| `counted_by_user_id` | FK auth.users | |

#### `inventory_cycle_count_lines`
| `id`, `cycle_count_id` (FK CASCADE), `item_id` (FK) | | |
| `system_qty` | numeric(18,4) | Snapshot at count creation |
| `counted_qty` | numeric(18,4) | Operator entry |
| `variance_qty` | numeric(18,4) GENERATED | Computed |
| `adjustment_id` | uuid FK inventory_adjustments(id) | Set when variance flushed to an adjustment |

### 5.3 Admin UI surface

- `src/tanda/InternalInventoryAdjustments.tsx` — list + add + post.
- `src/tanda/InternalInventoryTransfers.tsx` — list + add (skeleton; full UX matures when multi-warehouse lands).
- `src/tanda/InternalCycleCounts.tsx` — start count (snapshot), enter counts, finalize → generates adjustments → posts.

### 5.4 Notification hooks

| Event | Recipients |
|---|---|
| `inventory_variance_exceeds_threshold` | `recipient_roles: ['admin']` — when a cycle count line's variance > X% |
| `inventory_write_off_posted` | `recipient_roles: ['admin','accountant']` |

Approval gate fires for adjustments exceeding $X (rule: `kind='inventory_adjustment'`, `min_amount_cents`).

---

## 6. M39 Mobile Scanner

### 6.1 Scope

Native iOS + Android shell that operators carry on the warehouse floor for:
- **Scan-to-receive:** scan vendor PO barcode → load receipt session → scan each item to add to receipt → submit
- **Scan-to-pick:** scan customer SO → scan items as picked → submit completes the SO line items
- **Scan-to-transfer:** scan from-location → items → to-location → submit
- **Scan-to-count:** join cycle count → scan items + qty → submit

P3 ships the **REST contract + offline-replay JSON** that the apps consume. The apps themselves (Swift + Kotlin / React Native — TBD) ship in the M39 implementation chunk; mobile shell is out of the back-end scope.

### 6.2 Auth model

Scanner devices use Supabase Auth via email/password (one auth user per device user). Tokens stored in iOS Keychain / Android Keystore. RLS gates everything via `entity_users.auth_id = auth.uid()`. No new auth flow.

### 6.3 New: `scanner_sessions`

A session represents one operator's scan flow against one target (a receipt, a SO pick, a cycle count, a transfer).

| Column | Type | Notes |
|---|---|---|
| `id`, `entity_id` | std + FK | |
| `device_user_id` | uuid FK auth.users(id) | Who is scanning |
| `mode` | text | `receive`/`pick`/`transfer`/`count` (CHECK) |
| `target_kind` | text | `po`/`so`/`cycle_count`/`adhoc` |
| `target_id` | uuid | Loose FK depending on `target_kind` |
| `status` | text | `open`/`submitted`/`cancelled` |
| `scanned_at` | timestamptz | Last activity |
| `submitted_at` | timestamptz | NULL until submit |
| `client_meta` | jsonb | Device id, app version, network status flags |

### 6.4 New: `scanner_events`

Append-only log of every scan. Sessions are reconstructed by scanning this table.

| Column | Type | Notes |
|---|---|---|
| `id`, `entity_id` | std | |
| `session_id` | uuid FK scanner_sessions(id) ON DELETE CASCADE | |
| `client_event_id` | uuid | Idempotency key — apps generate this offline so replays are dedup-safe |
| `scanned_barcode` | text | Raw barcode value |
| `resolved_item_id` | uuid FK ip_item_master(id) | NULL when barcode doesn't resolve |
| `qty` | numeric(18,4) | Default 1; configurable in the app for pack scans |
| `client_timestamp` | timestamptz | When scan happened on device |
| `server_received_at` | timestamptz DEFAULT `now()` | When server saw it |
| `notes` | text | NULL |

**Unique:** `(session_id, client_event_id)` — dedupes offline replays.

### 6.5 Offline-replay contract

Apps POST batches to `/api/internal/scanner/events/batch`:
```json
{
  "session_id": "uuid",
  "events": [
    { "client_event_id": "uuid", "scanned_barcode": "...", "resolved_item_id": "uuid", "qty": 1, "client_timestamp": "..." }
  ]
}
```
Handler INSERT ... ON CONFLICT (session_id, client_event_id) DO NOTHING. Returns per-event success/failure. Apps drop the local queue items that came back successful.

### 6.6 Submit handler

`POST /api/internal/scanner/sessions/:id/submit` validates the session against `mode` + `target_kind`, then:
- `mode=receive`: aggregates events into receipt line items, calls M3 AP path
- `mode=pick`: aggregates into SO shipment lines (M4 territory — placeholder for P3)
- `mode=transfer`: creates `inventory_transfers` row
- `mode=count`: writes counted_qty into `inventory_cycle_count_lines`

### 6.7 No admin UI in P3

The scanner has no `/tangerine` UI tab in P3 — operator-facing scanner is the mobile app. We add a basic `InternalScannerSessions.tsx` viewer that lets admins see active sessions + event log for troubleshooting, but no edit / submit / cancel.

---

## 6.X Master-data appendix: Fabric Codes (P3-11)

**Added 2026-05-27** after operator flagged the gap: M34 Style Master (P1 Chunk 4) shipped without structured fabric data, M42 PIM is in P8 (months away), but textile-specific fabric reference is needed NOW for tech packs, GS1 care labels, and the M48 customs work. Today fabric info lives in `ip_item_master.attributes` JSONB or unstructured tech-pack PDFs.

This is a lightweight precursor — narrower scope than M42, but unblocks the apparel-side downstream work without forcing the operator to wait for the full PIM build.

### 6.X.1 New: `fabric_codes`

```sql
CREATE TABLE fabric_codes (
  id                       uuid PRIMARY KEY,
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code                     text NOT NULL,           -- short identifier, unique per entity, locked post-creation
  name                     text NOT NULL,
  composition_text         text NOT NULL,           -- free-form for label / tech-pack display
  composition_json         jsonb,                   -- optional structured [{fiber,pct}] for analytics
  fabric_weight_gsm        numeric(8,2),
  country_of_origin_iso2   char(2),                 -- ISO 3166-1 alpha-2; CHECK ~ '^[A-Z]{2}$'
  hts_code                 text,                    -- HTS/HSN for customs (M48)
  care_instructions        text,                    -- for GS1 care labels
  default_vendor_id        uuid REFERENCES vendors(id) ON DELETE SET NULL,
  is_active                boolean NOT NULL DEFAULT true,
  ...std audit cols...
  UNIQUE (entity_id, code)
);
```

Standard P1 RLS template (`anon_all` + `auth_internal`). Idempotent migration. Touch trigger on `updated_at`.

**Defensive seed** for ROF entity (skipped if any fabric_codes row already exists for ROF): 9 common apparel fabrics — `CTN100`, `DEN14`, `DEN12`, `POLY100`, `POLY60_CTN40`, `VIS100`, `WOOL100`, `LINEN100`, `SPANDEX_BLEND`. Country and HTS left NULL — operator fills via UI.

### 6.X.2 New: `style_fabric_codes` (M:N junction)

```sql
CREATE TABLE style_fabric_codes (
  id                  uuid PRIMARY KEY,
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_id            uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  fabric_code_id      uuid NOT NULL REFERENCES fabric_codes(id) ON DELETE RESTRICT,
  role                text NOT NULL CHECK (role IN ('primary','lining','trim','interlining','accent','other')),
  yardage_per_unit    numeric(10,4),
  notes               text,
  ...std audit cols...
  UNIQUE (style_id, fabric_code_id, role)
);
```

The UNIQUE on `(style_id, fabric_code_id, role)` — not just `(style_id, fabric_code_id)` — is intentional: the same fabric can validly appear in multiple roles on the same style (e.g. cotton as `primary` shell AND cotton as `trim` binding).

ON DELETE behavior:
- `style_id` → CASCADE — deleting a style detaches its fabric assignments automatically
- `fabric_code_id` → RESTRICT — can't delete a fabric while it's still in use anywhere; deactivate instead

### 6.X.3 Handler surface

```
/api/internal/fabric-codes            GET (list, ?include_inactive, ?q, ?country, ?limit)
                                      POST (create, validateInsert)
/api/internal/fabric-codes/:id        GET, PATCH (code locked), DELETE (409 if referenced)
/api/internal/style-fabric-codes      GET (style_id OR fabric_code_id required), POST
/api/internal/style-fabric-codes/:id  GET, PATCH (role/yardage/notes only), DELETE
```

### 6.X.4 Admin UI surface

- **New tab** `/tangerine` → Master Data → 🧵 Fabric Codes (`InternalFabricCodes.tsx`)
- **Embedded in Style Master edit modal** — bottom "Fabrics" subsection in `InternalStyleMaster.tsx`. Self-managing component that calls `/api/internal/style-fabric-codes` directly; style master save flow is unchanged.

### 6.X.5 Integration touchpoints (downstream)

| Module | Touchpoint |
|---|---|
| M33 BOM (future) | `style_fabric_codes.yardage_per_unit` → apparel BOM coefficient |
| Tech Pack PDF | `composition_text` + `fabric_weight_gsm` + `care_instructions` render into spec sheet |
| GS1 care label | `care_instructions` → human-readable block on label |
| M48 Customs | `country_of_origin_iso2` + `hts_code` are the two customs columns |
| M42 PIM (P8) | Either folds in as a sub-entity or remains a normalized lookup — decision deferred to P8 arch pass; UI surface is forward-compatible either way |

### 6.X.6 Why not just wait for M42

M42 PIM scope is broad (full product information management including media, marketing copy, multi-channel attributes). Fabric is one small slice. The lightweight `fabric_codes` table satisfies the textile-specific use cases NOW without committing to PIM's data model, and the surface is small enough that it can either fold into M42 cleanly or remain alongside it as a specialized lookup. The cost of building it now is a handful of files; the cost of NOT building it now is keeping fabric info in unstructured PDFs / JSONB until P8 ships.

---

## 7. Hook contract recap

P3 modules CALL P2 cross-cutters; they do not take FKs on cross-cutter tables.

```
                                  ┌──────────────────────┐
                                  │ approvalsAPI         │ M27
                                  │  .requestIfRequired  │
                                  │  .decide             │
                                  │  .cancel             │
                                  └──────────────────────┘
M3 AP Invoice handler  ─────────►─┤
M37 Adjustment handler ─────────►─┤
                                  ┌──────────────────────┐
                                  │ notificationsAPI     │ M28
                                  │  .enqueue            │
                                  └──────────────────────┘
M3 / M5 / M37 / M39    ─────────►─┤
                                  ┌──────────────────────┐
                                  │ <DocumentAttach...   │ M29
                                  └──────────────────────┘
AP Invoice modal       ─────────►─┤  (kind=vendor_invoice_pdf)

Posting service        ─────────►─┤ gl_post_journal_entry RPC  (Chunk 3)
```

---

## 8. RLS

No new RLS pattern. Every new table follows the P1 template:

```sql
CREATE POLICY "anon_all_<table>" ON <table>
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_<table>" ON <table>
  FOR ALL TO authenticated
  USING (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
```

Exceptions:
- `inventory_consumption` is append-only — SELECT + INSERT policies only.
- `scanner_events` is append-only — same.
- `scanner_sessions` allows UPDATE only on `status` and `submitted_at` (column grants via separate policy).

---

## 9. Chunk split (implementation — DO NOT start until operator approves)

In dependency order:

- **P3-1 — M3 AP schema + posting rules**
  - Migration: invoices/invoice_line_items column additions + `invoice_payments` table + indexes + RLS
  - `api/_lib/accounting/posting/rules/apInvoiceReceived.js` (fill body)
  - `api/_lib/accounting/posting/rules/apInvoicePaid.js` (fill body)
  - `api/_lib/accounting/posting/rules/apInvoiceVoided.js` (new)
  - 30+ unit tests

- **P3-2 — M3 admin UI + handlers**
  - `api/_handlers/internal/ap-invoices/` (h27x list/create/[id]/post/pay/void)
  - `api/_handlers/internal/ap-payments/`
  - `src/tanda/InternalAPInvoices.tsx`
  - `src/tanda/InternalAPPayments.tsx`
  - Approval gate hook + notification hooks wired
  - Document widget drop-in
  - User-guide chapter 11

- **P3-3 — M5 FIFO schema + algorithm**
  - Migration: `inventory_layers` + `inventory_consumption` + indexes + RLS
  - PL/pgSQL function: `inventory_fifo_consume(item_id, qty, consumer_kind, consumer_ref_id) RETURNS bigint`
  - Opening-balance seed migration (from `ip_inventory_snapshot` × `ip_item_avg_cost`)
  - 25+ unit tests (mocked draw-down scenarios, concurrent FOR UPDATE, edge cases)

- **P3-4 — M5 integration into M3**
  - AP invoice posting creates `inventory_layers` rows for inventory lines
  - AR-side `consume()` integration is a placeholder (real wire-up in P4)
  - User-guide chapter 12 (concept page)

- **P3-5 — M37 Inventory Adjustments**
  - Migration: `inventory_adjustments` table + RLS
  - `api/_handlers/internal/inventory-adjustments/`
  - `src/tanda/InternalInventoryAdjustments.tsx`
  - Posting integration (positive → new layer; negative → consume)
  - Approval gate for adjustments > $X

- **P3-6 — M37 Cycle Counts**
  - Migration: `inventory_cycle_counts` + `inventory_cycle_count_lines`
  - `src/tanda/InternalCycleCounts.tsx` (snapshot → enter → finalize → generates adjustments)
  - User-guide chapter 13

- **P3-7 — M37 Transfers (skeleton)**
  - Migration: `inventory_transfers` (schema only; UX minimal at single-location)
  - `src/tanda/InternalInventoryTransfers.tsx` (read-only list at launch)

- **P3-8 — M39 Scanner back-end**
  - Migration: `scanner_sessions` + `scanner_events` + RLS
  - `api/_handlers/internal/scanner/sessions/` + `events/batch/` + `submit/`
  - `src/tanda/InternalScannerSessions.tsx` (read-only troubleshooting view)
  - REST contract documented in OpenAPI-style snippet for mobile teams
  - User-guide chapter 14

- **(M39 mobile app implementation is a separate stream of work — Swift/Kotlin or RN — owned by mobile, not part of this back-end pass.)**

<<<<<<< HEAD
- **P3-11 — Fabric Code Master (added 2026-05-27)**
  - Migration: `fabric_codes` + `style_fabric_codes` junction + RLS + 9-fabric seed (ROF entity)
  - `api/_handlers/internal/fabric-codes/` (index.js + [id].js)
  - `api/_handlers/internal/style-fabric-codes/` (index.js + [id].js)
  - `src/tanda/InternalFabricCodes.tsx` (new top-level Master Data tab)
  - Embed Fabrics subsection in `InternalStyleMaster.tsx` edit modal
  - 15 + 10 test cases (validateInsert + validatePatch for both tables)
  - User-guide chapter 15
  - Inserted out of dependency order (no dependency on P3-1…P3-8). Operator flagged the gap on 2026-05-27 evening: M34 Style Master shipped without structured fabric data, M42 PIM is in P8 (months away), but textile-specific fabric reference is needed NOW for tech packs + GS1 care labels + M48 customs.
=======
- **P3-9 — Payment Terms Master (added 2026-05-27)**
  - Migration: `payment_terms` table + `compute_due_date()` helper function + FK columns on vendors / customers / invoices + 9 seeded defaults + best-effort text → FK backfill
  - `api/_handlers/internal/payment-terms/` (index.js + [id].js — standard list/create/get/patch/hard-delete pattern with reference-count guard on DELETE)
  - `src/tanda/InternalPaymentTerms.tsx` (list + search + Add/Edit modal with due-date preview)
  - **Existing panels updated:** `InternalVendorMaster.tsx` + `InternalCustomerMaster.tsx` replace the free-text `payment_terms` input with a structured dropdown of payment_terms rows
  - **Existing handlers updated:** vendor-master + customer-master accept `payment_terms_id` (UUID, validated) in addition to the legacy text column
  - User-guide chapter 14 (`14-payment-terms.md`)
  - ~50 new tests covering validators on all 5 handlers
>>>>>>> 402da48 (Tangerine P3-9 - Payment Terms Master (arch §3.9))

Each chunk lands as its own PR. Isolated worktree pattern per [[feedback-isolated-worktree-for-tangerine]]. Per [[feedback-memorize-each-chunk]], memory + user-guide update in the same PR.

---

## 10. Verification criteria — what proves P3 is "done"

1. **AP lifecycle E2E:** create vendor → upload invoice PDF → enter line items → post → approval rule fires if amount > threshold → approve → JE posts (accrual side) → record payment → cash JE posts (sibling-linked).
2. **FIFO accuracy:** seed 3 receipt layers @ different unit costs → consume across two of them → `cogs_cents` total matches hand-calc; `remaining_qty` decremented correctly.
3. **FIFO concurrency:** two parallel `consume()` calls on the same item draw from disjoint layers (the `FOR UPDATE` row-lock test).
4. **Insufficient inventory raises clearly:** consume more than available → exception with item code + short-by qty.
5. **Adjustment posts:** positive adjustment creates a new layer; negative one consumes; GL impact is the counter-account expense / income.
6. **Cycle count flush:** finalize a count with variance → adjustments auto-generated, posted, layers updated.
7. **Scanner offline replay:** POST same batch twice → second insert is no-op due to `(session_id, client_event_id)` unique.
8. **Approval gate:** AP > $5k blocks at posted; the gate trigger from P2-1 fires the JE-level error.
9. **Notifications fire:** at every AP lifecycle event, dispatches land for the configured roles.
10. **Documents:** AP invoice modal embeds DocumentAttachmentList; uploading a PDF works against the `tangerine-documents` bucket.
11. **Posting service:** `apInvoiceReceived` / `apInvoicePaid` / `apInvoiceVoided` rule bodies wired and dispatched by `postEvent()`.
12. **No regressions:** the 2878 existing tests still pass; new tests bring the total to ~3050.

---

## 11. Sub-decisions deferred to implementation

| # | Sub-decision | Resolve in |
|---|---|---|
| 1 | Default AP control account code | P3-1 (with operator) |
| 2 | Default bank account code for payments | P3-1 (with operator) |
| 3 | Approval rule MVP thresholds for ap_invoice | P3-2 (operator config UI seeded with sensible defaults) |
| 4 | Layer FIFO ordering: tie-break by id only, or include created_by? | P3-3 — recommend id-only for simplicity |
| 5 | Cycle-count variance threshold for the notification rule | P3-6 |
| 6 | Mobile app stack: native vs React Native | Out of P3 scope; M39 mobile-app chunk |
| 7 | Whether scanner barcode-resolve uses item_master.upc, sku_code, or both | P3-8 |
| 8 | AR (M4) inventory consume integration at invoice vs at shipment | P4 architecture pass |
| 9 | ~~Free-text vs structured payment terms~~ — **CLOSED 2026-05-27 (P3-9):** structured `payment_terms` table + `compute_due_date()` helper + FK columns on vendors/customers/invoices. See §3.9. | P3-9 |

---

## 12. Risk register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Opening-balance seed at avg cost mis-states COGS for early sales | High | Med | Documented as a known approximation; reconciled at next physical count. |
| FIFO `FOR UPDATE` causes lock contention on high-volume items | Med | Med | Index supports fast scan; consume scope is per-event so locks are short. Monitor via Supabase performance dashboard at launch. |
| Negative adjustments with no inventory layers raise exception mid-batch | Med | High | Pre-validate availability in handler before the consume call; surface clear error in UI before posting. |
| Mobile scanner offline-replay collides on `client_event_id` if app regenerates uuid per retry | Low | High | Mobile app spec mandates a single uuid per scan, persisted to local DB. Documented in the M39 mobile-app contract. |
| AR (M4) needs consume() but P3 doesn't ship M4 | Certain | Low | Stub the call site in P3-4; M4 lands in P4 and wires it. |
| Approval gate on AP blocks legitimate same-day posts when operator is OOO | Med | Med | Approval rule allows `mode='any'` with multi-role; admin and CEO can both approve. Cancel + re-post path documented. |
| Inventory transfers schema lands without UX | Low | Low | Skeleton schema is fine; deferred UX is called out in the user guide. |

---

## 13. Out of scope (explicit)

- AR (M4) — P4
- Bank/CC feeds (M7) + reconciliation (M8) — P6
- Multi-warehouse / per-location inventory tracking — stretch
- Multi-currency / FX — locked USD only
- Mobile scanner native iOS/Android app implementation — separate work stream
- Tax (M21) on AP invoices — P25
- 1099 generation (M20) — P25
- Fixed assets (M22) — P25

---

## 14. Approval handshake

This doc-only PR auto-merges on CI green per the revised [[feedback-plan-approval-not-implementation]] rule. **Implementation chunks (P3-1 onward) require explicit operator approval before they kick off** — the pause-and-ask rule still applies for code/schema work.

Kickoff sequence when ready:
1. Operator reviews this doc end-to-end
2. Operator picks default AP control + default bank account codes (sub-decisions §11.1 + §11.2)
3. Operator says "go" — P3-1 opens as the first PR
4. Subsequent chunks ship one-at-a-time per the [[feedback-memorize-each-chunk]] rule
