import XLSXStyle from "xlsx-js-style";
import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { fmtDate, displayColor } from "./helpers";
import type { GridTotals } from "./computeTotals";
import { periodAvail } from "./compute";
import type { ExportOptions } from "./panels/ExportOptionsModal";
import type { SalesFetchResult, SalesAggregate } from "./exportSalesFetch";

type EventIndex = Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>>;

const EMPTY_AGG: SalesAggregate = { qty: 0, totalPrice: 0, marginAmount: 0 };
// Autofit non-spacer cols: max(len(value)) + 2, capped at 80.
// No frozen panes, no autofilter, no merged cells.
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
) {
  const payload = buildExportPayload(rows, periods, _hiddenColumns, _totals, options, _eventIndex, salesAggregates, explodePpk);
  if (!payload) return;
  triggerXlsxDownload(payload.wb, payload.filename);
}

// ── Trigger a browser download for a built workbook. ─────────────────
export function triggerXlsxDownload(wb: any, filename: string): void {
  const buf  = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ExportPayload {
  aoa: any[][];     // the array-of-arrays the worksheet was built from
  wb: any;          // XLSXStyle workbook ready to write
  filename: string; // download filename
  // Display title used by the preview modal header. Kept optional so
  // legacy code that built ExportPayload without one still type-checks
  // — the preview default falls back to "Export".
  title?: string;
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
  };
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
  // Customer-facing mode strips every column that exposes our cost
  // basis or margin. Applied here so all downstream column-existence
  // checks (header / body / subtotal / bottom-total) honor it.
  if (opts.customerFacing) {
    opts.avgCost = false;
    opts.slsPrcAtMrgn = false;
  }
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
  let nextCol = 1;
  const COL = {
    category:    nextCol++,
    subCat:      nextCol++,
    style:       nextCol++,
    description: nextCol++,
    color:       nextCol++,
    spacerF:     nextCol++,
    onHand:      nextCol++,
    spacerH:     nextCol++,
    onOrder:     nextCol++,
    spacerJ:     nextCol++,
    onPO:        nextCol++,
    spacerL:     nextCol++,
    firstPeriod: nextCol,
    lastPeriod:  nextCol + numPeriods - 1,
    total:       nextCol + numPeriods,
  } as Record<string, number>;
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
  const HDR_TEXT_FILL  = "3278CC"; // text headers + every spacer
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
  const BORDER_BODY: any   = { top: THIN,  bottom: THIN,  left: THICK, right: THICK };
  // Header column dividers use THIN so the joints between period header
  // cells read lighter (planner asked for lighter / less heavy header
  // dividers); top + bottom stay thick so the header band frames clearly.
  const BORDER_HEADER: any = { top: THICK, bottom: THICK, left: THIN, right: THIN };
  const BORDER_TOTAL: any  = { top: THICK, bottom: THICK, left: THICK, right: THICK };

  // ── Style factories ────────────────────────────────────────────────────
  const headerStyle = (fill: string, align: "left" | "center", wrap: boolean = false): any => ({
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center", wrapText: wrap },
    border:    BORDER_HEADER,
  });
  // Tracks whether ANY header cell was built with wrap enabled —
  // used downstream to decide the header row height.
  let headerHasWrap = false;
  // Build a header cell, automatically flipping wrap on for any text
  // value longer than 10 chars. Sets wrapText at construction time
  // (not via post-walk mutation) so xlsx-js-style's aoa_to_sheet
  // serializer reliably picks it up.
  const headerCell = (value: string, fill: string, align: "left" | "center") => {
    const wrap = value.length > 10;
    if (wrap) headerHasWrap = true;
    return { v: value, t: "s" as const, s: headerStyle(fill, align, wrap) };
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
  // cols — same row's zebra fill applied to col R per planner.
  const bodyTotalStyle = (fill: string): any => ({
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_BODY,
  });
  // Spacer cell — always #3278CC top to bottom, no value. NO borders —
  // spacers read as a clean colored gap between column groups (planner
  // asked for the spacer-column vertical borders to be removed).
  const spacerCellStyle = (): any => ({
    fill:   { fgColor: { rgb: HDR_TEXT_FILL }, patternType: "solid" },
    border: {},
  });

  // ── Header row ─────────────────────────────────────────────────────────
  // All header cells go through headerCell() so wrapText is applied at
  // construction for any text > 10 chars. (Earlier post-walk mutation
  // wasn't always picked up by xlsx-js-style's aoa_to_sheet
  // serializer.)
  const headerRow: any[] = new Array(totalColumnCount);
  headerRow[COL.category    - 1] = headerCell("Category",    HDR_TEXT_FILL, "left");
  headerRow[COL.subCat      - 1] = headerCell("Sub Cat",     HDR_TEXT_FILL, "left");
  headerRow[COL.style       - 1] = headerCell("Style",       HDR_TEXT_FILL, "left");
  headerRow[COL.description - 1] = headerCell("Description", HDR_TEXT_FILL, "left");
  headerRow[COL.color       - 1] = headerCell("Color",       HDR_TEXT_FILL, "left");
  headerRow[COL.spacerF - 1] = headerCell("", HDR_TEXT_FILL, "center");
  headerRow[COL.spacerH - 1] = headerCell("", HDR_TEXT_FILL, "center");
  headerRow[COL.spacerJ - 1] = headerCell("", HDR_TEXT_FILL, "center");
  headerRow[COL.spacerL - 1] = headerCell("", HDR_TEXT_FILL, "center");
  headerRow[COL.onHand  - 1] = headerCell("On Hand",  HDR_ONHAND_FILL, "center");
  headerRow[COL.onOrder - 1] = headerCell("On Order", HDR_DARK_FILL, "center");
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
  const sumStartLetter = colLetter(COL.spacerL);   // L (empty spacer)
  const sumEndLetter = colLetter(COL.lastPeriod);  // last period letter

  // ── BP-level (style_code) max Sls Prc ─────────────────────────────────
  // Operator rule: all variants of the same BP must show the same
  // Sls Prc — pick the HIGHEST formula-derived price across the BP's
  // rows so the most expensive variant doesn't get under-priced.
  // Mirrors the per-row formula (including the explodePpk grain
  // conversion and round-up-to-$0.05). Rows with no master_style or
  // non-positive avgCost are skipped here AND fall through to the
  // per-row formula at body time.
  const bpMaxSlsPrc = new Map<string, number>();
  if (COL_SLS_PRC || COL_SLS_MRGN_PCT) {
    for (const r of rows) {
      const styleKey = r.master_style ?? "";
      if (!styleKey) continue;
      const rMult = (typeof r.ppkMult === "number" && r.ppkMult > 0) ? r.ppkMult : 1;
      const rCostMul = (explodePpk ?? true) ? 1 : rMult;
      const rAvgCost = (r.avgCost ?? 0) * rCostMul;
      if (rAvgCost <= 0 || slsMargin >= 1) continue;
      const rPrice = Math.ceil((rAvgCost / (1 - slsMargin)) * 20) / 20;
      const cur = bpMaxSlsPrc.get(styleKey);
      if (cur === undefined || rPrice > cur) bpMaxSlsPrc.set(styleKey, rPrice);
    }
    // Diagnostic: print bpMaxSlsPrc state so we can verify the BP-uniform
    // rule is actually applying. Read-only — no behavior change.
    const sample = [...bpMaxSlsPrc.entries()].slice(0, 8)
      .map(([k, v]) => `${JSON.stringify(k)}:$${v.toFixed(2)}`)
      .join(", ");
    console.info(`[ATS export] bpMaxSlsPrc → ${bpMaxSlsPrc.size} styles, slsMarginPct=${opts.slsMarginPct}, explodePpk=${explodePpk}${bpMaxSlsPrc.size ? `, sample: ${sample}` : ""}`);
  }

  // ── Data rows ──────────────────────────────────────────────────────────
  // Each input row → one qty data row. Prepack rows ALSO produce a
  // PPK suffix row immediately below — but only the PERIOD cells
  // (M-Q) carry a suffix. Every other cell on the prepack pair (text
  // cols A-E, spacers F/H/J/L, qty cols G/I/K, Total R) MERGES across
  // the pair so the qty value sits vertically centered in the taller
  // merged cell. Matches the planner's reference image exactly.
  const dataRows: any[][] = [];
  let nextExcelRow = 2; // header is row 1
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
  function buildSubtotalRow(styleLabel: string, group: ATSRow[]): any[] {
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
    const onO = group.reduce((a, x) => a + (x.onOrder ?? 0), 0);
    const onP = group.reduce((a, x) => a + (x.onPO ?? 0), 0);
    const perPeriod = periods.map((_p, i) => group.reduce((a, x) => a + periodValueOf(x, i), 0));
    const grand = perPeriod.reduce((a, b) => a + b, 0);

    const r2: any[] = new Array(totalColumnCount);
    for (const ci of [COL.category, COL.subCat, COL.style, COL.description]) {
      r2[ci - 1] = { v: "", t: "s", s: subTextStyle };
    }
    r2[COL.color - 1] = { v: `${styleLabel} Subtotal`, t: "s", s: subTextStyle };
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
    r2[COL.onPO    - 1] = subCell(onP);
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      r2[ci - 1] = subCell(perPeriod[i]);
    }
    r2[COL.total - 1] = subCell(grand);

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
        let xRowTotal = 0;
        for (let i = 0; i < numPeriods; i++) xRowTotal += periodValueOf(x, i);
        totalQtyForCost += xRowTotal;
        totalCostSum += xAvg * xRowTotal;
      }
      const weightedAvgCost = totalQtyForCost > 0 ? totalCostSum / totalQtyForCost : 0;
      // Subtotal Sls Prc: when every row in the group belongs to the
      // same BP (style-level subtotal), use that BP's unified max so
      // the subtotal matches the per-row values. For mixed-BP groups
      // (Category / Sub Category subtotals) fall back to the weighted-
      // avg-derived formula price.
      let groupBpMax: number | undefined;
      if (group.length > 0) {
        const firstStyle = group[0].master_style ?? "";
        if (firstStyle && group.every(x => (x.master_style ?? "") === firstStyle)) {
          groupBpMax = bpMaxSlsPrc.get(firstStyle);
        }
      }
      // Round UP to the nearest $0.05 to match the per-row Sls Prc rule.
      const slsPrcW = groupBpMax !== undefined
        ? groupBpMax
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
        r2[COL_SLS_MRGN_PCT - 1] = subPct(subMrgn);
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
    dataRows.push(buildSubtotalRow(currentGroupStyle, currentGroup));
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
    const onOrderV = (r.onOrder ?? 0) / qtyDiv;
    const onPOV    = (r.onPO    ?? 0) / qtyDiv;
    qtyRow[COL.onHand  - 1] = onHandV  === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onHandV,  t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    qtyRow[COL.onOrder - 1] = onOrderV === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onOrderV, t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    qtyRow[COL.onPO    - 1] = onPOV    === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onPOV,    t: "n", s: bodyNumStyle(FILL_QTY_COL) };

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
    const avgCostV = (r.avgCost ?? 0) * costMul;
    // Total cost = avgCost × the row's total qty across periods.
    // Both avgCostV and rowPeriodTotal have already been scaled by
    // costMul / qtyDiv (inverses); the product is grain-invariant.
    const totalCostV = avgCostV > 0 ? avgCostV * rowPeriodTotal : 0;
    // Implied sale price needed to hit `slsMarginPct` against avgCost.
    // price = avgCost / (1 - margin). Guard against margin >= 100.
    // Rounded UP to the nearest $0.05 so prices always end in 0 or 5.
    // Per-BP unification: every row of the same master_style shows the
    // HIGHEST formula-derived price across the BP's variants — pulled
    // from bpMaxSlsPrc. Falls through to the per-row formula when the
    // row has no master_style match.
    const styleKeyForSlsPrc = r.master_style ?? "";
    const slsPrcV = (avgCostV > 0 && slsMargin < 1)
      ? (styleKeyForSlsPrc && bpMaxSlsPrc.has(styleKeyForSlsPrc)
          ? bpMaxSlsPrc.get(styleKeyForSlsPrc)!
          : Math.ceil((avgCostV / (1 - slsMargin)) * 20) / 20)
      : 0;
    if (COL_AVG_COST) qtyRow[COL_AVG_COST - 1] = avgCostV === 0
      ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
      : { v: avgCostV, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };
    if (COL_TOT_COST) qtyRow[COL_TOT_COST - 1] = totalCostV === 0
      ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
      : { v: totalCostV, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };
    if (COL_SLS_PRC) qtyRow[COL_SLS_PRC - 1] = slsPrcV === 0
      ? { v: "", t: "s", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } }
      : { v: slsPrcV, t: "n", s: { ...bodyNumStyle(fill), numFmt: "$#,##0.00" } };

    // Mrgn % — see COL_SLS_MRGN_PCT declaration for the priority rules.
    // Falls back to formula margin (== slsMarginPct) when no preferred
    // price source applies.
    if (COL_SLS_MRGN_PCT) {
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
      const m = (derivedPrice > 0 && avgCostV > 0)
        ? (derivedPrice - avgCostV) / derivedPrice
        : 0;
      const base = bodyNumStyle(fill);
      const styled = mrgnColor === "default"
        ? { ...base, numFmt: "0.0%" }
        : { ...base, numFmt: "0.0%", font: { ...base.font, bold: true, color: { rgb: mrgnColor === "blue" ? MRGN_BLUE : MRGN_RED } } };
      qtyRow[COL_SLS_MRGN_PCT - 1] = m === 0
        ? { v: "", t: "s", s: styled }
        : { v: m, t: "n", s: styled };
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
      ppkRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.onHand  - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));
      ppkRow[COL.onOrder - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));
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
      for (const ci of [COL_AVG_COST, COL_TOT_COST, COL_SLS_PRC, COL_SLS_MRGN_PCT, COL_T3_QTY, COL_T3_PRICE, COL_T3_TTL_SLS, COL_T3_MRGN, COL_LY_QTY, COL_LY_PRICE, COL_LY_TTL_SLS, COL_LY_MRGN, COL_T3_LY_DIFF_QTY, COL_T3_LY_DIFF, COL_T3_LY_DIFF_MRGN]) {
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
    // Fill any optional extra columns with blank styled cells so the
    // outline finalizer + autofit see real cells and the bottom row
    // closes the table cleanly across its full width. Callers that
    // want real aggregates patch these in after.
    const optCols = [COL_AVG_COST, COL_TOT_COST, COL_SLS_PRC, COL_SLS_MRGN_PCT, COL_T3_QTY, COL_T3_PRICE, COL_T3_TTL_SLS, COL_T3_MRGN, COL_LY_QTY, COL_LY_PRICE, COL_LY_TTL_SLS, COL_LY_MRGN, COL_T3_LY_DIFF_QTY, COL_T3_LY_DIFF, COL_T3_LY_DIFF_MRGN];
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

    return { avgCostW, totalCostW: costSum, slsPrcW, slsMrgnW, t3Qty, t3RawQty: t3Qty, t3Price, t3Tot, t3Mrgn, lyQty, lyRawQty: lyQty, lyPrice, lyTot, lyMrgn };
  }

  // Overlay the optional-col aggregates onto a stack row in-place. Used
  // for the toggle-OFF Total row and the toggle-ON "TOTAL Qty" row.
  function patchOptColAggregates(cells: any[], agg: ReturnType<typeof computeOptColAggregates>) {
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
    setCurr(COL_AVG_COST,    agg.avgCostW);
    setCurr(COL_TOT_COST,    agg.totalCostW);
    setCurr(COL_SLS_PRC,     agg.slsPrcW);
    setPct (COL_SLS_MRGN_PCT, agg.slsMrgnW);
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
      (k) => t[k].qty,
      (key) => t.periodQty[key] ?? 0,
      () => periodSums.reduce((a, b) => a + b, 0),
    );
    patchOptColAggregates(totalQtyRow, computeOptColAggregates());
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
    const onOrderSum = rows.reduce((a, r) => a + (r.onOrder ?? 0), 0);
    const onPOSum    = rows.reduce((a, r) => a + (r.onPO    ?? 0), 0);
    const periodSumByKey: Record<string, number> = {};
    periods.forEach((p, i) => { periodSumByKey[p.endDate] = periodSums[i]; });
    const totalRow = buildStackRow(
      "Total",
      (k) => k === "onHand" ? onHandSum : k === "onOrder" ? onOrderSum : onPOSum,
      (key) => periodSumByKey[key] ?? 0,
      () => periodSums.reduce((a, b) => a + b, 0),
    );
    patchOptColAggregates(totalRow, computeOptColAggregates());
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
  // Title-row merge: span A1 across every column so the 22pt customer
  // name has room to render. Without this the adjacent cells (which
  // we wrote as { v: "", t: "s" } so the row width stays correct)
  // block Excel's text-overflow into neighbouring empty cells —
  // operator only sees the first ~8 chars in column A's narrow width.
  if (titleRow) {
    if (customerFilter && dateRangeText) {
      // Customer in col A (un-merged so its 22pt left-justified text
      // stays anchored), date range merged across B..lastCol so its
      // 20pt centered banner fills the rest of the row.
      merges.push({
        s: { r: 0, c: 1 },
        e: { r: 0, c: lastColIdx },
      });
    } else {
      // Single value (customer OR date range alone) — merge the full
      // row so its anchor cell can render the wide text without being
      // clipped by adjacent empty cells.
      merges.push({
        s: { r: 0, c: 0 },
        e: { r: 0, c: lastColIdx },
      });
    }
  }

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
    }
  }

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = effectiveAllRows;
  const ws  = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

  // ── Auto-fit column widths ──────────────────────────────────────────────
  const SPACER_WCH = 1.57;
  const PAD = 2;
  const MAX_WCH = 80;
  function widthForColumn(idx1: number): number {
    if (SPACER_COLS.has(idx1)) return SPACER_WCH;
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
    return Math.min(MAX_WCH, maxLen + PAD);
  }
  // Width array follows the same projection as the AOA when hideZero
  // is on: only emit widths for kept columns, in the same order.
  ws["!cols"] = [];
  if (columnIndexMap) {
    const keptOrigCols = [...columnIndexMap.keys()].sort((a, b) => (columnIndexMap!.get(a)! - columnIndexMap!.get(b)!));
    keptOrigCols.forEach((origCol, i) => {
      ws["!cols"][i] = { wch: widthForColumn(origCol) };
    });
  } else {
    for (let ci = 1; ci <= totalColumnCount; ci++) {
      ws["!cols"][ci - 1] = { wch: widthForColumn(ci) };
    }
  }

  // Row heights — set per Excel row index after we've already pushed
  // every dataRow (variants + PPK pairs + style subtotals + bottom
  // Total / stack). Header taller; PPK follower rows shorter; subtotal
  // and total rows a touch taller for visual weight.
  // Header height bumps when any cell wrapped (estimate two lines @
  // 11pt + padding). Single-line headers keep the tighter 22pt.
  const HEADER_HPT = headerHasWrap ? 34 : 22;
  const ROW_HPT = 15;
  const PPK_ROW_HPT = 11;
  const SUBTOTAL_HPT = 19;
  const TOTAL_HPT = 18;
  const rowsHeight: any[] = [];
  if (titleRow) rowsHeight.push({ hpt: 30 }); // taller for the 22pt customer name
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
      rowsHeight.push({ hpt: ROW_HPT });
    }
  }
  ws["!rows"] = rowsHeight;

  // Merged cells for prepack pairs — text + spacers + qty cols + Total
  // span both rows; only period cols stay split (qty top, PPK bottom).
  if (effectiveMerges.length > 0) {
    ws["!merges"] = effectiveMerges;
  }
  // No frozen panes, no autofilter.

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, "ATS Report");

  return { aoa, wb, filename: `ATS_Report_${fmtDate(new Date())}.xlsx`, title: "ATS Grid" };
}
