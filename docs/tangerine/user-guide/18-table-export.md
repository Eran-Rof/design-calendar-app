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

## Code map

- `src/tanda/exports/ExportButton.tsx` — the drop-in button + dropdown.
- `src/tanda/exports/useTableExport.ts` — pure helpers (`buildAoA`, `formatCell`, `toCsv`, `inferColumns`, `todayStamp`) + the imperative `useTableExport({rows, columns, filename, format})` hook.
- `src/tanda/exports/__tests__/useTableExport.test.ts` — 13 unit tests covering cell coercion, CSV quoting, header inference.
