import { buildMultiSheetWorkbook, writeWorkbookToFile, type MultiSheetSpec } from "./exportTheme";
import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { fmtDate, displayColor } from "./helpers";
import type { GridTotals } from "./computeTotals";
import { periodAvail } from "./compute";
import type { ExportOptions } from "./panels/ExportOptionsModal";
import type { SalesFetchResult, SalesAggregate } from "./exportSalesFetch";
import type { ExportImage } from "../shared/exportImages";

type EventIndex = Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>>;

const EMPTY_AGG: SalesAggregate = { qty: 0, totalPrice: 0, marginAmount: 0 };
// Autofit non-spacer cols: max(len(value)) + 2, capped at 80.
// No frozen panes, no autofilter, no merged cells.
// Per-row customer-narrowed SO summary built by the export prep when a
// customer is selected. Keyed by `${sku}::${store}` to match the row's
// in-memory identity. Used to override the On Order column display + to
// populate the new "SO Prc" column inserted between On Order and On PO.
export interface CustomerSoEntry { qty: number; soPrice: number }
export type CustomerSoMap = Map<string, CustomerSoEntry>;

export function exportToExcel(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  // Kept for signature compatibility with the existing call sites.
  // The fixed 18-col layout doesn't honor hiddenColumns — drop the
  // arg if the planner's intent shifts.
  _hiddenColumns: string[] = [],
  _totals: GridTotals | null = null,
  options?: ExportOptions,
  // eventIndex retained on the signature for any legacy caller; T3/LY
  // now read from the pre-fetched salesAggregates (database-sourced).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _eventIndex?: EventIndex | null,
  // Pre-fetched per-SKU sales aggregates from ip_sales_history_wholesale.
  // Empty maps when neither trailing3 nor spLY is on, or when fetch
  // failed / no rows. NavBar pre-fetches before calling exportToExcel.
  salesAggregates?: SalesFetchResult,
  // Grid's current "Explode PPK" toggle. When true (default) the grid
  // shows everything in UNIT grain — qty cols and avg cost are
  // displayed as units. When false the grid shows packs — qty cols
  // divided by ppkMult, avg cost multiplied by ppkMult. The export
  // mirrors the grid so what the operator sees on screen is what the
  // download (and View preview) shows.
  explodePpk?: boolean,
  // Per-row customer-narrowed SO totals (qty + qty-weighted avg
  // unit price). Provided only when a customer is selected upstream.
  // When present, the On Order column displays the customer's qty
  // (instead of the row's full onOrder) AND a new "SO Prc" column
  // is inserted between On Order and On PO.
  customerSoMap?: CustomerSoMap,
  // Optional By Size Matrix worksheet inputs (see buildExportPayload).
  sizeMatrix?: AtsSizeMatrixResponse,
  bulkByStyleColor?: Map<string, { so: number; po: number }>,
  periodMatrices?: Array<{ name: string; matrix: AtsSizeMatrixResponse }>,
  styleImages?: Map<string, ExportImage>,
) {
  const payload = buildExportPayload(rows, periods, _hiddenColumns, _totals, options, _eventIndex, salesAggregates, explodePpk, customerSoMap, sizeMatrix, bulkByStyleColor, periodMatrices, styleImages);
  if (!payload) return;
  return triggerXlsxDownload(payload.wb, payload.filename);
}

// ── Trigger a browser download for a built (ExcelJS) workbook. ───────
export function triggerXlsxDownload(wb: any, filename: string): Promise<void> {
  return writeWorkbookToFile(wb, filename);
}

export interface ExportPayload {
  aoa: any[][];     // the array-of-arrays the worksheet was built from
  wb: any;          // branded ExcelJS workbook ready to write
  filename: string; // download filename
  // Display title used by the preview modal header. Kept optional so
  // legacy code that built ExportPayload without one still type-checks
  // — the preview default falls back to "Export".
  title?: string;
  // Non-main worksheet AOAs (By Size Matrix + per-period tabs) so the
  // preview can render them without reaching into the workbook internals.
  extraSheets?: Array<{ name: string; aoa: any[][] }>;
}

// Same as exportToExcel but returns the workbook + AOA without
// triggering a download. Used by the "View" flow so the preview modal
// can render the AOA before the operator decides whether to download.
export function buildExportPayload(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  _hiddenColumns: string[] = [],
  _totals: GridTotals | null = null,
  options?: ExportOptions,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _eventIndex?: EventIndex | null,
  salesAggregates?: SalesFetchResult,
  explodePpk: boolean = true,
  customerSoMap?: CustomerSoMap,
  // By Size Matrix worksheet (optional): per-style size-grain ATS-available
  // from /api/internal/ats-size-matrix, plus the bulk SO/PO overlay per
  // (style, color) keyed "STYLE|COLOR" (upper-cased). Both undefined → no
  // extra sheet (default).
  sizeMatrix?: AtsSizeMatrixResponse,
  bulkByStyleColor?: Map<string, { so: number; po: number }>,
  // One By-Size-Matrix tab per selected report period — each carries a 22pt
  // dark-blue period banner and the same matrix computed AS OF that period
  // (on-hand + inbound-by-then − reservations). Appended after the snapshot
  // "By Size Matrix" tab. Empty/undefined → period tabs omitted.
  periodMatrices?: Array<{ name: string; matrix: AtsSizeMatrixResponse }>,
  // Embedded style thumbnails, keyed "STYLE|COLOR" (upper-cased) → base64 data
  // URL, already fetched + color-matched by the caller. Present only when the
  // operator ticked "Include style images". Adds a dedicated Image column.
  styleImages?: Map<string, ExportImage>,
): ExportPayload | null {
  // Default options — keeps the export's pre-modal behavior when
  // exportToExcel is called without a modal (e.g. legacy tests).
  const opts: ExportOptions = {
    subtotals:           options?.subtotals           ?? true,
    avgCost:             options?.avgCost             ?? false,
    slsPrcAtMrgn:        options?.slsPrcAtMrgn        ?? false,
    slsMarginPct:        options?.slsMarginPct        ?? 21,
    trailing3:           options?.trailing3           ?? false,
    spLY:                options?.spLY                ?? false,
    customerEnabled:     options?.customerEnabled     ?? false,
    customer:            options?.customer            ?? "",
    showCustomerMargin:  options?.showCustomerMargin  ?? true,
    customerFacing:           options?.customerFacing           ?? false,
    hideZeroColumns:          options?.hideZeroColumns          ?? false,
    hideATSData:              options?.hideATSData              ?? false,
    hideEmptyHistoryRows:     options?.hideEmptyHistoryRows     ?? false,
    customSalesRangeEnabled:  options?.customSalesRangeEnabled  ?? false,
    customSalesRangeStart:    options?.customSalesRangeStart    ?? "",
    customSalesRangeEnd:      options?.customSalesRangeEnd      ?? "",
    bySizeMatrix:             options?.bySizeMatrix             ?? false,
    buyerWorksheet:           options?.buyerWorksheet           ?? false,
  };
  // Buyer worksheet = the live pricing view for an internal buyer: shows the
  // Avg Cost column INLINE plus an editable Sls Prc with LIVE Mrgn % / Total $
  // formulas that recompute when a price is edited. It is NOT customer-safe
  // (cost + margin are visible) — that's intentional; it's a working tool, not
  // a customer hand-out. Force the columns it needs on.
  if (opts.buyerWorksheet) {
    opts.avgCost = true;
    opts.slsPrcAtMrgn = true;
    opts.customerFacing = false; // mutually exclusive — buyer view shows cost
  }
  // hideATSData drops the entire ATS-data block — including Avg Cost,
  // Total Cost, and Sls Prc @ Mrgn. Force the optional-column toggles
  // off here so allocation skips them entirely (mirrors how
  // customerFacing strips cost-revealing columns above). Periods + the
  // Total column are non-optional and get dropped later in the
  // column-projection pass.
  if (opts.hideATSData) {
    opts.avgCost = false;
    opts.slsPrcAtMrgn = false;
  }
  // Customer-facing mode strips EVERY column that exposes our cost basis or
  // margin (Avg Cost, Total Cost, Sls Prc @ Mrgn) so the workbook is safe to
  // send to a customer. (The live-pricing view now lives in the separate
  // "Buyer worksheet" option, which is NOT customer-safe by design.)
  if (opts.customerFacing) {
    opts.avgCost = false;
    opts.slsPrcAtMrgn = false;
  }
  // LIVE Excel formulas (editable Sls Prc → Mrgn % + Total $) are the Buyer
  // worksheet behavior ONLY. The margin formula references the Avg Cost column
  // INLINE on the same sheet (no separate cost sheet). Plain Sls Prc @ Margin
  // (without buyer worksheet) keeps its original static values.
  const slsPrcFormulaMode = opts.buyerWorksheet;
  // Margin column appears in trailing/SPLY blocks always when no
  // customer is selected; when a customer IS selected, only when the
  // operator opted in. Customer-facing mode forces the margin column
  // off regardless.
  const showT3Margin   = !opts.customerFacing && (!opts.customerEnabled || opts.showCustomerMargin);
  const customerFilter = opts.customerEnabled ? opts.customer : "";
  // Sales-margin fraction shared by body / subtotal / total calcs.
  const slsMargin = opts.slsMarginPct / 100;

  // Sort rows by master_style → master_color → sku before any grouping
  // or iteration so all rows of the same style cluster together. The
  // downstream subtotal emitter flushes when style changes between
  // adjacent rows; without this sort, the same style could appear in
  // multiple non-contiguous blocks and produce duplicate subtotal rows
  // (e.g. RYB0412 mid-export, then again at the bottom). Empty/null
  // styles sort to the end. Sort is stable when keys collide.
  rows = [...rows].sort((a, b) => {
    const sa = (a.master_style ?? "").trim();
    const sb = (b.master_style ?? "").trim();
    if (sa !== sb) {
      if (!sa) return 1;
      if (!sb) return -1;
      return sa.localeCompare(sb);
    }
    const ca = (a.master_color ?? "").trim();
    const cb = (b.master_color ?? "").trim();
    if (ca !== cb) {
      if (!ca) return 1;
      if (!cb) return -1;
      return ca.localeCompare(cb);
    }
    return (a.sku ?? "").localeCompare(b.sku ?? "");
  });
  // Skip rows whose availability is zero across every visible period.
  // Two complementary signals — keep the row when EITHER fires:
  //   • periodAvail — non-zero in any period catches new receipts
  //     arriving and the period-0 cumulative free-to-sell.
  //   • row.dates (raw cumulative ATS) — catches rows whose on-hand
  //     stock is FULLY RESERVED for future SOs (freeMap=0 everywhere,
  //     so periodAvail returns 0 in delta mode) but who still have
  //     real inventory the planner expects to see in the export.
  const hasAnyAvailability = (r: ATSRow): boolean => {
    for (let i = 0; i < periods.length; i++) {
      if (periodAvail(r, periods, i) !== 0) return true;
      const v = r.dates[periods[i].endDate];
      if (typeof v === "number" && v !== 0) return true;
    }
    return false;
  };
  // Cross-grid synthetic rows (added in NavBar.prepareExportArgs when
  // a customer is selected + Trailing 3 / SP LY is on) carry empty
  // dates / zero qty fields — their value lives entirely in the T3/LY
  // columns, which come from salesAggregates rather than this row.
  // Don't filter them out: a row that has either past sales (t3 / ly
  // maps) qualifies even if no future-period activity exists.
  const _filterT3 = salesAggregates?.t3;
  const _filterLY = salesAggregates?.ly;
  const hasSalesHistory = (r: ATSRow): boolean => {
    if (_filterT3) {
      const a = _filterT3.get(r.sku);
      if (a && (a.qty > 0 || a.totalPrice > 0)) return true;
    }
    if (_filterLY) {
      const a = _filterLY.get(r.sku);
      if (a && (a.qty > 0 || a.totalPrice > 0)) return true;
    }
    return false;
  };
  rows = rows.filter(r => hasAnyAvailability(r) || hasSalesHistory(r));

  // hideEmptyHistoryRows (set by Hide ATS data) tightens the filter
  // further: a row qualifies only if it has T3 OR LY sales — pure
  // availability (on-hand without history) is not enough. The planner
  // asked for this coupling because Hide ATS data drops the in-flight
  // columns, leaving only sales history meaningful per row.
  if (opts.hideEmptyHistoryRows) {
    rows = rows.filter(r => hasSalesHistory(r));
  }

  // Column letter helper (1-based: A=1, AA=27, ...).
  const colLetter = (idx1: number): string => {
    let s = "";
    let n = idx1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };

  // ── Layout (1-based column indexes) ────────────────────────────────────
  // Base 18-col layout (when numPeriods=5). The modal can append extra
  // numeric columns on the right: Avg Cost / Total Cost / Sls Prc @
  // Mrgn / T3 Qty / T3 Sls Price / T3 Mrgn % / LY Qty / LY Sls Price /
  // LY Mrgn %. The optional columns slot in after `total` in the order
  // requested by the user; we record their indexes here so the data /
  // header / subtotal / outline loops can pick them up uniformly.
  const numPeriods = periods.length;
  // Dedicated Image column (after Color) when the operator opted into style
  // thumbnails. Inserted in the COL allocator so every downstream index shifts
  // automatically; left undefined otherwise so the report is byte-identical.
  const wantImages = !!styleImages && styleImages.size > 0;
  // Report text is scaled up; defined here so the autofit (below) widens text
  // columns to match and the row-height + font passes share one factor.
  const FONT_SCALE: number = 1.35;
  // Image column geometry: ~220px square thumbnail (large product image). The
  // embedded source is the higher-res "web" derivative so it stays crisp.
  const IMG_COL_WCH = 32;   // ≈ 229px column
  const IMG_ROW_HPT = 170;  // ≈ 227px row
  const IMG_PX = 220;       // embedded thumbnail px (inset inside the cell)
  let nextCol = 1;
  const COL = {
    category:    nextCol++,
    subCat:      nextCol++,
    style:       nextCol++,
    description: nextCol++,
    color:       nextCol++,
    ...(wantImages ? { image: nextCol++ } : {}),
    spacerF:     nextCol++,
    onHand:      nextCol++,
    spacerH:     nextCol++,
    onOrder:     nextCol++,
  } as Record<string, number>;
  // SO Prc column inserted BETWEEN On Order and the spacer-J / On PO band
  // when a customer is selected AND at least one visible row has a
  // customer-narrowed SO. Operator request: see the per-row contracted
  // unit price for the selected customer's SOs of this (BP, color).
  const willHaveSoPrcCol = !!customerSoMap && customerSoMap.size > 0;
  const COL_SO_PRC: number | undefined = willHaveSoPrcCol ? nextCol++ : undefined;
  Object.assign(COL, {
    spacerJ:     nextCol++,
    onPO:        nextCol++,
    spacerL:     nextCol++,
    firstPeriod: nextCol,
    lastPeriod:  nextCol + numPeriods - 1,
    total:       nextCol + numPeriods,
  });
  nextCol = (COL.total as number) + 1;
  // Optional extra columns. Each is either a 1-based col index or
  // undefined (column not present).
  const COL_AVG_COST:    number | undefined = opts.avgCost      ? nextCol++ : undefined;
  const COL_TOT_COST:    number | undefined = opts.avgCost      ? nextCol++ : undefined;
  const COL_SLS_PRC:     number | undefined = opts.slsPrcAtMrgn ? nextCol++ : undefined;
  // Mrgn % column ships alongside Sls Prc @. Math priority:
  //   1. Customer selected + customer bought this SKU within 12mo →
  //      use that price, RED font.
  //   2. Style has T3 sales (any customer; respects customer filter when
  //      one is set upstream) → use style-level avg unit price, BLUE font.
  //   3. Fall through to formula Sls Prc = avgCost / (1 - margin) →
  //      margin equals operator-typed slsMarginPct, default font.
  const COL_SLS_MRGN_PCT: number | undefined = opts.slsPrcAtMrgn ? nextCol++ : undefined;
  // Total $ — implied sale price × the row's Total qty. A live Excel formula
  // (Sls Prc cell × Total qty cell) so it tracks any sale-price edit. Ships
  // alongside Sls Prc @ Margin.
  // Total $ ships only in the Buyer worksheet (live-formula) view.
  const COL_SLS_TTL:     number | undefined = slsPrcFormulaMode ? nextCol++ : undefined;
  const COL_T3_QTY:      number | undefined = opts.trailing3    ? nextCol++ : undefined;
  const COL_T3_PRICE:    number | undefined = opts.trailing3    ? nextCol++ : undefined;
  const COL_T3_TTL_SLS:  number | undefined = opts.trailing3    ? nextCol++ : undefined;
  const COL_T3_MRGN:     number | undefined = (opts.trailing3 && showT3Margin) ? nextCol++ : undefined;
  const COL_LY_QTY:      number | undefined = opts.spLY         ? nextCol++ : undefined;
  const COL_LY_PRICE:    number | undefined = opts.spLY         ? nextCol++ : undefined;
  const COL_LY_TTL_SLS:  number | undefined = opts.spLY         ? nextCol++ : undefined;
  const COL_LY_MRGN:     number | undefined = (opts.spLY && showT3Margin) ? nextCol++ : undefined;
  // T3 vs LY: % change in volume (qty) and revenue ($) between the
  // two 3-month windows. Both present when trailing3 AND spLY are on.
  // Qty version goes first per planner — volume change is the leading
  // indicator; dollars come after. Positive = T3 outsold LY (green
  // text); negative = underperformed (red text). No cell fill so the
  // row stripe stays visible.
  const COL_T3_LY_DIFF_QTY:  number | undefined = (opts.trailing3 && opts.spLY) ? nextCol++ : undefined;
  const COL_T3_LY_DIFF:      number | undefined = (opts.trailing3 && opts.spLY) ? nextCol++ : undefined;
  // T3/LY Mrgn % diff column. Same formula as t3VsLyCell:
  // (t3_mrgn − ly_mrgn) / t3_mrgn. Only emitted when BOTH trailing3
  // AND spLY are on AND the operator opted in to margin columns (the
  // showT3Margin gate that controls T3 Mrgn % and LY Mrgn % per-row
  // columns — emitting a vs-LY margin column without the source
  // margins to compare would be meaningless).
  const COL_T3_LY_DIFF_MRGN: number | undefined = (opts.trailing3 && opts.spLY && showT3Margin) ? nextCol++ : undefined;

  const SPACER_COLS = new Set([COL.spacerF, COL.spacerH, COL.spacerJ, COL.spacerL]);
  const totalColumnCount = nextCol - 1;

  // ── Style fills ────────────────────────────────────────────────────────
  const HDR_TEXT_FILL  = "3278CC"; // text headers
  const SPACER_FILL    = "2C69B2"; // separator columns — darker than 3278CC so they read clearly against the On Hand header (#4081D0)
  const HDR_ONHAND_FILL = "4081D0"; // On Hand only
  const HDR_DARK_FILL  = "1F497D"; // On Order, On PO, periods, Total
  const FILL_EVEN = "EEF3FA";       // zebra even data rows (text + period cols)
  const FILL_ODD  = "FFFFFF";       // zebra odd data rows (text + period cols)
  // Single fill for the three qty-col data cells (On Hand, On Order,
  // On PO). Sits between the very-light zebra (FILL_EVEN/FILL_ODD)
  // and the Color column header (#3278CC) — clearly darker than the
  // body zebra, well lighter than the text headers, and no zebra
  // alternation in those cols so the qty block reads as a coherent
  // band.
  const FILL_QTY_COL = "B4C7E7";    // medium-light blue (Accent 1 Lighter 60%)

  // ── Borders ────────────────────────────────────────────────────────────
  // Per planner: thin border around every cell PLUS a thick blue outline
  // around each column AND around each header. Implementation:
  //   - Body cells: thin top + bottom (the "regular border around each
  //     cell"), thick left + right (the "thick border around each
  //     column" — adjacent cells share the thick edge).
  //   - Header cells: thick on all four sides.
  //   - Bottom Total row cells: thick top (separator from data) and
  //     thick bottom (closes the table); thick left + right for the
  //     column outline.
  const THICK: any = { style: "medium", color: { rgb: "1F497D" } };
  const THIN: any  = { style: "thin",   color: { rgb: "4472C4" } };
  // Interior gridlines are a single clean THIN weight: the heavy vertical
  // column dividers drop from medium→thin (lighter than before) and every
  // interior line stays a continuous solid. We don't go below thin — Excel's
  // "hair" weight renders as a dotted line, not a thinner solid one. The
  // outer frame (EXTRA_THICK, applied in the outline pass) and the line
  // below the header (THICK) stay heavy.
  const BORDER_BODY: any   = { top: THIN,  bottom: THIN,  left: THIN, right: THIN };
  const BORDER_HEADER: any = { top: THICK, bottom: THICK, left: THIN, right: THIN };
  const BORDER_TOTAL: any  = { top: THICK, bottom: THICK, left: THIN, right: THIN };
  // Text-header column dividers in WHITE — the blue THIN (#4472C4) is
  // invisible against the #3278CC text-header fill, so the Category / Sub
  // Cat / Style / Description / Color splits don't read. Header row only;
  // the data cells below keep their normal THIN dividers.
  const WHITE_THIN: any = { style: "thin", color: { rgb: "FFFFFF" } };
  const BORDER_HTEXT_FIRST: any = { top: THICK, bottom: THICK, left: THIN,       right: WHITE_THIN }; // Category (left = outer frame via outline)
  const BORDER_HTEXT_MID:   any = { top: THICK, bottom: THICK, left: WHITE_THIN, right: WHITE_THIN };  // Sub Cat / Style / Description / Color
  const BORDER_HSEP_FIRST:  any = { top: THICK, bottom: THICK, left: WHITE_THIN, right: THIN };        // first separator: white edge to its left (before On Hand)

  // ── Style factories ────────────────────────────────────────────────────
  const headerStyle = (fill: string, align: "left" | "center", wrap: boolean = false, border: any = BORDER_HEADER): any => ({
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center", wrapText: wrap },
    border,
  });
  // Tracks whether ANY header cell was built with wrap enabled —
  // used downstream to decide the header row height.
  let headerHasWrap = false;
  // Build a header cell, automatically flipping wrap on for any text
  // value longer than 10 chars. Sets wrapText at construction time
  // (not via post-walk mutation) so xlsx-js-style's aoa_to_sheet
  // serializer reliably picks it up.
  const headerCell = (value: string, fill: string, align: "left" | "center", border?: any) => {
    const wrap = value.length > 10;
    if (wrap) headerHasWrap = true;
    return { v: value, t: "s" as const, s: headerStyle(fill, align, wrap, border) };
  };
  // For non-merged rows, alignment is left/center. For prepack pairs,
  // text + qty cols are merged across the pair so the value sits in
  // the vertical CENTER of the merged region (matches the planner's
  // image — qty 0/360/4272 centered in the taller cells).
  const bodyTextStyle = (fill: string): any => ({
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border:    BORDER_BODY,
  });
  const bodyStyleStyle = (fill: string): any => ({
    // Style col: bold blue text, left-aligned.
    font:      { sz: 11, bold: true, color: { rgb: "1F497D" }, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border:    BORDER_BODY,
  });
  const bodyNumStyle = (fill: string): any => ({
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_BODY,
  });
  // Centered numeric (used in the period cells where qty + PPK split).
  // Qty sits at the bottom of its cell, PPK suffix at the top of the
  // cell directly below — visually flush.
  const periodQtyStyle = (fill: string): any => ({
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "bottom" },
    border:    BORDER_BODY,
  });
  // PPK suffix font: 6.6pt = 5.5pt × 1.2 per planner's "+20%" request.
  const periodPpkStyle = (fill: string): any => ({
    font:      { sz: 6.6, color: { rgb: "B0BAC9" }, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "top" },
    border:    BORDER_BODY,
  });
  const lowStockStyle = (base: any): any => ({
    ...base,
    font: { ...base.font, bold: true, color: { rgb: "7F6000" } },
    fill: { fgColor: { rgb: "FFEB9C" }, patternType: "solid" },
  });
  // Total column body cells now zebra-stripe like the text + period
  // cols — same row's zebra fill applied to col R per planner. Numbers
  // RIGHT-aligned (operator standard for total columns across all reports).
  const bodyTotalStyle = (fill: string): any => ({
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "right", vertical: "center" },
    border:    BORDER_BODY,
  });
  // Spacer cell — always #2C69B2 top to bottom, no value. NO borders —
  // spacers read as a clean colored gap between column groups (planner
  // asked for the spacer-column vertical borders to be removed).
  const spacerCellStyle = (): any => ({
    fill:   { fgColor: { rgb: SPACER_FILL }, patternType: "solid" },
    border: {},
  });

  // ── Header row ─────────────────────────────────────────────────────────
  // All header cells go through headerCell() so wrapText is applied at
  // construction for any text > 10 chars. (Earlier post-walk mutation
  // wasn't always picked up by xlsx-js-style's aoa_to_sheet
  // serializer.)
  const headerRow: any[] = new Array(totalColumnCount);
  headerRow[COL.category    - 1] = headerCell("Category",    HDR_TEXT_FILL, "left", BORDER_HTEXT_FIRST);
  headerRow[COL.subCat      - 1] = headerCell("Sub Cat",     HDR_TEXT_FILL, "left", BORDER_HTEXT_MID);
  headerRow[COL.style       - 1] = headerCell("Style",       HDR_TEXT_FILL, "left", BORDER_HTEXT_MID);
  headerRow[COL.description - 1] = headerCell("Description", HDR_TEXT_FILL, "left", BORDER_HTEXT_MID);
  headerRow[COL.color       - 1] = headerCell("Color",       HDR_TEXT_FILL, "left", BORDER_HTEXT_MID);
  if (COL.image) headerRow[COL.image - 1] = headerCell("Image", HDR_TEXT_FILL, "center");
  headerRow[COL.spacerF - 1] = headerCell("", SPACER_FILL, "center", BORDER_HSEP_FIRST);
  headerRow[COL.spacerH - 1] = headerCell("", SPACER_FILL, "center");
  headerRow[COL.spacerJ - 1] = headerCell("", SPACER_FILL, "center");
  headerRow[COL.spacerL - 1] = headerCell("", SPACER_FILL, "center");
  headerRow[COL.onHand  - 1] = headerCell("On Hand",  HDR_ONHAND_FILL, "center");
  headerRow[COL.onOrder - 1] = headerCell("On Order", HDR_DARK_FILL, "center");
  if (COL_SO_PRC) headerRow[COL_SO_PRC - 1] = headerCell("SO Prc", HDR_DARK_FILL, "center");
  headerRow[COL.onPO    - 1] = headerCell("On PO",    HDR_DARK_FILL, "center");
  for (let i = 0; i < numPeriods; i++) {
    const ci = COL.firstPeriod + i;
    headerRow[ci - 1] = headerCell(periods[i].label.replace(/\n/g, " "), HDR_DARK_FILL, "center");
  }
  headerRow[COL.total - 1] = headerCell("Total", HDR_DARK_FILL, "center");

  // Optional extra-column headers. Sls Prc col header carries the
  // user-chosen margin pct so the spreadsheet documents the
  // calculation (e.g. "Sls Prc @ 21%").
  if (COL_AVG_COST) headerRow[COL_AVG_COST - 1] = headerCell("Avg Cost",   HDR_ONHAND_FILL, "center");
  if (COL_TOT_COST) headerRow[COL_TOT_COST - 1] = headerCell("Total Cost", HDR_ONHAND_FILL, "center");
  if (COL_SLS_PRC)  headerRow[COL_SLS_PRC  - 1] = headerCell(`Sls Prc @ ${opts.slsMarginPct}%`, HDR_ONHAND_FILL, "center");
  if (COL_SLS_MRGN_PCT) headerRow[COL_SLS_MRGN_PCT - 1] = headerCell("Mrgn %", HDR_ONHAND_FILL, "center");
  if (COL_SLS_TTL) headerRow[COL_SLS_TTL - 1] = headerCell("Total $", HDR_ONHAND_FILL, "center");
  // T3/LY column labels reflect the customer narrowing AND, when the
  // operator picked a custom date range via Hide ATS data, the actual
  // window the aggregates were computed over. Format examples:
  //   default:                       "T3 Qty"
  //   default + customer:            "T3 Qty (Acme)"
  //   custom range:                  "Sales Jan/01/2026..Mar/31/2026 Qty"
  //   custom range + customer:       "Sales Jan/01/2026..Mar/31/2026 Qty (Acme)"
  // The Qty header is what feeds the planner's eye — the SP LY headers
  // mirror the same convention but use the LY window (custom range
  // shifted back 12 months) so the spreadsheet self-documents both.
  // Dates render as MMM/DD/YYYY (planner preference) rather than the
  // ISO YYYY-MM-DD that the underlying SalesFetchWindows carries.
  const fmtHeaderDate = (iso: string): string => {
    const [yyyy, mm, dd] = iso.split("-");
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const mi = parseInt(mm, 10) - 1;
    if (mi < 0 || mi > 11 || !yyyy || !dd) return iso;
    return `${MONTHS[mi]}/${dd}/${yyyy}`;
  };
  const custTag = customerFilter ? ` (${customerFilter})` : "";
  // Date range now lives on the centered title-row banner (built
  // below as titleRow), not in column headers — operator preference,
  // keeps column headers compact + readable. Headers stay as plain
  // "T3 …" / "S/P LY …" regardless of custom range.
  // Header prefix per planner: "T3" when using the default trailing-3-
  // months window; "TY" (this-year-to-date / picked-window) when the
  // operator selected a custom date range via Hide ATS data. The LY
  // label stays "S/P LY" — same-period-last-year is well-understood
  // and the actual window dates render in the title banner.
  const t3LabelBase = opts.customSalesRangeEnabled ? "TY" : "T3";
  const lyLabelBase = "S/P LY";
  const diffLabelPrefix = opts.customSalesRangeEnabled ? "TY" : "T3";
  if (COL_T3_QTY)     headerRow[COL_T3_QTY     - 1] = headerCell(`${t3LabelBase} Qty${custTag}`, HDR_DARK_FILL, "center");
  if (COL_T3_PRICE)   headerRow[COL_T3_PRICE   - 1] = headerCell(`${t3LabelBase} Sls Price`,     HDR_DARK_FILL, "center");
  if (COL_T3_TTL_SLS) headerRow[COL_T3_TTL_SLS - 1] = headerCell(`${t3LabelBase} Ttl Sls`,       HDR_DARK_FILL, "center");
  if (COL_T3_MRGN)    headerRow[COL_T3_MRGN    - 1] = headerCell(`${t3LabelBase} Mrgn %`,        HDR_DARK_FILL, "center");
  if (COL_LY_QTY)     headerRow[COL_LY_QTY     - 1] = headerCell(`${lyLabelBase} Qty${custTag}`, HDR_DARK_FILL, "center");
  if (COL_LY_PRICE)   headerRow[COL_LY_PRICE   - 1] = headerCell(`${lyLabelBase} Sls Price`,     HDR_DARK_FILL, "center");
  if (COL_LY_TTL_SLS) headerRow[COL_LY_TTL_SLS - 1] = headerCell(`${lyLabelBase} Ttl Sls`,       HDR_DARK_FILL, "center");
  if (COL_LY_MRGN)    headerRow[COL_LY_MRGN    - 1] = headerCell(`${lyLabelBase} Mrgn %`,        HDR_DARK_FILL, "center");
  if (COL_T3_LY_DIFF_QTY)  headerRow[COL_T3_LY_DIFF_QTY  - 1] = headerCell(`${diffLabelPrefix} vs LY Qty`,    HDR_DARK_FILL, "center");
  if (COL_T3_LY_DIFF)      headerRow[COL_T3_LY_DIFF      - 1] = headerCell(`${diffLabelPrefix} vs LY $`,      HDR_DARK_FILL, "center");
  if (COL_T3_LY_DIFF_MRGN) headerRow[COL_T3_LY_DIFF_MRGN - 1] = headerCell(`${diffLabelPrefix} vs LY Mrgn %`, HDR_DARK_FILL, "center");

  // ── Trailing-3 / SP-LY aggregate lookups ──────────────────────────────
  // Pre-fetched maps keyed by ATS-row sku (variant grain). The fetcher
  // queried ip_sales_history_wholesale for the relevant windows already
  // and honored the customer narrow.
  const t3Map = salesAggregates?.t3 ?? new Map<string, SalesAggregate>();
  const lyMap = salesAggregates?.ly ?? new Map<string, SalesAggregate>();
  const t3Of = (sku: string): SalesAggregate => t3Map.get(sku) ?? EMPTY_AGG;
  const lyOf = (sku: string): SalesAggregate => lyMap.get(sku) ?? EMPTY_AGG;
  const t3ByStyleMap = salesAggregates?.t3ByStyle;
  const lastCustPriceMap = salesAggregates?.lastCustomerPriceBySku;
  // Hex colors for the Mrgn % cell font. Blue matches the existing
  // dark-header palette (1F497D); red matches the existing T3-vs-LY
  // negative-diff color (C00000).
  const MRGN_BLUE = "1F497D";
  const MRGN_RED  = "C00000";

  // ── Helpers ────────────────────────────────────────────────────────────
  // Index-aware accessor — periodAvail returns cumulative free at
  // period 0 and per-period new-receipt delta after.
  const periodValueOf = (r: ATSRow, i: number): number => {
    return periodAvail(r, periods, i);
  };
  // SUM range covers ONLY the period columns. Old code started from
  // the spacer at COL.spacerL — the spacer is empty so the cached
  // value was correct, but after hide-zero column drops reflowed the
  // layout, the literal "L:lastPeriod" Excel range over-reached into
  // the Total column itself (Total moves leftward into what was the
  // lastPeriod letter, so the formula now circularly references its
  // own cell). Narrowing the range to firstPeriod:lastPeriod removes
  // that whole class of bug.
  const sumStartLetter = colLetter(COL.firstPeriod);
  const sumEndLetter   = colLetter(COL.lastPeriod);

  // ── BP-level (style_code) max Sls Prc ─────────────────────────────────
  // Operator rule: all variants of the same BP must show the same
  // Sls Prc — pick the HIGHEST formula-derived price across the BP's
  // rows so the most expensive variant doesn't get under-priced.
  // Mirrors the per-row formula (including the explodePpk grain
  // conversion and round-up-to-$0.05). Rows with no master_style or
  // non-positive avgCost are skipped here AND fall through to the
  // per-row formula at body time.
  //
  // OUTLIER GUARD: a single corrupt cost must not become the whole BP's price.
  // Real example (RYB1416, a NON-prepack style): two variants carried a
  // pack-grain unit_cost of 171.60 while every other variant was 7.50 — the
  // 171.60 → $222.90 implied price then propagated to every variant, so normal
  // rows showed a 96.8% margin. A unit/pack mix-up always lands the cost many×
  // the real unit cost, so we drop any variant whose cost exceeds 8× the
  // CHEAPEST variant in the BP before taking the max. Legit same-style
  // variation (rarely > 2×) is well under that; a 12–72-unit pack cost is well
  // over it.
  const COST_OUTLIER_FACTOR = 8;
  // Per-BP cost cap = cheapest variant × 8. A cost above the cap is treated as
  // corrupt (a pack cost mis-keyed as a unit cost) and excluded from BOTH the
  // BP-max implied price AND the grand-total weighted average, so it can't
  // inflate either. Shared via isOutlierCost() below.
  const bpCostCap = new Map<string, number>();
  // Cheapest valued variant per BP (grain-adjusted). Used both for the cap and
  // as the REPRESENTATIVE cost a corrupt-outlier row falls back to, so its
  // Avg Cost / Total Cost / margin render consistently with its siblings.
  const bpMinCost = new Map<string, number>();
  {
    for (const r of rows) {
      const styleKey = r.master_style ?? "";
      if (!styleKey) continue;
      const rMult = (typeof r.ppkMult === "number" && r.ppkMult > 0) ? r.ppkMult : 1;
      const rCostMul = (explodePpk ?? true) ? 1 : rMult;
      const rAvgCost = (r.avgCost ?? 0) * rCostMul;
      if (rAvgCost <= 0) continue;
      const cur = bpMinCost.get(styleKey);
      if (cur === undefined || rAvgCost < cur) bpMinCost.set(styleKey, rAvgCost);
    }
    for (const [k, v] of bpMinCost) bpCostCap.set(k, v * COST_OUTLIER_FACTOR);
  }
  // A grain-adjusted cost is an outlier when the BP has >1 valued variant and
  // the cost exceeds that BP's cap. Single-variant BPs are never flagged.
  const isOutlierCost = (styleKey: string, grainCost: number, bpCount: number): boolean => {
    if (bpCount <= 1) return false;
    const cap = bpCostCap.get(styleKey);
    return cap !== undefined && grainCost > cap;
  };
  // BP variant counts (valued rows) so isOutlierCost can skip single-variant BPs.
  const bpValuedCount = new Map<string, number>();
  for (const r of rows) {
    const styleKey = r.master_style ?? "";
    if (!styleKey) continue;
    const rMult = (typeof r.ppkMult === "number" && r.ppkMult > 0) ? r.ppkMult : 1;
    const rCostMul = (explodePpk ?? true) ? 1 : rMult;
    if ((r.avgCost ?? 0) * rCostMul > 0) bpValuedCount.set(styleKey, (bpValuedCount.get(styleKey) ?? 0) + 1);
  }

  const bpMaxSlsPrc = new Map<string, number>();
  if ((COL_SLS_PRC || COL_SLS_MRGN_PCT) && slsMargin < 1) {
    for (const r of rows) {
      const styleKey = r.master_style ?? "";
      if (!styleKey) continue;
      const rMult = (typeof r.ppkMult === "number" && r.ppkMult > 0) ? r.ppkMult : 1;
      const rCostMul = (explodePpk ?? true) ? 1 : rMult;
      const rAvgCost = (r.avgCost ?? 0) * rCostMul;
      if (rAvgCost <= 0) continue;
      if (isOutlierCost(styleKey, rAvgCost, bpValuedCount.get(styleKey) ?? 1)) continue; // corrupt cost — skip
      const rPrice = Math.ceil((rAvgCost / (1 - slsMargin)) * 20) / 20;
      const cur = bpMaxSlsPrc.get(styleKey);
      if (cur === undefined || rPrice > cur) bpMaxSlsPrc.set(styleKey, rPrice);
    }
  }

  // ── Data rows ──────────────────────────────────────────────────────────
  // Each input row → one qty data row. Prepack rows ALSO produce a
  // PPK suffix row immediately below — but only the PERIOD cells
  // (M-Q) carry a suffix. Every other cell on the prepack pair (text
  // cols A-E, spacers F/H/J/L, qty cols G/I/K, Total R) MERGES across
  // the pair so the qty value sits vertically centered in the taller
  // merged cell. Matches the planner's reference image exactly.
  const dataRows: any[][] = [];
  // Image column support: an empty fill-matched cell per row (so the zebra/band
  // shows behind the thumbnail), plus a per-data-row anchor list the embedded
  // images are built from after the AOA is assembled.
  const imageCell = (f: string): any => ({ v: "", t: "s", s: { fill: { fgColor: { rgb: f }, patternType: "solid" }, alignment: { horizontal: "center", vertical: "center" }, border: BORDER_BODY } });
  const imageAnchors: Array<{ dataIdx: number; img: ExportImage; prepack: boolean }> = [];
  const imageFor = (r: ATSRow): ExportImage | undefined =>
    wantImages ? styleImages!.get(`${(r.master_style ?? "").trim().toUpperCase()}|${(r.master_color ?? "").trim().toUpperCase()}`) : undefined;
  // Title row gets prepended to the AOA when the operator narrows by customer
  // OR picks a custom date range. Both signals are knowable now, well before
  // the title-row block actually constructs the cell. The per-row Total has
  // a `SUM(L<r>:Q<r>)` formula keyed off this row counter — if we start at 2
  // when the title shifts data down by 1, every row's Total formula refers
  // to the row above it (View shows correct static `v:`; Excel opens the
  // file and recalculates → wrong totals).
  const willHaveTitleRow = !!customerFilter
    || !!(opts.customSalesRangeEnabled && salesAggregates?.windows);
  let nextExcelRow = willHaveTitleRow ? 3 : 2;
  // Merge ranges accumulated as we emit prepack pairs.
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [];
  // Cols that get merged across the qty+PPK pair when the input row
  // is a prepack. Period cols are EXCLUDED — those split (qty top,
  // PPK suffix bottom).
  const MERGED_PAIR_COLS = [
    COL.category, COL.subCat, COL.style, COL.description, COL.color,
    COL.spacerF, COL.onHand, COL.spacerH, COL.onOrder, COL.spacerJ, COL.onPO, COL.spacerL,
    COL.total,
    ...([
      COL_SO_PRC,
      COL_AVG_COST, COL_TOT_COST, COL_SLS_PRC, COL_SLS_MRGN_PCT,
      COL_T3_QTY, COL_T3_PRICE, COL_T3_TTL_SLS, COL_T3_MRGN,
      COL_LY_QTY, COL_LY_PRICE, COL_LY_TTL_SLS, COL_LY_MRGN,
      COL_T3_LY_DIFF_QTY, COL_T3_LY_DIFF, COL_T3_LY_DIFF_MRGN,
    ].filter((c): c is number => c !== undefined)),
  ];

  // T3 vs LY % diff cell factory. Formula (per planner):
  //
  //   diff% = (T3 − LY) / T3
  //
  // Reads as "share of T3 that's incremental over LY" rather than
  // standard period-over-period growth (which would divide by LY).
  // With this denominator:
  //   • T3 > 0, LY = 0   →  100% (entire T3 is incremental — what
  //                          used to render as "NEW")
  //   • T3 > 0, LY > 0   →  positive % when T3 > LY, negative when
  //                          T3 < LY (incremental can be negative
  //                          when current period under-performed)
  //   • T3 = 0, LY > 0   →  "Only LY" (no current revenue to compute
  //                          against; would be undefined division).
  //                          Rendered as a muted gray since it's an
  //                          informational tag, not a warning.
  //   • T3 = 0, LY = 0   →  blank (no data either side)
  //
  // Positive renders green, negative renders red. The percent is
  // encoded as a fraction so Excel's "0.0%" format multiplies by 100
  // for display. Cell fill stays whatever baseStyle carries so the
  // row's zebra band is preserved.
  const GREEN_TEXT = "006100";
  const RED_TEXT   = "9C0006";
  const MUTED_TEXT = "999999";
  function t3VsLyCell(t3Val: number, lyVal: number, baseStyle: any): any {
    // NaN sieve. `NaN <= 0` is false, so an upstream NaN sneaks past
    // the value guards below and renders as "NaN%" in Excel. Coerce
    // to 0 first so the existing guards do the right thing.
    if (!Number.isFinite(t3Val)) t3Val = 0;
    if (!Number.isFinite(lyVal)) lyVal = 0;
    if (t3Val <= 0 && lyVal <= 0) {
      return { v: "", t: "s", s: { ...baseStyle, numFmt: "0.0%" } };
    }
    if (t3Val <= 0) {
      // LY had sales, T3 doesn't — formula's denominator is 0. Show
      // "Only LY" as an informational tag (muted gray, not bold red)
      // since it's not a warning, just a state.
      return { v: "Only LY", t: "s", s: {
        ...baseStyle,
        font: { ...(baseStyle.font ?? {}), color: { rgb: MUTED_TEXT } },
      } };
    }
    const frac = (t3Val - lyVal) / t3Val;
    const color = frac >= 0 ? GREEN_TEXT : RED_TEXT;
    return {
      v: frac,
      t: "n",
      s: {
        ...baseStyle,
        font: { ...(baseStyle.font ?? {}), bold: true, color: { rgb: color } },
        numFmt: "0.0%",
      },
    };
  }

  // Margin-diff cell factory. Plain percentage-point subtraction per
  // planner: TY mrgn% − LY mrgn% (e.g. 22% − 19% = 3% green). Distinct
  // from t3VsLyCell's growth-share formula because margins are already
  // percentages — subtracting them gives a meaningful "change in
  // margin points" while dividing would inflate to a weird ratio.
  // Same green/red coloring + 0.0% number format as t3VsLyCell.
  //
  // Inputs are FRACTIONS (0.22 for 22%) — the Excel "0.0%" format
  // multiplies by 100 for display. Edge cases collapse naturally:
  //   • Both 0 (no margin data either side) → blank
  //   • T3 > 0, LY = 0   → positive (full T3 margin shows as the gain)
  //   • T3 = 0, LY > 0   → negative (loss of the prior margin)
  function marginDiffCell(t3Mrgn: number, lyMrgn: number, baseStyle: any): any {
    // Same NaN sieve as t3VsLyCell — protects against an upstream
    // NaN slipping past the === 0 guard and rendering as "NaN%".
    if (!Number.isFinite(t3Mrgn)) t3Mrgn = 0;
    if (!Number.isFinite(lyMrgn)) lyMrgn = 0;
    // Blank when EITHER side is 0/unknown. The export uses 0 as a
    // sentinel for "no margin computable" (either no sales in window,
    // or all contributing rows had suppressed cost from the $0
    // master.unit_cost rule). Subtracting a real margin from a 0
    // sentinel produces a misleading negative diff (e.g. TY="Only LY"
    // qty showing -20.6% diff against LY 20.6%) — not a real decline.
    // Rare cost: a legitimate 0% margin sale (price === cost) will
    // also blank — far less harm than the misleading subtraction.
    if (t3Mrgn === 0 || lyMrgn === 0) {
      return { v: "", t: "s", s: { ...baseStyle, numFmt: "0.0%" } };
    }
    const diff = t3Mrgn - lyMrgn;
    const color = diff >= 0 ? GREEN_TEXT : RED_TEXT;
    return {
      v: diff,
      t: "n",
      s: {
        ...baseStyle,
        font: { ...(baseStyle.font ?? {}), bold: true, color: { rgb: color } },
        numFmt: "0.0%",
      },
    };
  }

  // Detect whether the export spans more than one style. When yes,
  // we'll emit a subtotal row at the end of each style group; when
  // no (single style), the bottom Total row alone is enough.
  const distinctStyles = new Set<string>();
  for (const r of rows) {
    const s = (r.master_style ?? "").trim();
    if (s) distinctStyles.add(s);
  }
  const multiStyle = distinctStyles.size > 1;

  // Subtotal row factory. Sums the given qty / period totals across a
  // style group; styled blue + bold + 12.1pt (= 11pt qty × 1.1, the
  // planner's "+10%" request).
  function buildSubtotalRow(styleLabel: string, group: ATSRow[], excelRow: number): any[] {
    const subtotalFontSize = 12.1;
    const SUB_FILL = FILL_QTY_COL;  // sit on the qty band so the row
                                    // anchors visually against the qty cols
    const subTextStyle: any = {
      font:      { bold: true, sz: subtotalFontSize, color: { rgb: "1F497D" }, name: "Calibri" },
      fill:      { fgColor: { rgb: SUB_FILL }, patternType: "solid" },
      alignment: { horizontal: "left", vertical: "center" },
      border:    BORDER_BODY,
    };
    const subNumStyle: any = {
      font:      { bold: true, sz: subtotalFontSize, color: { rgb: "1F497D" }, name: "Calibri" },
      fill:      { fgColor: { rgb: SUB_FILL }, patternType: "solid" },
      alignment: { horizontal: "center", vertical: "center" },
      border:    BORDER_BODY,
    };
    const onH = group.reduce((a, x) => a + (x.onHand ?? 0), 0);
    // On Order subtotal mirrors the per-row override: when a customer
    // is selected, sum only that customer's SO qty across the group.
    const onO = customerSoMap !== undefined
      ? group.reduce((a, x) => a + (customerSoMap.get(`${x.sku}::${x.store ?? "ROF"}`)?.qty ?? 0), 0)
      : group.reduce((a, x) => a + (x.onOrder ?? 0), 0);
    const onP = group.reduce((a, x) => a + (x.onPO ?? 0), 0);
    // SO Prc subtotal = qty-weighted avg of the group's customer SO
    // unit prices. Only emit when the SO Prc column is allocated AND
    // some row in the group has customer SOs.
    let soPrcSub = 0;
    if (COL_SO_PRC && customerSoMap) {
      let totalQty = 0;
      let totalRev = 0;
      for (const x of group) {
        const e = customerSoMap.get(`${x.sku}::${x.store ?? "ROF"}`);
        if (!e || e.qty <= 0 || e.soPrice <= 0) continue;
        totalQty += e.qty;
        totalRev += e.qty * e.soPrice;
      }
      soPrcSub = totalQty > 0 ? totalRev / totalQty : 0;
    }
    const perPeriod = periods.map((_p, i) => group.reduce((a, x) => a + periodValueOf(x, i), 0));
    const grand = perPeriod.reduce((a, b) => a + b, 0);

    const r2: any[] = new Array(totalColumnCount);
    for (const ci of [COL.category, COL.subCat, COL.style, COL.description]) {
      r2[ci - 1] = { v: "", t: "s", s: subTextStyle };
    }
    r2[COL.color - 1] = { v: `${styleLabel} Subtotal`, t: "s", s: subTextStyle };
    if (COL.image) r2[COL.image - 1] = { v: "", t: "s", s: subTextStyle };
    r2[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
    r2[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
    r2[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
    r2[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
    // Zero subtotal values render as blank — same policy as the body
    // quantity cells.
    const subCell = (v: number) => v === 0
      ? { v: "", t: "s" as const, s: subNumStyle }
      : { v, t: "n" as const, s: subNumStyle };
    r2[COL.onHand  - 1] = subCell(onH);
    r2[COL.onOrder - 1] = subCell(onO);
    if (COL_SO_PRC) {
      r2[COL_SO_PRC - 1] = soPrcSub === 0
        ? { v: "", t: "s" as const, s: { ...subNumStyle, numFmt: "$#,##0.00" } }
        : { v: soPrcSub, t: "n" as const, s: { ...subNumStyle, numFmt: "$#,##0.00" } };
    }
    r2[COL.onPO    - 1] = subCell(onP);
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      r2[ci - 1] = subCell(perPeriod[i]);
    }
    r2[COL.total - 1] = subCell(grand);
    // Total column right-aligned to match the body Total column.
    if (r2[COL.total - 1]?.s) r2[COL.total - 1].s = { ...r2[COL.total - 1].s, alignment: { horizontal: "right", vertical: "center" } };

    // Optional extra columns at subtotal level.
    const subCurr = (v: number) => v === 0
      ? { v: "", t: "s" as const, s: { ...subNumStyle, numFmt: "$#,##0.00" } }
      : { v, t: "n" as const, s: { ...subNumStyle, numFmt: "$#,##0.00" } };
    const subPct = (v: number) => v === 0
      ? { v: "", t: "s" as const, s: { ...subNumStyle, numFmt: "0.0%" } }
      : { v, t: "n" as const, s: { ...subNumStyle, numFmt: "0.0%" } };

    // For avg cost / sls price, weighted-avg across the group (cost
    // weighted by Total qty; sls price is unweighted avg of avgCost-
    // derived prices — there's no qty multiplier on the implied price).
    if (COL_AVG_COST || COL_TOT_COST || COL_SLS_PRC || COL_SLS_MRGN_PCT) {
      let totalQtyForCost = 0;
      let totalCostSum = 0;
      for (const x of group) {
        const xAvg = x.avgCost ?? 0;
        if (xAvg <= 0) continue;
        // Skip per-BP corrupt cost outliers so they don't inflate the subtotal.
        const xKey = x.master_style ?? "";
        const xMult = (typeof x.ppkMult === "number" && x.ppkMult > 0) ? x.ppkMult : 1;
        const xGrain = xAvg * ((explodePpk ?? true) ? 1 : xMult);
        if (xKey && isOutlierCost(xKey, xGrain, bpValuedCount.get(xKey) ?? 1)) continue;
        let xRowTotal = 0;
        for (let i = 0; i < numPeriods; i++) xRowTotal += periodValueOf(x, i);
        totalQtyForCost += xRowTotal;
        totalCostSum += xAvg * xRowTotal;
      }
      const weightedAvgCost = totalQtyForCost > 0 ? totalCostSum / totalQtyForCost : 0;
      // Subtotal Sls Prc: when every row in the group belongs to the
      // same BP (style-level subtotal), match the per-row priority:
      //   1. Customer-T3 BP price when customer is selected and that
      //      BP has customer T3 sales.
      //   2. BP-max formula otherwise.
      // For mixed-BP groups (Category / Sub Category subtotals) fall
      // back to the weighted-avg-derived formula price.
      let groupSlsPrcOverride: number | undefined;
      if (group.length > 0) {
        const firstStyle = group[0].master_style ?? "";
        if (firstStyle && group.every(x => (x.master_style ?? "") === firstStyle)) {
          if (customerFilter) {
            const sAgg = t3ByStyleMap?.get(firstStyle);
            if (sAgg && sAgg.qty > 0 && sAgg.totalPrice > 0) {
              groupSlsPrcOverride = sAgg.totalPrice / sAgg.qty;
            }
          }
          if (groupSlsPrcOverride === undefined) {
            groupSlsPrcOverride = bpMaxSlsPrc.get(firstStyle);
          }
        }
      }
      // Round UP to the nearest $0.05 to match the per-row Sls Prc rule
      // (only when falling through to the formula path; customer-T3 and
      // BP-max are already at their canonical values).
      const slsPrcW = groupSlsPrcOverride !== undefined
        ? groupSlsPrcOverride
        : ((weightedAvgCost > 0 && slsMargin < 1)
            ? Math.ceil((weightedAvgCost / (1 - slsMargin)) * 20) / 20
            : 0);
      if (COL_AVG_COST) r2[COL_AVG_COST - 1] = subCurr(weightedAvgCost);
      if (COL_TOT_COST) r2[COL_TOT_COST - 1] = subCurr(totalCostSum);
      if (COL_SLS_PRC)  r2[COL_SLS_PRC  - 1] = subCurr(slsPrcW);
      // Subtotal Mrgn % uses the formula-derived weighted price — keeps
      // the subtotal grain-clean. Per-row color overrides aren't carried
      // up because subtotals can mix red/blue/default sources.
      if (COL_SLS_MRGN_PCT) {
        const subMrgn = (weightedAvgCost > 0 && slsPrcW > 0)
          ? (slsPrcW - weightedAvgCost) / slsPrcW
          : 0;
        if (slsPrcFormulaMode && COL_SLS_PRC && COL_AVG_COST) {
          // Buyer worksheet: live formula off this subtotal row's own Sls Prc +
          // Avg Cost cells, so editing the subtotal price updates its margin.
          const slsRef = `${colLetter(COL_SLS_PRC)}${excelRow}`;
          const costRef = `${colLetter(COL_AVG_COST)}${excelRow}`;
          r2[COL_SLS_MRGN_PCT - 1] = (slsPrcW > 0 && weightedAvgCost > 0)
            ? { v: subMrgn, f: `IF(${slsRef}=0,"",(${slsRef}-${costRef})/${slsRef})`, t: "n", s: { ...subNumStyle, numFmt: "0.0%" } }
            : subPct(subMrgn);
        } else {
          r2[COL_SLS_MRGN_PCT - 1] = subPct(subMrgn);
        }
      }
      // Subtotal Total $ (Buyer worksheet only — COL_SLS_TTL exists only then):
      // a live formula = this subtotal's Sls Prc × its Total qty, so editing the
      // subtotal price updates it.
      if (COL_SLS_TTL) {
        let groupQty = 0;
        for (const x of group) for (let i = 0; i < numPeriods; i++) groupQty += periodValueOf(x, i);
        const ttl = slsPrcW > 0 ? slsPrcW * groupQty : 0;
        const slsRef = COL_SLS_PRC ? `${colLetter(COL_SLS_PRC)}${excelRow}` : "";
        const totRef = `${colLetter(COL.total)}${excelRow}`;
        r2[COL_SLS_TTL - 1] = (slsRef && slsPrcW > 0 && groupQty > 0)
          ? { v: ttl, f: `IF(${slsRef}="",0,${slsRef}*${totRef})`, t: "n", s: { ...subNumStyle, numFmt: "$#,##0.00" } }
          : subCurr(ttl);
      }
    }

    // Subtotal T3 / LY: sales qty is now at unit grain in the DB
    // (qty_units, populated by the nightly sync), so we display it
    // directly — no /qtyDiv. Explode-PPK toggle only affects ATS columns
    // (on-hand / on-PO / on-SO) where compute.ts still applies the
    // per-row ppkMult. Margin % = aggregated margin_amount / totalPrice,
    // also from the DB; no per-export cost-cascade recomputation.
    //
    // Hoist subT3MrgnPct + subLYMrgnPct so the downstream diff-mrgn
    // cell can read both percentages even when only one toggle is on.
    let subT3MrgnPct = 0;
    let subLYMrgnPct = 0;
    if (opts.trailing3) {
      let qtyDisp = 0, totalPrice = 0, totalMargin = 0;
      for (const x of group) {
        const xT3 = t3Of(x.sku);
        qtyDisp += xT3.qty;
        totalPrice += xT3.totalPrice;
        totalMargin += xT3.marginAmount;
      }
      const price = qtyDisp > 0 ? totalPrice / qtyDisp : 0;
      subT3MrgnPct = totalPrice > 0 ? (totalMargin / totalPrice) * 100 : 0;
      if (COL_T3_QTY)     r2[COL_T3_QTY     - 1] = subCell(qtyDisp);
      if (COL_T3_PRICE)   r2[COL_T3_PRICE   - 1] = subCurr(price);
      if (COL_T3_TTL_SLS) r2[COL_T3_TTL_SLS - 1] = subCurr(totalPrice);
      if (COL_T3_MRGN)    r2[COL_T3_MRGN    - 1] = subPct(subT3MrgnPct / 100);
    }
    if (opts.spLY) {
      let qtyDisp = 0, totalPrice = 0, totalMargin = 0;
      for (const x of group) {
        const xLY = lyOf(x.sku);
        qtyDisp += xLY.qty;
        totalPrice += xLY.totalPrice;
        totalMargin += xLY.marginAmount;
      }
      const price = qtyDisp > 0 ? totalPrice / qtyDisp : 0;
      subLYMrgnPct = totalPrice > 0 ? (totalMargin / totalPrice) * 100 : 0;
      if (COL_LY_QTY)     r2[COL_LY_QTY     - 1] = subCell(qtyDisp);
      if (COL_LY_PRICE)   r2[COL_LY_PRICE   - 1] = subCurr(price);
      if (COL_LY_TTL_SLS) r2[COL_LY_TTL_SLS - 1] = subCurr(totalPrice);
      if (COL_LY_MRGN)    r2[COL_LY_MRGN    - 1] = subPct(subLYMrgnPct / 100);
    }

    // T3 vs LY at subtotal grain — plain growth math: sum every row's
    // T3 and LY, then (sum_T3 − sum_LY) / sum_LY. Matches what the
    // operator gets by hand-dividing the subtotal's T3 Ttl Sls and
    // LY Ttl Sls cells directly above this row. NEW rows (T3 > 0,
    // LY = 0) and Only-LY rows (T3 = 0, LY > 0) contribute to one side
    // and not the other — that's correct: growth on a NEW SKU has no
    // baseline so its T3 sales legitimately inflate the numerator
    // against the unchanged denominator.
    if (COL_T3_LY_DIFF_QTY || COL_T3_LY_DIFF || COL_T3_LY_DIFF_MRGN) {
      let t3SumQ = 0, lySumQ = 0, t3SumP = 0, lySumP = 0;
      for (const x of group) {
        const t = t3Of(x.sku);
        const l = lyOf(x.sku);
        t3SumQ += t.qty;
        lySumQ += l.qty;
        t3SumP += t.totalPrice;
        lySumP += l.totalPrice;
      }
      if (COL_T3_LY_DIFF_QTY)  r2[COL_T3_LY_DIFF_QTY  - 1] = t3VsLyCell(t3SumQ, lySumQ, subNumStyle);
      if (COL_T3_LY_DIFF)      r2[COL_T3_LY_DIFF      - 1] = t3VsLyCell(t3SumP, lySumP, subNumStyle);
      // Subtotal margin diff: plain TY mrgn% − LY mrgn%. Inputs are
      // percent-scale; convert to fractions for the 0.0% Excel format.
      if (COL_T3_LY_DIFF_MRGN) r2[COL_T3_LY_DIFF_MRGN - 1] = marginDiffCell(subT3MrgnPct / 100, subLYMrgnPct / 100, subNumStyle);
    }

    return r2;
  }

  // Track the rows in the current style group so the subtotal row at
  // the boundary can sum across them.
  let currentGroup: ATSRow[] = [];
  let currentGroupStyle = "";

  function flushGroupSubtotal() {
    if (!multiStyle) { currentGroup = []; return; }
    if (currentGroup.length === 0) return;
    // Modal opt-out: operator can disable subtotal rows entirely.
    if (!opts.subtotals) { currentGroup = []; return; }
    // Skip single-row style groups — the lone qty row already shows the
    // totals, so a subtotal would just repeat the same numbers.
    if (currentGroup.length === 1) { currentGroup = []; return; }
    dataRows.push(buildSubtotalRow(currentGroupStyle, currentGroup, nextExcelRow));
    nextExcelRow++;
    currentGroup = [];
  }

  rows.forEach((r, ri) => {
    const rowStyle = (r.master_style ?? "").trim();
    // If style changed from the previous row, close the previous
    // group with a subtotal (when applicable) before emitting this
    // row into the new group.
    if (multiStyle && currentGroup.length > 0 && rowStyle !== currentGroupStyle) {
      flushGroupSubtotal();
    }
    currentGroupStyle = rowStyle;
    currentGroup.push(r);

    const isEvenInputRow = (ri % 2) === 0;
    const fill = isEvenInputRow ? FILL_EVEN : FILL_ODD;
    const qtyExcelRow = nextExcelRow;
    // Guard against ppkMult=0 from data-quality outliers (rows with a
    // zeroed pack_size after a botched master refresh). `?? 1` only
    // fires on null/undefined; a numeric 0 falls through and causes a
    // divide-by-zero downstream that turns every qty cell into NaN.
    const mult = (typeof r.ppkMult === "number" && r.ppkMult > 0) ? r.ppkMult : 1;
    const isPrepack = mult > 1;
    // Grain divisor for display. Row qty fields + period values come
    // in at UNIT grain (computeRowsFromExcelData stores onHand*ppkMult);
    // costs come in at per-UNIT. When the grid's Explode-PPK toggle is
    // OFF we render the row in PACK grain — divide qty fields by mult,
    // multiply cost fields by mult. Non-prepack rows (mult=1) are a
    // no-op either way.
    const qtyDiv  = explodePpk ? 1 : mult;
    const costMul = explodePpk ? 1 : mult;

    // ── Qty row ──────────────────────────────────────────────────────────
    const qtyRow: any[] = new Array(totalColumnCount);
    if (COL.image) qtyRow[COL.image - 1] = imageCell(fill);
    qtyRow[COL.category    - 1] = { v: r.master_category ?? r.category ?? "", t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.subCat      - 1] = { v: r.master_sub_category ?? "",            t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.style       - 1] = { v: r.master_style ?? "",                   t: "s", s: bodyStyleStyle(fill) };
    qtyRow[COL.description - 1] = { v: r.master_description ?? r.description ?? "", t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.color       - 1] = { v: displayColor(r),                        t: "s", s: bodyTextStyle(fill) };

    qtyRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };

    // On Hand / On Order / On PO — single shared fill (FILL_QTY_COL),
    // not zebra. Reads as a coherent qty band between the zebra text
    // cols on the left and the period cols on the right. Per planner,
    // zero values in any of the three qty cols render with the SAME
    // blue fill + same font as non-zero cells — no red highlight on
    // On Hand zeros (the live grid has its own visual cues for zero
    // stock; the export stays uniform).
    // Zero qty → blank string cell (the planner doesn't want "0"
    // cluttering quantity columns). Style stays so borders / fills
    // remain consistent.
    const onHandV  = (r.onHand  ?? 0) / qtyDiv;
    // On Order display:
    //   - default: row's full onOrder (sum of all SO commitments)
    //   - when customer is selected: narrow to the selected customer's
    //     SO qty via customerSoMap. Per-period drawdowns inside the
    //     date columns intentionally stay unfiltered — operator picked
    //     "Only the export's On Order" scope explicitly.
    const customerSoEntry = customerSoMap?.get(`${r.sku}::${r.store ?? "ROF"}`);
    const onOrderRaw = customerSoMap !== undefined
      ? (customerSoEntry?.qty ?? 0)
      : (r.onOrder ?? 0);
    const onOrderV = onOrderRaw / qtyDiv;
    const onPOV    = (r.onPO    ?? 0) / qtyDiv;
    qtyRow[COL.onHand  - 1] = onHandV  === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onHandV,  t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    qtyRow[COL.onOrder - 1] = onOrderV === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onOrderV, t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    qtyRow[COL.onPO    - 1] = onPOV    === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onPOV,    t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    // SO Prc — qty-weighted avg unit price of the customer's matching
    // SOs for this row. The map stores per-UNIT price (NavBar divides
    // by mult when ingesting from Xoro's per-PACK SO data). Apply
    // costMul on display so pack mode (explodePpk=false) shows the
    // per-pack price and unit mode shows the per-unit price.
    if (COL_SO_PRC) {
      const soPrcUnit = customerSoEntry?.soPrice ?? 0;
      const soPrcDisplay = soPrcUnit * costMul;
      qtyRow[COL_SO_PRC - 1] = soPrcDisplay === 0
        ? { v: "", t: "s", s: { ...bodyNumStyle(FILL_QTY_COL), numFmt: "$#,##0.00" } }
        : { v: soPrcDisplay, t: "n", s: { ...bodyNumStyle(FILL_QTY_COL), numFmt: "$#,##0.00" } };
    }

    // Period cells. For prepack rows the qty sits at the BOTTOM of
    // its cell (anchored to the bottom edge) so the PPK suffix on the
    // row below visually sits flush against it. Non-prepack rows get
    // standard center alignment.
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      const n = periodValueOf(r, i) / qtyDiv;
      const baseStyle = isPrepack ? periodQtyStyle(fill) : bodyNumStyle(fill);
      if (n === 0) {
        qtyRow[ci - 1] = { v: "", t: "s", s: baseStyle };
        continue;
      }
      const style = (n > 0 && n <= 10) ? lowStockStyle(baseStyle) : baseStyle;
      qtyRow[ci - 1] = { v: n, t: "n", s: style };
    }

    // Total — formula PLUS pre-computed cached value so the cell
    // shows the number immediately (Excel won't recalc until the
    // user opens the workbook with calc enabled; without `v`, the
    // cell renders empty until recalc runs).
    let rowPeriodTotal = 0;
    for (let i = 0; i < numPeriods; i++) {
      rowPeriodTotal += periodValueOf(r, i) / qtyDiv;
    }
    // Zero row total → blank cell (no formula either — keeping the
    // SUM formula would still render "0" on recalc in Excel).
    qtyRow[COL.total - 1] = rowPeriodTotal === 0
      ? { v: "", t: "s", s: bodyTotalStyle(fill) }
      : {
          v: rowPeriodTotal,
          f: `SUM(${sumStartLetter}${qtyExcelRow}:${sumEndLetter}${qtyExcelRow})`,
          t: "n",
          s: bodyTotalStyle(fill),
        };

    // ── Optional extra columns ─────────────────────────────────────────
    // avgCost on the row is per-UNIT. When the grid is in pack mode
    // (explodePpk=false) we display it per-PACK by multiplying by
    // ppkMult so the operator sees the same grain as the grid.
    const rawAvgCostV = (r.avgCost ?? 0) * costMul;
    // A corrupt per-BP outlier cost (e.g. a pack cost mis-keyed as a unit cost,
    // like RYB1416's 171.60 vs the real 7.50) falls back to the BP's
    // representative (cheapest) cost, so this row's Avg Cost / Total Cost /
    // margin render consistently with its siblings instead of a wild negative
    // margin. The implied Sls Prc was already BP-uniform, so this keeps the
    // whole row coherent.
    const styleKeyForCost = r.master_style ?? "";
    const bpRepCost = bpMinCost.get(styleKeyForCost);
    const avgCostV = (bpRepCost != null && isOutlierCost(styleKeyForCost, rawAvgCostV, bpValuedCount.get(styleKeyForCost) ?? 1))
      ? bpRepCost
      : rawAvgCostV;
    // Total cost = avgCost × the row's total qty across periods.
    // Both avgCostV and rowPeriodTotal have already been scaled by
    // costMul / qtyDiv (inverses); the product is grain-invariant.
    const totalCostV = avgCostV > 0 ? avgCostV * rowPeriodTotal : 0;
    // Implied sale price needed to hit `slsMarginPct` against avgCost.
    // Priority (highest first):
    //   1. If a customer is selected AND that customer has T3 sales for
    //      ANY variant of this BP, use the customer's actual BP-level
    //      T3 avg sale price (sum(totalPrice)/sum(qty) across all the
    //      BP's variants for this customer, from t3ByStyleMap). Same
    //      price applies to EVERY row of the BP — not just the variant
    //      that had T3 sales. No rounding (it's a real avg).
    //   2. BP-uniform: every row of the same master_style shows the
    //      HIGHEST formula-derived price across the BP's variants —
    //      from bpMaxSlsPrc.
    //   3. Per-row formula: avgCost / (1 - margin), rounded UP to $0.05.
    const styleKeyForSlsPrc = r.master_style ?? "";
    const custT3StylePrice = (() => {
      if (!customerFilter || !styleKeyForSlsPrc) return 0;
      const sAgg = t3ByStyleMap?.get(styleKeyForSlsPrc);
      if (!sAgg || sAgg.qty <= 0 || sAgg.totalPrice <= 0) return 0;
      return sAgg.totalPrice / sAgg.qty;
    })();
    const slsPrcV = (avgCostV > 0 && slsMargin < 1)
      ? (custT3StylePrice > 0
          ? custT3StylePrice
          : (styleKeyForSlsPrc && bpMaxSlsPrc.has(styleKeyForSlsPrc)
              ? bpMaxSlsPrc.get(styleKeyForSlsPrc)!
              : Math.ceil((avgCostV / (1 - slsMargin)) * 20) / 20))
      : 0;
    if (COL_AVG_COST) qtyRow[COL_AVG_COST - 1] = avgCostV === 0
      ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
      : { v: avgCostV, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };
    if (COL_TOT_COST) qtyRow[COL_TOT_COST - 1] = totalCostV === 0
      ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
      : { v: totalCostV, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };
    // Sls Prc — the implied unit sale price. Stays an editable VALUE so the
    // operator can override it in Excel; Mrgn % + Total $ below are live
    // formulas keyed off this cell, so editing it recomputes both.
    if (COL_SLS_PRC) qtyRow[COL_SLS_PRC - 1] = slsPrcV === 0
      ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
      : { v: slsPrcV, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };

    // Mrgn %. Buyer worksheet → LIVE formula = (Sls Prc − Avg Cost) / Sls Prc,
    // referencing the INLINE Avg Cost cell on the same sheet, so editing the
    // Sls Prc recomputes the margin. Otherwise (plain Sls Prc @ Margin) keep
    // the original static value with its customer-T3 / last-price priority +
    // blue/red coloring.
    if (COL_SLS_MRGN_PCT) {
      if (slsPrcFormulaMode && COL_AVG_COST) {
        const m = (slsPrcV > 0 && avgCostV > 0) ? (slsPrcV - avgCostV) / slsPrcV : 0;
        const styled = { ...bodyNumStyle(fill), numFmt: "0.0%" };
        const slsRef = COL_SLS_PRC ? `${colLetter(COL_SLS_PRC)}${qtyExcelRow}` : "";
        const costRef = `${colLetter(COL_AVG_COST)}${qtyExcelRow}`;
        qtyRow[COL_SLS_MRGN_PCT - 1] = (slsPrcV > 0 && avgCostV > 0)
          ? { v: m, f: `IF(${slsRef}=0,"",(${slsRef}-${costRef})/${slsRef})`, t: "n", s: styled }
          : { v: "", t: "s", s: styled };
      } else {
        let derivedPrice = slsPrcV;
        let mrgnColor: "default" | "blue" | "red" = "default";
        if (avgCostV > 0) {
          const styleKey = r.master_style ?? "";
          const sAgg = styleKey ? t3ByStyleMap?.get(styleKey) : undefined;
          if (sAgg && sAgg.qty > 0 && sAgg.totalPrice > 0) {
            derivedPrice = sAgg.totalPrice / sAgg.qty;
            mrgnColor = "blue";
          }
          const cl = lastCustPriceMap?.get(r.sku);
          if (cl && cl.price > 0) {
            derivedPrice = cl.price;
            mrgnColor = "red";
          }
        }
        const m = (derivedPrice > 0 && avgCostV > 0) ? (derivedPrice - avgCostV) / derivedPrice : 0;
        const base = bodyNumStyle(fill);
        const styled = mrgnColor === "default"
          ? { ...base, numFmt: "0.0%" }
          : { ...base, numFmt: "0.0%", font: { ...base.font, bold: true, color: { rgb: mrgnColor === "blue" ? MRGN_BLUE : MRGN_RED } } };
        qtyRow[COL_SLS_MRGN_PCT - 1] = m === 0
          ? { v: "", t: "s", s: styled }
          : { v: m, t: "n", s: styled };
      }
    }

    // Total $ — LIVE formula = Sls Prc × Total qty. Recomputes on a price edit.
    if (COL_SLS_TTL) {
      const slsRef = COL_SLS_PRC ? `${colLetter(COL_SLS_PRC)}${qtyExcelRow}` : "";
      const totRef = `${colLetter(COL.total)}${qtyExcelRow}`;
      const totalSls = slsPrcV * rowPeriodTotal;
      const styled = { ...bodyNumStyle(fill), numFmt: "$#,##0.00" };
      qtyRow[COL_SLS_TTL - 1] = (slsPrcV > 0 && rowPeriodTotal > 0)
        ? { v: totalSls, f: `IF(${slsRef}="",0,${slsRef}*${totRef})`, t: "n", s: styled }
        : { v: "", t: "s", s: styled };
    }

    // Trailing 3 — sales over the last 3 months from today, optionally
    // narrowed to one customer. Sales qty is now at unit grain in the
    // DB (qty_units, populated by the nightly sync). Display as-is —
    // the Explode-PPK toggle only affects ATS columns above (on-hand /
    // on-PO / on-SO), not sales. Margin % is the aggregated
    // margin_amount / totalPrice from the DB, eliminating the old
    // per-export master-cost recomputation that was producing
    // grain-confused margins.
    //
    // Hoist t3MrgnPct + lyMrgnPct out of the if blocks so the
    // downstream "T3 vs LY Mrgn %" diff cell can read both even when
    // only one block runs.
    let t3MrgnPct = 0;
    let lyMrgnPct = 0;
    if (opts.trailing3) {
      const t3 = t3Of(r.sku);
      const t3Qty   = t3.qty;
      const t3Price = t3Qty > 0 ? t3.totalPrice / t3Qty : 0;
      t3MrgnPct = t3.totalPrice > 0 ? (t3.marginAmount / t3.totalPrice) * 100 : 0;
      if (COL_T3_QTY)     qtyRow[COL_T3_QTY     - 1] = t3Qty === 0
        ? { v: "", t: "s", s: bodyNumStyle(fill) }
        : { v: t3Qty, t: "n", s: bodyNumStyle(fill) };
      if (COL_T3_PRICE)   qtyRow[COL_T3_PRICE   - 1] = t3Price === 0
        ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
        : { v: t3Price, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };
      if (COL_T3_TTL_SLS) qtyRow[COL_T3_TTL_SLS - 1] = t3.totalPrice === 0
        ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
        : { v: t3.totalPrice, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };
      if (COL_T3_MRGN)    qtyRow[COL_T3_MRGN    - 1] = t3MrgnPct === 0
        ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "0.0%" } }
        : { v: t3MrgnPct / 100, t: "n", s: { ...bodyNumStyle(fill), numFmt: "0.0%" } };
    }

    // Same-Period Last Year — same rules as T3.
    if (opts.spLY) {
      const ly = lyOf(r.sku);
      const lyQty   = ly.qty;
      const lyPrice = lyQty > 0 ? ly.totalPrice / lyQty : 0;
      lyMrgnPct = ly.totalPrice > 0 ? (ly.marginAmount / ly.totalPrice) * 100 : 0;
      if (COL_LY_QTY)     qtyRow[COL_LY_QTY     - 1] = lyQty === 0
        ? { v: "", t: "s", s: bodyNumStyle(fill) }
        : { v: lyQty, t: "n", s: bodyNumStyle(fill) };
      if (COL_LY_PRICE)   qtyRow[COL_LY_PRICE   - 1] = lyPrice === 0
        ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
        : { v: lyPrice, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };
      if (COL_LY_TTL_SLS) qtyRow[COL_LY_TTL_SLS - 1] = ly.totalPrice === 0
        ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
        : { v: ly.totalPrice, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };
      if (COL_LY_MRGN)    qtyRow[COL_LY_MRGN    - 1] = lyMrgnPct === 0
        ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "0.0%" } }
        : { v: lyMrgnPct / 100, t: "n", s: { ...bodyNumStyle(fill), numFmt: "0.0%" } };
    }

    // T3 vs LY % diff — qty (volume), $ (revenue), and margin %.
    // All three use the same factory: diff = (t3 − ly) / t3. Qty + $
    // ratios are grain-invariant; margin % is a percentage already so
    // grain doesn't apply. The margin-diff column reads the t3MrgnPct
    // + lyMrgnPct values computed above in the per-row blocks.
    if (COL_T3_LY_DIFF_QTY || COL_T3_LY_DIFF || COL_T3_LY_DIFF_MRGN) {
      const t3 = t3Of(r.sku);
      const ly = lyOf(r.sku);
      if (COL_T3_LY_DIFF_QTY)  qtyRow[COL_T3_LY_DIFF_QTY  - 1] = t3VsLyCell(t3.qty, ly.qty, bodyNumStyle(fill));
      if (COL_T3_LY_DIFF)      qtyRow[COL_T3_LY_DIFF      - 1] = t3VsLyCell(t3.totalPrice, ly.totalPrice, bodyNumStyle(fill));
      // Margin diff: plain percentage-point subtraction (TY mrgn% − LY mrgn%).
      // Inputs here are percent-scale (e.g. 22 for 22%); convert to
      // fractions before passing so the "0.0%" Excel format renders
      // correctly (Excel multiplies by 100 for display).
      if (COL_T3_LY_DIFF_MRGN) qtyRow[COL_T3_LY_DIFF_MRGN - 1] = marginDiffCell(t3MrgnPct / 100, lyMrgnPct / 100, bodyNumStyle(fill));
    }

    if (wantImages) { const im = imageFor(r); if (im) imageAnchors.push({ dataIdx: dataRows.length, img: im, prepack: isPrepack }); }
    dataRows.push(qtyRow);
    nextExcelRow++;

    // ── PPK suffix follower row (only for prepack rows) ──────────────────
    if (isPrepack) {
      const ppkRow: any[] = new Array(totalColumnCount);
      // Text cols + spacers + qty cols + total: blank — they're MERGED
      // with the qty row above. Excel ignores the values in non-top
      // cells of a merge anyway, but keeping the styling consistent
      // avoids weird ghost-cell artifacts in some viewers.
      const blankFill = (s: any) => ({ v: "", t: "s", s });
      qtyRow[COL.category    - 1].s = { ...qtyRow[COL.category    - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.subCat      - 1].s = { ...qtyRow[COL.subCat      - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.style       - 1].s = { ...qtyRow[COL.style       - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.description - 1].s = { ...qtyRow[COL.description - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.color       - 1].s = { ...qtyRow[COL.color       - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.onHand      - 1].s = { ...qtyRow[COL.onHand      - 1].s, alignment: { horizontal: "center", vertical: "center" } };
      qtyRow[COL.onOrder     - 1].s = { ...qtyRow[COL.onOrder     - 1].s, alignment: { horizontal: "center", vertical: "center" } };
      qtyRow[COL.onPO        - 1].s = { ...qtyRow[COL.onPO        - 1].s, alignment: { horizontal: "center", vertical: "center" } };
      qtyRow[COL.total       - 1].s = { ...qtyRow[COL.total       - 1].s, alignment: { horizontal: "right",  vertical: "center" } };

      ppkRow[COL.category    - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.subCat      - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.style       - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.description - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.color       - 1] = blankFill(bodyTextStyle(fill));
      if (COL.image) ppkRow[COL.image - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.onHand  - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));
      ppkRow[COL.onOrder - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));
      if (COL_SO_PRC) ppkRow[COL_SO_PRC - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));
      ppkRow[COL.onPO    - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));

      // Period cells: PPK suffix only where qty > 0; otherwise blank.
      for (let i = 0; i < numPeriods; i++) {
        const ci = COL.firstPeriod + i;
        const n = periodValueOf(r, i);
        if (n === 0) {
          ppkRow[ci - 1] = { v: "", t: "s", s: periodPpkStyle(fill) };
          continue;
        }
        const packs = Math.round(n / mult);
        ppkRow[ci - 1] = {
          v: `PPK${mult} × ${packs.toLocaleString()}`,
          t: "s",
          s: periodPpkStyle(fill),
        };
      }
      ppkRow[COL.total - 1] = { v: "", t: "s", s: bodyTotalStyle(fill) };

      // Optional extra cols on the PPK follower row — blank with the
      // same style as the qty row's matching cell so the merge looks
      // clean and the outline finalizer sees a real cell to border.
      for (const ci of [COL_SO_PRC, COL_AVG_COST, COL_TOT_COST, COL_SLS_PRC, COL_SLS_MRGN_PCT, COL_SLS_TTL, COL_T3_QTY, COL_T3_PRICE, COL_T3_TTL_SLS, COL_T3_MRGN, COL_LY_QTY, COL_LY_PRICE, COL_LY_TTL_SLS, COL_LY_MRGN, COL_T3_LY_DIFF_QTY, COL_T3_LY_DIFF, COL_T3_LY_DIFF_MRGN]) {
        if (ci !== undefined) ppkRow[ci - 1] = blankFill(bodyNumStyle(fill));
      }

      dataRows.push(ppkRow);
      const ppkExcelRow = nextExcelRow;
      nextExcelRow++;

      for (const ci of MERGED_PAIR_COLS) {
        merges.push({
          s: { r: qtyExcelRow - 1, c: ci - 1 },
          e: { r: ppkExcelRow - 1, c: ci - 1 },
        });
      }
    }
  });
  // Final group's subtotal (no next-row to trigger the boundary).
  flushGroupSubtotal();

  // ── Bottom totals ──────────────────────────────────────────────────────
  // Two modes, depending on whether the on-screen totals toggle is on:
  //   - Toggle ON  → 5-row stack (TOTAL Qty / Cost $ / Sale $ / Mrgn $ /
  //                  Mrgn %) using the supplied GridTotals.
  //   - Toggle OFF → single Total row with per-column qty sums (On Hand,
  //                  On Order, On PO, every period, grand total). No
  //                  Cost / Sale / Margin lines (those need GridTotals
  //                  which is only computed when the toggle is on).
  // Either way, the export always closes with at least one bottom row
  // so the column totals are readable at a glance.
  const totalNumStyle: any = {
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: FILL_EVEN }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_TOTAL,
  };
  const totalLabelStyle: any = {
    ...bodyTextStyle(FILL_EVEN),
    font: { bold: true, sz: 11, name: "Calibri" },
  };
  const periodSums: number[] = periods.map((_p, i) =>
    rows.reduce((acc, r) => acc + periodValueOf(r, i), 0),
  );

  function buildStackRow(label: string, getQty: (k: "onHand" | "onOrder" | "onPO") => string | number, getPeriod: (key: string) => string | number, getRowTotal: () => string | number) {
    const cells: any[] = new Array(totalColumnCount);
    for (const ci of [COL.category, COL.subCat, COL.style, COL.description]) {
      cells[ci - 1] = { v: "", t: "s", s: totalLabelStyle };
    }
    cells[COL.color - 1] = { v: label, t: "s", s: totalLabelStyle };
    if (COL.image) cells[COL.image - 1] = { v: "", t: "s", s: totalLabelStyle };
    cells[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
    cells[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
    cells[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
    cells[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
    // Zero-value cells render as blank. Handles numeric zeros and
    // empty strings from fmtUSD / safePct (which return "" for n=0).
    const cellFor = (v: string | number) => (v === 0 || v === "")
      ? { v: "", t: "s" as const, s: totalNumStyle }
      : { v, t: typeof v === "number" ? "n" as const : "s" as const, s: totalNumStyle };
    cells[COL.onHand  - 1] = cellFor(getQty("onHand"));
    cells[COL.onOrder - 1] = cellFor(getQty("onOrder"));
    cells[COL.onPO    - 1] = cellFor(getQty("onPO"));
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      // GridTotals.periodQty is keyed by period.endDate (== key).
      cells[ci - 1] = cellFor(getPeriod(periods[i].endDate));
    }
    cells[COL.total - 1] = cellFor(getRowTotal());
    // Right-align the grand-total Total cell to match the body Total column.
    if (cells[COL.total - 1]?.s) cells[COL.total - 1].s = { ...cells[COL.total - 1].s, alignment: { horizontal: "right", vertical: "center" } };
    // Fill any optional extra columns with blank styled cells so the
    // outline finalizer + autofit see real cells and the bottom row
    // closes the table cleanly across its full width. Callers that
    // want real aggregates patch these in after.
    const optCols = [COL_SO_PRC, COL_AVG_COST, COL_TOT_COST, COL_SLS_PRC, COL_SLS_MRGN_PCT, COL_SLS_TTL, COL_T3_QTY, COL_T3_PRICE, COL_T3_TTL_SLS, COL_T3_MRGN, COL_LY_QTY, COL_LY_PRICE, COL_LY_TTL_SLS, COL_LY_MRGN, COL_T3_LY_DIFF_QTY, COL_T3_LY_DIFF, COL_T3_LY_DIFF_MRGN];
    for (const ci of optCols) {
      if (ci !== undefined) cells[ci - 1] = { v: "", t: "s", s: totalNumStyle };
    }
    return cells;
  }

  // Aggregate helper for the bottom Total row's optional cols. Computes
  // weighted avgs / sums across every visible row.
  function computeOptColAggregates() {
    let qtyForCost = 0;
    let costSum = 0;
    for (const r of rows) {
      const a = r.avgCost ?? 0;
      if (a <= 0) continue;
      // Exclude per-BP corrupt cost outliers (see isOutlierCost) so a mis-keyed
      // pack cost can't inflate the grand-total weighted avg / implied price.
      const styleKey = r.master_style ?? "";
      const rMult = (typeof r.ppkMult === "number" && r.ppkMult > 0) ? r.ppkMult : 1;
      const grainCost = a * ((explodePpk ?? true) ? 1 : rMult);
      if (styleKey && isOutlierCost(styleKey, grainCost, bpValuedCount.get(styleKey) ?? 1)) continue;
      let q = 0;
      for (let i = 0; i < numPeriods; i++) q += periodValueOf(r, i);
      qtyForCost += q;
      costSum    += a * q;
    }
    const avgCostW = qtyForCost > 0 ? costSum / qtyForCost : 0;
    // Round UP to nearest $0.05 — matches the per-row and subtotal rule.
    const slsPrcW = (avgCostW > 0 && slsMargin < 1)
      ? Math.ceil((avgCostW / (1 - slsMargin)) * 20) / 20
      : 0;
    const slsMrgnW = (avgCostW > 0 && slsPrcW > 0)
      ? (slsPrcW - avgCostW) / slsPrcW
      : 0;

    // T3 / LY totals. Sales qty is at unit grain in the DB
    // (qty_units, populated by the nightly sync). Margin % comes from
    // aggregated margin_amount (also DB-populated) / totalPrice — no
    // per-export cost recomputation. RawQty sums kept for the
    // grain-invariant T3 vs LY ratio cell (same value as the qty sums
    // since both are at unit grain now).
    let t3Qty = 0, t3Tot = 0, t3Marg = 0;
    let lyQty = 0, lyTot = 0, lyMarg = 0;
    for (const r of rows) {
      if (opts.trailing3) {
        const t = t3Of(r.sku);
        t3Qty += t.qty;
        t3Tot += t.totalPrice;
        t3Marg += t.marginAmount;
      }
      if (opts.spLY) {
        const l = lyOf(r.sku);
        lyQty += l.qty;
        lyTot += l.totalPrice;
        lyMarg += l.marginAmount;
      }
    }
    const t3Price = t3Qty > 0 ? t3Tot / t3Qty : 0;
    const lyPrice = lyQty > 0 ? lyTot / lyQty : 0;
    const t3Mrgn  = t3Tot > 0 ? t3Marg / t3Tot : 0;
    const lyMrgn  = lyTot > 0 ? lyMarg / lyTot : 0;

    // SO Prc grand total: qty-weighted avg unit price across all rows
    // that have a customer-SO entry. 0 when no customer is selected.
    let soPrcQty = 0;
    let soPrcRev = 0;
    if (customerSoMap) {
      for (const r of rows) {
        const e = customerSoMap.get(`${r.sku}::${r.store ?? "ROF"}`);
        if (!e || e.qty <= 0 || e.soPrice <= 0) continue;
        soPrcQty += e.qty;
        soPrcRev += e.qty * e.soPrice;
      }
    }
    const soPrcW = soPrcQty > 0 ? soPrcRev / soPrcQty : 0;

    // Grand-total Total $ = weighted Sls Prc × total qty (snapshot; per-row
    // Total $ is the live formula).
    const slsTtl = slsPrcW > 0 ? slsPrcW * qtyForCost : 0;
    return { avgCostW, totalCostW: costSum, slsPrcW, slsMrgnW, slsTtl, soPrcW, t3Qty, t3RawQty: t3Qty, t3Price, t3Tot, t3Mrgn, lyQty, lyRawQty: lyQty, lyPrice, lyTot, lyMrgn };
  }

  // Overlay the optional-col aggregates onto a stack row in-place. Used
  // for the toggle-OFF Total row and the toggle-ON "TOTAL Qty" row.
  function patchOptColAggregates(cells: any[], agg: ReturnType<typeof computeOptColAggregates>, excelRow?: number) {
    const setCurr = (ci: number | undefined, v: number) => {
      if (!ci) return;
      cells[ci - 1] = v === 0
        ? { v: "", t: "s", s: { ...totalNumStyle, numFmt: "$#,##0.00" } }
        : { v, t: "n", s: { ...totalNumStyle, numFmt: "$#,##0.00" } };
    };
    const setQty = (ci: number | undefined, v: number) => {
      if (!ci) return;
      cells[ci - 1] = v === 0
        ? { v: "", t: "s", s: totalNumStyle }
        : { v, t: "n", s: totalNumStyle };
    };
    const setPct = (ci: number | undefined, v: number) => {
      if (!ci) return;
      cells[ci - 1] = v === 0
        ? { v: "", t: "s", s: { ...totalNumStyle, numFmt: "0.0%" } }
        : { v, t: "n", s: { ...totalNumStyle, numFmt: "0.0%" } };
    };
    setCurr(COL_SO_PRC,      agg.soPrcW);
    setCurr(COL_AVG_COST,    agg.avgCostW);
    setCurr(COL_TOT_COST,    agg.totalCostW);
    setCurr(COL_SLS_PRC,     agg.slsPrcW);
    setPct (COL_SLS_MRGN_PCT, agg.slsMrgnW);
    setCurr(COL_SLS_TTL,     agg.slsTtl);
    // Buyer worksheet: make the grand-total Mrgn % + Total $ LIVE formulas off
    // this row's own Sls Prc + Avg Cost + Total cells, so editing the grand
    // total's Sls Prc recomputes them (matches the per-row + subtotal rows).
    if (slsPrcFormulaMode && excelRow && COL_SLS_PRC && COL_AVG_COST) {
      const slsRef = `${colLetter(COL_SLS_PRC)}${excelRow}`;
      const costRef = `${colLetter(COL_AVG_COST)}${excelRow}`;
      const totRef = `${colLetter(COL.total)}${excelRow}`;
      if (COL_SLS_MRGN_PCT && agg.slsPrcW > 0 && agg.avgCostW > 0) {
        cells[COL_SLS_MRGN_PCT - 1] = { v: agg.slsMrgnW, f: `IF(${slsRef}=0,"",(${slsRef}-${costRef})/${slsRef})`, t: "n", s: { ...totalNumStyle, numFmt: "0.0%" } };
      }
      if (COL_SLS_TTL && agg.slsTtl > 0) {
        cells[COL_SLS_TTL - 1] = { v: agg.slsTtl, f: `IF(${slsRef}="",0,${slsRef}*${totRef})`, t: "n", s: { ...totalNumStyle, numFmt: "$#,##0.00" } };
      }
    }
    setQty (COL_T3_QTY,      agg.t3Qty);
    setCurr(COL_T3_PRICE,    agg.t3Price);
    setCurr(COL_T3_TTL_SLS,  agg.t3Tot);
    setPct (COL_T3_MRGN,     agg.t3Mrgn);
    setQty (COL_LY_QTY,      agg.lyQty);
    setCurr(COL_LY_PRICE,    agg.lyPrice);
    setCurr(COL_LY_TTL_SLS,  agg.lyTot);
    setPct (COL_LY_MRGN,     agg.lyMrgn);
    // Plain growth math at the bottom Total: (sum_T3 − sum_LY) /
    // sum_LY. Same inputs as the visible T3 Ttl Sls / LY Ttl Sls
    // cells above so hand-dividing those two values matches the
    // diff cell exactly. If the visible total ratio surprises the
    // operator, the issue is in the underlying T3 / LY totals — not
    // the growth formula.
    if (COL_T3_LY_DIFF_QTY) {
      cells[COL_T3_LY_DIFF_QTY - 1] = t3VsLyCell(agg.t3RawQty, agg.lyRawQty, totalNumStyle);
    }
    if (COL_T3_LY_DIFF) {
      cells[COL_T3_LY_DIFF - 1] = t3VsLyCell(agg.t3Tot, agg.lyTot, totalNumStyle);
    }
    if (COL_T3_LY_DIFF_MRGN) {
      // Total margin diff: plain TY mrgn% − LY mrgn%. agg.t3Mrgn /
      // agg.lyMrgn are already fractions (0.21 for 21%) — no scaling
      // needed for the 0.0% format.
      cells[COL_T3_LY_DIFF_MRGN - 1] = marginDiffCell(agg.t3Mrgn, agg.lyMrgn, totalNumStyle);
    }
  }

  if (_totals !== null) {
    // Toggle ON — 5-row stack from the supplied GridTotals.
    const t = _totals;
    // Zero $ values render as blank ("$0.00" cells were noise).
    const fmtUSD = (n: number) => n === 0
      ? ""
      : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    // sale=0 → "—" sentinel (genuinely no margin computable, distinct
    // from "margin is 0"). mrgn=0 → blank (a real zero margin).
    const safePct = (sale: number, mrgn: number) =>
      sale > 0 ? (mrgn === 0 ? "" : `${((mrgn / sale) * 100).toFixed(1)}%`) : "—";

    const periodCostSum = periods.reduce((a, p) => a + (t.periodCost[p.endDate] ?? 0), 0);
    const periodSaleSum = periods.reduce((a, p) => a + (t.periodSale[p.endDate] ?? 0), 0);

    const totalQtyRow = buildStackRow(
      "TOTAL Qty",
      (k) => {
        // Customer-narrowed On Order — mirrors the per-row override so
        // the TOTAL Qty row matches what the operator sees in the body.
        if (k === "onOrder" && customerSoMap !== undefined) {
          return rows.reduce((a, r) => a + (customerSoMap.get(`${r.sku}::${r.store ?? "ROF"}`)?.qty ?? 0), 0);
        }
        return t[k].qty;
      },
      (key) => t.periodQty[key] ?? 0,
      () => periodSums.reduce((a, b) => a + b, 0),
    );
    patchOptColAggregates(totalQtyRow, computeOptColAggregates(), nextExcelRow);
    dataRows.push(totalQtyRow);
    // Customer-facing mode drops Cost / Mrgn rows from the stack
    // (operator doesn't want our cost or margin visible to the
    // customer).
    if (!opts.customerFacing) {
      dataRows.push(buildStackRow(
        "TOTAL Cost",
        (k) => fmtUSD(t[k].cost),
        (key) => fmtUSD(t.periodCost[key] ?? 0),
        () => fmtUSD(periodCostSum),
      ));
    }
    dataRows.push(buildStackRow(
      "TOTAL Sale",
      (k) => fmtUSD(t[k].sale),
      (key) => fmtUSD(t.periodSale[key] ?? 0),
      () => fmtUSD(periodSaleSum),
    ));
    if (!opts.customerFacing) {
      dataRows.push(buildStackRow(
        "TOTAL Mrgn $",
        (k) => fmtUSD(t[k].sale - t[k].cost),
        (key) => fmtUSD((t.periodSale[key] ?? 0) - (t.periodCost[key] ?? 0)),
        () => fmtUSD(periodSaleSum - periodCostSum),
      ));
      dataRows.push(buildStackRow(
        "TOTAL Mrgn %",
        (k) => safePct(t[k].sale, t[k].sale - t[k].cost),
        (key) => safePct(t.periodSale[key] ?? 0, (t.periodSale[key] ?? 0) - (t.periodCost[key] ?? 0)),
        () => safePct(periodSaleSum, periodSaleSum - periodCostSum),
      ));
    }
  } else {
    // Toggle OFF — single Total row of per-column qty sums.
    const onHandSum  = rows.reduce((a, r) => a + (r.onHand  ?? 0), 0);
    // On Order Total mirrors the per-row override when customer selected.
    const onOrderSum = customerSoMap !== undefined
      ? rows.reduce((a, r) => a + (customerSoMap.get(`${r.sku}::${r.store ?? "ROF"}`)?.qty ?? 0), 0)
      : rows.reduce((a, r) => a + (r.onOrder ?? 0), 0);
    const onPOSum    = rows.reduce((a, r) => a + (r.onPO    ?? 0), 0);
    const periodSumByKey: Record<string, number> = {};
    periods.forEach((p, i) => { periodSumByKey[p.endDate] = periodSums[i]; });
    const totalRow = buildStackRow(
      "Total",
      (k) => k === "onHand" ? onHandSum : k === "onOrder" ? onOrderSum : onPOSum,
      (key) => periodSumByKey[key] ?? 0,
      () => periodSums.reduce((a, b) => a + b, 0),
    );
    patchOptColAggregates(totalRow, computeOptColAggregates(), nextExcelRow);
    dataRows.push(totalRow);
  }

  // ── Outer + style-group thick borders ──────────────────────────────────
  // Two extra-heavy outlines on top of the per-cell base borders:
  //   (a) one EXTRA-THICK rectangle around the entire output —
  //       top of header, bottom of total row, left of col A, right
  //       of last column.
  //   (b) one EXTRA-THICK rectangle around each STYLE group's row
  //       block (e.g. all variants of RYB153330PPK) spanning every
  //       column from Category to Total.
  // Excel's "thick" border style is the heaviest single line —
  // visibly heavier than the "medium" we use for the column
  // outline + header / total borders, so the outer + style outlines
  // stand out clearly.
  const EXTRA_THICK: any = { style: "thick", color: { rgb: "1F497D" } };

  // Identify style-group boundaries from the qty-row Style cells.
  // Walk all data rows (excluding the bottom Total row), pull each
  // row's style value from col C, and mark transitions.
  type RowKind = "qty" | "ppk";
  // Build an array describing each data row's kind + its qty row's
  // style. PPK rows inherit the previous qty row's style so they
  // never trigger a boundary.
  const rowMeta: Array<{ kind: RowKind; style: string }> = [];
  let lastQtyStyle = "";
  for (let i = 0; i < dataRows.length - 1; i++) { // skip bottom Total row
    const r = dataRows[i];
    const styleVal = r[COL.style - 1]?.v;
    if (typeof styleVal === "string" && styleVal.trim() !== "") {
      lastQtyStyle = styleVal.trim();
      rowMeta.push({ kind: "qty", style: lastQtyStyle });
    } else {
      // Empty style cell = follower row (PPK) inheriting previous style.
      rowMeta.push({ kind: "ppk", style: lastQtyStyle });
    }
  }
  // First/last data row (in the dataRows array) of each style group.
  // Indexes here are into dataRows (0-based), so the corresponding
  // Excel row is dataRows-index + 1 (since header is excelRow=0).
  const styleStartDataIdx = new Set<number>();
  const styleEndDataIdx = new Set<number>();
  let prevStyle = "";
  for (let i = 0; i < rowMeta.length; i++) {
    const meta = rowMeta[i];
    if (meta.style !== prevStyle) {
      styleStartDataIdx.add(i);
      if (i > 0) styleEndDataIdx.add(i - 1); // close the previous group
      prevStyle = meta.style;
    }
  }
  if (rowMeta.length > 0) styleEndDataIdx.add(rowMeta.length - 1); // close the last group

  // ── Optional customer title row ────────────────────────────────────────
  // Title row above the table. Surfaces context that would otherwise
  // clutter column headers:
  //   • Customer name (22pt, bold, left-justified in col A) when the
  //     operator narrowed by customer
  //   • Date range banner (20pt, bold, CENTERED) when a custom T3
  //     window was picked via Hide ATS data → custom range — replaces
  //     the previous per-header "Sales Jan/01/2026 .. ..." labels
  //
  // Layout cases:
  //   no customer, no date range  → no title row
  //   customer only               → customer name in col A (22pt left)
  //   date range only             → date range centered (20pt)
  //   customer + date range       → customer in col A (22pt left) AND
  //                                  date range centered (20pt) in the
  //                                  space to the right. We merge the
  //                                  right-of-A range so the centered
  //                                  text doesn't collide with the
  //                                  customer name.
  const dateRangeWindows = salesAggregates?.windows;
  // Just the TY / current-period window once — the LY window is the
  // same range shifted back 12 months and the operator already
  // understands that convention; repeating it on the banner was
  // visual noise.
  const dateRangeText = (opts.customSalesRangeEnabled && dateRangeWindows)
    ? `Sales ${fmtHeaderDate(dateRangeWindows.t3Start)} .. ${fmtHeaderDate(dateRangeWindows.t3End)}`
    : "";
  let titleRow: any[] | null = null;
  if (customerFilter || dateRangeText) {
    titleRow = new Array(totalColumnCount).fill(null).map(() => ({ v: "", t: "s" as const }));
    if (customerFilter) {
      titleRow[0] = {
        v: customerFilter,
        t: "s",
        s: {
          font: { sz: 22, bold: true, color: { rgb: "1F497D" }, name: "Calibri" },
          alignment: { horizontal: "left", vertical: "center" },
        },
      };
    }
    if (dateRangeText) {
      // When customer is set, the date range banner anchors at col B
      // and spans through the last column — centered in the remaining
      // space to the right of the customer name. When no customer is
      // set, the banner anchors at col A and spans the full row width.
      const bannerStartCol = customerFilter ? 1 : 0;
      titleRow[bannerStartCol] = {
        v: dateRangeText,
        t: "s",
        s: {
          font: { sz: 20, bold: true, color: { rgb: "1F497D" }, name: "Calibri" },
          alignment: { horizontal: "center", vertical: "center" },
        },
      };
    }
  }

  // Convert to aoa-row indexes. Outline indexes from where the table's
  // header row lives in the final AOA; if a title row was prepended it
  // gets row 0 and the rest shift down by 1.
  const titleRowCount = titleRow ? 1 : 0;
  const tableTopRow   = titleRowCount;             // header row's AOA index
  const lastAoaRow    = titleRowCount + dataRows.length; // last data row index
  const lastColIdx = totalColumnCount - 1;
  const allRows: any[][] = titleRow ? [titleRow, headerRow, ...dataRows] : [headerRow, ...dataRows];

  for (let r = tableTopRow; r <= lastAoaRow; r++) {
    for (let c = 0; c <= lastColIdx; c++) {
      const cell = allRows[r]?.[c];
      if (!cell || !cell.s) continue;
      const colIdx1 = c + 1;
      const isSpacer = SPACER_COLS.has(colIdx1);
      // Clone the border block so we don't mutate any shared style.
      const border: any = { ...(cell.s.border ?? {}) };

      // (a) Outer table outline — applies to BOTH spacers and non-
      // spacers so the heavy frame around the table reads as one
      // continuous line. Without this, the spacer header cells kept
      // their lighter THICK top while neighbors picked up EXTRA_THICK,
      // producing visible "joint" marks at every spacer/data boundary
      // at the top of the header row.
      if (c === 0) border.left = EXTRA_THICK;                     // left edge of A
      if (c === lastColIdx) border.right = EXTRA_THICK;            // right edge of last col
      if (r === tableTopRow) border.top = EXTRA_THICK;             // top of header
      if (r === lastAoaRow) border.bottom = EXTRA_THICK;           // bottom of total row

      // Separator column at the header row: drop the bottom rule so the
      // colored separator reads as one continuous band from header into
      // the data, with no horizontal line cutting across it.
      if (r === tableTopRow && isSpacer) delete border.bottom;

      // (b) Style-group outline — only on non-spacer columns.
      // Painting horizontal EXTRA_THICK across the spacer band would
      // chop the dark spacer column into bricks, which is exactly the
      // visual the planner asked us to remove.
      if (!isSpacer) {
        const dataIdx = r - tableTopRow - 1;
        if (dataIdx >= 0 && dataIdx < rowMeta.length) {
          if (styleStartDataIdx.has(dataIdx)) border.top = EXTRA_THICK;
          if (styleEndDataIdx.has(dataIdx)) border.bottom = EXTRA_THICK;
        }
      }

      cell.s = { ...cell.s, border };
    }
  }

  // Shift PPK merges to account for the prepended title row.
  if (titleRowCount > 0 && merges.length > 0) {
    for (const m of merges) {
      m.s.r += titleRowCount;
      m.e.r += titleRowCount;
    }
  }
  // Title-row merge is built AFTER the column-drop pass below, because
  // hideATSData / hideZeroColumns can shorten the row — if we used the
  // pre-drop lastColIdx here the remap at oldToNew0 would null out the
  // merge's end column and drop the title merge entirely, leaving the
  // 22pt customer name clipped to column A's width.

  // ── Optional pass: drop columns ──────────────────────────────────────
  // Two independent triggers, composed into one projection:
  //   • hideZeroColumns — drop any column whose body has no non-empty
  //     cell (identity / spacer cols are exempt).
  //   • hideATSData — drop the date columns + Total. Avg Cost / Total
  //     Cost / Sls Prc @ Mrgn are already forced off at opts setup so
  //     they aren't allocated; periods + Total are non-optional and
  //     have to be removed here.
  let effectiveAllRows = allRows;
  let effectiveMerges  = merges;
  let columnIndexMap: Map<number, number> | null = null; // old 1-based → new 1-based
  if (opts.hideZeroColumns || opts.hideATSData) {
    const alwaysKeep = new Set<number>([
      COL.category, COL.subCat, COL.style, COL.description, COL.color,
      COL.spacerF, COL.spacerH, COL.spacerJ, COL.spacerL,
      ...(COL.image ? [COL.image] : []),
    ]);
    // Build forced-drop set up-front. hideATSData drops period range
    // + Total; even if hideZeroColumns disagrees (e.g. a period column
    // has data), the forced drop wins because the user explicitly
    // asked for ATS data to be hidden.
    const forcedDrop = new Set<number>();
    if (opts.hideATSData) {
      for (let c = COL.firstPeriod; c <= COL.lastPeriod; c++) forcedDrop.add(c);
      forcedDrop.add(COL.total);
    }
    const hasData = new Set<number>();
    if (opts.hideZeroColumns) {
      const scanFrom = tableTopRow + 1; // skip title (if any) + header
      for (let r = scanFrom; r <= lastAoaRow; r++) {
        const row = allRows[r];
        if (!row) continue;
        for (let c = 0; c < totalColumnCount; c++) {
          const cell = row[c];
          if (!cell) continue;
          const v = cell.v;
          if (v !== undefined && v !== null && v !== "") {
            hasData.add(c + 1);
          }
        }
      }
    }
    const keptList: number[] = [];
    for (let c = 1; c <= totalColumnCount; c++) {
      if (forcedDrop.has(c)) continue;
      // When only hideATSData is on (no hideZeroColumns), keep every
      // non-forced-drop column — the user only asked to drop the ATS
      // range, not zero-trim the rest.
      if (!opts.hideZeroColumns) { keptList.push(c); continue; }
      if (alwaysKeep.has(c) || hasData.has(c)) keptList.push(c);
    }
    if (keptList.length < totalColumnCount) {
      // Build the new AOA by projecting each row to the kept columns.
      effectiveAllRows = allRows.map(row => keptList.map(c => row?.[c - 1]));
      // Remap merges: drop those whose anchor or end column was
      // removed; shift the remaining ones to the new column indexes.
      columnIndexMap = new Map();
      keptList.forEach((origCol, newIdx) => columnIndexMap!.set(origCol, newIdx + 1));
      const oldToNew0 = (origC0: number): number | null => {
        const newCol = columnIndexMap!.get(origC0 + 1);
        return newCol === undefined ? null : newCol - 1;
      };
      effectiveMerges = merges
        .map(m => {
          const sc = oldToNew0(m.s.c);
          const ec = oldToNew0(m.e.c);
          if (sc === null || ec === null) return null;
          return { s: { r: m.s.r, c: sc }, e: { r: m.e.r, c: ec } };
        })
        .filter((m): m is { s: { r: number; c: number }; e: { r: number; c: number } } => m !== null);

      // Rewrite every cell formula's column letters to match the new
      // post-hide-zero layout. Formula text was emitted earlier in the
      // pipeline using the ORIGINAL column letters (e.g. SUM(M11:R11)
      // for periods M..R); after the kept-list compaction those letters
      // refer to different cells in the reflowed worksheet. Without this
      // rewrite, the Total cell's SUM ends up summing whatever cells now
      // sit at M..R (often the row's own Total column, self-referencing).
      const colLetterToIdx = (letters: string): number => {
        let n = 0;
        for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
        return n;
      };
      // Map an original 1-based column to its new index. A DROPPED column is
      // clamped to the nearest KEPT column on the given side, so a range bound
      // shrinks INWARD rather than keeping a stale letter. Keeping a stale end
      // letter let a SUM range over-reach into the Total column that reflowed
      // leftward into the old period letters — the circular-reference bug.
      const keptAsc = keptList.slice().sort((a, b) => a - b);
      const mapClamped = (origIdx: number, side: "start" | "end"): number | null => {
        const direct = columnIndexMap!.get(origIdx);
        if (direct !== undefined) return direct;
        if (side === "end") {
          let best = -1;
          for (const k of keptAsc) { if (k <= origIdx) best = k; else break; }
          return best >= 0 ? columnIndexMap!.get(best)! : null;
        }
        for (const k of keptAsc) if (k >= origIdx) return columnIndexMap!.get(k)!;
        return null;
      };
      for (const row of effectiveAllRows) {
        if (!row) continue;
        for (const cell of row) {
          if (!cell || typeof cell.f !== "string") continue;
          // One pass over ranges (A1:B1) AND single refs (A1). Ranges clamp
          // dropped bounds inward; singles map directly (or keep if dropped).
          cell.f = cell.f.replace(/([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?/g, (whole, l1, d1, l2, d2, off, str) => {
            // Skip sheet-qualified refs (e.g. 'Cost ...'!A12) — the cell part
            // after "!" addresses a DIFFERENT sheet whose columns are not part
            // of this sheet's hide-zero compaction. Remapping it would corrupt
            // the cross-sheet cost reference behind Mrgn % / Total $.
            if (typeof off === "number" && off > 0 && str[off - 1] === "!") return whole;
            if (l2 !== undefined) {
              const a = mapClamped(colLetterToIdx(l1), "start");
              const b = mapClamped(colLetterToIdx(l2), "end");
              if (a === null || b === null || a > b) {
                const one = a ?? b;
                return one != null ? `${colLetter(one)}${d1}` : whole;
              }
              return `${colLetter(a)}${d1}:${colLetter(b)}${d2}`;
            }
            const newIdx = columnIndexMap!.get(colLetterToIdx(l1));
            return newIdx === undefined ? whole : `${colLetter(newIdx)}${d1}`;
          });
        }
      }
    }
  }

  // Title-row merge (built after column drop so it spans the final width).
  if (titleRow) {
    const finalLastColIdx = (effectiveAllRows[0]?.length ?? totalColumnCount) - 1;
    if (customerFilter && dateRangeText) {
      // Customer stays anchored in col A; date range banner spans B..end.
      effectiveMerges.push({ s: { r: 0, c: 1 }, e: { r: 0, c: finalLastColIdx } });
    } else {
      // Single value (customer OR date range alone) merges the full row.
      effectiveMerges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: finalLastColIdx } });
    }
  }

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = effectiveAllRows;

  // ── Auto-fit column widths ──────────────────────────────────────────────
  const SPACER_WCH = 1.57;
  const PAD = 2;
  const MAX_WCH = 80;
  function widthForColumn(idx1: number): number {
    if (SPACER_COLS.has(idx1)) return SPACER_WCH;
    if (COL.image && idx1 === COL.image) return IMG_COL_WCH;
    let maxLen = 0;
    const hdrCell = headerRow[idx1 - 1];
    if (hdrCell?.v != null) {
      const hdrLen = String(hdrCell.v).length;
      // When the header is set to wrap (len > 10 → wrapText flagged
      // upstream), cap its contribution to width so the column doesn't
      // auto-size to the full unwrapped header string and defeat the
      // wrap. Cap is 13 chars — wide enough to hold an MMM/DD/YYYY
      // date string (11 chars) on a single line so the date stays
      // intact when the surrounding header wraps. Body cells still
      // drive width when wider; the cap only applies to the header.
      const hdrWraps = !!hdrCell?.s?.alignment?.wrapText;
      maxLen = hdrWraps ? Math.min(hdrLen, 13) : hdrLen;
    }
    for (const row of dataRows) {
      const cell = row[idx1 - 1];
      if (!cell) continue;
      let s: string;
      if (cell.f) s = "999,999";
      else if (typeof cell.v === "number") s = cell.v.toLocaleString();
      else s = String(cell.v ?? "");
      if (s.length > maxLen) maxLen = s.length;
    }
    // Widen by FONT_SCALE so the 135%-scaled text isn't clipped in its column.
    return Math.min(Math.round(MAX_WCH * FONT_SCALE), Math.round((maxLen + PAD) * FONT_SCALE));
  }
  // Width array follows the same projection as the AOA when hideZero
  // is on: only emit widths for kept columns, in the same order.
  const mainCols: Array<{ wch: number }> = [];
  if (columnIndexMap) {
    const keptOrigCols = [...columnIndexMap.keys()].sort((a, b) => (columnIndexMap!.get(a)! - columnIndexMap!.get(b)!));
    keptOrigCols.forEach((origCol, i) => {
      mainCols[i] = { wch: widthForColumn(origCol) };
    });
  } else {
    for (let ci = 1; ci <= totalColumnCount; ci++) {
      mainCols[ci - 1] = { wch: widthForColumn(ci) };
    }
  }

  // Row heights — set per Excel row index after we've already pushed
  // every dataRow (variants + PPK pairs + style subtotals + bottom
  // Total / stack). Header taller; PPK follower rows shorter; subtotal
  // and total rows a touch taller for visual weight.
  // Header height bumps when any cell wrapped (estimate two lines @
  // 11pt + padding). Single-line headers keep the tighter 22pt.
  // Row heights scaled by FONT_SCALE (defined above) to match the larger text.
  // Image rows are sized for the picture by the renderer, not the font.
  const HEADER_HPT = Math.round((headerHasWrap ? 34 : 22) * FONT_SCALE);
  const ROW_HPT = Math.round(15 * FONT_SCALE);
  const PPK_ROW_HPT = Math.round(11 * FONT_SCALE);
  const SUBTOTAL_HPT = Math.round(19 * FONT_SCALE);
  const TOTAL_HPT = Math.round(18 * FONT_SCALE);
  const rowsHeight: any[] = [];
  if (titleRow) rowsHeight.push({ hpt: Math.round(30 * FONT_SCALE) }); // taller for the customer-name banner
  rowsHeight.push({ hpt: HEADER_HPT });
  // Walk the dataRows we actually built. A subtotal / bottom Total row
  // is identifiable by a "Subtotal" or "Total" label in the Color col;
  // a PPK follower has an empty Style cell; everything else is a qty
  // row. Mapping by content keeps the height aligned even after the
  // multi-feature row insertion.
  for (const row of dataRows) {
    const colorVal = row[COL.color - 1]?.v;
    const styleVal = row[COL.style - 1]?.v;
    if (typeof colorVal === "string" && /Subtotal$/i.test(colorVal)) {
      rowsHeight.push({ hpt: SUBTOTAL_HPT });
    } else if (typeof colorVal === "string" && (colorVal === "Total" || /^TOTAL /i.test(colorVal))) {
      rowsHeight.push({ hpt: TOTAL_HPT });
    } else if (typeof styleVal === "string" && styleVal.trim() === "") {
      rowsHeight.push({ hpt: PPK_ROW_HPT });
    } else {
      // Taller qty rows when embedding thumbnails so the image fits.
      rowsHeight.push({ hpt: wantImages ? Math.max(ROW_HPT, IMG_ROW_HPT) : ROW_HPT });
    }
  }
  // Merged cells for prepack pairs — text + spacers + qty cols + Total
  // span both rows; only period cols stay split (qty top, PPK bottom).
  // No frozen panes, no autofilter on the main sheet.
  // Embedded thumbnails → AoA-relative anchors (the renderer adds the banner
  // offset). The Image column index is stable: every column at/left of it is
  // in alwaysKeep, so the column-drop pass never shifts it.
  const reportImages = (wantImages && COL.image)
    ? imageAnchors.map((a) => ({
        aoaRow: titleRowCount + 1 + a.dataIdx,
        col: (COL.image as number) - 1,
        dataUrl: a.img.dataUrl,
        // Exact pixel dims measured in the browser → the renderer sizes the row
        // to the image so the cell fits it with no empty space. Fall back to the
        // square box only if dims are unknown (e.g. server-side, no canvas).
        width: a.img.w > 0 ? a.img.w : IMG_PX,
        height: a.img.h > 0 ? a.img.h : IMG_PX,
        // Prepack rows are a qty row + a PPK annotation row. Extend the image
        // down over the PPK row so it covers the internal qty/PPK border (the
        // stray blue line under the picture) and its bottom lands on the
        // record's outer separator. px ≈ pt*96/72.
        extendPx: a.prepack ? Math.round((PPK_ROW_HPT * 96) / 72) : 0,
      }))
    : undefined;
  const sheetSpecs: MultiSheetSpec[] = [{
    sheetName: "ATS Report",
    allRows: aoa,
    cols: mainCols,
    rowHeights: rowsHeight,
    merges: effectiveMerges.length > 0 ? effectiveMerges : undefined,
    images: reportImages,
  }];

  // Scale every cell's font up by FONT_SCALE (the row heights above are already
  // bumped to match). Each touched cell is cloned so shared style objects in
  // the factories aren't scaled more than once.
  if (FONT_SCALE !== 1) {
    for (const row of aoa) {
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        const sz = cell?.s?.font?.sz;
        if (typeof sz === "number") {
          row[c] = { ...cell, s: { ...cell.s, font: { ...cell.s.font, sz: Math.round(sz * FONT_SCALE * 2) / 2 } } };
        }
      }
    }
  }

  // Optional "By Size Matrix" worksheet(s) (operator export option). Built
  // only when the size-grain data was fetched; the main report is unaffected.
  if (opts.bySizeMatrix && sizeMatrix && Array.isArray(sizeMatrix.styles) && sizeMatrix.styles.length > 0) {
    const usedNames = new Set<string>(["ATS Report"]);
    // Excel tab names: ≤31 chars, none of []:*?/\, unique within the book.
    const safeTab = (raw: string) => {
      let base = String(raw).replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
      let name = base, n = 2;
      while (usedNames.has(name)) { const suf = ` ${n++}`; name = base.slice(0, 31 - suf.length) + suf; }
      usedNames.add(name);
      return name;
    };
    // Snapshot (total) matrix tab.
    const matrixSpec = buildSizeMatrixSheet(sizeMatrix, bulkByStyleColor);
    if (matrixSpec) sheetSpecs.push({ ...matrixSpec, sheetName: safeTab("By Size Matrix") });
    // One tab per selected period, each AS OF that period with a 22pt banner.
    for (const pm of periodMatrices ?? []) {
      if (!pm?.matrix || !Array.isArray(pm.matrix.styles) || pm.matrix.styles.length === 0) continue;
      const spec = buildSizeMatrixSheet(pm.matrix, bulkByStyleColor, pm.name);
      if (spec) sheetSpecs.push({ ...spec, sheetName: safeTab(pm.name) });
    }
  }


  const { wb } = buildMultiSheetWorkbook(`ATS_Report_${fmtDate(new Date())}.xlsx`, sheetSpecs);
  const extraSheets = sheetSpecs.slice(1).map((s) => ({ name: s.sheetName, aoa: s.allRows }));
  return { aoa, wb, filename: `ATS_Report_${fmtDate(new Date())}.xlsx`, title: "ATS Grid", extraSheets };
}

// ── By Size Matrix worksheet ───────────────────────────────────────────────
// Response shape of POST /api/internal/ats-size-matrix (h611).
export interface AtsSizeMatrixColor {
  color: string;
  by_size: Record<string, number>; // size → ATS-available eaches
  total_eachs: number;
  ppk_packs: number;
}
export interface AtsSizeMatrixStyle {
  style_code: string;
  style_name: string;
  sizes: string[];      // ordered size columns (from the style's scale)
  pack_size: number;    // dominant PPK pack size (0 when none)
  colors: AtsSizeMatrixColor[];
}
export interface AtsSizeMatrixResponse {
  as_of: string | null;
  styles: AtsSizeMatrixStyle[];
}

// Build a "By Size Matrix" worksheet. One block per style:
//   [optional 22pt period banner] · per-style title · header
//   (Style·Color·SO·_·PO·_·ATS·_·<sizes>·PPK·Total Eachs·Total PPK<n>) ·
//   one row per color · a Subtotal row · a blank spacer row.
// Blank spacer COLUMNS sit after SO, PO and ATS (operator layout). SO / PO
// come from the bulk color-grain overlay (keyed "STYLE|COLOR"); the size
// cells + PPK come from the size-grain fetch. Fills mirror the main ATS
// report palette (dark-blue headers / white font, qty-band data cells,
// blue spacer columns). `periodHeader` adds the big banner used by the
// per-period tabs. Returns null when there is nothing to render.
function buildSizeMatrixSheet(
  data: AtsSizeMatrixResponse,
  bulk?: Map<string, { so: number; po: number }>,
  periodHeader?: string,
): Omit<MultiSheetSpec, "sheetName"> | null {
  const NUMFMT = "#,##0";
  // Report palette (matches exportExcel's main sheet).
  const DARK = "1F497D";   // dark-blue header fill (On Order/PO/periods/Total)
  const TEXTHDR = "3278CC"; // text headers
  const SPACER_FILL = "2C69B2"; // separator columns (matches main sheet)
  const QTY = "B4C7E7";    // qty-band data cells
  const EVEN = "EEF3FA";   // zebra even (text cols)
  const ODD = "FFFFFF";    // zebra odd (text cols)
  const WHITE = "FFFFFF";
  const THICK = { style: "medium", color: { rgb: DARK } };
  const THIN = { style: "thin", color: { rgb: "4472C4" } };
  const HDR_BORDER: any = { top: THICK, bottom: THICK, left: THIN, right: THIN };
  const CELL_BORDER: any = { top: THIN, bottom: THIN, left: THIN, right: THIN };

  const fill = (rgb: string) => ({ fgColor: { rgb }, patternType: "solid" });
  // Header cells.
  const hDark = (v: string) => ({ v, t: "s", s: { font: { bold: true, sz: 11, color: { rgb: WHITE }, name: "Calibri" }, fill: fill(DARK), alignment: { horizontal: "center", vertical: "center" }, border: HDR_BORDER } });
  const hText = (v: string) => ({ v, t: "s", s: { font: { bold: true, sz: 11, color: { rgb: WHITE }, name: "Calibri" }, fill: fill(TEXTHDR), alignment: { horizontal: "center", vertical: "center" }, border: HDR_BORDER } });
  const hSpacer = () => ({ v: "", t: "s", s: { fill: fill(SPACER_FILL), border: HDR_BORDER } });
  // Data cells.
  const dTxt = (v: string, z: string) => ({ v, t: "s", s: { font: { sz: 11, name: "Calibri" }, fill: fill(z), alignment: { horizontal: "left" }, border: CELL_BORDER } });
  const dNum = (v: number, rgb: string) => ({ v: v > 0 ? v : "", t: v > 0 ? "n" : "s", s: { numFmt: NUMFMT, font: { sz: 11, name: "Calibri" }, fill: fill(rgb), alignment: { horizontal: "right" }, border: CELL_BORDER } });
  const dSpacer = (z: string) => ({ v: "", t: "s", s: { fill: fill(z), border: CELL_BORDER } });
  // Subtotal cells (bold dark-blue font on the qty band, thick top rule).
  const SUB_BORDER: any = { top: THICK, bottom: THIN, left: THIN, right: THIN };
  const sTxt = (v: string) => ({ v, t: "s", s: { font: { bold: true, sz: 11, color: { rgb: DARK }, name: "Calibri" }, fill: fill(QTY), border: SUB_BORDER } });
  const sNum = (v: number) => ({ v: v > 0 ? v : "", t: v > 0 ? "n" : "s", s: { numFmt: NUMFMT, font: { bold: true, sz: 11, color: { rgb: DARK }, name: "Calibri" }, fill: fill(QTY), alignment: { horizontal: "right" }, border: SUB_BORDER } });
  const sSpacer = () => ({ v: "", t: "s", s: { fill: fill(QTY), border: SUB_BORDER } });
  // Per-style title banner + the big period banner.
  const titleCell = (v: string) => ({ v, t: "s", s: { font: { bold: true, sz: 13, color: { rgb: WHITE }, name: "Calibri" }, fill: fill(DARK), alignment: { horizontal: "left", vertical: "center" } } });
  const periodCell = (v: string) => ({ v, t: "s", s: { font: { bold: true, sz: 22, color: { rgb: WHITE }, name: "Calibri" }, fill: fill(DARK), alignment: { horizontal: "center", vertical: "center" } } });
  const blank = { v: "", t: "s" };
  const keyOf = (style: string, color: string) => `${String(style).toUpperCase()}|${String(color).toUpperCase()}`;

  // Block width = Style,Color,SO,_,PO,_,ATS,_ (8) + sizes + PPK,TotalEachs,TotalPPK (3).
  const widthOf = (sizes: string[]) => 8 + sizes.length + 3;
  const maxWidth = Math.max(...data.styles.filter((s) => (s.colors?.length ?? 0) > 0).map((s) => widthOf(s.sizes || [])), 1);

  const aoa: any[][] = [];
  const merges: any[] = [];
  const padTo = (row: any[], w: number) => { while (row.length < w) row.push(blank); return row; };

  // Big period banner (per-period tabs only).
  if (periodHeader) {
    const r = aoa.length;
    aoa.push(padTo([periodCell(periodHeader)], maxWidth));
    merges.push({ s: { r, c: 0 }, e: { r, c: maxWidth - 1 } });
    aoa.push([]); // breathing room under the banner
  }

  for (const st of data.styles) {
    if (!st || (st.colors?.length ?? 0) === 0) continue;
    const sizes = Array.isArray(st.sizes) ? st.sizes : [];
    const packLabel = st.pack_size > 1 ? `Total PPK${st.pack_size}` : "Total PPK";
    const blockWidth = widthOf(sizes);

    // Per-style title (merged).
    const titleR = aoa.length;
    aoa.push(padTo([titleCell(`${st.style_code}  ${st.style_name || ""}  —  ATS Available by Size`)], blockWidth));
    merges.push({ s: { r: titleR, c: 0 }, e: { r: titleR, c: blockWidth - 1 } });

    // Header row (spacers after SO, PO, ATS).
    aoa.push([
      hText("Style"), hText("Color"),
      hDark("SO"), hSpacer(), hDark("PO"), hSpacer(), hDark("ATS"), hSpacer(),
      ...sizes.map((s) => hDark(String(s))),
      hDark("PPK"), hDark("Total Eachs"), hDark(packLabel),
    ]);

    // Color rows + running subtotal.
    const sub = { so: 0, po: 0, eachs: 0, ppk: 0, bySize: {} as Record<string, number> };
    let i = 0;
    for (const c of st.colors) {
      const z = (i++ % 2 === 0) ? EVEN : ODD; // zebra for text cols + spacers
      const ov = bulk?.get(keyOf(st.style_code, c.color)) ?? { so: 0, po: 0 };
      sub.so += ov.so; sub.po += ov.po; sub.eachs += c.total_eachs || 0; sub.ppk += c.ppk_packs || 0;
      aoa.push([
        dTxt(st.style_name || st.style_code, z), dTxt(c.color, z),
        dNum(ov.so, QTY), dSpacer(z), dNum(ov.po, QTY), dSpacer(z), dNum(c.total_eachs || 0, QTY), dSpacer(z),
        ...sizes.map((s) => { const q = Number(c.by_size?.[s]) || 0; sub.bySize[s] = (sub.bySize[s] || 0) + q; return dNum(q, QTY); }),
        dNum(c.ppk_packs || 0, QTY), dNum(c.total_eachs || 0, QTY), dNum(c.ppk_packs || 0, QTY),
      ]);
    }

    // Subtotal row.
    aoa.push([
      sTxt("Subtotal"), sTxt(""),
      sNum(sub.so), sSpacer(), sNum(sub.po), sSpacer(), sNum(sub.eachs), sSpacer(),
      ...sizes.map((s) => sNum(sub.bySize[s] || 0)),
      sNum(sub.ppk), sNum(sub.eachs), sNum(sub.ppk),
    ]);

    aoa.push([]); // spacer between style blocks
  }

  if (aoa.length === 0) return null;
  // Column widths: Style/Color wide, narrow spacers (cols 3,5,7), compact numerics.
  const cols: Array<{ wch: number }> = [{ wch: 22 }, { wch: 22 }, { wch: 9 }, { wch: 2 }, { wch: 9 }, { wch: 2 }, { wch: 10 }, { wch: 2 }];
  for (let i = 8; i < maxWidth; i++) cols.push({ wch: i >= maxWidth - 3 ? 11 : 7 });
  return {
    allRows: aoa,
    cols,
    merges: merges.length > 0 ? merges : undefined,
    rowHeights: periodHeader ? [{ hpt: 30 }] : [], // tall banner row
  };
}
