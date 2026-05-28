# Cross-cutter T7 — Date-range presets

Status: **PLAN ONLY** (2026-05-28). Operator ask: "anywhere we have date ranges to be able to one click YTD, MTD, TY, LY, This Y to last month, etc."

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
/>
```

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

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **T7-1** | Component + pure helpers + tests | `DateRangePresets.tsx` + `dateRangePresets.ts` (the math) + ~20 unit tests covering each preset against a fixed today. | — |
| **T7-2** | Sweep all existing date-range panels | One PR that touches every panel with `from/to` date inputs. ~12-15 panels. Each gets the component drop-in. | T7-1 |
| **T7-3** | Memory rule + per-chunk update | Extend `feedback_memorize_each_chunk.md` so every new date-range panel ships with presets. | T7-2 |

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
