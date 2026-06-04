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

## Exports (`src/ats/export*.ts`)

- **Full grid** (`exportExcel.ts`) — identity + on-hand/PO/SO + period projections + totals; optional avg-cost, margin %, trailing-3-months / same-period-LY blocks, customer-facing redaction, PPK explode/merge.
- **By-Size Matrix** (PRs #887/#898/#902) — pivots ATS-available into a **color × size** matrix (sizes resolved from the master), report-palette fills + spacer columns, a separate **PPK** pack column, one tab per selected report period (22pt banner), and a separate **PPK explode** block when the grid toggle is on. It **reprojects the main ATS report** (`sizeMatrixDistribute.ts` largest-remainder split over an on-hand/incoming size shape from h611) so totals tie to the main sheet to the unit. The export **View preview** (`ExportPreviewModal.tsx`) carries a tab switcher across every `wb.SheetNames` worksheet — non-main sheets are reconstructed from their stored cells via `sheetToRows.ts`.
- **Aged inventory** (`exportAgedInven.ts`) — days-on-hand aging tiers.
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

## See also
- [po-wip-overview.md](po-wip-overview.md) — the PO data ATS pulls in
- [inventory-planning-overview.md](inventory-planning-overview.md) — downstream consumer
