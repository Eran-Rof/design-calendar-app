# 18. Table export — every panel

> **T3 cross-cutter (2026-05-28):** every viewable Tangerine panel ships with an Excel/CSV download button.

Look for the **⬇ Export** button in the filter bar of any list, report, or master panel. Click it for a small menu:

- **Excel (.xlsx)** — formatted spreadsheet with autofit columns and a header row. Currencies come through as real numbers (already converted from cents). Dates as ISO `YYYY-MM-DD`.
- **CSV (.csv)** — RFC 4180 with a UTF-8 BOM so Excel opens it without garbled accents.

## What gets exported

**WYSIWYG.** Whatever you see on screen is what lands in the file:

- Active filter (status / account / date range / search) is respected — only the filtered rows are downloaded.
- Sort order is preserved.
- Columns mirror the on-screen `<thead>` — not the underlying DB schema. So `Code` stays `Code` (not `gl_account_code`), and `Amount` is dollars (not `amount_cents`).
- The current row count appears in the button label, e.g. **⬇ Export (47)** when 47 rows are visible.

## Filename convention

Auto-named with a date stamp: `<panel-name>-YYYY-MM-DD.xlsx`. For dated reports, the date range is folded into the filename, e.g. `trial-balance-ACCRUAL-2026-01-01-to-2026-03-31.xlsx`.

## Multi-tab panels

Panels with tabs (Bank Reconciliation: Accounts + Transactions) have a separate **⬇ Export** in each tab — switch tabs first, then export. Same for any future multi-view panel.

## Forward-going

Per the per-chunk memory rule, every new Tangerine panel ships with an export button in the same PR. If you find a panel without one, it's a bug — flag it.

## Power-user notes

- The button is disabled when zero rows are visible (`opacity: 0.5`, hover tooltip "No rows to export").
- Empty cells in the source render as empty cells in the output (not the string `"null"` or `"undefined"`).
- Object-valued columns get JSON-stringified — rare; usually flattened upstream by the panel.
- 60-character per-column width cap to keep wide sheets readable.

## Click-to-sort columns

> **2026-06-04:** Tangerine table columns are now **click-sortable**.

Click a column header to sort the table by that column. Each click cycles through three states:

1. **First click** — ascending (▲ appears next to the header).
2. **Second click** — descending (▼).
3. **Third click** — sort cleared; the table returns to its natural order.

Notes:

- Only **one** column sorts at a time — clicking a new header replaces the previous sort.
- Numbers sort numerically, text sorts alphabetically (case-insensitive, so `Item 2` comes before `Item 10`), and **blank cells always sink to the bottom** in both directions.
- Your sort choice is **remembered per panel** across page reloads (stored locally in your browser).
- Sorting is layered on top of the Columns show/hide and Export buttons — it only reorders what's already on screen, and the **Export respects the current sort order**.
- Some columns are intentionally **not sortable** (they show no ▲/▼ on hover) — these are computed, lookup, or multi-value cells where a row-by-row sort wouldn't be meaningful.

This is rolling out panel-by-panel. The master-data and operations panels (Genders, Countries, Payment Terms, Fabric Codes, Factors, Style Classifications, Employees, Employee Titles/Departments, Customer/Vendor Master, CRM Tasks/Activities, Inventory Transfers, Cycle Counts, Scanner Sessions, and Approval Requests) had it first (wave 1).

**Wave 2 (2026-06-05)** extends the same click-to-sort to the sibling apps:

- **Costing** — Projects list and RFQs list.
- **GS1** — Scale Master, UPC Item Master, and Pack GTIN Master.
- **Planning** — the admin Job Runs and Audit Explorer dashboards.

The heavily virtualized / sticky-column grids (the main ATS grid, the wholesale/ecom planning grids) are intentionally left out — a row-by-row reorder there would fight the frozen columns and per-cell editors.

**Wave 3 (2026-06-29)** extends the same click-to-sort to the OPS / Inventory panels: **Receiving**, **3PL** (Providers + Shipments), **3PL Recon**, **Drop-ship**, **Sales Returns / RMA**, **Shopify Refunds**, **Reconciliation Dashboard** (cutover-history list), **EDI** (Partners + Messages), **EDI Customers**, **Marketplace Status**, **Size Scales**, and **Three-Way Match**. As always, editable line-entry grids and expanded detail sub-tables are left inert (no ▲/▼). The cross-vendor **Shipments** view and a few card-style lists (Workspaces, Sustainability, Marketplace Inquiries) render rows outside a sortable table and so aren't click-sortable, but their filters and exports got the same treatment.

Two companion sweeps landed alongside wave 3:

- **Export Totals row.** On these panels, when the export carries numeric or money columns, the exported spreadsheet now ends with a **TOTAL** row that sums those columns (text columns are left blank). It honours the same WYSIWYG rule as the rest of export — it totals whatever rows are currently in the table.
- **Select-on-focus search boxes.** Clicking (or tabbing) into a panel's free-text **search/filter** box now **selects its current contents**, so you can just start typing to replace the previous search instead of clearing it first.
- **Cascading filters.** On the cross-vendor **Shipments** view, the **Vendor** and **Status** dropdowns (plus the search box) now narrow each other — each dropdown only offers values that still have matching shipments under the other active filters (your current selection always stays available so you can clear it).

## Totals button — total any column with numbers

> **2026-07-15:** every export control now sits beside a **Totals** button.

Next to the **Export** button on any list / report panel you'll now see a **Totals ▾** button. Click it to open a compact strip that **sums every numeric column** in the table:

- **Money columns** (stored as cents) total to a proper **$X.XX** figure.
- **Quantity / count columns** total with thousands separators.
- **Percentage columns are not summed** — averaging a percent is misleading, so they're left blank (a small "Percentages are not summed" note appears when the table has any).
- **Text and date columns** stay blank in the totals row.

It's **WYSIWYG**, exactly like Export: it totals only the rows currently visible under your active filter, search, and sort. Click **Totals** again (or press Escape / click away) to close the strip. The toggle is **per-table** — opening totals on one panel doesn't affect another.

The button **hides itself** on tables that have no numeric columns (master-data / text-only grids), and is intentionally **omitted** on statement-shaped reports that already carry their own subtotal/total rows — **Balance Sheet, Trial Balance, Cash Flow, Income Statement, Segment P&L** — where re-summing the amount column would double-count the built-in subtotals. Matrix and transaction-list grids keep it, since their rows sum cleanly.

## Code map

- `src/tanda/exports/ExportButton.tsx` — the drop-in export button + dropdown; also renders the adjacent `<TotalsButton>` (opt out with the `noTotals` prop).
- `src/tanda/exports/TotalsButton.tsx` — the universal Totals toggle + totals strip (same `rows`/`columns` props as ExportButton).
- `src/tanda/exports/tableTotals.ts` — pure totals logic (`computeColumnTotals`, `formatIsSummable`, `inferredNumeric`) — money summed as cents, percent columns skipped.
- `src/tanda/exports/__tests__/tableTotals.test.ts` — 16 unit tests: cents summing, null-skip, percent-skip, inferred-numeric detection.
- `src/tanda/exports/useTableExport.ts` — pure helpers (`buildAoA`, `formatCell`, `toCsv`, `inferColumns`, `todayStamp`) + the imperative `useTableExport({rows, columns, filename, format})` hook.
- `src/tanda/exports/__tests__/useTableExport.test.ts` — 13 unit tests covering cell coercion, CSV quoting, header inference.
- `src/tanda/hooks/useSort.ts` — the click-to-sort primitive (tri-state, null-safe, localStorage-persisted) + pure `sortRows`/`baseCompare` helpers.
- `src/tanda/components/SortableTh.tsx` — the sortable header cell that renders the ▲/▼ indicator and coexists with the column show/hide `hidden` pattern.
- `src/tanda/hooks/__tests__/useSort.test.ts` — unit tests for the comparator + stable, null-last sort.
