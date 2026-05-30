# 25. Parallel-Run Reconciliation (P9 — Tangerine ⇄ Xoro per domain)

> **P9 status (2026-05-29):** all 9 chunks shipped. PRs #520 (schema), #529 (AP), #528 (AR), #534 (Cash), #533 (GL), #536 (Inventory), #543 + #546 (dashboard + tests), #550 (cron + notifications + preflight), #553 (cutover automation). P9 is the discipline phase that compares Tangerine's books against Xoro's nightly fetch domain-by-domain and graduates each domain to **solo** mode (Tangerine as sole source of truth) after a 60-day clean window.

T10 Shadow Mirror produces Tangerine's mirrored sub-ledgers; P9 reconciles those mirrored numbers — plus the direct-integration sources (`shopify`, `fba`, `walmart`, `faire`, `plaid_sync`, `manual`) — against Xoro every Monday, surfaces variances per domain, and gates period close on cleared variances.

---

## 25.1 What it is

**Parallel-run reconciliation** is a weekly cron + 5-engine comparison layer + operator dashboard that asks, per domain, "is Tangerine's number equal to Xoro's number on the same business date, scoped to the same unit of comparison, and if not, by how much, why, and who owns the variance?"

Five reconciliation domains, each with its own engine, thresholds, and cutover gate:

| Domain | Tangerine side | Xoro side | Per-row threshold | Per-domain threshold |
|---|---|---|---|---|
| **AP** | `invoices` (vendor bills) | `tanda_pos` (open POs) | $1 | $100 |
| **AR** | `ar_invoices` × `source` (shopify / fba / walmart / faire / xoro_mirror / manual) | `ip_sales_history_wholesale_open` | $1 | $100 |
| **Cash** | `bank_transactions` (Plaid) + cash GL balance | Xoro bank GL extract | **$0.50** (tightest) | $3 |
| **GL** | `journal_entry_lines × period` trial balance | Xoro trial-balance extract per account × period | $5 | $25 |
| **Inventory** | `inventory_layers` per `(item, location)` | `ip_inventory_snapshot` × Xoro warehouse_id | $50 | $250 |

These thresholds are **operator-locked** (D2). They reflect each domain's measurement noise floor — cash is tightest because Plaid is exact, inventory loosest because qty × cost rounding adds up.

---

## 25.2 What it does NOT do

- **Does NOT write back to Xoro.** P9 is read-only against both sides. Variances are surfaced, not auto-corrected.
- **Does NOT auto-fire on every recon discrepancy.** Auto-replay only triggers on detected retroactive Xoro edits (D11). A normal variance stays open until the operator clears it or it ages out.
- **Does NOT auto-create cases for every variance.** Only variances > 3× per-row threshold (D10) auto-open an M47 case; smaller ones live in the variance queue until the operator triages.
- **Does NOT fire on weekends.** Cron runs Monday 06:00 UTC over the prior Mon-Sun week. Daily granularity is supported via the manual re-run path but not auto-scheduled.

---

## 25.3 How to read the Reconciliation Dashboard

A new top-nav group **🔁 Parallel Run** hosts `InternalReconciliationDashboard`. The panel is operationally action-first: status → grid → variance side panel → cutover history.

### Five status cards (top row)

One per domain (AP / AR / Cash / GL / Inventory). Each card shows:

- Last recon run timestamp · cadence · status badge (✅ clean / ⚠️ variance / ❌ error / ⏳ running)
- Last variance total (signed dollars)
- "Run now" button — currently wired for **Inventory** (`/api/internal/recon/run-inventory`). Other domains route through the weekly cron or the "Re-run all" button.

### Date range presets + status grid

A `<DateRangePresets />` (T7) at the top defaults to the last 30 days. The grid below has one row per domain and one column per recon date in range. Cells are color-coded:

- 🟢 **clean** — engine ran, all scope keys within per-row threshold
- 🔴 **variance** — at least one scope key over per-row threshold OR domain total over per-domain threshold
- 🟡 **error** — engine exception (read the side panel for the stack)
- 🔵 **running** — currently executing
- ⚪ **pending** — scheduled but not yet run

Click any cell → opens the variance side panel for that run.

### Variance side panel

For the clicked run, lists every row in `recon_variances` with:

- `source_table` (where Tangerine read from)
- `scope_key` (e.g. `vendor:RYV001` / `customer:RETAILX` / `account:4000/period:2026-05` / `sku:BLK-S/loc:FBA-NA` / `bank_account:<uuid>`)
- `source_tag` badge per T10-7 (`shopify` / `fba` / `walmart` / `faire` / `xoro_mirror` / `manual` / `plaid_sync` / `xoro_truth`)
- Tangerine cents · Xoro cents · variance cents · status badge
- **Clear…** button per row — opens the audit-reason modal (reason REQUIRED per P9-1 schema NOT NULL constraint)
- `<ExportButton />` (T8 xlsx-only) at the top of the panel

### Clear flow

Clicking **Clear…** on a variance row:

1. Opens a modal that asks for **a reason** (free text, REQUIRED — the `recon_cleared_log.reason` column is NOT NULL).
2. Operator types the reason → confirms.
3. Handler writes `recon_cleared_log` with `cleared_kind='manual_clear'` + flips the `recon_variances.status` to `'cleared'`.
4. Side panel refreshes inline — the row is greyed out and moved to the bottom.

Cleared variances are **never deleted**. The audit trail is permanent.

### Cutover history table (bottom)

Read-only list of `recon_cutover_signoffs` across all domains. Shows current parallel/solo state per domain, consecutive clean days, the operator who signed off, the flip timestamp, and the revert timestamp if the 30-day reversibility window was used.

---

## 25.4 Weekly cron + notifications

**Schedule:** Monday 06:00 UTC. The orchestrator at `api/cron/recon-weekly.js` runs the 5 engines in a fixed sequence:

```
AP → AR → Cash → Inventory → GL
```

**GL is last on purpose** — its lagging-indicator logic (P9-5) reads the sibling recon_runs for the same period from the previous engines so it can categorize variances as `category='missing_standalone_je'` when AP/AR/cash/inventory are all clean but GL is off (the missing amount is in a domain Tangerine doesn't yet originate — commissions accrual, prepaid expenses, depreciation, etc).

**Per-engine error isolation:** one failing engine doesn't abort the others. Each engine is wrapped in try/catch; an exception becomes `status='error'` for that domain and the orchestrator moves on.

**After each engine the orchestrator:**

a) Updates `entities.parallel_run_status` jsonb with per-domain `{status, last_recon, last_status}` so the dashboard top-bar can render last-recon timestamps without re-querying `recon_runs`.

b) If `result.status` is `'variance'` or `'error'`, fires a variance notification via `notifyReconVariance` (M28 fan-out to `admin` + `accountant` roles).

### Notification rules (D10)

| Kind | When it fires | Recipients |
|---|---|---|
| `recon_variance_detected` | Any engine's recon_run lands `status='variance'` (weekly cadence) | admin + accountant |
| `recon_replay_variance_detected` | An auto-fired or manual replay recon_run lands `status='variance'` (cadence='replay') | admin + accountant |
| (close blocker — soft) | `gl_period_close_preflight` `unresolved_recon_variances` returns `status='fail'` `blocking=false` (pre-cutover, parallel mode) | (no email — surfaces in close UI) |
| (close blocker — hard) | Same check returns `status='fail'` `blocking=true` (post-cutover, solo domain has open variance) | (no email — surfaces in close UI as 409) |

**Idempotency:** notification events key on `(recon_run_id, kind)`. Re-running the cron for the same Monday would emit a second event — that's correct behavior for re-runs (a replay should fire its own notification).

---

## 25.5 D11 Replay — re-running historical recons

Xoro retroactive edits poison historical recons: if Xoro back-edits an invoice from 5 days ago, today's recon is clean but the 5-day-ago `recon_runs` row is now wrong. The **D11 replay** path handles this.

### Auto-replay (the only auto-trigger)

The T10 mirror jobs check each record's `data->>'_updated_at'` against the previously-mirrored value. If the timestamp moves **backwards** — the unambiguous signal that the underlying Xoro state was retroactively edited — the mirror fires `recon_replay(domain, last_known_clean_period_start, today)` to surface the variance the retro-edit created.

**90-day cap.** Auto-replay only looks back 90 days by default. Operators who need to replay further override via `?since=YYYY-MM-DD` on the manual replay endpoint.

**Why backwards-timestamp ONLY?** A variance can be a real Xoro misposting that the operator should investigate; an auto-replay on every recon discrepancy would mask that. Backwards-timestamp is the unambiguous signal that the underlying state was retroactively edited — anything else is a real variance and stays open.

### Manual replay

Operator triggers from the variance detail row (per-scope replay) or from the dashboard (full-domain replay). UPSERTs the `recon_runs` row for `(domain, recon_date)`, overwriting prior totals. Emits `recon_replayed` notification with the diff vs the previous values.

### Replay history

Every replay writes to `recon_runs` with `cadence='replay'`. The variance side panel shows the latest run per `(domain, period_start, period_end)` tuple — older variance/replay runs for the same window are superseded but not deleted.

---

## 25.6 D8 Cutover — graduating a domain to solo mode

Each domain runs in **parallel mode** (Tangerine + Xoro both kept in sync, Xoro is system-of-record) until the cutover sign-off flips it to **solo mode** (Tangerine becomes sole truth, T10 mirror stops for that domain).

### Pre-flip checklist (eligibility — automated)

Sign Off button is disabled until ALL of these pass:

- **60 consecutive days** with `recon_runs.variances_over = 0` for this domain
- All `recon_runs.domain_threshold_breached = false` for this domain in that window
- **Zero open M47 cases** tagged `recon_bug` for this domain
- (Optional) Accountant sign-off via M27 approval if operator opted in

The eligibility check lives at `api/_lib/recon/cutover-eligibility.js`.

### Sign-off flow

`InternalReconciliationDecomStatus` panel → Sign Off button → modal lists what changes when the flip happens:

1. **T10 mirror skip:** the nightly Shadow Mirror cron stops mirroring that domain on its next run. The cron reads `entities.parallel_run_status->>'<domain>'` and short-circuits the AR / AP / Inventory mirror branch if it equals `'tangerine_solo'`.
2. **Close pre-flight hard-block:** the `unresolved_recon_variances` check flips from soft-block (advisory) to **hard-block** for THIS domain. Open variances on a solo domain mean Tangerine — now authoritative — has a real bug. The operator cannot close the period until the variance is resolved.
3. **Xoro fetch scripts** for the cutover domain can be turned off (operator decision, not automatic). The mirror skip handles the data side; turning off the fetch saves Xoro API quota.

Operator confirms → handler INSERTs `recon_cutover_signoffs` + UPDATEs `entities.parallel_run_status` jsonb to `{"<domain>": {"status": "solo"}}`.

### 30-day reversibility window

If the operator catches a bug post-flip, the **Revert** button restores the prior state for 30 days from the signoff timestamp. After 30 days, reverting requires re-enabling T10 manually and accepting that 30 days of Tangerine-direct activity won't be back-fed to Xoro (it stays Tangerine-only).

### Expected cutover sequence

1. **Cash first** — P6 Plaid is mature, simplest match, $0.50 per-row threshold is achievable.
2. **AR for Shopify channel** — P11 direct integration, source-tag-aware recon shows this clean first.
3. **AR for FBA + Walmart + Faire** — P12 channels, after their parallel runs settle.
4. **AR Xoro residue** — EDI-only wholesale customers; requires P22 EDI to ship, otherwise stays mirror-active.
5. **AP** — depends on P21 3PL receiving + P13 PO origination maturity.
6. **Inventory** — depends on P21 receiving + P12 FBA/WFS mirrors stabilizing.
7. **GL last** — lagging indicator; trails the rest by definition.

---

## 25.7 Troubleshooting

### "I cleared a variance but it shows up again next Monday"

The clear flow flips `recon_variances.status` to `'cleared'` for THAT variance row. Next Monday's run creates a NEW `recon_run` + new `recon_variances` rows. If the underlying Tangerine vs Xoro number is still off, you'll see a new variance for the same scope.

**Fix the root cause** — clearing is for one-time anomalies (FX rounding on a single invoice, known operator typo). For recurring drift, open an M47 case from the variance detail modal so engineering can investigate.

### "Replay history — how do I see what changed?"

Filter the recon_runs table by `cadence='replay'`. Each replay run shows the totals at replay time; compare against the prior `cadence='weekly'` run for the same `(domain, period_start, period_end)` to see the delta.

The auto-fire path also emits a `recon_replayed` notification with the diff inline.

### `missing_standalone_je` — what does this category mean?

GL is the **lagging indicator**. If AP / AR / Cash / Inventory are all `clean` for the same recon date but GL has an `over` variance, the missing amount lives in a domain Tangerine doesn't yet originate — typically:

- **Commissions accrual** (M17 — manual monthly post on mirrored AR by design; see chapter 22 §22.6)
- **Prepaid expenses** (no Tangerine module yet)
- **Depreciation** (no Tangerine module yet)
- **Other manually-posted standalone JEs** that Xoro has but Tangerine never received

The variance auto-categorizes as `category='missing_standalone_je'` and includes a hint pointing to which GL account is off. Operator posts the missing standalone JE in Tangerine; next Monday's recon should clear.

### "Period close is blocked — `unresolved_recon_variances` says blocking=true"

This means a **solo-mode domain** has an open variance. Pre-cutover the same check is `blocking=false` (advisory). Post-cutover it's a hard-block because Tangerine is now authoritative — an open variance means a real bug.

**Triage:**

1. Open `InternalReconciliationDashboard` → click the failing domain's most recent variance run → side panel.
2. For each row in the side panel: investigate (open as M47 case), resolve the underlying data, OR clear with reason if it's a known one-time anomaly.
3. Once all variances on the solo domain are `cleared` or have a subsequent clean recon run, re-run the close pre-flight.

### "Auto-replay fired but I don't see a retro edit in Xoro's audit log"

Backwards-timestamp detection compares the T10-mirrored `data->>'_updated_at'` against the previously-stored value. If the operator (or a Xoro admin) edited the Xoro row through a path that didn't update the audit log but DID update `updated_at`, the mirror will still catch it.

If you genuinely don't believe there was a retro edit, the auto-replay's `cadence='replay'` recon_run will show the variance (or lack of one) — clean replay = false alarm, variance = real change.

### "Cash recon shows a $0.50 variance every Monday"

That's within the per-row threshold for Cash ($0.50). Variances at or below threshold auto-mark `status='within'` and don't fire notifications — they exist in `recon_variances` for trend analysis only.

If you're seeing > $0.50 consistently, the Plaid sync or a manual cash JE is drifting. Open the variance detail → drill into the bank account scope → compare Tangerine's `bank_transactions.amount_cents` against Xoro's cash GL extract for the same date.

---

## 25.8 Code map

| Layer | File / chunk |
|---|---|
| Architecture | `docs/tangerine/P9-parallel-run-architecture.md` |
| P9-1 — Schema (4 tables + entities ALTER) | `supabase/migrations/20260629800000_p9_chunk1_recon_schema.sql` (#520) |
| P9-2 — AP recon engine | `api/_lib/recon/ap-engine.js` (#529) |
| P9-3 — AR recon engine (source-tag-aware) | `api/_lib/recon/ar-engine.js` (#528) |
| P9-4 — Cash recon engine | `api/_lib/recon/cash-engine.js` (#534) |
| P9-5 — GL recon engine + `missing_standalone_je` categorization | `api/_lib/recon/gl-engine.js` (#533) |
| P9-6 — Inventory recon engine (location-aware) | `api/_lib/recon/inventory-engine.js` (#536) |
| P9-7 — Dashboard UI + 4 read handlers + clear flow | `src/tanda/InternalReconciliationDashboard.tsx`, `api/_handlers/internal/recon/{runs,variances,cutovers,clear}.js` (#543) + tests (#546) |
| P9-8 — Weekly cron + variance notifications + close preflight extension | `api/cron/recon-weekly.js`, `api/_lib/recon/notifications.js`, `api/_handlers/internal/gl-periods/preflight.js` (#550) |
| P9-9 — Cutover automation (eligibility + signoff + T10 skip + preflight hard-block) | `api/_lib/recon/cutover-eligibility.js`, `api/_handlers/internal/recon/cutover-signoff.js` (#553) |
| P9-99 — User guide ch25 + memory rules | this chapter + memory updates |

---

## 25.9 What's NOT in v1

- **Daily cadence.** v1 ships weekly. Daily granularity is supported via the manual re-run path but not auto-scheduled. If the operator wants daily, change the cron schedule + reseed `entities.parallel_run_status[domain].cadence`.
- **Per-source dashboard pivot.** The AR engine emits one row per `(customer, source)` pair, but the dashboard grid shows aggregated per-domain status. The variance side panel shows the source-tag breakdown via badges.
- **Auto-categorization beyond `missing_standalone_je`.** GL's lagging-indicator categorization is the only auto-category in v1. Other "this looks like a class of variance" auto-tagging is deferred.
- **Cutover for individual sources within a domain.** AR cutover today is all-or-nothing per domain. "Cutover Shopify AR but not FBA AR" needs a per-source signoff flow — planned for P9 v2 if Shopify clears 60 days before the other channels.

---

## 25.10 Cross-cutter wiring shipped with P9-7 + P9-8 + P9-9

- **M28 Notifications**: 2 new notification rules seeded (idempotently — `ON CONFLICT DO NOTHING`):
  - `recon_variance_detected` — fires on any engine returning `status='variance'` (weekly cadence)
  - `recon_replay_variance_detected` — fires on replay-cadence runs returning `status='variance'`
- **No new approval rules** — cutover signoff is not gated by M27 (the 60-day clean window IS the gate). Operator can opt-in to an accountant sign-off rule manually.
- **T6 / T7 / T8 / T9 / T10-7 cross-cutters honored** on the dashboard panel: global search, date range presets, xlsx ExportButton, SearchableSelect for scope_key picker, SourceBadge on every variance row.
- **Close pre-flight extension** in `api/_handlers/internal/gl-periods/preflight.js`:
  - Pre-cutover (parallel mode): `unresolved_recon_variances` returns `status='fail' blocking=false` — surfaces in UI but doesn't block close.
  - Post-cutover (solo mode + variance on cutover domain): `status='fail' blocking=true` — close handler rejects with 409.

---

Pairs with: chapter 13 (AP — feeds the AP recon engine), chapter 16 (AR), chapter 17 (Bank Recon — feeds Cash engine), chapter 22 (Shadow Mirror — the data foundation). Strategic context: `docs/tangerine/XORO-DECOM-MAP.md` (per-domain cutover roadmap).
