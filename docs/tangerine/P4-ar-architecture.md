# Tangerine P4 — Accounts Receivable Architecture Pass

**Codename:** Tangerine
**Phase:** P4 Accounts Receivable
**Modules:** M4 Accounts Receivable + 5-Year Historical Backfill
**Status:** Architecture only — no code yet. Doc-only PRs auto-merge per the revised [[feedback-plan-approval-not-implementation]] rule; operator approval is still required before implementation chunks ship.
**Date:** 2026-05-27
**Inputs:** P1 + P2 + P3 all merged + applied through 2026-05-27. See `P1-foundation-architecture.md`, `P2-cross-cutters-architecture.md`, `P3-acc-core-architecture.md`, and `project_tangerine_progress.md`.

---

## 0. Scope guardrails

This pass produces:

1. AR invoice lifecycle (`draft → sent → partial_paid → paid → void`) — mirror of P3's M3 AP shape with the symmetric debit/credit flip.
2. AR payment + receipt schema and posting integration.
3. FIFO ↔ AR consume() integration at the `sent` transition — fills the COGS-side JE that P3-4 left stubbed in `arInvoiceSent.js`.
4. Customer credit limits + age-bucket aging report.
5. **5-Year Historical Backfill** — the heaviest piece — ingesting `ip_sales_history_wholesale` and `ip_sales_history_ecom` into AR + GL with `posted_historical` status and a one-time period-lock bypass.
6. Posting-rule bodies for `arInvoiceSent` / `arPaymentReceived` / `arInvoiceVoided` / `arCreditMemo`.
7. Approval rule + notification hooks (credit limit, void-above-threshold, payment received, overdue).
8. Admin UI surfaces — sketch only; chunk split owns the build.

This pass does **not** produce:

- Bank/CC feed reconciliation (M7/M8 in P6).
- SO entry + pricing (still in Xoro through P15+P16 / M43+M10).
- B2B portal customer self-service (P18 / M40+M41).
- Drop-ship AR pure-product flow (P20 / M49).
- Sales tax on AR (P25 / M21).
- Multi-currency / FX (locked USD-only per roadmap §1).
- Carrier integration (P16 / M44).
- 1099 generation, fixed assets (P25 / M20+M22).

---

## 1. Existing state (one-paragraph map)

After P3: dual-basis GL with posting trigger guards is live; COA / Periods / JE admin UIs are deployed; the M3 AP lifecycle ships end-to-end (invoice → post → pay → void), with FIFO layers created at AP posting and the FIFO `consume()` RPC available via `api/_lib/inventory/fifo.js`. The cross-cutters (M27 Approvals, M28 Notifications, M29 Documents, M30 Employees) are all wired and ready to call from any new posting flow. **AR is half-stubbed:** `arInvoiceSent.js` and `arPaymentReceived.js` exist as posting rules but the COGS-side at `arInvoiceSent` carries only a `TODO P4` placeholder — no actual FIFO consume call. **The legacy `invoices` table is vendor-only** (it has `vendor_id` NOT NULL and `vendor_own_*` RLS policies for the portal) — using it polymorphically for customer invoices would force the `vendor_id` constraint to NULL and conflict with the vendor-portal RLS. **`customers` exists from P1 Chunk 6** as the canonical M36 master. **`ip_sales_history_wholesale` + `ip_sales_history_ecom`** carry ~5 years of historical sales data (Xoro feed + Shopify feed respectively) — these are the backfill source. **No AR receipt table** anywhere yet; `arPaymentReceived` rule references `ar_receipts` as `source_table` in description text only, not a real table.

---

## 2. Decisions feeding this pass (recap from locked decisions + arch context)

| # | Decision | Source | Impact |
|---|---|---|---|
| 1 | USD only | Roadmap locked #1 | No FX schema in P4; `currency` column kept for forward-compat only |
| 2 | Dual accrual + cash | Roadmap locked #2 | Every AR event emits accrual + cash twins where appropriate |
| 3 | 5-year AR backfill | Roadmap locked #3 | One-shot migration in P4-8 reads `ip_sales_history_*` and produces synthetic AR + JEs |
| 4 | Accountant identity deferred | Roadmap locked #4 | AR approval rules support single + multi-user routing |
| 5 | FIFO per receipt layer | Roadmap locked #5 | AR `sent` consumes from `inventory_layers` FIFO; backfill consumes from pre-cutover `opening_balance` layers only |
| 6 | **Sibling tables `ar_invoices` + `ar_invoice_lines` (NOT reuse `invoices`)** | This doc §3.1 | See §3.1 for rationale |
| 7 | **`posted_historical` gl_status + scoped `bypass_period_lock`** (NOT reopen-and-repost) | This doc §6.2 | Bypass is trigger-side, only honored when JE journal_type='ar_invoice_historical' AND originating call sets bypass flag inside the backfill RPC — operator UI cannot set it |
| 8 | Credit limits enforced via M27 approval gate | This doc §7 | Soft-block via `customer_credit_extension` approval rule; legitimate override path goes through Approval Inbox |

---

## 3. M4 Accounts Receivable

### 3.1 BIG DECISION — sibling tables `ar_invoices` + `ar_invoice_lines`, NOT reuse `invoices`

The original arch question: extend the existing `invoices` table polymorphically (add `invoice_kind` in {`vendor_bill`, `customer_invoice`}) OR introduce sibling tables `ar_invoices` + `ar_invoice_lines`?

**Decision: sibling tables.** Three forcing reasons:

1. **`invoices.vendor_id` is NOT NULL today** with `REFERENCES vendors(id) ON DELETE RESTRICT`, and it carries vendor-portal RLS policies (`vendor_own_invoices_select` / `vendor_own_invoices_insert` / `vendor_own_invoices_update_while_submitted`). Polymorphic reuse would require dropping the NOT NULL constraint, weakening vendor-portal isolation, and adding `customer_id` as a sibling-nullable column. Every existing query that joins `invoices` to `vendors` would need a `WHERE invoice_kind='vendor_bill'` filter retrofitted in to stay correct. That's a large blast radius.

2. **P3 chunk P3-1 already committed** to `invoices` extensions for AP (`gl_status`, `expense_account_id`, `ap_account_id`, `accrual_je_id`, `cash_je_id`, `total_amount_cents`, `paid_amount_cents`, `payment_terms_id`). The AP-flavored column names (`expense_account_id`, `ap_account_id`) become semantically misleading on a customer-invoice row. Renaming to `gl_debit_default_account_id` + `gl_credit_default_account_id` would be technically cleaner but would force a destructive migration on the live P3 AP table.

3. **5-year backfill volume.** The backfill inserts ~5 years × ~1k invoices/yr = ~5,000+ AR invoice headers plus 10× that many lines. Mixing those into the live `invoices` table doubles the table's row count and forces every existing AP-side index (`uq_invoices_vendor_number`, `idx_invoices_status`, etc.) to scan over irrelevant AR rows. Sibling tables keep AP-side query performance untouched.

**Tradeoffs accepted with sibling tables:**

- Two parallel posting-payments tables (`invoice_payments` for AP, new `ar_receipts` for AR). The DRY cost is small because the posting rules differ enough that a shared table would need a `kind` column anyway.
- Two parallel admin UIs (`InternalAPInvoices.tsx` and a new `InternalARInvoices.tsx`). Code duplication is real but UX differs (Send vs Post, Credit Memo, Aging report) — sharing a base modal would be premature abstraction.
- Documents drop-in pattern still works: `<DocumentAttachmentList contextTable="ar_invoices" ...>` instead of `contextTable="invoices"` — no shared-blob assumption.

### 3.2 New: `ar_invoices`

```
ar_invoices (
  id                  uuid PK DEFAULT gen_random_uuid()
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT
  invoice_number      text NOT NULL                  -- AR-YYYY-NNNNN format; UNIQUE (entity_id, invoice_number)
  invoice_kind        text NOT NULL DEFAULT 'customer_invoice'
                        CHECK (invoice_kind IN ('customer_invoice','customer_credit_memo','customer_invoice_historical'))
  gl_status           text NOT NULL DEFAULT 'draft'
                        CHECK (gl_status IN ('draft','pending_approval','sent','partial_paid','paid','void','posted_historical'))
  posting_date        date NOT NULL                  -- maps to invoice_date for new; ip_sales_history_wholesale.invoice_date for backfill
  due_date            date                            -- computed via compute_due_date(posting_date, payment_terms_id)
  payment_terms_id    uuid REFERENCES payment_terms(id) ON DELETE SET NULL    -- overrides customer's default
  ar_account_id       uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT      -- debit at send (AR control); default from entity.default_ar_account_id (new col, see §3.9)
  revenue_account_id  uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT      -- credit at send (default revenue); per-line override possible
  cogs_account_id     uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT      -- debit at FIFO consume
  inventory_account_id uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT     -- credit at FIFO consume
  accrual_je_id       uuid REFERENCES journal_entries(id) ON DELETE SET NULL  -- set at sent
  cash_je_id          uuid REFERENCES journal_entries(id) ON DELETE SET NULL  -- set per AR payment (deferred cash basis)
  total_amount_cents  bigint NOT NULL DEFAULT 0       -- trigger-maintained from ar_invoice_lines
  paid_amount_cents   bigint NOT NULL DEFAULT 0       -- trigger-maintained from ar_receipts
  reversed_by_invoice_id uuid REFERENCES ar_invoices(id) ON DELETE SET NULL   -- when a credit memo voids this
  reverses_invoice_id    uuid REFERENCES ar_invoices(id) ON DELETE SET NULL   -- self-ref for credit memos
  shipment_id         uuid                            -- soft FK to shipments(id); set when SO entry lands in P15
  notes               text
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
  created_at          timestamptz NOT NULL DEFAULT now()
  updated_at          timestamptz NOT NULL DEFAULT now()
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL

  UNIQUE (entity_id, invoice_number)
)

INDEX (entity_id, gl_status)
INDEX (entity_id, posting_date)               -- AR aging + reports
INDEX (customer_id, posting_date)             -- per-customer ledger
INDEX (entity_id, due_date) WHERE paid_amount_cents < total_amount_cents     -- overdue scan
INDEX (entity_id, gl_status) WHERE gl_status = 'pending_approval'             -- approval inbox
INDEX (invoice_kind) WHERE invoice_kind = 'customer_invoice_historical'      -- backfill scan
```

**Triggers:**
- `ar_invoices_touch_updated_at` on UPDATE (standard).
- `ar_invoices_total_maintainer` AFTER INSERT/UPDATE/DELETE on `ar_invoice_lines` — recomputes parent `total_amount_cents` = SUM(line_total_cents) (mirror of P3-1's pattern on `invoices`).
- `ar_invoices_paid_maintainer` AFTER INSERT/UPDATE/DELETE on `ar_receipts` — recomputes `paid_amount_cents` = SUM(amount_cents) for receipts pointing at this invoice; flips gl_status `sent → partial_paid → paid` based on threshold (paid_amount_cents >= total_amount_cents).
- `ar_invoices_status_guard` BEFORE UPDATE — rejects `gl_status` regressions (e.g. paid → draft) outside the void/credit-memo path.

### 3.3 New: `ar_invoice_lines`

```
ar_invoice_lines (
  id                    uuid PK DEFAULT gen_random_uuid()
  entity_id             uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT
  ar_invoice_id         uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE CASCADE
  line_index            integer NOT NULL              -- 1-based ordering within invoice
  description           text
  inventory_item_id     uuid REFERENCES ip_item_master(id) ON DELETE SET NULL    -- when set, drives FIFO consume at send
  revenue_account_id    uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT       -- overrides parent's default
  quantity              numeric(18,4)
  unit_price_cents      bigint                        -- AR-side unit price (selling price, not cost)
  line_total_cents      bigint NOT NULL               -- explicit (not generated) — lets historical backfill carry the raw amount even when qty/unit_price are missing
  tax_amount_cents      bigint NOT NULL DEFAULT 0     -- reserved P21
  -- COGS resolution (set at send time by posting rule, NOT operator):
  cogs_cents            bigint                        -- the FIFO result; NULL until sent
  cogs_resolved_at      timestamptz                   -- when consume() ran
  notes                 text
  created_at            timestamptz NOT NULL DEFAULT now()

  UNIQUE (ar_invoice_id, line_index)
)

INDEX (ar_invoice_id)
INDEX (inventory_item_id) WHERE inventory_item_id IS NOT NULL
```

### 3.4 New: `ar_receipts`

Customer payment received (the AR-side analogue of `invoice_payments`). One row per receipt event; a single receipt may apply to multiple invoices via a junction table (next).

```
ar_receipts (
  id                  uuid PK DEFAULT gen_random_uuid()
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT
  receipt_date        date NOT NULL
  total_amount_cents  bigint NOT NULL CHECK (total_amount_cents > 0)
  bank_account_id     uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT
  method              text NOT NULL                  -- 'ach' | 'wire' | 'check' | 'credit_card' | 'cash' | 'other'
                        CHECK (method IN ('ach','wire','check','credit_card','cash','other'))
  reference           text                            -- check number / wire confirmation / Stripe charge id
  notes               text
  accrual_je_id       uuid REFERENCES journal_entries(id) ON DELETE SET NULL
  cash_je_id          uuid REFERENCES journal_entries(id) ON DELETE SET NULL
  is_void             boolean NOT NULL DEFAULT false
  voided_at           timestamptz
  voided_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL
  void_reason         text
  created_at          timestamptz NOT NULL DEFAULT now()
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL
)

INDEX (entity_id, receipt_date)
INDEX (customer_id, receipt_date)
INDEX (entity_id, method)
```

### 3.5 New: `ar_receipt_applications`

A receipt is applied against one or more invoices. Junction table:

```
ar_receipt_applications (
  id                  uuid PK DEFAULT gen_random_uuid()
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT
  ar_receipt_id       uuid NOT NULL REFERENCES ar_receipts(id) ON DELETE CASCADE
  ar_invoice_id       uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE RESTRICT
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0)
  applied_at          timestamptz NOT NULL DEFAULT now()
  notes               text                           -- optional per-application memo (e.g. discount applied)

  UNIQUE (ar_receipt_id, ar_invoice_id)              -- one application row per (receipt, invoice) pair
)

INDEX (ar_invoice_id)
```

**Trigger:** `ar_receipt_application_invariant` BEFORE INSERT/UPDATE — enforces `SUM(applications.amount_cents) ≤ receipt.total_amount_cents`. Over-allocation is rejected. Under-allocation is allowed and reported in `v_ar_unapplied_receipts` (see §3.10).

### 3.6 `customers` — extensions

Add (idempotent ADD COLUMN IF NOT EXISTS):

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `credit_limit_cents` | bigint | NULL | NULL = no limit. ≥ 0 when set. CHECK enforced. |
| `credit_limit_currency` | char(3) | NOT NULL DEFAULT `'USD'` | Forward-compat only; locked to USD at launch. |
| `default_ar_account_id` | uuid | NULL | FK gl_accounts(id) — customer-specific AR control account override (rare; defaults to entity.default_ar_account_id) |
| `default_revenue_account_id` | uuid | NULL | FK gl_accounts(id) — per-customer revenue account routing (e.g. wholesale vs ecom) |

### 3.7 `entities` — extensions

Add (idempotent):

| Column | Type | Notes |
|---|---|---|
| `default_ar_account_id` | uuid NULL | FK gl_accounts(id). Operator default: AR code `1200`. |
| `default_revenue_account_id` | uuid NULL | FK gl_accounts(id). Operator default: revenue code `4000`. |
| `default_cogs_account_id` | uuid NULL | FK gl_accounts(id). Operator default: COGS code `5000`. |
| `default_inventory_account_id` | uuid NULL | FK gl_accounts(id). Operator default: inventory code `1300`. (Already referenced by P3-3 opening-balance seed; this just adds the FK column.) |

### 3.8 Posting trigger extension — `bypass_period_lock`

The `gl_post_journal_entry` posting trigger (introduced in P1 Chunk 2 + RPC in P1 Chunk 3) currently rejects writes to JEs whose `period_id.status = 'closed'`. Backfill needs to write to historically-closed periods. **The arch decision:** add a SECURITY-DEFINER-scoped function parameter, NOT an operator-settable flag.

```sql
CREATE OR REPLACE FUNCTION gl_post_journal_entry(
  p_je_id uuid,
  p_bypass_period_lock boolean DEFAULT false   -- NEW in P4
) RETURNS uuid AS $$
DECLARE
  v_period_status text;
  v_journal_type text;
BEGIN
  SELECT gp.status, je.journal_type
    INTO v_period_status, v_journal_type
    FROM journal_entries je
    JOIN gl_periods gp ON gp.id = je.period_id
   WHERE je.id = p_je_id;

  -- Bypass is honored ONLY for historical-backfill journal_type entries.
  -- Any other use raises a hard error — backfill is the only legitimate caller.
  IF p_bypass_period_lock AND v_journal_type NOT IN ('ar_invoice_historical', 'ar_receipt_historical') THEN
    RAISE EXCEPTION 'bypass_period_lock requires journal_type in (ar_invoice_historical, ar_receipt_historical); got %', v_journal_type;
  END IF;

  IF v_period_status = 'closed' AND NOT p_bypass_period_lock THEN
    RAISE EXCEPTION 'cannot post to closed period';
  END IF;

  -- ... rest of posting logic unchanged ...
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Why scoped, not operator-overridable:** the `journal_type` check is the gate. A backfill caller sets `bypass_period_lock=true` AND sets `journal_type='ar_invoice_historical'` on the JE BEFORE calling the RPC. Operators acting through the admin UI never set `journal_type` directly — the AP/AR/JE handlers hardcode it. So there is no admin-UI path that lets an operator post into a closed period. The bypass is structurally locked to the backfill migration.

### 3.9 New: `v_cash_receipts_journal` (view)

Standard accounting report: every cash event impacting AR, joined to its applications and underlying invoices. Useful for monthly reconciliation against bank statements.

```sql
CREATE OR REPLACE VIEW v_cash_receipts_journal AS
SELECT
  r.entity_id,
  r.id              AS receipt_id,
  r.receipt_date,
  r.method,
  r.reference,
  r.bank_account_id,
  c.name            AS customer_name,
  c.id              AS customer_id,
  app.ar_invoice_id,
  inv.invoice_number,
  app.amount_cents  AS applied_amount_cents,
  r.total_amount_cents AS receipt_total_cents,
  (r.total_amount_cents - COALESCE(SUM(app2.amount_cents) OVER (PARTITION BY r.id), 0)) AS unapplied_cents,
  r.accrual_je_id,
  r.cash_je_id
FROM ar_receipts r
  JOIN customers c ON c.id = r.customer_id
  LEFT JOIN ar_receipt_applications app ON app.ar_receipt_id = r.id
  LEFT JOIN ar_receipt_applications app2 ON app2.ar_receipt_id = r.id
  LEFT JOIN ar_invoices inv ON inv.id = app.ar_invoice_id
WHERE r.is_void = false;
```

### 3.10 New: `v_ar_aging` + `v_ar_unapplied_receipts` (views)

`v_ar_aging` is computed on-demand; the admin UI passes an `as_of_date` parameter to the handler, which writes a parameterized version:

```sql
-- Pseudo-view; the real impl is a SQL function returning SETOF for parameterization
CREATE OR REPLACE FUNCTION ar_aging_as_of(p_entity_id uuid, p_as_of_date date)
RETURNS TABLE (
  customer_id uuid,
  customer_name text,
  current_cents bigint,        -- 0-30 days
  bucket_30_cents bigint,      -- 31-60 days
  bucket_60_cents bigint,      -- 61-90 days
  bucket_90_cents bigint,      -- 91-120 days
  bucket_120_cents bigint,     -- 121+ days
  total_outstanding_cents bigint
) AS $$
  SELECT
    c.id,
    c.name,
    SUM(CASE WHEN (p_as_of_date - inv.due_date)  <= 30  AND outstanding > 0 THEN outstanding ELSE 0 END) AS current_cents,
    SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 31 AND 60 THEN outstanding ELSE 0 END) AS bucket_30_cents,
    SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 61 AND 90 THEN outstanding ELSE 0 END) AS bucket_60_cents,
    SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 91 AND 120 THEN outstanding ELSE 0 END) AS bucket_90_cents,
    SUM(CASE WHEN (p_as_of_date - inv.due_date) > 120 THEN outstanding ELSE 0 END) AS bucket_120_cents,
    SUM(outstanding) AS total_outstanding_cents
  FROM customers c
  JOIN LATERAL (
    SELECT inv.id, inv.due_date,
           (inv.total_amount_cents - inv.paid_amount_cents) AS outstanding
      FROM ar_invoices inv
     WHERE inv.customer_id = c.id
       AND inv.entity_id = p_entity_id
       AND inv.gl_status NOT IN ('draft','void','pending_approval')
       AND inv.posting_date <= p_as_of_date
       AND (inv.total_amount_cents - inv.paid_amount_cents) > 0
  ) inv ON true
  GROUP BY c.id, c.name;
$$ LANGUAGE sql STABLE;
```

`v_ar_unapplied_receipts` lists receipts with unapplied balance (over-payments + on-account receipts):
```sql
CREATE OR REPLACE VIEW v_ar_unapplied_receipts AS
SELECT
  r.entity_id, r.id AS receipt_id, r.customer_id, r.receipt_date, r.total_amount_cents,
  COALESCE(SUM(app.amount_cents), 0) AS applied_cents,
  r.total_amount_cents - COALESCE(SUM(app.amount_cents), 0) AS unapplied_cents
FROM ar_receipts r
LEFT JOIN ar_receipt_applications app ON app.ar_receipt_id = r.id
WHERE r.is_void = false
GROUP BY r.id, r.entity_id, r.customer_id, r.receipt_date, r.total_amount_cents
HAVING r.total_amount_cents > COALESCE(SUM(app.amount_cents), 0);
```

---

## 4. Posting rules

### 4.1 `arInvoiceSent.js` — fill the body

Replaces the existing stub. Per arch §4 of P3, when an AR invoice is sent:

- **Accrual JE:** DR ar_account / CR revenue (per-line if line override) + per-inventory-line FIFO COGS pair (DR cogs / CR inventory).
- **Cash JE:** none (deferred to AR payment receipt).

```js
export async function arInvoiceSent(event, ctx) {
  const d = event.data;
  required(d, ["invoice_id", "customer_id", "invoice_number", "invoice_date",
               "ar_account_id", "revenue_account_id", "lines"]);
  // ctx provides { supabase, fifoAPI: inventory_fifo_consume wrapper }

  let lineNumber = 1;
  const accrualLines = [];
  const consumePlan = [];   // P3-5 vocabulary — postEvent drains this BEFORE persist

  let arTotalCents = 0n;
  for (const ln of d.lines) {
    const revenueAccountId = ln.revenue_account_id || d.revenue_account_id;
    const amountCents = toCents(ln.line_total);
    // Revenue credit (one line per AR line)
    accrualLines.push({
      line_number: lineNumber++,
      account_id: revenueAccountId,
      debit: "0",
      credit: ln.line_total,
      memo: ln.description || `AR invoice ${d.invoice_number}`,
      subledger_type: null,
      subledger_id: null,
    });
    arTotalCents += amountCents;

    // FIFO COGS pair — only if line has inventory_item_id + qty
    if (ln.inventory_item_id && ln.quantity != null) {
      // Sentinel "0" amounts in JE; postEvent rewrites after consume() returns cogs_cents
      // consumer_ref_id = ar_invoice_line_id (the line stores cogs_cents post-consume)
      const dr = { line_number: lineNumber++, account_id: d.cogs_account_id, debit: "0", credit: "0",
                   memo: `COGS ${d.invoice_number} L${ln.line_index}`,
                   subledger_type: "item", subledger_id: ln.inventory_item_id };
      const cr = { line_number: lineNumber++, account_id: d.inventory_account_id, debit: "0", credit: "0",
                   memo: `COGS ${d.invoice_number} L${ln.line_index}`,
                   subledger_type: "item", subledger_id: ln.inventory_item_id };
      accrualLines.push(dr, cr);
      consumePlan.push({
        item_id: ln.inventory_item_id,
        qty: ln.quantity,
        consumer_kind: "ar_invoice",
        consumer_ref_id: ln.id,                  // ar_invoice_line.id
        dr_line_ix: accrualLines.length - 2,     // index in the lines array for rewrite
        cr_line_ix: accrualLines.length - 1,
        target_line_id: ln.id,                   // for setting cogs_cents back onto the ar_invoice_line
      });
    }
  }
  // DR AR (sum of revenue credits, mirror of P3-1's CR-AP pattern)
  accrualLines.unshift({
    line_number: 0,   // renumbered after unshift to 1
    account_id: d.ar_account_id,
    debit: fromCents(arTotalCents),
    credit: "0",
    memo: `AR invoice ${d.invoice_number}`,
    subledger_type: "customer",
    subledger_id: d.customer_id,
  });
  // Renumber lines 1..N
  accrualLines.forEach((l, i) => { l.line_number = i + 1; });

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_invoice",
    posting_date: d.invoice_date,
    source_module: "ar",
    source_table: "ar_invoices",
    source_id: d.invoice_id,
    description: `AR invoice ${d.invoice_number}`,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: accrualLines,
  };

  return { accrual, cash: null, consumePlan };
}
```

**`consumePlan` shape — exactly as P3-5 introduced it** (see `project_tangerine_progress.md` P3-5 note for the vocabulary): postEvent iterates the plan BEFORE `persistRuleOutput`, calls `inventory_fifo_consume()` per item, captures the returned `cogs_cents`, then mutates the relevant lines on the accrual candidate (rewriting `debit` on the DR line and `credit` on the CR line) before persistence. Per-line `cogs_cents` is also written back to `ar_invoice_lines.cogs_cents` (+ `cogs_resolved_at = now()`). The atomicity tradeoff is the P3-5 inverse: consume() mutates `inventory_layers` + `inventory_consumption` BEFORE the JE persists, so if persist fails, the FIFO ledger leads the GL by one event. P3-5 documented this asymmetry as acceptable; P4 inherits it.

### 4.2 `arPaymentReceived.js` — fill the body

Mirror of P3 `apInvoicePaid.js` flipped to AR. Triggered per `ar_receipt` row insert.

- **Accrual JE:** DR bank_account / CR ar_account (clears AR)
- **Cash JE:** DR bank_account / CR revenue_account (deferred revenue recognition — cash basis)

The existing rule (`arPaymentReceived.js`) already has the right shape for the simple single-invoice case — P4 extends it to handle multi-application receipts. When a single `ar_receipt` applies to N invoices, the rule emits ONE accrual JE per receipt with N credit lines (one per invoice's AR-clear), and ONE cash JE per receipt with N revenue credit lines. The data payload becomes:

```jsonc
event.data = {
  receipt_id, customer_id, receipt_date,
  bank_account_id, ar_account_id, revenue_account_id,
  applications: [{ invoice_id, amount_cents, line_index }],  // from ar_receipt_applications
  total_amount_cents
}
```

Cash JE revenue split: if the applied invoice carries a per-line `revenue_account_id`, the cash side splits the amount proportionally across those revenue accounts. Default routing (single revenue account) when no per-line override.

### 4.3 `arInvoiceVoided.js` — new rule

Emits a `reversals: string[]` shape (same pattern as P3-1's `apInvoiceVoided.js` — see [[project-tangerine-progress]] P3 deviation #1):

```js
export function arInvoiceVoided(event) {
  const d = event.data;  // { invoice_id, accrual_je_id, cash_je_id }
  const reversals = [];
  if (d.accrual_je_id) reversals.push(d.accrual_je_id);
  if (d.cash_je_id)    reversals.push(d.cash_je_id);  // only if payment was already recognized in cash basis
  return { accrual: null, cash: null, reversals };
}
```

`postEvent` recognizes the `reversals` output (P3-1 already extended `index.js` for this) and calls `reverseJournalEntry(jeId)` for each. The reverse handler emits a new JE with negated lines (`reverses_je_id` set) and the FIFO consumption is RESTORED — `inventoryFifoAPI.restoreConsumption(consumer_ref_id)` undoes the layer draw-downs for any `inventory_consumption` rows with `consumer_kind='ar_invoice'` AND `consumer_invoice_id=<voided invoice id>`. (`restoreConsumption` is a new helper added to `api/_lib/inventory/fifo.js` in P4-2 — finds the consumption rows, restores remaining_qty to the source layer, deletes the consumption row inside a transaction.)

### 4.4 `arCreditMemo.js` — new rule

Credit memos can be:
- **Full void of a sent invoice** — reverses revenue + AR + COGS + inventory; functionally equivalent to `arInvoiceVoided` but with a separate audit trail (the credit memo is a real document the customer receives).
- **Partial credit** — credits a portion of revenue + AR; does NOT touch inventory unless the line was specifically marked "return-to-stock".

```js
export function arCreditMemo(event) {
  const d = event.data;
  // d = { credit_memo_id, original_invoice_id, customer_id, credit_amount_cents,
  //       inventory_returned_lines: [{ item_id, qty, layer_layer_overrides? }], ... }
  // The accrual JE: DR revenue / CR AR (negated original)
  // If inventory_returned_lines is non-empty, ALSO emit per-line:
  //   DR inventory / CR cogs   (reverse the COGS hit)
  // No FIFO restoreConsumption — instead, a NEW layer is created with
  // source_kind='customer_return' and unit_cost_cents pulled from the original
  // consume's average cost (operator can override per line if the return was
  // damaged and should layer at a lower cost).
  ...
  return { accrual, cash: null, inventoryLayers };
}
```

Re-using P3-4's `inventoryLayers[]` drain pattern for the return-to-stock case keeps the posting service abstraction clean. A new `inventory_layers.source_kind` enum value is added in P4-1: `'customer_return'`.

---

## 5. Hook contracts — calling P2 cross-cutters

P4 modules call the P2 hooks; they do not take FKs on cross-cutter tables (same contract as P3).

### 5.1 Approvals (M27)

Two kinds wire in:

- **`customer_credit_extension`** — fires when `(existing_ar_balance + new_invoice_total) > customers.credit_limit_cents`. Hook called from the AR invoice handler at `draft → sent` transition, BEFORE posting. Rule example:
  ```jsonc
  { "kind": "customer_credit_extension",
    "match": { "min_breach_pct": 0 },   // any breach
    "steps": [{ "step_order": 1, "mode": "any", "role_required": "ceo" }] }
  ```
- **`ar_invoice_void_above_threshold`** — for high-dollar voids/credit-memos that affect closed-period financials. Rule example:
  ```jsonc
  { "kind": "ar_invoice_void_above_threshold",
    "match": { "min_amount_cents": 1000000 },   // $10k+
    "steps": [{ "step_order": 1, "mode": "any", "role_required": "ceo" }] }
  ```

Hook code (mirror of P3-2 pattern):
```js
const check = await approvalsAPI.requestIfRequired(supabase, {
  kind: 'customer_credit_extension',
  entity_id: invoice.entity_id,
  context_table: 'ar_invoices',
  context_id: invoice.id,
  amount_cents: invoice.total_amount_cents,
  payload: {
    customer_id: invoice.customer_id, customer_code: customer.code,
    existing_balance_cents: existingBalance, credit_limit_cents: customer.credit_limit_cents,
    breach_cents: (existingBalance + invoice.total_amount_cents) - customer.credit_limit_cents,
  },
});
if (check.required) {
  await supabase.from('ar_invoices').update({ gl_status: 'pending_approval' }).eq('id', invoice.id);
  return { invoice, approval_request_id: check.request_id };
}
// otherwise proceed to send
```

When the approval flips to `approved`, the `approval-requests/decide.js` post-hook re-runs the send path with `fromApprovalHook=true` (same pattern P3-2 introduced for AP).

### 5.2 Notifications (M28)

| Event | Triggered when | Recipients |
|---|---|---|
| `ar_invoice_sent` | AR invoice flips to `sent` | `recipient_roles: ['accountant', 'admin']` |
| `ar_payment_received` | `ar_receipts` row inserted | `recipient_roles: ['accountant', 'admin']` |
| `ar_invoice_overdue_30` | Daily cron: days_overdue between 30 and 59 | `recipient_roles: ['accountant', 'admin']` |
| `ar_invoice_overdue_60` | Daily cron: days_overdue between 60 and 89 | `recipient_roles: ['accountant', 'admin']` |
| `ar_invoice_overdue_90` | Daily cron: days_overdue >= 90 | `recipient_roles: ['admin']` (CEO escalation) |
| `ar_credit_limit_breach` | Approval rule `customer_credit_extension` fires | `recipient_roles: ['admin']` |
| `ar_credit_memo_issued` | Credit memo posts | `recipient_roles: ['accountant', 'admin']` |
| `ar_receipt_voided` | Receipt void event | `recipient_roles: ['accountant', 'admin']` |

Daily cron `/api/cron/ar-overdue-scan.js` runs at 09:00 ET, scans `ar_invoices` where `gl_status IN ('sent','partial_paid')` and `due_date <= current_date - threshold`, enqueues one notification per invoice per threshold band (idempotent via `notification_dispatches.dedupe_key = 'ar_overdue:' || invoice.id || ':' || band`).

### 5.3 Documents (M29)

`<DocumentAttachmentList contextTable="ar_invoices" kinds={['customer_invoice_pdf','signed_contract','dispute_correspondence','credit_memo_pdf','remittance_advice','other']}/>` is embedded in the AR invoice edit modal.

Receipt-level documents: `<DocumentAttachmentList contextTable="ar_receipts" kinds={['remittance_advice','wire_confirmation','check_image','ach_confirmation','other']}/>`.

---

## 6. 5-Year Historical Backfill (P4-8 — the heaviest chunk)

### 6.1 Source data

- **`ip_sales_history_wholesale`** — Xoro feed. Carries invoice-level rows with `invoice_number`, `invoice_date`, `sku_id`, `qty`, `qty_units`, `qty_grain`, `unit_cost_at_sale`, sale amount, customer (varies — `customer_id` or `customer_code` text). Roughly 5 years of data.
- **`ip_sales_history_ecom`** — Shopify feed. Similar shape but ecom-side. Ingested separately because the customer side is "consumer" (no AR carrying balance — paid at order time).
- **Both feeds carry COGS info via `unit_cost_at_sale`** (per P3-3 sales-history-cogs migration). The backfill must NOT call `inventory_fifo_consume()` for historical lines — instead, it uses the recorded `unit_cost_at_sale` directly to compute COGS cents. See §6.4.

### 6.2 Strategy — `posted_historical` status + scoped `bypass_period_lock`

**Decision: do NOT reopen-and-repost closed periods.** Two reasons:

1. **Mid-loop failure risk.** Reopening + posting + reclosing N years × 12 periods has at least 60 state transitions. Any failure mid-loop leaves periods in an inconsistent state (some reopened, some reclosed, some posted) and partial-rollback is hard because period status changes are not atomic with JE writes.
2. **Audit clarity.** Operator's accountant needs a way to identify backfilled JEs at a glance for tax-period reconciliation. A distinct `gl_status='posted_historical'` (on `ar_invoices`) plus a distinct `journal_type IN ('ar_invoice_historical','ar_receipt_historical')` (on `journal_entries`) is the cleanest separator.

**Backfill flow** (single migration `20260601000000_p4_chunk8_ar_historical_backfill.sql` with idempotent guards):

```
FOR each year IN (5 years back → today)
  FOR each month IN (12 months)
    BEGIN savepoint p4_backfill_<year>_<month>
      -- Group sales-history rows by (invoice_number, customer, invoice_date)
      WITH grouped AS (
        SELECT invoice_number, customer_id, invoice_date, ARRAY_AGG(...) AS lines
          FROM ip_sales_history_wholesale
         WHERE invoice_date >= start_of_month AND invoice_date < start_of_next_month
         GROUP BY invoice_number, customer_id, invoice_date
      )
      -- INSERT ar_invoices rows with gl_status='posted_historical', invoice_kind='customer_invoice_historical'
      -- INSERT ar_invoice_lines per source row
      -- Call gl_post_journal_entry(je_id, p_bypass_period_lock=true) — only allowed because journal_type='ar_invoice_historical'
      -- INSERT ar_receipts + ar_receipt_applications for matched payments (next month)
      checkpoint_log.insert({ year, month, invoices_created, je_created, status: 'done' })
    EXCEPTION WHEN OTHERS THEN
      ROLLBACK TO p4_backfill_<year>_<month>
      checkpoint_log.insert({ year, month, error: SQLERRM, status: 'failed' })
      -- continue to next month
    END
END
```

Idempotency: the unique index on `ar_invoices(entity_id, invoice_number)` + an `ON CONFLICT DO NOTHING` clause makes re-runs safe (rows already inserted are skipped). The `bf_backfill_checkpoint_log` table tracks per-month progress so a failure-and-rerun resumes from the failed month without re-inserting earlier months.

```
CREATE TABLE IF NOT EXISTS bf_backfill_checkpoint_log (
  id uuid PK,
  backfill_run_id uuid NOT NULL,
  year smallint NOT NULL,
  month smallint NOT NULL,
  invoices_created int NOT NULL DEFAULT 0,
  receipts_created int NOT NULL DEFAULT 0,
  je_created int NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('done','failed','in_progress','skipped')),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX bf_checkpoint_run ON bf_backfill_checkpoint_log (backfill_run_id, year, month);
```

### 6.3 Customer resolution

Historical rows carry customer info as `customer_code` or `customer_name` text — not always FK-resolved to `customers(id)`. The backfill:

1. JOIN `ip_sales_history_wholesale` to `customers` on `customer_code` first, then on `customer_name` UPPER fuzzy match.
2. For unmatched: create a `customers` row with `code='HIST_<normalized>'`, `name=<source_name>`, `metadata={'historical_backfill': true, 'source_run_id': <uuid>}`.
3. Log unmatched rows to `bf_unmatched_customers_log` for operator review post-backfill.

### 6.4 FIFO retroactive consumption — DOES NOT call `inventory_fifo_consume()`

**Critical:** the live FIFO consume path locks layers `FOR UPDATE` and draws from oldest-first. Calling that for 5 years of historical sales would:
- Drain the `opening_balance` layers (P3-3 seeded these from `ip_inventory_snapshot` × `ip_item_avg_cost`).
- Leave snapshot-as-of-cutover inconsistent because pre-cutover sales would consume the "now" snapshot.

**Backfill bypasses FIFO entirely.** It uses the recorded `unit_cost_at_sale` from `ip_sales_history_wholesale` (per the P3-3 sales-history-cogs migration) to compute COGS cents directly. The historical JEs balance, but no `inventory_layers` rows are touched and no `inventory_consumption` rows are created. **This is documented in the user guide chapter 16 (Backfill) as a known approximation:** historical COGS reflects what Xoro recorded; the live FIFO engine starts from the post-cutover snapshot.

For lines where `unit_cost_at_sale` is null (~known small percentage from the P3-3 zero-cost-suppression migration), the backfill skips the COGS pair on that line and logs the line to `bf_skipped_cogs_log`. The revenue side still posts. The operator reviews the skipped log and decides whether to manual-adjust.

### 6.5 Receipt backfill

`ip_sales_history_wholesale` does NOT carry payment info directly — historical receipts come from a separate Xoro report or operator-supplied CSV. **Backfill receipt strategy:**

- Best case: a separate `ip_sales_history_payments` table is sourced from Xoro (one of two options): (a) a one-time Xoro "Customer Receipts" report dump uploaded by the operator; (b) inferred receipts from `ip_sales_history_wholesale.payment_status` and `payment_date` columns if present in the feed schema.
- For each historical invoice, INSERT one matching `ar_receipts` row + one `ar_receipt_applications` row applying full amount to the invoice. Use `method='other'` and `reference='HISTORICAL_BACKFILL_<year>'`. Post `journal_type='ar_receipt_historical'` JE with `bypass_period_lock=true`.
- If no payment data is sourced, leave the invoice in `posted_historical` with `paid_amount_cents=0`. The operator can manually mark-as-paid via the UI post-backfill (this is an acceptable degraded mode — discussed in §11).

### 6.6 Reconciliation SQL

End of backfill, this query MUST pass before the run is marked successful:

```sql
WITH source_totals AS (
  SELECT
    EXTRACT(YEAR FROM invoice_date)::int AS year,
    EXTRACT(MONTH FROM invoice_date)::int AS month,
    SUM(unit_price * qty_units) AS source_revenue,
    COUNT(DISTINCT invoice_number) AS source_invoice_count
  FROM ip_sales_history_wholesale
  GROUP BY 1, 2
),
ar_totals AS (
  SELECT
    EXTRACT(YEAR FROM posting_date)::int AS year,
    EXTRACT(MONTH FROM posting_date)::int AS month,
    SUM(total_amount_cents) / 100.0 AS ar_revenue,
    COUNT(*) AS ar_invoice_count
  FROM ar_invoices
  WHERE invoice_kind = 'customer_invoice_historical'
  GROUP BY 1, 2
)
SELECT
  COALESCE(s.year, a.year) AS year,
  COALESCE(s.month, a.month) AS month,
  s.source_invoice_count, a.ar_invoice_count,
  s.source_revenue, a.ar_revenue,
  (s.source_revenue - a.ar_revenue) AS variance,
  ABS(s.source_revenue - a.ar_revenue) / NULLIF(s.source_revenue, 0) AS variance_pct
FROM source_totals s
FULL OUTER JOIN ar_totals a USING (year, month)
WHERE ABS(COALESCE(s.source_revenue, 0) - COALESCE(a.ar_revenue, 0)) > 0.01;
```

Acceptance criteria: **zero rows** returned (perfect $ reconciliation) OR all variance < $1 per month (rounding noise). Anything else blocks the operator from flipping the backfill from `in_progress` to `complete`.

### 6.7 Backfill rollback strategy

If reconciliation fails AND operator wants to wipe-and-retry:

```sql
-- Rollback all backfill artifacts. Idempotent.
DELETE FROM ar_receipt_applications
  WHERE ar_receipt_id IN (SELECT id FROM ar_receipts WHERE method = 'other' AND reference LIKE 'HISTORICAL_BACKFILL_%');
DELETE FROM ar_receipts WHERE method = 'other' AND reference LIKE 'HISTORICAL_BACKFILL_%';
DELETE FROM journal_entry_lines WHERE journal_entry_id IN (
  SELECT id FROM journal_entries WHERE journal_type IN ('ar_invoice_historical', 'ar_receipt_historical')
);
DELETE FROM journal_entries WHERE journal_type IN ('ar_invoice_historical', 'ar_receipt_historical');
DELETE FROM ar_invoice_lines WHERE ar_invoice_id IN (
  SELECT id FROM ar_invoices WHERE invoice_kind = 'customer_invoice_historical'
);
DELETE FROM ar_invoices WHERE invoice_kind = 'customer_invoice_historical';
-- Customers created by backfill (HIST_*) are NOT deleted automatically — operator may have manually merged some
TRUNCATE bf_backfill_checkpoint_log;
```

The cleanup script ships as a separate operator-runnable SQL file in `docs/tangerine/`, not inside the auto-applied migration set.

---

## 7. Admin UI surfaces

### 7.1 `src/tanda/InternalARInvoices.tsx`

Mirror of P3-2's `InternalAPInvoices.tsx` flipped to AR semantics. Buttons: **Send** (instead of Post), **Receive Payment**, **Void**, **Credit Memo**, **Print PDF** (uses M29 documents pipeline to render + attach). Filter row: status / customer / date range / overdue toggle. Add modal: customer picker → date → optional payment_terms_id override → line builder with inventory_item_id search (same pattern as AP, but the COGS-side rendering is hidden because the operator never sees a COGS line — it's auto-derived at send).

Embeds:
- `<DocumentAttachmentList contextTable="ar_invoices" kinds={['customer_invoice_pdf','signed_contract','dispute_correspondence','credit_memo_pdf','remittance_advice','other']}/>` in the edit modal.
- Approval Inbox notice banner at top when `gl_status='pending_approval'` with the approval reason ("credit limit breach by $X").

### 7.2 `src/tanda/InternalARPayments.tsx`

Read-only ledger of `ar_receipts` joined to `ar_receipt_applications` joined to `ar_invoices`. Filter row: method / date range / customer / unapplied-only toggle. Click-through opens a payment detail modal showing the application breakdown + a button to add another application (when unapplied balance > 0) or to void the receipt entirely (with approval gate hook).

### 7.3 `src/tanda/InternalARAging.tsx` — NEW (operator's daily morning view)

Top-of-page date selector (defaults to today). Below: a customer × age-bucket grid driven by `ar_aging_as_of(entity_id, as_of_date)`. Each cell is click-through — drills into a filtered `InternalARInvoices.tsx` view scoped to that customer + bucket. Export button: CSV download + PDF render via M29.

Rendering: sticky-column customer name on the left, bucket columns on the right, total row at the bottom. Color-code: green for current, yellow 30-60, orange 60-90, red 90+. The operator's morning routine is "open this page, look for red, call the customers in red."

### 7.4 `src/tanda/InternalCustomers.tsx` — extension

The existing P1 Chunk 7c customer-master admin UI gains `credit_limit_cents` + `credit_limit_currency` + `default_ar_account_id` + `default_revenue_account_id` form fields. The credit limit field renders as dollars-with-cents (input mask), persists as bigint cents.

### 7.5 `src/tanda/InternalARBackfill.tsx` — backfill-specific operator console

Special-purpose admin panel that's only visible to `role='admin'` users (RLS won't help here since the migration runs server-side; the panel itself reads `bf_backfill_checkpoint_log` and `bf_unmatched_customers_log` + `bf_skipped_cogs_log` and surfaces the reconciliation SQL output as a status grid).

Sections:
- Run status: per-year × per-month grid of `done` / `failed` / `in_progress` / `skipped` with a click-through detail modal showing the error log.
- Unmatched customers: list of `bf_unmatched_customers_log` with a "merge into existing customer" action that calls a handler to UPDATE `ar_invoices.customer_id` from `HIST_*` to the chosen `customers.id` and then DELETE the orphan `HIST_*` customer.
- Skipped COGS: list of lines that posted revenue-only; operator can manually post a COGS adjustment.
- Reconciliation: live SQL output from §6.6; refresh button.
- "Rerun failed months" + "Wipe and start over" buttons (only enabled when there is no `in_progress` work).

Wired into Tangerine top nav under a new **Backfill** group (sibling to Accounting) — gets hidden after the backfill is marked complete by the operator (a config flag in `entities.metadata.backfill_complete=true`).

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
- `ar_receipt_applications` follows parent receipt's RLS (entity_id scoped).
- `bf_backfill_checkpoint_log` + `bf_unmatched_customers_log` + `bf_skipped_cogs_log` are admin-only — SELECT + INSERT for anon (server-side migration writes), no UPDATE/DELETE policy.

---

## 9. Hook contract recap

```
                                  ┌──────────────────────┐
                                  │ approvalsAPI         │ M27
                                  │  .requestIfRequired  │
                                  └──────────────────────┘
M4 AR Invoice send handler  ────►─┤  kind='customer_credit_extension'
M4 AR Void / CreditMemo h.  ────►─┤  kind='ar_invoice_void_above_threshold'

                                  ┌──────────────────────┐
                                  │ notificationsAPI     │ M28
                                  └──────────────────────┘
M4 AR send / pay / void / cm  ──►─┤
Daily cron ar-overdue-scan    ──►─┤  ar_invoice_overdue_{30,60,90}

                                  ┌──────────────────────┐
                                  │ <DocumentAttach...   │ M29
                                  └──────────────────────┘
AR Invoice modal           ─────►─┤  contextTable='ar_invoices'
AR Receipt modal           ─────►─┤  contextTable='ar_receipts'

                                  ┌──────────────────────┐
                                  │ inventoryFifoAPI     │ M5
                                  └──────────────────────┘
AR send (live path)        ─────►─┤  .consume()
AR void (live path)        ─────►─┤  .restoreConsumption()   ★ new helper in P4-2
AR credit-memo (returns)   ─────►─┤  .createLayer(source_kind='customer_return')

                                  ┌──────────────────────┐
                                  │ gl_post_journal_entry│ P1 RPC
                                  └──────────────────────┘
Backfill RPC               ─────►─┤  p_bypass_period_lock=true (scoped to journal_type IN ('ar_invoice_historical','ar_receipt_historical'))
```

---

## 10. Chunk split (implementation — DO NOT start until operator approves)

In dependency order:

- **P4-1 — M4 AR schema (the foundation chunk)**
  - Migration: `ar_invoices` + `ar_invoice_lines` + `ar_receipts` + `ar_receipt_applications` + indexes + RLS + touch triggers + total/paid maintainer triggers + status-guard trigger.
  - `customers.credit_limit_cents` + `credit_limit_currency` + `default_ar_account_id` + `default_revenue_account_id` extensions.
  - `entities.default_ar_account_id` + `default_revenue_account_id` + `default_cogs_account_id` + `default_inventory_account_id` extensions.
  - `inventory_layers.source_kind` CHECK expanded to include `'customer_return'`.
  - New views: `v_cash_receipts_journal` + `v_ar_unapplied_receipts` + function `ar_aging_as_of(entity_id, as_of_date)`.
  - `gl_post_journal_entry` RPC extension — `p_bypass_period_lock` parameter with `journal_type` guard.
  - 40+ unit tests on schema constraints + trigger behavior + the bypass-guard scope.

- **P4-2 — Posting rules**
  - `api/_lib/accounting/posting/rules/arInvoiceSent.js` — fill body, emit `consumePlan[]`, multi-line + per-line revenue override support.
  - `api/_lib/accounting/posting/rules/arPaymentReceived.js` — multi-application receipt support.
  - `api/_lib/accounting/posting/rules/arInvoiceVoided.js` — new, emits `reversals[]`.
  - `api/_lib/accounting/posting/rules/arCreditMemo.js` — new, emits `inventoryLayers[]` for return-to-stock.
  - `api/_lib/inventory/fifo.js` — new helper `restoreConsumption(consumer_kind, consumer_ref_id)`.
  - 60+ unit tests covering all four rules + the FIFO restore path.

- **P4-3 — FIFO ↔ AR wire-up at posting service**
  - `api/_lib/accounting/posting/index.js` — `consumePlan` drain integration (already exists from P3-5 negative adjustments; this chunk just covers the AR consumer_kind path).
  - Per-line `cogs_cents` write-back to `ar_invoice_lines` after consume() success.
  - `restoreConsumption` wiring into the void / credit-memo reversal paths.
  - 25+ unit tests covering end-to-end posting flow with FIFO including insufficient_inventory error propagation.

- **P4-4 — AR Invoices admin UI**
  - Handlers under `api/_handlers/internal/ar-invoices/`: `index.js` list+create, `[id].js` get+patch+delete (draft only), `send.js`, `void.js`, `credit-memo.js`.
  - `src/tanda/InternalARInvoices.tsx` — list + filters + Add/Edit modal + Send/Pay/Void/CreditMemo action buttons + DocumentAttachmentList embed.
  - Approval gate hook wired (`customer_credit_extension` + `ar_invoice_void_above_threshold`).
  - Notification hooks: `ar_invoice_sent`, `ar_credit_memo_issued`.
  - Approval Inbox post-decide hook for pending-approval AR invoices.
  - User-guide chapter 16 (AR Invoices).

- **P4-5 — AR Payments + Receipts admin UI**
  - Handlers under `api/_handlers/internal/ar-receipts/`: `index.js` list+create with `applications: [...]` payload, `[id].js` get+patch+delete, `void.js`.
  - Handlers under `api/_handlers/internal/ar-receipt-applications/`: `index.js` for adding additional applications to an existing under-applied receipt.
  - `src/tanda/InternalARPayments.tsx` — read-only ledger + apply-more action.
  - DocumentAttachmentList drop-in for receipts.
  - Notification hooks: `ar_payment_received`, `ar_receipt_voided`.
  - User-guide chapter 17.

- **P4-6 — AR Aging report + overdue cron**
  - Handler `/api/internal/ar/aging?entity_id=...&as_of_date=YYYY-MM-DD` returning the `ar_aging_as_of` function output as JSON.
  - `src/tanda/InternalARAging.tsx` — the grid view.
  - Daily cron `/api/cron/ar-overdue-scan.js` (Vercel cron config in `vercel.json`).
  - Notification hooks: `ar_invoice_overdue_{30,60,90}`.
  - Idempotent dispatch via `notification_dispatches.dedupe_key`.
  - User-guide chapter 18.

- **P4-7 — Customer Credit Limit approval rule + admin UI extension**
  - `src/tanda/InternalCustomers.tsx` gains the `credit_limit_cents` + `default_ar_account_id` + `default_revenue_account_id` form fields.
  - Customer master handlers extended to validate + accept those fields.
  - Seed example approval rules in `InternalApprovalRules.tsx` (the rule examples — schema already supports them from P2-1).
  - 20+ unit tests on the credit-limit form + handler validation.
  - User-guide chapter 18.1 (Credit Limit Management).

- **P4-8 — 5-Year Historical Backfill** *(the heaviest — gets its own chunk)*
  - Migration: `bf_backfill_checkpoint_log` + `bf_unmatched_customers_log` + `bf_skipped_cogs_log`.
  - Backfill RPC: `ar_backfill_run(p_entity_id, p_start_year, p_end_year)` — the per-month loop with savepoints + checkpoint logging.
  - Customer resolution helper SQL function: `bf_resolve_customer(p_customer_code, p_customer_name) RETURNS uuid`.
  - `src/tanda/InternalARBackfill.tsx` — the operator console.
  - Handlers under `api/_handlers/internal/ar-backfill/`: `index.js` (status + checkpoint log), `start.js` (kicks off the RPC), `reconcile.js` (runs the reconciliation SQL + returns variance grid), `merge-customer.js` (merges HIST_* customers).
  - Reconciliation SQL view + acceptance criteria.
  - Rollback script in `docs/tangerine/p4-backfill-rollback.sql` (operator-runnable, not auto-applied).
  - Wired into Tangerine top nav under a new **Backfill** group (hidden when `entities.metadata.backfill_complete=true`).
  - User-guide chapter 19 (5-Year Backfill — operator runbook).
  - **Special verification:** dry-run mode (`p_dry_run=true`) inserts nothing but writes checkpoint log + reconciliation summary; operator reviews before flipping to live run.

Each chunk lands as its own PR. Isolated worktree pattern per [[feedback-isolated-worktree-for-tangerine]]. Per [[feedback-memorize-each-chunk]], memory + user-guide update in the same PR.

---

## 11. Sub-decisions deferred to implementation

| # | Sub-decision | Resolve in |
|---|---|---|
| 1 | ~~Reuse `invoices` vs sibling `ar_invoices`~~ — **CLOSED in §3.1: sibling tables.** | This doc |
| 2 | ~~`posted_historical` vs reopen-and-repost closed periods~~ — **CLOSED in §6.2: scoped `bypass_period_lock`.** | This doc |
| 3 | Backfill rollback strategy if mid-loop failure — **savepoint-per-month + checkpoint log**, ships in P4-8 | P4-8 |
| 4 | AR over-payment handling — **show in `v_ar_unapplied_receipts`; operator decides** (refund vs credit memo vs apply-later) | P4-5 (with operator UI to decide per receipt) |
| 5 | AR under-payment handling — leave invoice in `partial_paid`; standard accounting practice | P4-5 |
| 6 | Credit memo numbering scheme — **continuation of invoice sequence with `-CM` suffix** (e.g. `AR-2026-00123-CM`); avoids parallel sequence with risk of skew | P4-2 |
| 7 | AR invoice numbering scheme — **new sequence `AR-YYYY-NNNNN`**; backfill uses original Xoro `invoice_number` (no re-numbering) | P4-1 (post-cutover); P4-8 (backfill preserves source) |
| 8 | Whether to defer multi-currency until later — **yes, locked USD per roadmap §1**; `credit_limit_currency` column reserved | Locked |
| 9 | Receipt-side backfill data source (separate Xoro CSV vs operator-supplied) | P4-8 with operator at kickoff |
| 10 | Whether voided receipts auto-cancel their applications or require explicit re-apply — recommend explicit (audit trail) | P4-5 |
| 11 | Backfill handles ecom-side (`ip_sales_history_ecom`) the same way as wholesale OR skips ecom — **recommend skip**; ecom is consumer-side (no AR balance carried — paid at order time); flag for review | P4-8 |
| 12 | Default credit limit for unmigrated customers — **NULL (no limit)** until operator sets explicitly | P4-7 |
| 13 | Whether AR send-time approval blocks the email-the-customer step — **yes**, gate fires BEFORE PDF generation + send | P4-4 |
| 14 | Whether dispute_correspondence document kind links to a future M40 disputes table — **flag for P18**; for now just a document kind without FK | P18 future |

---

## 12. Risk register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| 5-year backfill failure mid-loop leaves inconsistent state | Med | High | Savepoint-per-month + checkpoint log + idempotent `ON CONFLICT DO NOTHING`; resume from failed month without re-insert; full wipe-and-retry script available. |
| FIFO retroactive consumption depletes opening_balance layers asymmetrically | High | Med | **Backfill does NOT call `inventory_fifo_consume()`** — uses `unit_cost_at_sale` directly. Live FIFO starts from post-cutover snapshot. Documented as known approximation. |
| Closed-period bypass weakens trigger guarantees | Low | High | `bypass_period_lock` is scoped to `journal_type IN ('ar_invoice_historical', 'ar_receipt_historical')` AT THE TRIGGER LEVEL. Operator UI cannot set journal_type → no admin path to bypass. |
| Customer credit limit breach blocks legitimate same-day urgent invoices | Med | Med | M27 approval rule `mode='any'`: CEO + admin can both approve. Documented in operator runbook §16.4. |
| AR aging report at large scale (5yr × ~1k invoices/yr) — query performance | Med | Med | Index on `(entity_id, posting_date)` + `(customer_id, posting_date)` + partial WHERE `paid_amount_cents < total_amount_cents` for overdue. `ar_aging_as_of` is STABLE — Postgres can plan it. Materialized view fallback flagged for P6 if needed. |
| Cash-basis vs accrual on backfilled rows doubles JE volume | Certain | Low | Backfill emits both sets (per locked decision #2). Reporting filters by `basis` — no operator confusion. Storage cost negligible (~30k rows). |
| Customer dispute → credit memo lifecycle not yet linked to vendor_portal disputes table | Low | Low | Flag for P18 (vendor portal already has dispute schema; symmetric customer-side will mirror it). For now, `dispute_correspondence` is just a document kind. |
| Receipt-side backfill source unknown until operator kickoff | High | Med | P4-8 ships with two ingest paths: (a) operator CSV upload + (b) inferred from `ip_sales_history_wholesale.payment_status` if available. Degraded mode = no receipts (invoices stay `posted_historical` with `paid_amount_cents=0`). |
| HIST_* customer rows pollute the customers panel | Med | Low | `bf_unmatched_customers_log` lists them; operator-driven merge action in `InternalARBackfill.tsx` consolidates. Filter in `InternalCustomers.tsx` hides `code LIKE 'HIST_%'` by default with toggle. |
| `unit_cost_at_sale = NULL` in source data causes revenue-only postings (no COGS) | Med | Med | Logged to `bf_skipped_cogs_log`; operator reviews + manual-adjusts. Documented as a known approximation in user guide chapter 19. |
| FIFO restoreConsumption race condition when concurrent void + new sale on same item | Low | Med | `restoreConsumption` runs in same transaction as the void posting; layers row-locked `FOR UPDATE`; new sales block until void commits. Symmetric to P3-5's consume `FOR UPDATE` pattern. |
| Overdue-cron firing during backfill marks historical invoices as overdue | Low | Med | Cron filter excludes `gl_status='posted_historical'`; only `gl_status IN ('sent','partial_paid')` triggers overdue notifications. |

---

## 13. Out of scope (explicit)

- Multi-currency / FX (locked USD-only — `credit_limit_currency` is forward-compat).
- Bank / CC feed reconciliation (P6 / M7+M8).
- Drop-ship AR pure-product flow (P20 / M49).
- B2B portal customer self-service (P18 / M40+M41).
- SO entry / pricing — still in Xoro at P4 (P15 + P16 / M43+M10).
- Sales tax on AR (P25 / M21).
- Carrier integration (P16 / M44).
- 1099 generation, fixed assets (P25 / M20+M22).
- AR invoice email-the-customer pipeline — sketch only in P4-4; full sendgrid/resend wire-up deferred to a P4 cleanup chunk.
- Ecom-side backfill (`ip_sales_history_ecom`) — recommend skip (ecom is paid-at-order); flag for review with operator at P4-8 kickoff.
- Customer portal for invoice viewing — P18.
- Multi-warehouse / per-location AR routing — stretch.

---

## 14. Approval handshake

This doc-only PR auto-merges on CI green per the revised [[feedback-plan-approval-not-implementation]] rule. **Implementation chunks (P4-1 onward) require explicit operator approval before they kick off** — the pause-and-ask rule still applies for code/schema work.

Kickoff sequence when ready:
1. Operator reviews this doc end-to-end with particular focus on §3.1 (sibling-tables decision), §6 (backfill strategy), and §11 (deferred sub-decisions).
2. Operator confirms:
   - Default AR + Revenue + COGS + Inventory account codes (sub-decisions §11.6 + roadmap)
   - Receipt-side backfill data source (§11.9 — CSV vs inferred)
   - Whether to include ecom backfill (§11.11)
3. Operator says "go" — P4-1 opens as the first PR.
4. Subsequent chunks ship one-at-a-time per the [[feedback-memorize-each-chunk]] rule.
5. **P4-8 (backfill) ships LAST** — only after the live P4-1..P4-7 path is operator-validated against a handful of new test invoices. Backfill against an unvalidated lifecycle would compound bugs across 5 years of data.
