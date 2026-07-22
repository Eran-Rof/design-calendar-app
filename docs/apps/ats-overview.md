# ATS — Available To Sell

**Route:** `/ats` · **Entry:** `src/ATS.tsx` (+ `src/ats/`) · **Access:** `permissions.ats`

## What it is

ATS is the wholesale **free-to-sell** inventory view. For every style/color it
shows what's on hand, what's already committed to sales orders, what's incoming
on POs, and the **available-to-sell by future period** — so the sales team knows
what they can promise and when. It's a fast, Excel-driven grid with rich exports;
it is *not* an accounting system (that's Tangerine).

## Where its data comes from

| Input | Source |
|---|---|
| **On-hand** | Excel upload (Inventory sheet) persisted in `app_data['ats_excel_data']` (gzip). Xoro-fed per **color** — this is the "gold" on-hand number. |
| **Sales orders (committed)** | Excel upload (Orders sheet), windowable by date to match Xoro's "Open Orders" view |
| **Purchase orders (incoming)** | **PO WIP (Tanda)** — fetched live on every load via `src/ats/hooks/usePOWIPSync.ts` → `applyPOWIPDataToExcel()` (paginates `tanda_pos`) |
| **Item master** | `ip_item_master` (color/size/category/style/cost) via `src/ats/itemMasterLookup.ts` |

## How "available" is computed

`src/ats/compute.ts` (`computeRowsFromExcelData`) builds, per (sku, store):

- `onHand` from the inventory sheet, `onPO` from Tanda POs, `onOrder` from SOs;
- per-period **free-to-sell** = `onHand − cumulative committed SOs` (clamped ≥ 0);
- **PPK pack grain** applied when the style code ends in `PPK` (see
  `project_ppk_grain_rule_CANONICAL`).

Supporting modules: `normalize.ts` (SKU standardization, user-approved),
`merge.ts` (dedupe + user merges), `enrichWithItemMaster.ts` (join master
fields), `collapse.ts` (group by category/sub-category/style), `filter.ts`
(search/category/store/min-ATS), `computeTotals.ts` (footer totals).

**Grain:** ATS is **color-grain** on-hand. The grid is one row per (style, color).

**Toolbar filter cascade:** the Category / Sub Cat / Style / Gender dropdowns are
**reciprocal** — each one's options are derived (in `renderPanel.tsx`) from
`filterRows` with that one dimension omitted, so the options always reflect the
rows passing every *other* active filter (search + the other dropdowns + store +
status). Selecting any one narrows the rest; clearing it re-widens them; stale
selections are auto-pruned. These cascaded lists drive the **toolbar only** — the
full Category/Sub Cat/Style lists handed to **Sales Comps** stay unfiltered so a
report can be broadened past the grid's current scope.

## Exports (`src/ats/export*.ts`)

- **Full grid** (`exportExcel.ts`) — identity + on-hand/PO/SO + period projections + totals; optional avg-cost, margin %, trailing-3-months / same-period-LY blocks, customer-facing redaction, PPK explode/merge.
- **By-Size Matrix** (PRs #887/#898/#902) — pivots ATS-available into a **color × size** matrix (sizes resolved from the master), report-palette fills + spacer columns, a separate **PPK** pack column, one tab per selected report period (22pt banner), and a separate **PPK explode** block when the grid toggle is on. It **reprojects the main ATS report** (`sizeMatrixDistribute.ts` largest-remainder split over an on-hand/incoming size shape from h611) so totals tie to the main sheet to the unit. The export **View preview** (`ExportPreviewModal.tsx`) carries a tab switcher across every `wb.SheetNames` worksheet — non-main sheets are reconstructed from their stored cells via `sheetToRows.ts`.
- **Aged inventory** (`exportAgedInven.ts`) — days-on-hand aging tiers. The optional Category filter matches `master_category` (the same item-master-resolved values the Category dropdown lists), not the raw feed category.
- **Negative ATS** (`exportNegInven.ts`) — rows where on-hand can't cover committed SOs.
- **Stock vs SO** (`exportStockVsSo.ts`) — style × SO matrix with deficit cells.
- **Cost cascade** (`exportCostCascade.ts`) — trace of how a unit cost was resolved (debug missing avg costs).
- **Incomplete SKUs** (`exportIncompleteSkus.ts`) — SKUs missing a master match.

## How ATS feeds Planning

The persisted `ats_excel_data` snapshot is the authoritative on-hand source for
Inventory Planning. `api/_handlers/ats-supply-sync.js` →
`syncOnHandChunkFromAtsSnapshot()` (in `api/_lib/planning-sync.js`) writes:

- `ip_inventory_snapshot` — one on-hand row per SKU per day (planning supply, `source='manual'`);
- `ip_open_sales_orders` — SO lines for lead-time calc.

The planning **Supply** workbench's "Sync on-hand (ATS)" button triggers the
same code path (`POST /api/planning/sync-on-hand`). Planning keeps ATS supply at
**color grain** (a deliberate choice — Tangerine's own size-grain on-hand is a
separate source; see [po-wip-overview.md](po-wip-overview.md) and the Planning
overview).

## Brand filter & style images

The toolbar's **Brand** multi-select is populated from `brand_master` (via
`src/ats/brandLookup.ts`, loaded once on mount alongside the item-master
cache). Each row's brand is resolved by **matching its style code to
Tangerine's `style_master.brand_id`** — `brandLookup` also loads a
`style_code → brand` map from `style_master` (paginated past the 1000-row
cap), and `enrichWithItemMaster` stamps `row.master_brand` via
`brandNameForStyle(style)`. `filter.ts` matches on the brand name.

> **Why not `ip_item_master.brand_id`?** That Xoro-fed column is backfilled
> to the ROF default on every row (100% "Ring of Fire" in prod), so it can't
> distinguish brands. The authoritative per-style brand lives in Tangerine's
> `style_master`; `ip_item_master.brand_id` is only a last-resort fallback for
> styles absent from `style_master`.

The **IMAGES** toggle renders a per-row style thumbnail inside the Style
column. Because ATS works off style **codes** (not `style_master` uuids), it
calls `POST /api/internal/pim/style-thumbs-by-code` (a code-keyed sibling of
`style-thumbs`) via `useStyleThumbsByCode`; the response carries the
`style_id` so clicking a thumb opens the shared `StyleImageGallery`
(enlarge / download / print). Thumbnails are fetched live for the current
page only, so styles gain images automatically as they're added in the
Tangerine PIM.

## Row exclusion ("X" column)

A checkbox column between Sub Cat and Style (`STICKY_COL_META` key `exclude`)
lets the operator drop a row from every aggregation. State lives in
`ATSState.excludedSkus` (a SKU list), persisted globally to the `app_data`
key `ats_excluded_skus` so exclusions survive reloads. The split is done by
two pure helpers in `src/ats/exclude.ts` (`excludeRows` / `onlyExcluded`):

- **Display** keeps excluded rows (`filtered` / `pageRows`) — they render
  greyed with the box checked so they can be unchecked.
- **Calc set** (`calcFiltered` / `calcSortedFiltered`, and `calcSkuSet` for
  the SO/PO/margin value memos) drops them, and feeds the totals row
  (`GridTable totalsRows`), the stat cards, and every report/export.

Before any report runs, `NavBar` shows a warning listing the excluded styles
with **Continue** (run excluding — uses the calc set), **Include them** (run
counting them this once — swaps in `fullFiltered`), or **Cancel**. Every
report builder (`onNegInven` / `onAgedInven` / incomplete / stock-vs-SO /
Excel export / Sales Comps) takes an `includeExcluded` flag that selects the
row set; `onNegInven`/`onAgedInven` filter the full `rows` set since they
report over the whole dataset, not the grid filter.

## Column sort

The main ATS grid is a custom virtualized / sticky-left-column grid with a
stacked totals row, so the universal per-column click-to-sort (rolled out to the
master-data and master-list panels in the 2026-06 sort waves) is **intentionally
not** wired here — a naive row reorder would fight the frozen columns and the
per-period cumulative/delta math. Sort/ordering in ATS stays driven by its own
filter and grouping controls.

## Wording: Warehouse (not Store)
The toolbar location filter and the related labels (SO-line-items modal column, Sales-Comps location multi-select, and the Aged/Incomplete/Negative/Stock-vs-SO export headers) read **Warehouse**, not "Store" — Tangerine has warehouses + brands, no ROF sales stores. The underlying data field/values (`store` = `ROF / ROF ECOM / PT / PT ECOM`) and the **Excel input** column names (`Store` / `Sale Store`) are unchanged — only the on-screen + export-report wording.

## Sales Comps results sort + filter UX (2026-06)

The **Sales Comps** modal's comparison tables (per-customer / category / style /
SKU breakdowns) now have **click-to-sort column headers** with a functional ▲▼
indicator — sort by any of TY/LY Qty, Rev, Mrgn%, Δ Rev, or Δ Mrgn pp, or the
leftmost dimension label. The default (unsorted) order stays the upstream
TY-rev-descending order; the TOTAL row(s) stay pinned at the bottom regardless of
sort. Every search/filter text box in the ATS toolbar (SKU search, the
Category/Sub-Cat/Style/Brand/Cust-Vend dropdown search fields) and in the Sales
Comps + Export-Options modals now **selects all text on focus**, so tabbing in and
typing replaces the prior value in one keystroke.

## Sales Comps default window + sold-out styles (2026-07)

The Sales Comps modal **always opens on a backward-looking YTD → today
window**. It previously inherited the grid's display window, but the grid is a
forward-looking availability view (start ≈ today), and a forward window has
zero shipped sales by definition — every past invoice silently fell out of the
report and it opened "empty" (bit the operator on ROF-I153370 / RYB1893).
The `gridStart`/`gridEnd` threading (renderPanel → NavBar → modal) was removed.

The modal's **Style picker options = grid styles ∪ the full item master**
(`getAllMasterStyles()` in `itemMasterLookup.ts`, deduped past the whitespace-
alias keys in `byStyleCode`). Sold-out styles have no ATS grid row (the blob's
active-SKU filter drops zero-availability SKUs at `ats-parse.js`), so the old
grid-derived list couldn't offer them — even though the sales fetch's
cross-grid extras machinery reports their history fine. Master descriptions
also backfill the picker's *code — description* labels for styles with no
grid row.

## See also
- [po-wip-overview.md](po-wip-overview.md) — the PO data ATS pulls in
- [inventory-planning-overview.md](inventory-planning-overview.md) — downstream consumer
