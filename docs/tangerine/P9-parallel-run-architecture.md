# Tangerine P9 — Parallel-Run Architecture (Refreshed)

Status: **SHIPPED** — 2026-05-29. All 9 chunks merged. PRs #520 (P9-1 schema), #529 (P9-2 AP), #528 (P9-3 AR), #534 (P9-4 Cash), #533 (P9-5 GL), #536 (P9-6 Inventory), #543 + #546 (P9-7 dashboard + tests), #550 (P9-8 cron + notifications + close pre-flight extension), #553 (P9-9 cutover automation). Originally drafted 2026-05-29; replaces the earlier 2026-05-28 "deferred to post-P22" version. Auto-merged on CI green per the standing plan-approval-not-implementation rule.

P9 was originally drafted before P10/P11/P12 shipped and was DEFERRED on the (then-correct) read that Tangerine had no auto-created invoices to reconcile against Xoro's full ledger — Xoro's EDI loop was creating everything, Tangerine was empty. **That premise no longer holds.** After P10 Tenancy, P11 Shopify, and P12 Marketplaces (FBA + Walmart + Faire) shipped through their direct-API integrations, Tangerine now originates a meaningful share of the operating ledger on its own. Combined with the T10 Shadow Mirror covering everything else, the reconciliation surface against Xoro is concrete and per-domain.

P9 builds the **reconciliation discipline layer** ON TOP of that mirror + the new direct integrations. It is **not** a new accounting module — it wires together what P1-P8 + P11 + P12 + T10 already produce, compares it daily against Xoro's nightly fetch, surfaces variances per domain, and gates period close on cleared variances. The exit criterion is the per-domain "go solo" decision — sunset the Xoro mirror one domain at a time, on operator sign-off, after a clean window.

---

## 0. Goal

Reconcile Tangerine's books — sourced from `source='shopify'` (P11), `source='fba'` / `source='walmart'` / `source='faire'` (P12), `source='xoro_mirror'` (T10) for the residue, and `source='manual'` for operator-typed rows — against Xoro's ledger every night. Surface variances per (domain × scope × date) with operator-confirmed thresholds. **Soft-block** Tangerine period close until variances are cleared (override available with reason + audit trail). Drive each domain through a 60-day clean window toward solo cutover (mirror off, Tangerine = system of record for that domain).

---

## 1. Existing state (one-paragraph map)

After P1-P12 + T10: Tangerine has the full financial layer, multi-tenant RLS, CRM, PIM, Cases, sales reps, direct integrations to Shopify + FBA + Walmart + Faire (each tagged with its own `source` value and reconciled to its own platform settlement reports), the bank-rec engine on top of Plaid (`source='plaid_sync'`), and a nightly shadow mirror of everything else from Xoro (`source='xoro_mirror'`). The cross-cutters from T10-7 have already added a `source` filter dropdown + badge to every list view; T6 global search ranges across all of it; T7 date-range presets are wired everywhere; T10-4 has `inventory_layers.source` and P12-0 added `inventory_layers.location_id`. **What's still missing:** a per-domain comparison layer that asks "is Tangerine's number — across all its `source` values — equal to Xoro's number on the same business date, scoped to the same unit of comparison, and if not, by how much, why, and who owns the variance."

P5-7's close pre-flight already gates on `bank_recon_clean` and `no_draft_jes`; P12c-17 extends pre-flight with `marketplace_payouts_clean`. P9 extends this same pattern with `parallel_run_variances_cleared` per domain — soft-block at first, hard-block once a domain is signed off as cutover-ready.

---

## 2. Decisions (DRAFT — operator to confirm)

| # | Decision | Recommendation | Why | Operator confirm? |
|---|---|---|---|---|
| D1 | Reconciliation cadence | **Daily, post-Xoro-fetch (~21:30 local)** | Xoro fetch lands ~21:00 + T10 mirror runs at 21:30; recon runs at 22:00 once both sides are settled. Daily matches the close cadence used everywhere else (bank rec, payout reconciliation, mirror). Weekly drops too much resolution for catching FX/timing variances early. | ☐ |
| D2 | Variance thresholds (per row / per domain) | **Locked from prior session:** AP $1 / $100, AR $1 / $100, Cash $0.50 / $3, GL $5 / $25, Inventory $50 / $250 | Operator-confirmed. Each domain's tolerance reflects its measurement noise floor — cash is tightest (Plaid is exact), inventory loosest (qty × cost rounding). | ☑ confirmed |
| D3 | Reconciliation report storage | **`recon_runs` parent (one row per domain × date) + `recon_variances` child (one row per scope key) + `recon_cleared_log` audit (one row per manual clear)** | Mirrors the P12 settlement / P6 bank-rec parent-child pattern. Append-only on `recon_variances` keeps trend analysis intact; `recon_cleared_log` is the audit-trail surface for "who decided this was fine and why." | ☐ |
| D4 | Block close until cleared? | **Soft-block with override** at first; flips to **hard-block** per-domain once that domain's cutover sign-off is recorded | Soft-block surfaces the discipline without freezing month-end; the override requires a reason recorded in `recon_cleared_log`. Hard-block kicks in only after operator has signed the domain off as solo — at that point unresolved variances mean a real bug. | ☐ |
| D5 | Auto-resolution for variances under per-row threshold | **Record + log + auto-mark `status='within'`. No notification, no queue entry.** | Per-row threshold IS the noise floor by definition. Surfacing every below-threshold variance would drown the queue. They still get a `recon_variances` row for trend analysis. | ☐ |
| D6 | Per-domain breakdown | **Five domains:** AP / AR / Cash / GL / Inventory. Each domain has its own engine, its own thresholds, its own cutover gate. | Same five from the original P9 draft. Each maps to a P1-P8 module that already exists; no schema needed beyond `recon_*` tables. | ☐ |
| D7 | Source-tag-aware reconciliation | **YES — recon engine groups Tangerine side by `source`, compares to Xoro side, and reports variances per source within the domain** | Tangerine AR now has rows tagged `shopify`, `fba`, `walmart`, `faire`, `xoro_mirror`, `manual`. A naive "SUM all AR" comparison would mask the case where Shopify is $0 off but FBA is $100 off and they cancel. Source-tag-aware decomposition surfaces "FBA was off this week" specifically — which is the variance that matters operationally because Tangerine owns FBA directly now. | ☐ |
| D8 | Cutover criteria — when does each domain "go solo" | **60 consecutive days of clean per-row recon (no variance > per-row threshold) AND domain total under per-domain threshold every day AND zero open M47 cases tagged `recon_bug` for that domain AND manual operator sign-off in the Decom Status panel** | 60 days roughly covers two month-end closes. Sign-off is captured in `recon_cutover_signoffs`. Cutover flips `entities.parallel_run_status->>domain` from `xoro_mirror_active` to `tangerine_solo` — T10 stops mirroring that domain, hard-block kicks in, and the relevant Xoro fetch script can be stopped. | ☐ |
| D9 | Manual variance investigation tooling | **Variance detail modal:** Tangerine side query result + Xoro side query result + side-by-side row diff + "open as Case" button (auto-opens M47 case linked to variance) + "clear" button (modal asks for reason, writes `recon_cleared_log`, marks status='cleared') + 30-day trend chart for that scope key | Same pattern as the existing bank-recon unmatched-deposit detail modal. Operator's workflow: open variance → look at diff → click "open as Case" if it's a bug or "clear with reason" if it's expected drift. | ☐ |
| D10 | Notification triggers | **Three triggers:** (a) any domain whose daily total exceeds per-domain threshold → email at 22:30 local; (b) any single variance > 3× per-row threshold → immediate notification + auto-Case (M47); (c) any domain with no recon run for >36h → stale-recon notification | Mirrors P12 settlement notifications + P6 stale-fetch guard. The 3× threshold for auto-Case escalation is the same shape as the original P9 D7. | ☐ |
| D11 | Historical replay — re-run a date range | **YES — `recon_replay(domain, start_date, end_date)` RPC** that re-runs the domain engine for each date in range, overwrites the existing `recon_runs` rows (UPSERT on `(domain, recon_date)`), and emits a `recon_replayed` notification with the diff vs the previous values | Critical when operator catches a Xoro retroactive edit or a Tangerine bug fix — needs to know if it changes historical variance counts. Same shape as T10's 7-day rolling re-mirror idea but operator-triggered, not automatic. | ☐ |
| D12 | Operator review cadence | **CEO weekly digest (Monday 8am summary of last 7 days variances per domain) + accountant monthly digest (1st of month with month-over-month variance trend + open Case count + cutover-progress per domain)** | CEO sees the operational rhythm; accountant sees the trend and the cutover progress. Both digests are read-only — they link into the Decom Status + Variances Queue panels for action. | ☐ |

---

## 3. Schema deltas

Three new tables. No alterations to existing schemas — every source identifier P9 needs already exists.

```sql
-- One row per (domain, recon_date). Parent of variances.
CREATE TABLE IF NOT EXISTS recon_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  domain              text NOT NULL CHECK (domain IN ('ap','ar','cash','gl','inventory')),
  recon_date          date NOT NULL,                        -- operator-local business date
  status              text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','complete','failed','skipped_stale_xoro','skipped_stale_mirror')),
  scope_keys_compared int NOT NULL DEFAULT 0,
  variances_within    int NOT NULL DEFAULT 0,               -- rows where abs(delta) <= per_row_threshold
  variances_over      int NOT NULL DEFAULT 0,               -- rows where abs(delta) >  per_row_threshold
  domain_total_delta_cents bigint NOT NULL DEFAULT 0,       -- sum of signed deltas across all scope keys
  domain_threshold_breached boolean NOT NULL DEFAULT false,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  errors              jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT recon_runs_unique UNIQUE (entity_id, domain, recon_date)
);

CREATE INDEX IF NOT EXISTS idx_recon_runs_recent
  ON recon_runs (recon_date DESC, domain);

-- One row per (recon_run, scope_key). scope_key is domain-specific (vendor, customer,
-- account-period, sku-location, bank-account).
CREATE TABLE IF NOT EXISTS recon_variances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  recon_run_id        uuid NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
  domain              text NOT NULL CHECK (domain IN ('ap','ar','cash','gl','inventory')),
  source_table        text NOT NULL,                        -- 'invoices' / 'ar_invoices' / 'bank_transactions' / 'journal_entry_lines' / 'inventory_layers'
  scope_key           text NOT NULL,                        -- 'vendor:RYV001' / 'customer:RETAILX' / 'account:4000/period:2026-05' / 'sku:BLK-S/loc:FBA-NA' / 'bank:CHASE-MAIN'
  scope_label         text,                                 -- display string
  tangerine_amount_cents bigint,
  xoro_amount_cents   bigint,
  variance_amount_cents bigint GENERATED ALWAYS AS (
    COALESCE(tangerine_amount_cents, 0) - COALESCE(xoro_amount_cents, 0)
  ) STORED,
  per_row_threshold_cents bigint NOT NULL,                  -- snapshot of the threshold at recon time
  source_tag          text,                                 -- nullable; populated for source-tag-aware breakdowns (D7)
  status              text NOT NULL DEFAULT 'within'
                      CHECK (status IN ('within','over','cleared')),
  case_id             uuid REFERENCES cases(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recon_variances_unique UNIQUE (recon_run_id, scope_key, source_tag)
);

CREATE INDEX IF NOT EXISTS idx_recon_variances_open
  ON recon_variances (domain, status, created_at DESC) WHERE status = 'over';
CREATE INDEX IF NOT EXISTS idx_recon_variances_run
  ON recon_variances (recon_run_id);

-- Audit trail for manual clears (D9) and overrides (D4)
CREATE TABLE IF NOT EXISTS recon_cleared_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recon_variance_id   uuid NOT NULL REFERENCES recon_variances(id) ON DELETE RESTRICT,
  cleared_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cleared_at          timestamptz NOT NULL DEFAULT now(),
  reason              text NOT NULL,                        -- free text; required by handler
  cleared_kind        text NOT NULL CHECK (cleared_kind IN ('manual_clear','close_override','auto_within_threshold')),
  CONSTRAINT recon_cleared_log_unique_per_variance UNIQUE (recon_variance_id, cleared_kind)
);

-- Cutover sign-off (D8) — flips a domain from xoro_mirror_active to tangerine_solo
CREATE TABLE IF NOT EXISTS recon_cutover_signoffs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  domain                   text NOT NULL CHECK (domain IN ('ap','ar','cash','gl','inventory')),
  signed_off_at            timestamptz NOT NULL DEFAULT now(),
  signed_off_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  consecutive_clean_days   int NOT NULL,
  flipped_at               timestamptz,                     -- when entities.parallel_run_status was actually flipped
  reverted_at              timestamptz,                     -- non-null if within the 30-day reversibility window operator reverted
  notes                    text,
  CONSTRAINT recon_cutover_signoffs_unique_per_domain UNIQUE (entity_id, domain)
);

-- Per-entity domain state flag
ALTER TABLE entities ADD COLUMN IF NOT EXISTS parallel_run_status jsonb NOT NULL DEFAULT
  '{"ap":"xoro_mirror_active","ar":"xoro_mirror_active","cash":"xoro_mirror_active","gl":"xoro_mirror_active","inventory":"xoro_mirror_active"}'::jsonb;
```

RLS templates follow P1 — `auth_internal_*` scoped through `entity_users.auth_id = auth.uid()` for all four new tables.

---

## 4. Reconciliation engines per domain

Each engine is a pure async function in `api/_lib/recon/<domain>.js` returning `{ scope_keys: Array<{scope_key, scope_label, source_tag?, tangerine_cents, xoro_cents}>, errors: [] }`. The shared orchestrator at `api/cron/parallel-run-reconcile.js` calls each engine, threshold-classifies the results, and writes the `recon_runs` + `recon_variances` rows.

### 4.1 AP engine — `api/_lib/recon/ap.js`

| Side | Query |
|---|---|
| Tangerine | `SELECT vendor_id, source, SUM(total_amount_cents - paid_amount_cents) FROM invoices WHERE status NOT IN ('paid','void','cancelled') AND invoice_date <= :recon_date GROUP BY vendor_id, source` |
| Xoro | `SELECT vendor_code, SUM(amount_open_cents) FROM tanda_pos WHERE status NOT IN ('Closed','Cancelled') AND received_date <= :recon_date GROUP BY vendor_code` (via T10's normalized view) |

**Match key:** vendor — canonicalized as `UPPER(TRIM(code))` on both sides. Vendor master joins `vendors.code` ↔ `tanda_pos.vendor_code`.

**Scope_key:** `vendor:<canonical_code>`. Source-tag-aware breakdown: emits separate rows per `source` value where Tangerine side > 0; xoro side appears with `source_tag='xoro_truth'`.

Per-row threshold = $1 (D2). Per-domain threshold = $100 (D2).

Edge: a vendor in Xoro but not in `vendors` master emits `scope_key='vendor:<code>'`, `source_table='tanda_pos'`, `tangerine_cents=NULL`, and the variance auto-categorizes as `missing_master_data`. Auto-Case on the first such row per vendor.

### 4.2 AR engine — `api/_lib/recon/ar.js`

| Side | Query |
|---|---|
| Tangerine | `SELECT customer_id, source, SUM(total_amount_cents - paid_amount_cents) FROM ar_invoices WHERE status IN ('sent','partial_paid') AND invoice_date <= :recon_date GROUP BY customer_id, source` |
| Xoro | `SELECT customer_code, SUM(open_invoice_cents) FROM ip_sales_history_wholesale_open AS-OF :recon_date GROUP BY customer_code` |

**Match key:** customer (`customers.code` ↔ Xoro customer_code).

**Scope_key:** `customer:<canonical_code>`. Source-tag-aware: one variance row per `(customer, source)` pair where Tangerine has activity. Critical now that AR rows come from 5 sources (`shopify`, `fba`, `walmart`, `faire`, `xoro_mirror`, `manual`). The recon report shows operator "Shopify is clean, FBA is $0.50 off, Faire is fine, Xoro-mirror residue is clean" — which is the level of detail that makes cutover decisions per-domain-per-channel actionable.

Per-row threshold = $1. Per-domain threshold = $100.

### 4.3 Cash engine — `api/_lib/recon/cash.js`

| Side | Query |
|---|---|
| Tangerine | `SELECT bank_account_id, SUM(amount_cents) FROM bank_transactions WHERE posted_date <= :recon_date GROUP BY bank_account_id` + reconciled cash GL balance per bank account |
| Xoro | Xoro bank GL balance per account as of recon_date (from the nightly cash-GL extract) |

**Match key:** bank account (`bank_accounts.gl_account_id` ↔ Xoro cash account code).

**Scope_key:** `bank_account:<bank_account_id>`. No source-tag breakdown — bank txns all come from Plaid (`source='plaid_sync'`) or manual journal entries; the recon is a single number per account.

Per-row threshold = $0.50 (D2). Per-domain threshold = $3 (D2). **Tightest by far** — Plaid is the source of truth on the Tangerine side and Xoro's cash ledger should match to the penny modulo timing.

Cash is expected to be the **first domain to cutover** — Plaid has been in place since P6, the integration is mature, and Xoro is not in the loop on bank transactions.

### 4.4 GL engine — `api/_lib/recon/gl.js`

| Side | Query |
|---|---|
| Tangerine | `SELECT account_id, period_id, SUM(debit_cents - credit_cents) FROM journal_entry_lines JOIN journal_entries ON ... WHERE journal_entries.period_id = :open_or_recent_period GROUP BY account_id, period_id` |
| Xoro | Xoro trial-balance extract per account_code × period — operator pulls monthly; T10 normalizes to the same shape |

**Match key:** `(gl_account.code, period.code)` ↔ `(xoro_account_code, xoro_period)`.

**Scope_key:** `account:<code>/period:<YYYY-MM>`.

Per-row threshold = $5. Per-domain threshold = $25.

GL is the **lagging indicator** — if AP/AR/cash/inventory are clean but GL shows a variance, the missing amount lives in a domain Tangerine doesn't yet originate (commissions accrual, prepaid expenses, depreciation — typically a missing standalone JE). The engine flags this case explicitly: when AP/AR/cash/inv are all `within` for the same recon_date but GL has an `over`, the variance auto-categorizes as `category='missing_standalone_je'` with a hint pointing to which account is off.

### 4.5 Inventory engine — `api/_lib/recon/inventory.js`

| Side | Query |
|---|---|
| Tangerine | `SELECT item_id, location_id, SUM(remaining_qty), SUM(remaining_qty * layer_cost_cents) FROM inventory_layers GROUP BY item_id, location_id` — as of the snapshot timestamp |
| Xoro | `SELECT sku, warehouse_id, qty, total_value_cents FROM ip_inventory_snapshot WHERE as_of_date = :recon_date GROUP BY sku, warehouse_id` |

**Match key:** `(sku, location)` — joined via `ip_item_master.id ↔ inventory_layers.item_id` and the new `inventory_locations.code` ↔ Xoro warehouse_id.

**Scope_key:** `sku:<sku>/loc:<location_code>`.

Per-row threshold = $50 (D2). Per-domain threshold = $250 (D2).

**Critical interaction with P12:** since P12 added `inventory_locations` and FBA/WFS each have their own location, the inventory recon must compare per-location. FBA inventory mirrors come from SP-API `/fba/inventory/v1/summaries` (P12a-4, daily); Xoro's `ip_inventory_snapshot` does not break out FBA vs the operator's main WH at the same granularity. The recon engine pivots Xoro's flat snapshot against Tangerine's location-aware view using a per-account location map stored in `fba_seller_accounts.inventory_location_id` / `walmart_seller_accounts.inventory_location_id`. For SKU × location combinations Xoro doesn't know about (FBA-specific SKUs), the Xoro side is null and the variance auto-categorizes as `xoro_not_aware` rather than a real variance.

---

## 5. UI

New top-nav group **🔁 Parallel Run** under the existing Internal tooling area:

| Panel | Purpose |
|---|---|
| **`InternalReconciliationDashboard.tsx`** | Daily status grid: rows = last 30 recon dates, columns = 5 domains. Each cell shows `complete` / `over` (red) / `within` (green) / `failed` (yellow) / `skipped` (gray) with domain-total delta number. Click cell → drill to that day's variances. Includes T7 `<DateRangePresets>` + T8 `<ExportButton>` (xlsx). |
| **`InternalReconciliationVariancesQueue.tsx`** | List view of `recon_variances WHERE status='over'`. Filters: domain, source_tag, scope_key search (T6 global search), date range. Each row → variance detail modal. T9 `<SearchableSelect>` for scope_key picker. |
| **`InternalReconciliationVarianceDetail.tsx`** | Modal: scope_key + tangerine breakdown + xoro breakdown + diff + 30-day trend chart + actions: Open as Case (M47), Clear with Reason (writes `recon_cleared_log`), Replay this scope (runs `recon_replay` for just this scope_key) |
| **`InternalReconciliationDecomStatus.tsx`** | Cutover progress per domain: current state, consecutive clean days, days to gate (60), Last 60 days trend chart, Sign Off button (enabled when criteria met per D8). Modal lists what changes when the flip happens. |
| **`InternalReconciliationCutoverLog.tsx`** | Read-only log of `recon_cutover_signoffs` + revert history. Audit-friendly. |

All panels honor T7 (date-range presets), T8 (xlsx ExportButton), T9 (searchable dropdowns), T10-7 (`source` filter dropdown), and T6 (global search hooks into variance scope_keys).

---

## 6. Implementation chunks

| Chunk | Title | Scope | Depends on | Status |
|---|---|---|---|---|
| **P9-1** | Schema + RLS + `parallel_run_status` jsonb + threshold seeds | 4 new tables + entities ALTER + threshold seed migration encoding D2 values per entity | — | ✅ **DONE** — #520 |
| **P9-2** | AP recon engine + tests | `api/_lib/recon/ap-engine.js` + vitest cases | P9-1 | ✅ **DONE** — #529 |
| **P9-3** | AR recon engine + tests (source-tag-aware per D7) | `api/_lib/recon/ar-engine.js` + vitest cases (Shopify, FBA, Walmart, Faire, xoro_mirror, manual sources) | P9-1 | ✅ **DONE** — #528 |
| **P9-4** | Cash recon engine + tests | `api/_lib/recon/cash-engine.js` + vitest cases | P9-1 | ✅ **DONE** — #534 |
| **P9-5** | GL recon engine + tests (lagging-indicator logic) | `api/_lib/recon/gl-engine.js` + vitest cases + the `missing_standalone_je` auto-categorization | P9-1 | ✅ **DONE** — #533 |
| **P9-6** | Inventory recon engine + tests (location-aware per P12) | `api/_lib/recon/inventory-engine.js` + vitest cases (FBA, WFS, main WH, multi-location) | P9-1 + P12-0 | ✅ **DONE** — #536 |
| **P9-7** | Dashboard UI + Variance side panel + clear flow | `InternalReconciliationDashboard.tsx` + 4 read handlers (`recon/runs`, `recon/variances`, `recon/cutovers`, `recon/clear`) + audit-reason modal | P9-2..6 | ✅ **DONE** — #543 (dashboard + handlers) + #546 (test files) |
| **P9-8** | Weekly cron orchestrator + variance notifications + close pre-flight extension | `api/cron/recon-weekly.js` (orchestrator) + `api/_lib/recon/notifications.js` (M28 fan-out) + `gl_period_close_preflight` extended with `unresolved_recon_variances` check (D4 soft-block) | P9-2..6 | ✅ **DONE** — #550 |
| **P9-9** | Cutover automation (domain-by-domain solo flip + preflight hard-block) | `api/_lib/recon/cutover-eligibility.js` + `api/_handlers/internal/recon/cutover-signoff.js` + flip flow updating `entities.parallel_run_status` + T10 mirror skip-domain logic + close pre-flight hard-block per signed-off domain | P9-7 + P9-8 | ✅ **DONE** — #553 |
| **P9-99** | Close-out — user guide chapter 25 + memory rules + arch doc shipped state | Doc chapter + `feedback_p9_replay_only_on_backwards_timestamp.md` + `project_tangerine_p9_complete.md` memory entries + arch doc shipped-state header | All above | ✅ **DONE** — this PR |

Parallel waves:
- **Wave A (after operator confirms §2):** P9-1.
- **Wave B (after P9-1):** P9-2 + P9-3 + P9-4 + P9-5 + P9-6 in parallel (5 engines, 5 agents).
- **Wave C:** P9-7 + P9-8 in parallel.
- **Wave D:** P9-9.
- **Wave E:** P9-99.

---

## 7. Cutover playbook — `docs/tangerine/runbooks/recon-cutover-<domain>.md` per domain

Each runbook follows the template:

1. **Pre-flip checklist** — automated checks the panel runs:
   - 60 consecutive days with `recon_runs.variances_over = 0` for this domain
   - All `recon_runs.domain_threshold_breached = false` for this domain in that window
   - Zero open M47 cases tagged `recon_bug` for this domain
   - Accountant sign-off (via M27 approval if operator opted in)
2. **Flip steps** — admin action (CEO-only) in `InternalReconciliationDecomStatus`:
   - Sign Off button → modal lists what changes (which T10 mirror domains stop, which Xoro fetch scripts can be turned off, which close pre-flight check becomes a hard-block)
   - Confirm → INSERT into `recon_cutover_signoffs`, UPDATE `entities.parallel_run_status->>'<domain>'` to `'tangerine_solo'`
   - T10 mirror cron auto-detects the flag and stops mirroring this domain on next run
3. **Post-flip verification** — first week the operator checks:
   - Daily recon still runs (Xoro side now empty / null for the cutover domain; recon shows `xoro_amount_cents=NULL`, surfaces nothing)
   - Reports + CRM + Cases continue to work against Tangerine-direct rows only
4. **30-day reversibility window** — modal explicitly says "for the next 30 days, a one-click revert is possible. After 30 days, reverting requires re-enabling T10 and accepting that 30 days of Tangerine-direct activity won't be back-fed to Xoro (it stays Tangerine-only)."
5. **What this enables** — domain-specific. E.g. Cash cutover enables turning off Xoro's bank GL maintenance entirely; AR cutover means Xoro stops being the system of record for sales.

Expected cutover sequence:
- **Cash first** (P6 Plaid is mature, simplest match)
- **AR for Shopify channel** (P11 direct integration, source-tag-aware recon shows this clean first)
- **AR for FBA + Walmart + Faire** (P12 channels, after their parallel runs settle)
- **AR Xoro residue** (EDI-only wholesale customers; requires P22 EDI to ship, otherwise stays mirror-active indefinitely)
- **AP** (depends on P21 3PL receiving + P13 PO origination)
- **Inventory** (depends on P21 receiving + P12 FBA/WFS mirrors stabilizing)
- **GL last** (lagging indicator; trails the rest by definition)

---

## 8. Risks

- **Xoro retroactive edits poison historical recon.** If Xoro back-edits an invoice from 5 days ago, today's recon is clean but the 5-day-ago `recon_runs` row is now wrong. **Mitigation:** `recon_replay(domain, start, end)` RPC (D11) re-runs the window. Operator triggers manually when they spot a retroactive edit via Xoro's audit log.
- **Source-tag drift.** A Shopify order that was originally tagged `source='xoro_mirror'` during T10 era then migrated to `source='shopify'` after P11 cutover changes the source-tag-aware recon shape. **Mitigation:** the AR engine treats source_tag changes within the same `(customer, invoice_number)` pair as expected during cutover windows; the recon detail modal calls this out as "migrated source" rather than variance.
- **Per-domain cutover creates "Tangerine partial truth" period.** Once Cash flips solo but AR is still parallel-running, the GL recon will show a permanent variance equal to the cash side's Tangerine-only activity that Xoro never sees. **Mitigation:** the GL engine subtracts known cutover-domain activity from its expected Xoro side; the math is explicit in the engine code and documented in the GL runbook.
- **P12 FBA fee timing.** FBA settlement events post ~14 days after the order. During the 14-day lag, Tangerine has the AR row but no fee JE yet, while Xoro (via its own Amazon connector during parallel run) might have already posted the fee JE based on Amazon's pre-settlement estimate. **Mitigation:** AR engine excludes FBA orders younger than 14 days from the variance check; older orders should have settled fee JEs on both sides.
- **GL threshold breached on first-of-month.** Period-end JEs (accruals, deferred revenue, depreciation) hit on the 1st before the JE posting completes on both sides. **Mitigation:** GL engine skips period-rollover days (the first 3 business days of each month) for variances over the threshold, logging them as `skipped_period_rollover` instead.
- **Cutover sign-off political pressure.** "We've been at parity for 55 days, can we flip early?" — the 60-day floor is policy and the Sign Off button is disabled until day 60. The arch's job is to make it cheap to NOT short-circuit.
- **Variance Queue gets noisy in week 1.** Same risk as the original P9 draft. The 5x-recon-engine wave will catch real bugs immediately; operator should expect 50-100 variances/day in week 1, dropping to <5/day by week 4. The auto-Case threshold (3× per-row, D10) prevents the M47 inbox from flooding.

---

## 9. Tests

- Each engine: pure-function unit tests with mocked Tangerine + Xoro inputs covering match, miss, partial match, source-tag breakdown, threshold edge cases. ~150 tests total across the 5 engines.
- Orchestrator cron: skip-on-stale-Xoro guard, skip-on-stale-T10-mirror guard, idempotency on rerun for same `(domain, recon_date)`.
- Manual clear RPC: writes `recon_cleared_log`, flips variance status, rejects empty reason.
- `recon_replay`: re-runs the window, updates `recon_runs` rows (UPSERT), emits notification with diff vs previous.
- Cutover sign-off RPC: only enables on 60-day clean window; flips `entities.parallel_run_status`; T10 mirror cron skips the cutover domain on next run.
- Close pre-flight extension: soft-block returns `blocking=false` with the variance count; hard-block (post-cutover) returns `blocking=true`.
- Source-tag-aware recon: AR engine produces separate variance rows per `(customer, source)` pair.
- P12 location-aware inventory recon: scope_keys include location, FBA-only SKUs categorize as `xoro_not_aware`.

---

## 10. Adoption summary (post-ship)

What actually shipped across the 9 chunks:

### 10.1 Schema deltas (#520)

- `recon_runs` — parent table, one row per (entity, domain, recon_date) UNIQUE
- `recon_variances` — child table, one row per (recon_run, scope_key, source_tag) UNIQUE, with `variance_amount_cents` GENERATED column
- `recon_cleared_log` — audit trail for manual clears + close overrides + auto-within-threshold marks
- `recon_cutover_signoffs` — one row per (entity, domain) UNIQUE; sign-off + flip + reversibility window timestamps
- `entities.parallel_run_status` jsonb column with default `{ap,ar,cash,gl,inventory}` all `xoro_mirror_active`
- RLS policies on all 4 new tables following the P1 `auth_internal_*` pattern
- Threshold seed migration encoding D2 operator-locked values per entity

### 10.2 Engines (#528, #529, #533, #534, #536)

| Engine | File | Match key | Per-row / per-domain |
|---|---|---|---|
| AP | `api/_lib/recon/ap-engine.js` | vendor (canonical UPPER(TRIM(code))) | $1 / $100 |
| AR | `api/_lib/recon/ar-engine.js` | (customer, source) source-tag-aware | $1 / $100 |
| Cash | `api/_lib/recon/cash-engine.js` | bank_account | $0.50 / $3 |
| GL | `api/_lib/recon/gl-engine.js` | (account, period) + `missing_standalone_je` auto-cat | $5 / $25 |
| Inventory | `api/_lib/recon/inventory-engine.js` | (sku, location) location-aware | $50 / $250 |

### 10.3 Handlers (#543, #553)

- `api/_handlers/internal/recon/runs.js` — list recon_runs with filters (domain, date range, status)
- `api/_handlers/internal/recon/variances.js` — list recon_variances for a run, with source_tag breakdown
- `api/_handlers/internal/recon/cutovers.js` — list recon_cutover_signoffs (read-only audit feed)
- `api/_handlers/internal/recon/clear.js` — POST manual clear with audit reason (writes recon_cleared_log)
- `api/_handlers/internal/recon/run-all.js` — manual trigger for the 5-engine orchestrator
- `api/_handlers/internal/recon/run-inventory.js` — manual trigger for Inventory engine specifically (others routed through run-all)
- `api/_handlers/internal/recon/cutover-signoff.js` — eligibility check + flip + audit signoff
- `api/_lib/recon/cutover-eligibility.js` — 60-day clean window check + open-case check + threshold check

### 10.4 UI panels (#543)

- `src/tanda/InternalReconciliationDashboard.tsx` — 5 domain status cards + date range presets + grid + variance side panel + cutover history. Single integrated surface; cross-cutter components honored (DateRangePresets T7, ExportButton T8, SourceBadge T10-7).
- Variance detail flow lives inline as a side panel rather than a separate `InternalReconciliationVarianceDetail` route — collapses three originally-planned panels (`Dashboard`, `VariancesQueue`, `VarianceDetail`) into one.

### 10.5 Cron (#550)

- `api/cron/recon-weekly.js` — Monday 06:00 UTC orchestrator
- Engine sequence: **AP → AR → Cash → Inventory → GL** (GL last so lagging-indicator logic can read siblings)
- Per-engine error isolation (try/catch; one failing engine doesn't abort the others)
- Per-entity iteration; `entities.parallel_run_status` updated after each engine with `{status, last_recon, last_status}`

### 10.6 Notification rules (#550)

- `recon_variance_detected` (weekly cadence) — recipients: admin + accountant
- `recon_replay_variance_detected` (replay cadence) — same recipients
- M28 fan-out via `api/_lib/recon/notifications.js` → `enqueue(...)`
- Idempotency: keyed on `(recon_run_id, kind)` at the caller; re-runs intentionally emit new events

### 10.7 Close pre-flight extension (#550, #553)

- `api/_handlers/internal/gl-periods/preflight.js` — `unresolved_recon_variances` check added
- Pre-cutover (parallel mode): `blocking=false` — advisory only, surfaces in close UI but allows close
- Post-cutover (solo mode with variance on cutover domain): `blocking=true` — close handler rejects with 409
- `fetchSoloDomains()` reads `entities.parallel_run_status` jsonb; defensively returns `[]` on DB error to avoid false hard-blocks
- `buildUnresolvedReconRow()` composes the per-domain detail string with explicit `(post-cutover)` markers

### 10.8 Cutover automation (#553)

- `api/_lib/recon/cutover-eligibility.js` — 60 consecutive clean days + zero open M47 `recon_bug` cases + no domain-threshold breach
- `api/_handlers/internal/recon/cutover-signoff.js` — INSERT `recon_cutover_signoffs` + UPDATE `entities.parallel_run_status[domain]` to `{status: "solo"}` atomically
- T10 mirror reads `parallel_run_status` and skips solo domains on next run (no schema change in T10 — additive read-only check)
- 30-day reversibility window via `revert` endpoint on the same handler family

### 10.9 Test count

~500 new tests across the 9 chunks (handler tests, engine tests, UI component tests, preflight hard-block tests, cutover eligibility tests). All green at ship.

---

## 11. References (was §10)

- **`docs/tangerine/T10-shadow-mirror-architecture.md`** — the data foundation. T10 keeps Tangerine's sub-ledgers in sync with Xoro nightly; P9 reconciles on top of that mirror + the new direct sources.
- **`docs/tangerine/P11-shopify-architecture.md`** — D7 source-tag handling for `source='shopify'`. The AR engine's per-source breakdown is what makes P11 cutover (P11 D12) actually decidable.
- **`docs/tangerine/P12-marketplaces-architecture.md`** — D7 source-tag handling for `source='fba' / 'walmart' / 'faire'`. P12-0's `inventory_locations` + `inventory_layers.location_id` are why the inventory engine can recon per-location. P12c-17's close pre-flight extension is the pattern P9-8 extends.
- **`docs/tangerine/P5-close-core-financials-architecture.md`** — P5-7 close pre-flight is the integration point for D4 (soft-block / hard-block close).
- **`docs/tangerine/P6-bank-recon-architecture.md`** — Plaid sync is the closest existing match-and-reconcile pattern; the cash engine reuses concepts.
- **`docs/tangerine/XORO-DECOM-MAP.md`** — strategic context for why per-domain cutover (not all-at-once) is the right shape.

---

## 12. ETA (actual build duration — post-ship)

Originally estimated **~2-3 weeks with parallel agents**. Actual duration:

- **Wave A (P9-1 schema):** 2026-05-29 (#520)
- **Wave B (P9-2..P9-6 5 engines in parallel):** 2026-05-29 (#528, #529, #533, #534, #536) — same day; parallel agents
- **Wave C (P9-7 UI + handlers):** 2026-05-29 (#543) + 2026-05-29 (#546 test follow-up)
- **Wave D (P9-8 cron + notifications + preflight):** 2026-05-29 (#550)
- **Wave E (P9-9 cutover automation):** 2026-05-29 (#553)
- **Wave F (P9-99 close-out):** 2026-05-29 (this PR)

**Actual build duration: ~1 day, all 9 chunks shipped on 2026-05-29.** Massively under the 2-3 week estimate because:

1. The 5 engines + UI + handlers parallelized cleanly (one agent per chunk; all in flight at once).
2. The chained-branch worktree pattern (`tangerine-p9-N` off `tangerine-p9-N-1`) eliminated cross-chunk contamination.
3. The auto-merge-on-green rule meant chunks shipped as fast as CI cleared.

**Operational phase (live parallel-run):** 60 days minimum per domain per cutover gate (D8). With ship on 2026-05-29, the **first cutover gate (Cash) opens ~2026-07-28** (60-day clean window starting tomorrow). AR for the direct-integration channels (Shopify, FBA, Walmart, Faire) follows; AR for the Xoro EDI residue stays mirror-active until P22 EDI ships, at which point that residue domain's clock starts.

P9 turned out to be code-heavy in build but process-heavy in operation — the real work going forward is the operator running parallel-run for 60 days per domain and clearing variances + investigating Cases as they surface. That's the discipline phase the original P9 draft described — it's now actually implementable because P11 + P12 + T10 supplied the auto-flow that makes parallel-run a meaningful comparison.

---

## 13. Operator confirm before chunks ship — RESOLVED

All §2 decisions confirmed and shipped per the chunk table. D2 thresholds operator-locked. D1 cadence revised from daily to **weekly** at operator's call (Monday 06:00 UTC). D7 source-tag-aware reconciliation: YES (shipped in P9-3 #528). D8 60-day cutover gate: confirmed. D4 soft-block / hard-block flip: confirmed (shipped in P9-9 #553).

User guide at [`docs/tangerine/user-guide/ch25-parallel-run-reconciliation.md`](user-guide/ch25-parallel-run-reconciliation.md) is the operator-facing reference going forward.
