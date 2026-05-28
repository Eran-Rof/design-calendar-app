# Tangerine P9 — Parallel-Run Architecture Pass

Status: **DRAFT — DEFERRED to post-P22** (revised 2026-05-28 afternoon).

P9 is **not** a software-build phase like P1–P8. It's the **2-month live-alongside-Xoro period** that has to land before P10 Tenancy + the eventual Xoro decom (P23). The deliverable isn't new code — it's *evidence* that Tangerine reproduces Xoro's numbers within tolerance, per domain, every day, for long enough that the operator + the future accountant trust it as source-of-truth.

This doc plans the **scaffolding** that makes parallel-run tractable: daily reconciliation jobs, per-domain parity dashboards, variance taxonomy, decom gates, and the per-domain runbooks for flipping each module from "Xoro-truth" to "Tangerine-truth."

---

## ⚠️ Scheduling reframe — 2026-05-28 afternoon

**P9 implementation is deferred until after P22 EDI ships** (approximately 18-24 months out).

Why: ROF's Xoro is end-to-end EDI-integrated. AR / AP / COGS aren't typed by operator — they materialize from EDI / 3PL / Shopify events. Until Tangerine can originate POs (P13), receive EDI (P22), and talk to 3PL (P21), Tangerine has zero auto-created invoices to reconcile against Xoro's full ledger. Running P9 today would compare Tangerine's empty AR table to Xoro's full one — meaningless.

See `docs/tangerine/XORO-DECOM-MAP.md` for the full reframe + revised timeline.

**What replaces "P9 next":** the **T10 Shadow Mirror** cross-cutter (`docs/tangerine/T10-shadow-mirror-architecture.md`). Shadow Mirror keeps Tangerine sub-ledgers continuously in sync with the nightly Xoro fetch — so reports + CRM + Cases work against real numbers without operator dual-entry. T10 is the immediate-next work; P9 is the eventual decom gate.

**The technical content of P9 below is still correct** — same 5 domains, variance taxonomy, decom gates, sign-off ceremony. Only the *when* moves. The §2 D2 thresholds operator confirmed (AP $1/$100, AR $1/$100, cash $0.50/$3, GL $5/$25, inventory $50/$250) carry forward to the eventual P9 implementation unchanged.

---

## 0. Scope guardrails

**In scope (this phase):**

- **Daily reconciliation cron** — pulls Xoro's nightly fetch + queries Tangerine's tables + emits one variance row per (domain × entity × date).
- **Five parity dashboards** under a new top-nav group **🔁 Parallel Run**:
  1. **AP Parity** — Xoro AP open invoice list vs Tangerine `invoices` (P3 AP) + payments + GL postings
  2. **AR Parity** — Xoro AR open invoices + receipts vs Tangerine `ar_invoices` + `ar_receipts` (P4)
  3. **GL Parity** — trial balance comparison per account per period
  4. **Inventory Parity** — Xoro on-hand vs Tangerine FIFO layers (P3-3) per SKU per warehouse
  5. **Cash Parity** — Xoro bank balances vs Tangerine cash GL + Bank Recon (P6)
- **Variance taxonomy + workflow** — every flagged variance gets a category (timing / FX / rounding / cutoff / missing-entry / bug) + an assignee + an investigation note + a resolution flag.
- **Per-domain decom gates** — explicit thresholds and sign-off ceremonies for cutting each module from Xoro: e.g. *AP decom requires N consecutive days at <$X variance across all open AP*.
- **Runbook docs** — one per module: how to flip Tangerine to source-of-truth, how to stop the Xoro feed, what breaks downstream.
- **Cross-cutter wiring** — notifications when a variance crosses a threshold (operator gets emailed before checking the dashboard).

**Explicitly OUT of scope (deferred):**

- **Xoro decom itself** — that's P23. P9 only proves Tangerine is *ready*; pulling the plug is a separate phase.
- **Net-new accounting modules** — no new schemas for AP/AR/GL/inventory/cash. P9 wires *together* what P3-P8 built.
- **Tenancy flip (multi-RLS)** — that's P10. P9 stays single-tenant ROF, focused on parity.
- **Migration of *historical* Xoro data** — operator has been on Xoro since Aug 2024 and P4-8 already backfilled the AR side. AP historical backfill is in P14 / P21 if needed; P9 does not address it.
- **Real-time / streaming reconciliation** — daily cadence is sufficient. Real-time parity is M46 BI in P24.
- **Automated variance auto-resolution** — every variance is operator-reviewed in v1. Auto-classification can come later.
- **Re-flowing Xoro data into Tangerine** — Xoro stays read-only into Tangerine via the existing daily fetch. We don't write back to Xoro from Tangerine; Xoro is the legacy system being retired.

---

## 1. Existing state (one-paragraph map)

After P8: 8 phases shipped (Foundation → Cross-cutters → Acc Core AP → AR → Close → Bank Recon → Revenue Ops → Data+CRM). Operator's nightly Xoro fetch (`rof_xoro_project`) runs at 21:00 on both Mac (launchd) + Windows (Task Scheduler) and produces CSVs: `currentproducts.csv`, `tanda_pos.csv`, `invoice_detail.csv`, `inventory_byitem.csv`, `item_costing.csv`. These are already ingested into Supabase via the post-scripts (`post_master_data.py`, `post_invoice_detail.py`, etc.) and surface in ATS / PO WIP / Tangerine reports. **What's missing: a per-domain comparison layer** that asks "is Tangerine's number = Xoro's number, and if not, by how much, and why."

---

## 2. Decisions (DRAFT — operator to confirm)

| # | Decision | Recommendation | Why | Operator confirm? |
|---|---|---|---|---|
| D1 | Reconciliation cadence | **Daily, post-Xoro-fetch** (~21:30 local) | Xoro fetch lands ~21:00; reconciliation needs both sides up-to-date. Daily is sufficient per arch §6 timing. | ☐ |
| D2 | $-tolerance threshold | **$10 per variance row + $100 per domain total** by default; per-domain override via `parallel_run_thresholds` table | Roadmap locked-decision §5 set the spirit ("$-tolerance decom"); these numbers are starting points. AR / AP probably tighter; inventory looser. | ☐ |
| D3 | Variance taxonomy | **6 categories** — `timing` / `fx` / `rounding` / `cutoff` / `missing_entry` / `bug` | Covers the apparel-wholesale accounting variance modes. `bug` triggers a P1-P8 hotfix; `cutoff` is informational only; others usually self-resolve next cycle. | ☐ |
| D4 | Sign-off ceremony per domain | **N consecutive days under threshold** AND **manual operator sign-off** in the dashboard, recorded in `decom_signoffs` table | Avoids "the system thinks we're ready" autopilot. Operator is CEO, decom is a board-relevant decision. | ☐ |
| D5 | N for D4 | **30 consecutive days** | Aligns with "2-month parallel run" — 30 days under threshold = stable enough; first 30 days are typically variance-spike (catching real bugs). | ☐ |
| D6 | Variance storage | **`parallel_run_variances` append-only** table — one row per (domain, date, scope_key, side) | Append-only mirrors the P5 close audit + P8 CRM activity log pattern. Old variances stay for trend analysis. | ☐ |
| D7 | Investigation workflow | **Reuse M47 Cases** (P7) — every variance > 3× threshold auto-opens a case linked back to the variance row | One inbox for ops, one place to thread comments. Variance-without-case = unattended. | ☐ |
| D8 | Notification rules | **Email digest at 22:00 local** summarizing the day's variances per domain — count + worst delta + new-since-yesterday | Pre-empts the operator opening the dashboard cold. M28 cross-cutter handles delivery. | ☐ |
| D9 | Where the dashboard lives | **New top-nav group `🔁 Parallel Run`** with 5 panels (one per domain) + a Variances queue + a Decom Status overview | Operationally distinct from accounting / reports. Cleanly removable when P23 decom is done. | ☐ |
| D10 | Tangerine-truth flip per domain | **Per-domain feature flag** on `entities.parallel_run_status` jsonb — `{ap: "xoro_truth"|"tangerine_truth", ar: ..., gl: ..., inventory: ..., cash: ...}`. Flip is a one-time admin action with a confirmation modal that lists what changes (which reports source from where). | Modular flip is the whole point of parallel-run — operator can flip AP first without committing to AR / GL yet. | ☐ |

---

## 3. Reconciliation framework

### 3.1 Tables

```sql
-- One row per (domain, scope, date). scope_key is the unit of comparison
-- (a vendor_id for AP, a customer_id for AR, an (account, period_id) for GL,
-- an (item, warehouse) for inventory, a bank_account_id for cash).
CREATE TABLE IF NOT EXISTS parallel_run_variances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  domain              text NOT NULL CHECK (domain IN ('ap','ar','gl','inventory','cash')),
  scope_key           text NOT NULL,                  -- "vendor:RYV001" / "account:1100/period:2026-04" / etc.
  scope_label         text,                           -- display string
  recon_date          date NOT NULL,                  -- the date the reconciliation ran for
  xoro_value_cents    bigint,
  tangerine_value_cents bigint,
  delta_cents         bigint GENERATED ALWAYS AS (
    COALESCE(tangerine_value_cents, 0) - COALESCE(xoro_value_cents, 0)
  ) STORED,
  threshold_cents     bigint NOT NULL,                -- the threshold this row was compared against
  is_over_threshold   boolean GENERATED ALWAYS AS (
    ABS(COALESCE(tangerine_value_cents, 0) - COALESCE(xoro_value_cents, 0)) > threshold_cents
  ) STORED,
  category            text CHECK (category IN ('timing','fx','rounding','cutoff','missing_entry','bug')),
  case_id             uuid REFERENCES cases(id) ON DELETE SET NULL,  -- auto-opened if > 3× threshold
  notes               text,
  resolved_at         timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prv_unique_per_recon UNIQUE (entity_id, domain, scope_key, recon_date)
);

CREATE INDEX IF NOT EXISTS idx_prv_recon_date     ON parallel_run_variances (recon_date DESC, domain);
CREATE INDEX IF NOT EXISTS idx_prv_over_threshold ON parallel_run_variances (recon_date DESC, domain) WHERE is_over_threshold = true;
CREATE INDEX IF NOT EXISTS idx_prv_open           ON parallel_run_variances (resolved_at) WHERE resolved_at IS NULL;
```

```sql
-- Operator-configurable per-domain thresholds + the "30 consecutive
-- days under threshold + signed off" gate state.
CREATE TABLE IF NOT EXISTS parallel_run_thresholds (
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  domain                 text NOT NULL CHECK (domain IN ('ap','ar','gl','inventory','cash')),
  per_row_threshold_cents bigint NOT NULL DEFAULT 1000,    -- $10
  per_domain_threshold_cents bigint NOT NULL DEFAULT 10000, -- $100
  required_consecutive_days int NOT NULL DEFAULT 30,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (entity_id, domain)
);

CREATE TABLE IF NOT EXISTS decom_signoffs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  domain             text NOT NULL CHECK (domain IN ('ap','ar','gl','inventory','cash')),
  signed_off_at      timestamptz NOT NULL DEFAULT now(),
  signed_off_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  consecutive_clean_days int NOT NULL,                -- snapshot at signoff time
  flipped_at         timestamptz,                     -- when entities.parallel_run_status was updated to tangerine_truth
  notes              text,
  CONSTRAINT decom_signoffs_unique_per_domain UNIQUE (entity_id, domain)
);
```

### 3.2 Reconciliation cron — `cron/parallel-run-reconcile`

Runs daily at 21:30 local (after the Xoro nightly fetch lands). For each domain:

1. Pull the Xoro side from the existing ingested tables (`ip_sales_history_wholesale` for AR, `tanda_pos` for PO+AP, `ip_inventory_snapshot` for inventory, etc.).
2. Pull the Tangerine side from the canonical tables (`ar_invoices`, `invoices` AP, `inventory_layers`, `gl_accounts` × `journal_entry_lines`, `bank_accounts`).
3. Compute deltas per scope_key.
4. Insert / upsert into `parallel_run_variances` with today's threshold values.
5. For each row where `ABS(delta) > 3 × threshold`, auto-open a Case (M47 P7-9) with the variance payload + assignee = entity-level default investigator.
6. Emit a `notification_event` for each domain whose total variance crosses the per-domain threshold.

Same write-then-summarize pattern as the existing bank-feed-sync cron.

---

## 4. Per-domain reconciliation specs

### 4.1 AP parity (§4-AP)

**Scope_key:** `vendor:<vendor_code>` for the AP open balance comparison.

| Source | Query |
|---|---|
| Xoro AP open | `SUM(amount_open_cents) FROM tanda_pos WHERE status NOT IN ('Closed','Cancelled') AND vendor_code = X` |
| Tangerine AP open | `SUM(total_amount_cents - paid_amount_cents) FROM invoices WHERE status NOT IN ('paid','void','cancelled') AND vendor_id = (resolve from vendor_code)` |

Also at the entity total: AP control account balance (`gl_accounts.code='2100'`) should match the sum of all open AP invoices.

Edge: vendors that exist in Xoro but not Tangerine vendors_master (or vice versa) emit a special variance row with `category='missing_entry'`.

### 4.2 AR parity (§4-AR)

**Scope_key:** `customer:<customer_code>`.

| Source | Query |
|---|---|
| Xoro AR open | `SUM(open_invoice_cents) FROM Xoro AR aging extract` (from the existing customer-receivables fetch script) |
| Tangerine AR open | `SELECT SUM(total_amount_cents - paid_amount_cents) FROM ar_invoices WHERE status IN ('sent','partial_paid') AND customer_id = X` |

Receipts side: compare daily total AR receipt $ vs Xoro's daily cash-applied. Mismatches usually = missing receipt entry on the Tangerine side.

### 4.3 GL parity (§4-GL)

**Scope_key:** `account:<gl_code>/period:<YYYY-MM>`.

For each posted account × open or recently-closed period:
- Tangerine: `gl_period_balance(account_id, period_id)` (P5 trial balance basis).
- Xoro: derived from Xoro's trial balance export (operator pulls monthly; the fetch script normalizes to the same shape).

GL parity is the toughest because every other domain rolls up here. The dashboard treats GL as the **lagging indicator** — if AP / AR / inventory / cash are all clean but GL has a $delta, the delta is in a domain we haven't built yet (commissions, prepaid, accrued — usually a missing JE).

### 4.4 Inventory parity (§4-Inventory)

**Scope_key:** `item:<sku>/warehouse:<store_id>`.

| Source | Query |
|---|---|
| Xoro on-hand | `ip_inventory_snapshot.qty` for the latest `as_of_date` |
| Tangerine on-hand | `SUM(remaining_qty) FROM inventory_layers WHERE sku = X AND warehouse = Y` (P3-3 FIFO) |

Inventory parity is the messiest because of timing (Xoro snapshot is whenever the script ran; Tangerine is real-time). The reconciliation specifically compares both **as of** the Xoro snapshot timestamp — Tangerine evaluates `SUM(remaining_qty)` minus any layer consumed after the snapshot time.

### 4.5 Cash parity (§4-Cash)

**Scope_key:** `bank_account:<bank_account_id>`.

| Source | Query |
|---|---|
| Xoro cash | bank balance as of Xoro's cash GL extract |
| Tangerine cash | bank_recon_runs latest `reconciled_diff_cents` + bank_statement_balance for each bank_account |

Cash parity should be the **first** clean domain — bank rec engine (P6) is the most directly comparable to Xoro's cash side. If cash isn't clean, nothing else can be.

---

## 5. Variance investigation workflow

Each unresolved variance > threshold appears in the **Variances queue** panel (sortable by date / domain / delta / category). Operator workflow:

1. Open the variance → read the auto-payload (Xoro side, Tangerine side, suspected category based on heuristics).
2. Click **Categorize** → pick one of the 6 categories (D3). If `bug`, the Investigate button auto-opens a Case linked to the variance.
3. Add notes.
4. Click **Resolve** → records `resolved_at` + `resolved_by_user_id` + `resolution_note`. The variance stays in the table for trend analysis but no longer appears in the queue.
5. Auto-resolution: variances where the next day's recon shows the same `(domain, scope_key)` is clean get auto-marked resolved with `resolution_note='auto: clean next cycle'`.

The 6 categories aren't mutually exclusive in real life, but for the workflow we pick the dominant cause.

---

## 6. Decom gates per domain

Each domain has a per-entity gate state:

```
ap:        xoro_truth → consecutive_clean_days >= 30 + manual_signoff → tangerine_truth
ar:        same
gl:        same (typically last since it lags everything)
inventory: same
cash:      same (typically first)
```

The **Decom Status** panel shows for each domain:
- Current state (`xoro_truth` / `tangerine_truth`)
- Consecutive clean days
- Days remaining to gate
- "Sign off" button (enabled when consecutive ≥ N)
- Last 60 days variance trend chart

The sign-off ceremony:
1. Operator clicks **Sign off → AP**.
2. Modal asks for confirmation + lists what changes when the flip happens (which reports source from where, which integrations switch).
3. Confirm → INSERT into `decom_signoffs`, UPDATE `entities.parallel_run_status->>'ap'` to `'tangerine_truth'`. The flip is **reversible** for 30 days (set `flipped_at + interval '30 days'` window where a one-click reversion is still possible).

---

## 7. Runbook docs

One markdown per domain at `docs/tangerine/runbooks/`:

- `decom-ap-runbook.md` — how to flip AP from Xoro to Tangerine + what downstream reports change + what to monitor in the first week
- `decom-ar-runbook.md`
- `decom-gl-runbook.md`
- `decom-inventory-runbook.md`
- `decom-cash-runbook.md`

Each runbook follows the template:
1. **Pre-flip checklist** (parity verified, sign-off in place, communication to accountant)
2. **Flip steps** (admin action in entities settings)
3. **Post-flip verification** (which reports to spot-check first day, first week)
4. **Rollback procedure** (within the 30-day reversibility window)
5. **What this enables** (e.g. after AP flip, Xoro AP entry is stopped; all AP creation goes through Tangerine)

---

## 8. Cross-cutter hooks (M27 / M28 / M29 recap)

- **M27 Approvals**: decom sign-off can require N-of-M approvals (CEO + accountant). Schema supports it; v1 ships CEO-only.
- **M28 Notifications**: daily variance digest email (D8). Per-variance auto-case-open (M47 + M28 fire together).
- **M29 Documents**: variances can have file attachments (Xoro export PDFs, screenshot diffs) via the existing P2-5 documents bucket.

---

## 9. Chunk split (implementation — DO NOT start until operator confirms §2 decisions)

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **P9-1** | Parallel-run schema | 3 tables (parallel_run_variances + parallel_run_thresholds + decom_signoffs) + `entities.parallel_run_status` jsonb extension + RLS. | — |
| **P9-2** | Reconciliation cron + 5 domain matchers | `api/cron/parallel-run-reconcile.js` + 5 pure matcher functions (one per domain) + 50+ tests. | P9-1 |
| **P9-3** | Variances queue panel + categorize/resolve UI | `InternalParallelRunVariances.tsx`. Filters by domain / date / threshold / resolved status. | P9-2 |
| **P9-4** | 5 per-domain parity dashboards | `InternalParallelRunApParity.tsx` + 4 siblings. Each shows scope_key list with daily deltas + drill-into-variance. | P9-3 |
| **P9-5** | Decom Status panel + sign-off ceremony | `InternalParallelRunDecomStatus.tsx` with the 5 domain gates + sign-off modal + reversibility window. | P9-1 (can run parallel to P9-2/3/4) |
| **P9-6** | Daily variance digest cron + notifications + auto-case-open | Adds digest email + auto-opens M47 Case when variance > 3× threshold. Notification rule seeds. | P9-2 |
| **P9-7** | 5 runbook docs (markdown only) | `docs/tangerine/runbooks/decom-{ap,ar,gl,inventory,cash}-runbook.md`. | — (parallel-safe) |
| **P9-8** | User guide chapter 22 + memory close-out | Doc + cross-cutter memory rule. | All above |

Parallel waves:
- **Wave A (after operator confirms §2):** P9-1 + P9-7.
- **Wave B:** P9-2 + P9-5.
- **Wave C:** P9-3 + P9-4 + P9-6.
- **Wave D:** P9-8.

~5-7 days end-to-end with parallel agents.

---

## 10. Risks

- **Xoro data freshness.** Reconciliation runs at 21:30 local; if the Xoro nightly fetch fails at 21:00 (it occasionally does — `daily_check` flags it), reconciliation runs against yesterday's Xoro data, producing fake variances. Mitigation: cron checks `last_successful_xoro_fetch_at` timestamp and skips today's recon if Xoro is stale, emitting a `parallel_run_skipped` notification instead.
- **Timezone confusion.** Xoro is on-prem operator's local TZ; Supabase is UTC. Recon dates are operator-local "the close of business of date X." Mitigation: explicit TZ handling in the matchers — Xoro timestamps land as `posted_at_local`, compared against Tangerine UTC normalized to local.
- **Scope_key drift.** Vendor codes in Xoro vs Tangerine `vendor_master.code` can have whitespace / case variations. Mitigation: matcher canonicalizes both sides (`UPPER(TRIM(code))`) before comparison; variances on lookup failures auto-categorize `missing_entry`.
- **First-week variance noise.** The first 7 days of parallel-run will show enormous variances as the operator catches edge cases that never came up in P1-P8 testing. That's the point. Operator should expect ~50-100 variances/day in week 1, dropping to ~5/day by week 4.
- **Decom sign-off political pressure.** "We've been at parity for 28 days, can we flip early?" — the 30-day floor is policy. The arch doc's job is to make it cheap to NOT short-circuit.
- **Reversibility window edge cases.** If the operator flips AP → tangerine_truth, then within 30 days an AP issue surfaces and they want to revert, the 30 days of AP entry that happened in Tangerine post-flip needs to be back-fed to Xoro. Runbook §4 (rollback) addresses this — operator runs an export script.

---

## 11. Tests

- Matchers (one per domain) — pure functions with mocked input pairs. ~100 unit tests total.
- Reconciliation cron — mock Xoro fetch state + Tangerine state; verify variance row shape + auto-case-open trigger.
- Decom sign-off RPC — only fires when consecutive_clean_days >= required; rejects if any unresolved variance exists.
- Reversibility — flip + revert produces clean audit trail in `decom_signoffs` + `entities.parallel_run_status` history.
- TZ handling — same date in NYC vs UTC vs operator local doesn't double-count or skip.

---

## 12. Operator confirm before chunks ship

Please mark §2 D1–D10 with answers. Once confirmed I'll kick off P9-1 + P9-7 in parallel.

**No env vars needed.** Xoro fetch already runs; Resend + Supabase Storage already configured.

**Suggested operator inputs to think about ahead of confirm:**

- D5 (30 consecutive days): tighter = decom faster but riskier. Looser = more confidence but P23 slips. 30 is the recommendation; you can call 21 or 45.
- D2 (thresholds): $10 per row + $100 per domain is conservative. For your scale you can probably tolerate $50 per row + $500 per domain without losing meaningful signal — apparel-wholesale margin / customer / vendor sizes.
- D7 (auto-case-open at 3× threshold): if you find Cases panel gets noisy, raise to 5× or move to "manual-only case open." Easy tuning.

**Estimated lift:** 5-7 days end-to-end. P9 is process-heavy — most chunks are small schema + UI; the real work is the operator running parallel-run for 60 days and documenting variance causes. Code is the easy part.

**P23 (Xoro decom) reachability — revised 2026-05-28 afternoon:** P22 ETA is ~18-24 months out (M11 → M14 + all the dependencies). P9 starts after P22. P9 itself is 60-90 days of validation. Realistic P23 ETA from today: **~24-30 months**. The original "90-120 days after P9 ships" line assumed P9 could start now; it can't, because partial decom isn't viable when AR/AP/COGS materialize from EDI events Tangerine can't yet originate.
