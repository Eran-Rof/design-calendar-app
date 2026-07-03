# 22. Shadow Mirror (Cross-cutter T10 — Xoro ⇄ Tangerine)

> **T10 status (2026-05-28):** all 8 chunks shipped. Shadow Mirror is the bridge that makes the P1-P8 modules usable today without waiting on the EDI / 3PL / Shopify pipeline (P11/P12/P22). Tangerine runs as a **shadow ledger** on top of the existing nightly Xoro fetch — operator's day-to-day Xoro work doesn't change.

T10 closes the "where do real numbers come from before integrations land?" gap. Reports / CRM / Cases all populate from real mirrored data on day one; operator never dual-enters anything.

---

## 22.1 What it is

Shadow Mirror is a nightly cron that reads the existing Xoro fetch (already landing in Supabase at 21:00 local) and mirrors AR invoices, AP bills, and inventory layers into Tangerine's sub-ledgers — then posts a daily summary journal entry per domain so trial balance / income statement / balance sheet reflect real numbers. Xoro stays the system-of-record; Tangerine reads, never writes back. Everything mirrored is tagged `source='xoro_mirror'` so operator-typed `source='manual'` rows are never touched.

---

## 22.2 What it does NOT do

- **Does NOT write back to Xoro.** Xoro is read-only into Tangerine. There is no reverse flow in v1.
- **Does NOT auto-create from Shopify / FBA / Walmart / EDI.** Those channels land in P11 (Shopify), P12 (FBA / Walmart / Faire settlement), and P22 (EDI 3PL). T10 mirrors only what the existing Xoro fetch produces.
- **Does NOT auto-accrue commissions on mirrored AR.** Deferred to a monthly operator action so that 24+ months of historical Xoro AR don't cascade into the M17 commission_accruals table at first run. Operator posts a monthly summary commission accrual manually.
- **Does NOT detect retroactive Xoro edits.** If Xoro changes a 90-day-old invoice, the mirror does not currently reconcile that backwards. Planned for T10 v2 if it bites.
- **Does NOT emit per-invoice JEs.** Daily summary only (one JE per domain per day).

---

## 22.3 The `source` tagging principle

Every sub-ledger row that can have multiple producers carries a `source` field. Producers and their meaning:

| `source` value | Producer |
|---|---|
| `manual` | Operator typed it in the UI |
| `xoro_mirror` | T10 cron created it from the Xoro feed |
| `shopify` | P11 future — Shopify webhook |
| `fba` | P12 future — Amazon FBA settlement |
| `walmart` | P12 future — Walmart settlement |
| `faire` | P12 future — Faire settlement |
| `edi_3pl` | P22 future — EDI inbound (856 / 945 / 810) |
| `plaid_sync` | P6 — Plaid bank txn sync |
| `api` | External API call to Tangerine |
| `system` | Internal trigger / RPC |

**Three rules the mirror obeys without exception:**

1. The cron only touches rows where `source = 'xoro_mirror'`. `source = 'manual'` rows are off-limits — never overwritten, never deleted, never re-keyed.
2. Every list view in Tangerine renders `source` as a small colored badge so operator sees at a glance how each row got there.
3. Operator can filter any list view by source (e.g. "show me my manually-typed AR invoices only" or "show me only what got auto-mirrored last night").

**Conflict resolution:** if Xoro and operator both touch the same logical entity (same invoice number, same vendor, same date), the `manual` row wins. Mirror logs the collision to the unmatched inbox; operator can force a re-mirror with an explicit "overwrite manual" confirm from the Status panel.

---

## 22.4 Daily flow

```mermaid
flowchart TD
    XoroCron["⏰ 21:00 local<br/>Xoro nightly fetch lands in Supabase<br/>(ip_sales_history_wholesale,<br/>tanda_pos, ip_inventory_snapshot,<br/>item_costing)"]
    T10Cron["⏰ 21:30 local<br/>T10-6 cron fires"]
    Guard{"Stale-Xoro<br/>guard:<br/>synced_at > 25h?"}
    Skip["⏭️ Skip + notify CEO<br/>(xoro_mirror_runs.status=skipped_stale_xoro)"]
    AR["📥 AR mirror (T10-2)<br/>UPSERT ar_invoices + ar_invoice_lines<br/>source='xoro_mirror'"]
    AP["📤 AP mirror (T10-3)<br/>UPSERT invoices (AP)<br/>source='xoro_mirror'"]
    Inv["📦 Inventory rebuild (T10-4)<br/>DROP xoro_mirror_snapshot layers<br/>+ rebuild from snapshot"]
    JE["🧾 Summary JE poster (T10-5)<br/>3 daily JEs:<br/>AR (DR 1200 / CR 4000)<br/>AP (DR 5xxx/6xxx / CR 2100)<br/>Inventory delta (DR 5000 / CR 1300)"]
    Notify["📧 Notification emit (T10-6)<br/>Operator gets nightly heartbeat<br/>email at 22:00 local"]

    XoroCron --> T10Cron --> Guard
    Guard -->|"yes"| Skip
    Guard -->|"no"| AR
    AR --> AP --> Inv --> JE --> Notify
```

**Stale-Xoro guard:** if the most recent `ip_sales_history_wholesale.synced_at` is more than 25h old, the mirror skips that night's run, logs `status='skipped_stale_xoro'` on `xoro_mirror_runs`, and pages the CEO via the existing M28 notification queue. Better to skip a night than to mirror stale data and post bogus JEs.

---

## 22.5 Status panel walkthrough — `🔁 Shadow Mirror`

A new top-nav group in Tangerine hosts the panel.

### Four status cards (top row)

| Card | Shows |
|---|---|
| **Last AR mirror** | timestamp · row count · status badge (✅ complete / ⏭️ skipped / ❌ failed) |
| **Last AP mirror** | same |
| **Last Inventory rebuild** | timestamp · layer count delta · status badge |
| **Last Summary JE** | timestamp · 3 JE references (AR / AP / Inv) · status badge |

### 30-day history grid

One row per (run_date × domain) sourced from `xoro_mirror_runs`. Color-coded:

- 🟢 **complete** — mirror ran, all rows applied, summary JE posted
- 🟡 **skipped** — stale-Xoro guard fired (operator action: investigate Xoro fetch)
- 🔴 **failed** — exception during mirror (operator action: read the error column + manual re-run)
- ⚪ **no-run** — cron didn't fire (rare; suggests Vercel cron config drift)

Click any row → drawer with full row-level detail (inputs, outputs, error stack if any, link to the posted JEs).

### Manual re-run button

Top-right of the panel. Operator picks a date + domains (AR / AP / Inv / Summary JE — multi-select) → confirms → cron worker runs out-of-band. Idempotent: re-running for a date that already has mirrored rows just upserts in place.

**Single date or a whole range.** The re-run modal has a **Single date / Date range** toggle:

- **Single date** — re-mirrors one business date (as above).
- **Date range** — pick **From** and **To** and it mirrors **every date in the range in one shot** (`POST /api/internal/xoro-mirror/backfill-range`). Each date runs the full pipeline (AR + AP + inventory mirror, then that date's summary JEs), and every entry posts with **its own date, into its own period** — so a backfill reconciles day-by-day, not lumped into today. The stale-fetch guard is bypassed (a backfill intentionally works off already-loaded data), and one aggregate result is returned (days processed, AR/AP/inv row counts, JE count, any errors).

  Re-running a range is safe: already-posted summary JEs are skipped and mirror rows upsert in place. **Any length works** — each server call is capped at **45 days** (to stay under the function time limit), and the panel **auto-splits a longer range into consecutive chunks** and runs them one after another, showing live progress (`chunk 2/8…`). You pick the span; it handles the chunking. Keep the panel open until it finishes.

### Unmatched inboxes

Two side panels:

- **Unmatched customers** — Xoro customer-keys the mirror couldn't resolve to a Tangerine `customers` row. Operator clicks a row → "Create customer" or "Map to existing customer" → mirror re-runs for that row.
- **Unmatched vendors** — same idea against `vendors`.

These inboxes are the operator's main day-to-day touchpoint with the mirror. As Tangerine masters catch up to the Xoro feed, the inboxes drain.

---

## 22.6 Reports impact

Once the mirror has run successfully, every report that reads from the affected sub-ledgers populates with **real** numbers:

| Report | Reads from | Populates because |
|---|---|---|
| Trial Balance | journal_entry_lines | Summary JEs post nightly |
| Income Statement | journal_entry_lines | Summary JEs post nightly |
| Balance Sheet | journal_entry_lines | Summary JEs post nightly |
| AR Aging | ar_invoices + ar_receipts | Mirror writes ar_invoices |
| AP Aging | invoices (AP) | Mirror writes AP invoices |
| Sales by Customer | ar_invoice_lines | Mirror writes line splits |
| Sales by Rep | ar_invoice_lines × commission_accruals | Lines populate; accruals stay zero until manual monthly post (intentional) |
| GL Detail | journal_entry_lines | Summary JEs post nightly; drill shows the daily roll-up rather than per-invoice |

**Why commission accrual on mirrored AR is intentionally NOT auto-fired:** the M17 commissions_accrue_for_invoice trigger would fire once per mirrored row, which on initial mirror means 24+ months of historical accruals appearing in one nightly burst. Operator instead posts a single monthly summary commission accrual JE manually (see chapter 19 §19.2 for the manual workflow). If the operator wants per-invoice accruals going forward, the rule can be flipped via a single config toggle on `entities.shadow_mirror_commission_mode`.

---

## 22.7 Manual override workflow

The mirror is designed so the operator can always reach in and override.

| Operator action | Where | What happens |
|---|---|---|
| **Re-run mirror for any date** | Status panel → "Manual re-run" | Operator picks date + domains; cron runs out-of-band; idempotent |
| **Filter any list view by `source`** | Source-filter dropdown on every list page | E.g. "Manual only" / "xoro_mirror only" / "All" — applies a `WHERE source = ?` to the underlying query |
| **Type manual AR / AP entries** | AR Invoices / AP Invoices panels (existing P3 / P4 panels) | New row written with `source='manual'`; mirror never touches it again, ever |
| **Map an unmatched Xoro customer/vendor** | Unmatched inbox | Operator clicks a row → "Create" or "Map" → mirror re-runs the affected period |
| **Force overwrite a manual row from Xoro** | Status panel → row detail drawer → "Overwrite manual with Xoro" button | Explicit confirm; flips `source` to `xoro_mirror`; future mirror runs are then free to update it |

The manual entries always live alongside mirrored entries forever. There's no merge / squash / unify step — both producers stay distinguishable for audit.

---

## 22.8 What to expect in week 1

- **First run will mirror the most recent Xoro feed** (the snapshot landed at 21:00 the night the cron is turned on). Backfill of earlier history is a separate explicit operator action — open the Status panel → "Backfill" → pick a start date.
- **Unmatched-customer / unmatched-vendor backlog will be substantial.** Every Xoro customer that doesn't yet exist in Tangerine's `customers` table lands in the unmatched inbox. Plan to spend the first week walking through it. Most can be resolved with the "Map to existing" action; a few will need new Tangerine customer rows.
- **Summary JEs start populating Trial Balance immediately.** Even before unmatched inboxes are drained, the JEs post against the catch-all "Uncategorized" customer / vendor for unmatched rows. As operator drains the inbox, future runs re-attribute correctly.
- **CRM / Cases pick up real customers immediately.** Anything in the Tangerine `customers` table that the mirror has touched gets back-populated with last-invoice / last-payment dates. Cases can be opened against real customers from day one.
- **Expect at least one stale-Xoro skip in the first week.** If the Xoro fetch fails or runs late, the guard catches it; the heartbeat email tells operator what happened. No corruption risk.

---

## 22.9 Code map

| Layer | File / chunk |
|---|---|
| Architecture | `docs/tangerine/T10-shadow-mirror-architecture.md` |
| T10-1 — Source-tagging columns + `xoro_mirror_runs` table | `supabase/migrations/20260620000000_t10_chunk1_source_tagging.sql` (PR #447) |
| T10-2 — AR mirror function + handler | `api/_lib/shadow-mirror/ar.js`, `api/_handlers/internal/shadow-mirror/run-ar.js` (PR #449) |
| T10-3 — AP mirror function + handler | `api/_lib/shadow-mirror/ap.js`, `api/_handlers/internal/shadow-mirror/run-ap.js` (PR #451) |
| T10-4 — Inventory rebuild | `api/_lib/shadow-mirror/inventory.js`, `api/_handlers/internal/shadow-mirror/run-inventory.js` (PR #452) |
| T10-5 — Daily summary JE poster | `api/_lib/shadow-mirror/summary-je.js`, `api/_handlers/internal/shadow-mirror/post-summary-je.js` (PR #453) |
| T10-6 — Orchestrator cron + stale-Xoro guard + notifications | `api/cron/shadow-mirror-nightly.js` (PR #454) |
| T10-7 — Status panel + unmatched inboxes UI | `src/tanda/InternalShadowMirrorStatus.tsx`, `InternalUnmatchedCustomers.tsx`, `InternalUnmatchedVendors.tsx` (PR pending) |
| T10-8 — User guide ch22 + memory rules | this chapter + memory updates (PR pending) |

---

## 22.10 What's NOT in v1

- **Commission accrual on mirrored AR** — intentionally manual; flip the entity toggle to opt in.
- **AR receipts mirror** — v1 mirrors invoices only. Receipts (cash applications) need to be entered manually OR via the M16 card-capture flow once a processor is selected (see chapter 19 §19.1). Planned for T10 v2.
- **Retroactive Xoro edit detection** — if Xoro changes a 90-day-old invoice, the mirror does not reconcile. Manual re-run for that date is the workaround.
- **Per-invoice JE granularity** — v1 posts daily summary JEs only. v2 may add a per-invoice toggle for entities that need it for audit.
- **Mirror correctness verification against Xoro** — that's what P9 (Parallel-Run) is for. T10 produces the mirror; P9 reconciles it.

---

## 22.11 Cross-cutter wiring shipped with T10-6 + T10-8

- **M28 Notifications**: 3 new notification rules seeded (idempotently — `ON CONFLICT DO NOTHING`):
  - `shadow_mirror_run_complete` — fires nightly when all 4 domains complete; payload includes row counts per domain
  - `shadow_mirror_skipped_stale_xoro` — fires when the stale-Xoro guard trips; pages CEO
  - `shadow_mirror_failed` — fires on any exception during the run
- **No new approval rules** — the mirror is not gated by M27; manual overrides ARE auditable via the `xoro_mirror_runs` table.

---

Pairs with: chapter 13 (AP), chapter 16 (AR), chapter 17 (Bank Recon), chapter 19 (Revenue Ops). Strategic context: `docs/tangerine/XORO-DECOM-MAP.md`.
