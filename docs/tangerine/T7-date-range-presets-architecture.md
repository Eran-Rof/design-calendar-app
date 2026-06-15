# Cross-cutter T7 — Date-range presets

Status: **DONE** (2026-05-28).

- T7-1 (PR #466, merged): component + pure helpers + unit tests.
- T7-2 (PR #467, merged): swept 13 panels — `<DateRangePresets>` is now next to every Tangerine from/to date input.
- T7-3 (this close-out): Trial Balance refetch fix, audit pass, arch-doc adoption section.

Operator ask: "anywhere we have date ranges to be able to one click YTD, MTD, TY, LY, This Y to last month, etc."

This is a small UI cross-cutter — a drop-in `<DateRangePresets>` component that sits next to any `From / To` date-input pair and offers one-click preset ranges.

---

## 0. Scope

**In scope:**
- One component: `src/tanda/components/DateRangePresets.tsx` (Tangerine-first; reusable across apps).
- Preset set (operator-confirmable, but recommended defaults below).
- Sweep across every existing panel with a date range: Trial Balance, Income Statement, Balance Sheet, Cash Flow, AR Aging, AR Backfill, Bank Recon Report, AP Aging (P7-7), Sales by Rep / Customer (P7-7), GL Detail (P7-7), Sales Comps (ATS), and any other date-bound report.
- Memory rule: every new date-range panel ships with `<DateRangePresets>` next to the inputs.

**Out of scope (v2 if asked):**
- Custom preset save / rename per user.
- Comparison mode ("this period vs prior period").
- Fiscal-year-aware presets (uses calendar Jan-1 today; could be made fiscal-aware once `entities.fiscal_year_start_month` is wired).

---

## 1. Recommended preset set

| Label | From | To | When useful |
|---|---|---|---|
| **MTD** | first of current month | today | "what's posted so far this month" |
| **YTD** | Jan 1 current year | today | most common accountant ask |
| **This Year** (TY) | Jan 1 current year | Dec 31 current year | full-year view |
| **Last Year** (LY) | Jan 1 prior year | Dec 31 prior year | comparison anchor |
| **TY → last month** | Jan 1 current year | end of prior month | the "clean" YTD that excludes in-progress month |
| **Last month** | first of prior month | last of prior month | month-over-month review |
| **Last 30d / 60d / 90d** | today − N days | today | rolling-window comparisons |
| **Last quarter** | first day of prior calendar quarter | last day of prior calendar quarter | QoQ / board reporting |
| **Custom...** | (opens manual From/To pickers) | — | escape hatch |

12 total. Two rows of 6 chips, or a dropdown — TBD at implementation time per visual density.

---

## 2. Component API

```tsx
<DateRangePresets
  from={fromDate}                               // "2026-01-01"
  to={toDate}                                   // "2026-05-28"
  onChange={(from, to) => { ... }}             // single callback when a preset is picked
  presets={DEFAULT_PRESETS}                     // optional override; default = the 12 above
  align="left"                                  // "left" | "right" — for chip alignment
  variant="dropdown"                            // "chips" (default) | "dropdown"
/>
```

**`variant` (added 2026-06-15, PR #1342):** `"chips"` (default) renders the
original wrap-row of preset chips; `"dropdown"` folds the same presets into a
single compact `<select>` (`data-testid="date-range-presets-dropdown"`) so the
control sits inline next to the date inputs without wrapping to a second line.
The `onChange` contract is identical in both modes (including the `"custom"`
empty-string case). **All 17 Tangerine report panels + the Costing comp-period
row use `variant="dropdown"`** as of the sweep below; the chip variant remains
for any caller that wants it.

The component itself owns the math for each preset (today's date, start-of-month, start-of-year, etc.). All preset functions are pure + unit-testable.

```ts
// src/tanda/components/dateRangePresets.ts (pure helpers)
export type Preset = {
  key: string;
  label: string;
  compute: (today?: Date) => { from: string; to: string };
};

export const DEFAULT_PRESETS: Preset[] = [
  { key: "mtd", label: "MTD", compute: (t = new Date()) => ({
      from: iso(startOfMonth(t)),
      to:   iso(t),
  })},
  // ... 11 more
];
```

Each `compute()` takes an optional `today` arg so tests pass a fixed date (no `Date.now()` mocking required).

---

## 3. Integration pattern

Every panel with from/to inputs gets:

```tsx
<div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
  <label>From <input type="date" value={fromDate} onChange={...} /></label>
  <label>To   <input type="date" value={toDate} onChange={...} /></label>
  <DateRangePresets from={fromDate} to={toDate} onChange={(f, t) => { setFromDate(f); setToDate(t); }} />
  <button onClick={load}>Refresh</button>
</div>
```

A panel that currently passes the dates through React Query or a parent state container wires the callback to `setX(...)` accordingly. WYSIWYG remains: clicking a preset just updates the inputs; nothing fetches until the user clicks Refresh (or however the panel currently triggers reload).

---

## 4. Chunk split (when implementation kicks off)

| Chunk | Title | Scope | Depends on | Status |
|---|---|---|---|---|
| **T7-1** | Component + pure helpers + tests | `DateRangePresets.tsx` + `dateRangePresets.ts` (the math) + ~20 unit tests covering each preset against a fixed today. | — | **DONE — PR #466** |
| **T7-2** | Sweep all existing date-range panels | One PR that touches every panel with `from/to` date inputs. ~13 panels. Each gets the component drop-in. | T7-1 | **DONE — PR #467** |
| **T7-3** | Close-out (refetch fix, audit, doc) | Fixed `InternalTrialBalance` empty-deps refetch bug; audited every call site for import + onChange signature consistency; updated this doc with adoption + quirks. | T7-2 | **DONE** |

Estimated **~half a day** end-to-end. T7-2 is straightforward but mechanical — same pattern as T3's export sweep.

---

## 5. Memory rule (added when T7-3 ships)

> Every Tangerine panel with a date-range filter MUST include `<DateRangePresets>` next to the from/to inputs. Operator's daily-driver workflow is "open report → pick YTD → done"; manual date typing every time is friction.

Mirrors the T3 export rule and the per-chunk memorization rule.

---

## 6. Risks

- **Fiscal-year vs calendar-year ambiguity.** Default presets use calendar Jan 1. If the operator's fiscal year ever shifts, the labels remain correct but the calculation needs a fiscal-aware override. Solution at that time: pass `fiscalYearStartMonth` prop, recompute "TY"/"LY"/"YTD" from that anchor.
- **Time-zone drift on "today".** `new Date()` uses the browser TZ. For an operator in NY but Supabase in UTC, "MTD" might end at "today 00:00 UTC" which is 8pm prior day NY time. Edge case; treat `to` as inclusive date-only (YYYY-MM-DD), no time.
- **Date range that crosses an open period boundary.** Not T7's problem — that's a P5 close-mechanics issue. T7 just sets the inputs.

---

## 7. Adoption (landed in T7-2, PR #467)

`<DateRangePresets>` is wired next to the from/to date inputs on these 13 panels:

1. `InternalAPPayments.tsx`
2. `InternalARBackfill.tsx`
3. `InternalARInvoices.tsx`
4. `InternalARReceipts.tsx`
5. `InternalCashFlow.tsx`
6. `InternalCrmActivities.tsx`
7. `InternalCycleCounts.tsx`
8. `InternalGLDetail.tsx`
9. `InternalIncomeStatement.tsx`
10. `InternalInventoryAdjustments.tsx`
11. `InternalSalesByCustomer.tsx`
12. `InternalSalesByRep.tsx`
13. `InternalTrialBalance.tsx`

All 13 use the same call shape:

```tsx
<DateRangePresets
  from={fromDate}
  to={toDate}
  onChange={(f, t) => { setFromDate(f); setToDate(t); }}
/>
```

Picking a chip just updates the date-state setters; refetch behavior is left to each panel's existing reload trigger (most still use a manual "Refresh" button, which is fine — the chip pre-fills the inputs).

**T7-3 fix:** `InternalTrialBalance` originally had `useEffect(load, [])` (empty deps). That meant clicking a preset chip updated state but the panel didn't auto-refetch — operator had to also click Refresh. Deps now include `[fromDate, toDate]` so the chip auto-loads. Basis dropdown remains on the manual-Refresh path (intentional — avoids mid-edit re-queries when toggling Accrual/Cash).

---

## 8. Skipped panels (intentionally out of scope)

Three panels use a single "as of" date instead of a from/to range — a preset chip-row doesn't map cleanly:

- `InternalAPAging.tsx` — AP aging snapshot as of a single date.
- `InternalARAging.tsx` — AR aging snapshot as of a single date.
- `InternalBalanceSheet.tsx` — balance-sheet snapshot as of a single date.

If the operator later wants single-date presets (Today / End of Last Month / End of Last Quarter / End of Last Year), that's a small follow-up cross-cutter — a `<DatePresets>` (singular) sibling component. Not in T7's scope.

The ATS **Sales Comps Toolbar** also uses a different pattern (`From + Show N days/weeks/months`) — not a from/to range, so the existing chip set doesn't map. Out of scope for T7; would need a dedicated "shift the From anchor" preset row.

---

## 9. Windows case-collision quirk — explicit `.tsx` / `.ts` extension rule

On Windows (case-insensitive filesystem), having both `DateRangePresets.tsx` (component) and `dateRangePresets.ts` (helpers) in the same directory plus a bare `from "./components/DateRangePresets"` import has produced sporadic Vite/TS resolution flakiness — Vite picks the first match it finds case-insensitively, which can be either file depending on cache state.

Rule: **all imports of the T7 component and helpers MUST include the explicit file extension.**

```tsx
import DateRangePresets from "./components/DateRangePresets.tsx";
import { DEFAULT_PRESETS, type Preset } from "./components/dateRangePresets.ts";
```

Audited in T7-3: all 13 panel imports + the test file already follow this rule.
