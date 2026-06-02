# Cross-cutter T10 — Tangerine ⇄ Xoro Shadow Mirror

Status: **DRAFT** (2026-05-28). Replaces "P9 next" given operator's clarification that partial decom isn't viable until P22 EDI ships.

T10 is the bridge that makes the P1-P8 modules **usable today** without waiting 24 months for the EDI / 3PL / Shopify pipeline. It reads the existing nightly Xoro fetch and mirrors the operational events into Tangerine's sub-ledgers + posts a daily summary JE so reports / CRM / Cases work against real numbers — without any operator dual-entry.

Tangerine in T10 mode is a **shadow ledger** + **standalone-modules-on-top** layer. Xoro stays system-of-record for all EDI-driven flows. Operator's daily Xoro work doesn't change at all.

---

## 0. Scope

**In scope (v1):**

- **AR mirror** — reads `ip_sales_history_wholesale` nightly + creates / upserts `ar_invoices` + `ar_invoice_lines` rows with `source='xoro_mirror'`.
- **AP mirror** — reads `tanda_pos` (receiving-complete subset) + creates / upserts `invoices` (AP) rows with `source='xoro_mirror'`.
- **Inventory layers refresh** — reads `ip_inventory_snapshot` + `item_costing` + rebuilds `inventory_layers` from scratch each night (idempotent: drop rows where `source='xoro_mirror'`, rebuild).
- **Daily summary JE** — one summary journal per day per domain, posted via `gl_post_journal_entry`:
  - AR JE: DR `1200 AR Control`, CR `4000 Revenue` (with discount/tax line splits per arch §3.4)
  - AP JE: DR `5000 COGS` + `6xxx Expense`, CR `2100 AP Control`
  - COGS JE: DR `5000 COGS`, CR `1300 Inventory Asset`
  - This preserves trial-balance / income-statement / balance-sheet semantics without per-invoice JE noise.
- **Source tagging** on every mirrored row so operator-typed `source='manual'` rows are never overwritten.
- **Mirror dashboard panel** — `🔁 Shadow Mirror Status` showing last successful run, row counts per domain, anomalies, manual re-run button.

**Explicitly OUT of scope (v1):**

- **Reverse flow (Tangerine → Xoro)** — Tangerine is read-only into Xoro; no writes. Xoro stays the system-of-record for events.
- **Per-invoice JEs from mirror** — daily summary is the v1 deliverable. Per-invoice JE granularity requires reversing previous-day's summary which is fragile; punted to v2 if needed.
- **Mirror of Shopify / FBA / Walmart settlement reports** — those land in P11/P12 with full settlement reconciliation. T10 only mirrors what the existing Xoro fetch produces.
- **Real-time mirror** — daily cadence; same as Xoro fetch.
- **Mirror correctness verification** — that's what P9 does (eventually). T10 just produces the mirror; P9 will reconcile against Xoro source.
- **CRM activity auto-creation from mirrored AR rows** — operator-typed activities only in v1.

---

## 1. Architectural principle — `source` column on every mutable sub-ledger

**Operator-locked 2026-05-28.** Every Tangerine table that gets writes from multiple producers must have a `source` column. Producers:

- `'manual'` — operator typed it in the UI
- `'xoro_mirror'` — T10 cron created it from Xoro feed
- `'shopify'` — P11 future
- `'fba'` / `'walmart'` / `'faire'` — P12 future
- `'edi_3pl'` — P22 future
- `'plaid_sync'` — P6 already (bank_transactions has this)
- `'api'` — external API call to Tangerine
- `'system'` — internal trigger / RPC

**Rules:**

1. **Mirror rules:** T10 cron only touches rows where `source='xoro_mirror'`. Operator-typed `source='manual'` rows are never overwritten or deleted by the mirror.
2. **UI badge:** every list view shows the `source` as a small badge so operator knows at a glance "this row was auto-mirrored from Xoro" vs "this was typed by me."
3. **Conflict resolution:** if Xoro and operator both touch the same logical row (same invoice number, same vendor, same date), the manual row wins. Operator can force a re-mirror with explicit "overwrite manual" confirm.
4. **Trail:** `created_by_user_id` (existing column) IS NULL on mirror rows; populated for manual.

This rule generalizes beyond T10 — every future integration uses the same pattern. It's the **manual-fallback-everywhere** principle from `XORO-DECOM-MAP.md` made explicit in the schema.

---

## 2. Schema additions

Each affected table gets a `source` text column with CHECK + default. Tables in v1:

```sql
-- AR (P4-1 created ar_invoices + ar_invoice_lines + ar_receipts + ar_receipt_applications)
ALTER TABLE ar_invoices       ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','api','system'));
ALTER TABLE ar_invoice_lines  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','api','system'));
ALTER TABLE ar_receipts       ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','api','system'));

-- AP (P3 invoices)
ALTER TABLE invoices          ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','api','system'));

-- Inventory layers (P3-3)
ALTER TABLE inventory_layers  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','api','system'));

-- Journal entries (P1) — for the daily summary JEs
ALTER TABLE journal_entries   ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','api','system'));
```

Plus one new state-tracking table for cron idempotency:

```sql
CREATE TABLE IF NOT EXISTS xoro_mirror_runs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id               uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  domain                  text NOT NULL CHECK (domain IN ('ar','ap','inventory','summary_je')),
  mirror_date             date NOT NULL,                  -- the operator-local business date being mirrored
  rows_upserted           int NOT NULL DEFAULT 0,
  rows_deleted            int NOT NULL DEFAULT 0,
  rows_unchanged          int NOT NULL DEFAULT 0,
  je_id                   uuid REFERENCES journal_entries(id),    -- set for summary_je domain
  errors                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  status                  text NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','complete','failed','skipped_no_change')),
  CONSTRAINT xoro_mirror_runs_unique UNIQUE (entity_id, domain, mirror_date)
);
```

The UNIQUE on `(entity_id, domain, mirror_date)` makes daily re-runs idempotent.

---

## 3. Mirror cron — `cron/xoro-mirror-nightly`

Runs daily at 21:30 local (~30 min after the existing Xoro nightly fetch at 21:00).

```
1. Determine mirror_date = the business date the fetch covered (operator local).
2. For each domain in (ar, ap, inventory, summary_je):
   a. Check if xoro_mirror_runs already has status='complete' for (entity, domain, mirror_date)
      → skip if so (idempotency).
   b. Insert xoro_mirror_runs row with status='running'.
   c. Run the domain mirror function (see §4).
   d. Update xoro_mirror_runs with row counts + status='complete' (or 'failed' with errors).
3. Post the daily summary JE if all sub-ledger domains succeeded.
4. Emit a notification_event with the per-domain summary.
```

Skip-on-stale-Xoro: if the most recent Xoro fetch timestamp is older than 25 hours, skip with status='skipped_no_change' + emit a stale-fetch warning. Same guard as bank-feed-sync.

---

## 4. Per-domain mirror specs

### 4.1 AR mirror

**Source:** `ip_sales_history_wholesale` filtered to `created_at::date = mirror_date`.

**Upsert key:** `(entity_id, source, external_invoice_id)` where `external_invoice_id` = Xoro's invoice number.

**For each Xoro invoice row:**

1. Look up customer by Xoro customer code → `customers.code`. If not found, log to a `xoro_mirror_unmatched_customers` table and skip (don't auto-create customer — operator decides).
2. Compose `ar_invoices` row: `invoice_number = <Xoro's number>`, `customer_id`, `invoice_kind='customer_invoice'`, `invoice_date`, `due_date` (from Xoro), `total_amount_cents`, `source='xoro_mirror'`, etc.
3. Compose `ar_invoice_lines` rows: one per Xoro detail line.
4. UPSERT both. The unique constraint on `(entity_id, invoice_number)` handles re-mirror.

**Status:** mirrored invoices stay in `gl_status='unposted'` because Tangerine isn't actually posting JEs per-invoice — the daily summary handles GL.

### 4.2 AP mirror

**Source:** `tanda_pos` filtered to receiving-complete subset (e.g. `status IN ('Received','Closed')` with `received_at::date = mirror_date`) + Xoro's AP entries from `ip_ap_history` if that fetch exists, or derived from `tanda_pos.invoice_amount_cents` + `vendor_code`.

**Upsert key:** `(entity_id, source, vendor_id, external_bill_id)`.

Similar workflow to AR. Mirror creates `invoices` (AP) rows with `source='xoro_mirror'`. GL posting is deferred to daily summary.

### 4.3 Inventory layers refresh

**Strategy:** drop-and-rebuild (`source='xoro_mirror'` rows only).

```
BEGIN;
DELETE FROM inventory_layers WHERE source = 'xoro_mirror';

INSERT INTO inventory_layers (item_id, warehouse_id, layer_cost_cents, remaining_qty, source, ...)
SELECT
  ipm.id AS item_id,
  warehouse_id,
  (ic.unit_cost * 100)::bigint AS layer_cost_cents,
  iis.qty AS remaining_qty,
  'xoro_mirror' AS source,
  ...
FROM ip_inventory_snapshot iis
JOIN ip_item_master ipm ON ipm.sku = iis.sku
LEFT JOIN ip_item_costing ic ON ic.sku = iis.sku
WHERE iis.as_of_date = <latest>
  AND iis.qty > 0;
COMMIT;
```

This makes FIFO COGS-on-AR-post work for any operator-typed AR invoices in Tangerine. Mirrored AR invoices don't consume FIFO (the summary JE handles their COGS).

**Trade-off:** layer granularity is collapsed to one layer per `(sku, warehouse)`. Real Xoro probably has many layers (FIFO from each receipt). We lose layer-age detail but keep current valuation correct. Acceptable for shadow-ledger mode.

### 4.4 Daily summary JE

After AR + AP + inventory complete successfully, post one summary JE per domain:

```
AR Summary JE (basis=ACCRUAL, journal_type='ar_xoro_mirror_daily', date=mirror_date):
  DR 1200 AR Control     = SUM(total_amount_cents) of mirrored AR invoices
  CR 4000 Revenue        = same
  (line splits for discount / tax if Xoro fetch exposes them — else lump into Revenue)

AP Summary JE (basis=ACCRUAL, journal_type='ap_xoro_mirror_daily', date=mirror_date):
  DR 5000 COGS (or 6xxx)  = SUM(total_amount_cents) of mirrored AP bills
  CR 2100 AP Control      = same

Inventory adjustment JE:
  IF SUM(new layer value) != SUM(old layer value):
    DR/CR 1300 Inventory Asset = delta
    DR/CR 5000 COGS            = delta (counter-side)
```

Each summary JE has `source='xoro_mirror'` and `source_table='xoro_mirror_runs'`, `source_id=<run id>` for traceability.

Idempotency on JE: before posting, query `journal_entries WHERE source='xoro_mirror' AND source_id=<this run's id>` and skip if exists.

---

## 5. Reporting impact

Once T10 is running:

- **Trial Balance / Income Statement / Balance Sheet** — populated by daily summary JEs. Numbers match Xoro at day-end.
- **AR Aging** — works against the mirrored `ar_invoices` rows.
- **AP Aging** — works against the mirrored `invoices` rows.
- **Sales by Customer** — works (P7-7 reads ar_invoices).
- **Sales by Rep** — works for invoices that have a rep assignment in `customer_sales_rep_assignments`. Commission accrual stays manual (operator can post monthly summary).
- **GL Detail by Account** — shows the daily summary JE rows; drill-in shows "this is a Xoro mirror summary."

What doesn't auto-flow yet:

- Sales commission accrual on mirrored AR — would require triggering `commissions_accrue_for_invoice` on every mirrored row, which feels wrong (it'd cascade across 24 months of history on initial mirror). Defer to operator-initiated monthly accrual run.
- AR receipts mirroring — Xoro fetch doesn't include receipts at line-detail level today. Either operator types receipts manually OR we add a Xoro receipts fetch script. Punted to v2.

---

## 6. Manual override + UI

The new **🔁 Shadow Mirror Status** panel shows:

- Last successful run per domain
- Row counts (upserted / deleted / unchanged)
- Last 30 days history grid
- **Manual re-run** button (admin-only) — triggers `cron/xoro-mirror-nightly` immediately
- **Unmatched customers** + **unmatched vendors** queue (rows the Xoro fetch references but Tangerine masters lack)
- Manual-fallback reminder card: "Need to enter an invoice for an event Xoro didn't capture? Use the AR Invoices panel directly. Your manual entry won't conflict with the mirror."

All existing list views (AR Invoices, AR Receipts, AP Invoices, Journal Entries) get a `source` filter dropdown + an inline source badge on each row so operator can see only manual entries, only mirrored, or both.

> **TODO (v2):** there is currently no inventory-layers list panel — T10-4 rebuilds rows nightly but operator views them indirectly via Trial Balance / Balance Sheet. When an inventory-layers admin panel ships (likely under Inventory or a new Inventory Layers module), it MUST adopt the same `source` filter dropdown + badge pattern that T10-7 established for AR/AP/JE. Use `src/tanda/components/SourceBadge.tsx` + `SOURCE_OPTIONS` directly.

---

## 7. Cross-cutter hooks

- **M28 Notifications:** daily mirror summary email at 22:00 local — row counts + failures + unmatched-customer/vendor count. Operator gets a heartbeat that the mirror ran.
- **M27 Approvals:** none in v1. (Re-mirror with "overwrite manual" might need approval in the future.)
- **M29 Documents:** none.

---

## 8. Chunk split

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **T10-1** | Schema additions (`source` columns + `xoro_mirror_runs` table) | One migration. Defaults `source='manual'` so existing rows aren't disrupted. | — |
| **T10-2** | AR mirror function + tests | `api/_lib/xoro-mirror/ar.js` + ~30 vitest cases | T10-1 |
| **T10-3** | AP mirror function + tests | Same pattern for AP | T10-1 |
| **T10-4** | Inventory layers refresh + tests | Drop-and-rebuild logic | T10-1 |
| **T10-5** | Daily summary JE poster + tests | Posts via existing `gl_post_journal_entry` RPC | T10-2/3/4 |
| **T10-6** | Mirror cron handler + skip-on-stale guard + notifications | `api/cron/xoro-mirror-nightly.js` + Vercel cron entry | T10-2..5 |
| **T10-7** | Shadow Mirror Status UI panel + `source` filter additions on AR/AP/Inventory list views | `InternalShadowMirrorStatus.tsx` + extending 5+ existing panels with `source` filter + badge | T10-6 |
| **T10-8** | User guide chapter 22 + memory close-out | Doc + memory rule for `source` field on future integrations | All above |

Parallel waves:
- **Wave A:** T10-1.
- **Wave B (parallel):** T10-2 + T10-3 + T10-4.
- **Wave C:** T10-5 + T10-6.
- **Wave D:** T10-7 + T10-8.

Estimated **~5-7 days** end-to-end with parallel agents.

---

## 9. Risks

- **Xoro fetch shape drift.** The Xoro nightly fetch CSVs occasionally change schema (Xoro support updates a field name). Mirror needs defensive column-presence checks + clear error logging on drift. Mitigation: each domain mirror has its own column-presence test in T10-2/3/4; failing test → status='failed' + alert.
- **Customer / vendor lookup misses.** Xoro might have a customer code that Tangerine `customers_master` lacks (or vice versa). Mitigation: unmatched queue + operator manual reconciliation step (see §6).
- **Drop-and-rebuild on inventory_layers loses real Tangerine consumption.** If operator typed an AR invoice in Tangerine that consumed a layer, then T10 rebuilds layers from Xoro snapshot, that consumption disappears. Mitigation: T10-4 only drops `source='xoro_mirror'` rows; manual operator-consumed layers stay. The `inventory_layers` schema needs a `source` column to make this work.
- **Mirror runs before Xoro fetch completes.** Race condition. Mitigation: cron checks `last_successful_xoro_fetch_at >= today's date`; skips otherwise + emits notification.
- **Summary JE produces wrong number if a Xoro invoice gets retroactively edited.** Today's mirror runs; tomorrow Xoro changes yesterday's invoice. Today's summary JE is now wrong. Mitigation: nightly mirror also covers a 7-day-rolling re-mirror of recent days, reversing yesterday's summary JE + posting a corrected one. Adds complexity; v1 ships with single-day mirror and operator manually triggers re-mirror if they catch retroactive edits.

---

## 10. Tests

- AR mirror: roundtrip a synthetic Xoro AR row + verify upsert + idempotency + unmatched-customer queue.
- AP mirror: same.
- Inventory refresh: drop-and-rebuild preserves manual rows + drops only `source='xoro_mirror'`.
- Daily summary JE: posts the right amounts + idempotent if mirror run already produced one.
- Skip-on-stale-Xoro guard: cron exits cleanly + emits the right notification when fetch is > 25h old.

---

## 11. Operator confirm before chunks ship

This is a meatier cross-cutter than T3-T9. Five things worth your confirm before T10-1 kicks off:

1. **`source` enum values** in §1 — happy with that set? Anything I should add now to avoid migration later?
2. **Daily summary JE granularity** in §4.4 — one per domain per day OK? Or do you want finer (per-customer-group / per-account-class)?
3. **Inventory drop-and-rebuild** in §4.3 — losing layer-age detail OK for the shadow-ledger phase? Real per-receipt FIFO comes back in P21.
4. **7-day rolling re-mirror** in §9 (risk: retroactive Xoro edits) — ship in v1 or punt to v2? My rec is punt; you trigger manual re-mirror when needed.
5. **Mirror cron schedule** — 21:30 local OK? Or 22:00? Just needs to be after Xoro fetch.

Once confirmed, ~5-7 days of build + ship.

---

## 12. Pairs with

- **`XORO-DECOM-MAP.md`** — operational context (why T10 exists, what it doesn't do)
- **`P9-parallel-run-architecture.md`** — eventual decom validation framework (still relevant post-P22)
- **P6 Bank Recon** — Plaid sync is the closest existing pattern (external source → Tangerine mirror with `source` tag)
- **Memory: standing principle — every external integration has a manual fallback path** (operator-locked 2026-05-28)
