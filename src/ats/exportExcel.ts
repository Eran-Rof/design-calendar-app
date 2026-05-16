import XLSXStyle from "xlsx-js-style";
import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { fmtDate, displayColor } from "./helpers";
import type { GridTotals } from "./computeTotals";
import { periodAvail } from "./compute";
import type { ExportOptions } from "./panels/ExportOptionsModal";
import type { SalesFetchResult, SalesAggregate } from "./exportSalesFetch";

type EventIndex = Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>>;

const EMPTY_AGG: SalesAggregate = { qty: 0, totalPrice: 0 };
// Autofit non-spacer cols: max(len(value)) + 2, capped at 80.
// No frozen panes, no autofilter, no merged cells.
export function exportToExcel(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  atShip = false,
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
) {
  const payload = buildExportPayload(rows, periods, atShip, _hiddenColumns, _totals, options, _eventIndex, salesAggregates);
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
}

// Same as exportToExcel but returns the workbook + AOA without
// triggering a download. Used by the "View" flow so the preview modal
// can render the AOA before the operator decides whether to download.
export function buildExportPayload(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  atShip = false,
  _hiddenColumns: string[] = [],
  _totals: GridTotals | null = null,
  options?: ExportOptions,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _eventIndex?: EventIndex | null,
  salesAggregates?: SalesFetchResult,
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
    customerFacing:      options?.customerFacing      ?? false,
    hideZeroColumns:     options?.hideZeroColumns     ?? false,
  };
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
  // Skip rows whose availability is zero across every visible period.
  // Negatives (shortages) and positives are kept. Uses periodAvail so
  // the "any availability" test honors the same delta-when-atShip
  // semantic the cells render with — a row whose only non-zero free is
  // carried-over (no new receipts) still counts as having availability
  // because period-0 is cumulative under that helper.
  const hasAnyAvailability = (r: ATSRow): boolean => {
    for (let i = 0; i < periods.length; i++) {
      const v = periodAvail(r, periods, i, atShip);
      if (v !== 0) return true;
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
  const COL_T3_QTY:      number | undefined = opts.trailing3    ? nextCol++ : undefined;
  const COL_T3_PRICE:    number | undefined = opts.trailing3    ? nextCol++ : undefined;
  const COL_T3_TTL_SLS:  number | undefined = opts.trailing3    ? nextCol++ : undefined;
  const COL_T3_MRGN:     number | undefined = (opts.trailing3 && showT3Margin) ? nextCol++ : undefined;
  const COL_LY_QTY:      number | undefined = opts.spLY         ? nextCol++ : undefined;
  const COL_LY_PRICE:    number | undefined = opts.spLY         ? nextCol++ : undefined;
  const COL_LY_TTL_SLS:  number | undefined = opts.spLY         ? nextCol++ : undefined;
  const COL_LY_MRGN:     number | undefined = (opts.spLY && showT3Margin) ? nextCol++ : undefined;

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
  const headerStyle = (fill: string, align: "left" | "center"): any => ({
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center", wrapText: false },
    border:    BORDER_HEADER,
  });
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
  const headerRow: any[] = new Array(totalColumnCount);
  headerRow[COL.category    - 1] = { v: "Category",    t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.subCat      - 1] = { v: "Sub Cat",     t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.style       - 1] = { v: "Style",       t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.description - 1] = { v: "Description", t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.color       - 1] = { v: "Color",       t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.spacerF - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerH - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerJ - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerL - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.onHand  - 1] = { v: "On Hand",  t: "s", s: headerStyle(HDR_ONHAND_FILL, "center") };
  headerRow[COL.onOrder - 1] = { v: "On Order", t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  headerRow[COL.onPO    - 1] = { v: "On PO",    t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  for (let i = 0; i < numPeriods; i++) {
    const ci = COL.firstPeriod + i;
    headerRow[ci - 1] = {
      v: periods[i].label.replace(/\n/g, " "),
      t: "s",
      s: headerStyle(HDR_DARK_FILL, "center"),
    };
  }
  headerRow[COL.total - 1] = { v: "Total", t: "s", s: headerStyle(HDR_DARK_FILL, "center") };

  // Optional extra-column headers. Slls Prc col header carries the
  // user-chosen margin pct so the spreadsheet documents the
  // calculation (e.g. "Sls Prc @ 21%").
  if (COL_AVG_COST) headerRow[COL_AVG_COST - 1] = { v: "Avg Cost",   t: "s", s: headerStyle(HDR_ONHAND_FILL, "center") };
  if (COL_TOT_COST) headerRow[COL_TOT_COST - 1] = { v: "Total Cost", t: "s", s: headerStyle(HDR_ONHAND_FILL, "center") };
  if (COL_SLS_PRC)  headerRow[COL_SLS_PRC  - 1] = { v: `Sls Prc @ ${opts.slsMarginPct}%`, t: "s", s: headerStyle(HDR_ONHAND_FILL, "center") };
  // T3/LY column labels reflect the customer narrowing so the
  // spreadsheet is self-documenting. Format: "T3 Qty" / "T3 Qty (Acme)".
  const custTag = customerFilter ? ` (${customerFilter})` : "";
  if (COL_T3_QTY)     headerRow[COL_T3_QTY     - 1] = { v: `T3 Qty${custTag}`, t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  if (COL_T3_PRICE)   headerRow[COL_T3_PRICE   - 1] = { v: `T3 Sls Price`,     t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  if (COL_T3_TTL_SLS) headerRow[COL_T3_TTL_SLS - 1] = { v: `T3 Ttl Sls`,       t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  if (COL_T3_MRGN)    headerRow[COL_T3_MRGN    - 1] = { v: `T3 Mrgn %`,        t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  if (COL_LY_QTY)     headerRow[COL_LY_QTY     - 1] = { v: `S/P LY${custTag}`, t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  if (COL_LY_PRICE)   headerRow[COL_LY_PRICE   - 1] = { v: `LY Sls Price`,     t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  if (COL_LY_TTL_SLS) headerRow[COL_LY_TTL_SLS - 1] = { v: `LY Ttl Sls`,       t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  if (COL_LY_MRGN)    headerRow[COL_LY_MRGN    - 1] = { v: `LY Mrgn %`,        t: "s", s: headerStyle(HDR_DARK_FILL, "center") };

  // ── Trailing-3 / SP-LY aggregate lookups ──────────────────────────────
  // Pre-fetched maps keyed by ATS-row sku (variant grain). The fetcher
  // queried ip_sales_history_wholesale for the relevant windows already
  // and honored the customer narrow.
  const t3Map = salesAggregates?.t3 ?? new Map<string, SalesAggregate>();
  const lyMap = salesAggregates?.ly ?? new Map<string, SalesAggregate>();
  const t3Of = (sku: string): SalesAggregate => t3Map.get(sku) ?? EMPTY_AGG;
  const lyOf = (sku: string): SalesAggregate => lyMap.get(sku) ?? EMPTY_AGG;

  // ── Helpers ────────────────────────────────────────────────────────────
  // Index-aware accessor — periodAvail handles the atShip=delta case
  // (cumulative free at period 0; per-period new-receipt delta after).
  const periodValueOf = (r: ATSRow, i: number): number => {
    return periodAvail(r, periods, i, atShip);
  };
  const sumStartLetter = colLetter(COL.spacerL);   // L (empty spacer)
  const sumEndLetter = colLetter(COL.lastPeriod);  // last period letter

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
      COL_AVG_COST, COL_TOT_COST, COL_SLS_PRC,
      COL_T3_QTY, COL_T3_PRICE, COL_T3_TTL_SLS, COL_T3_MRGN,
      COL_LY_QTY, COL_LY_PRICE, COL_LY_TTL_SLS, COL_LY_MRGN,
    ].filter((c): c is number => c !== undefined)),
  ];

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
    if (COL_AVG_COST || COL_TOT_COST || COL_SLS_PRC) {
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
      const slsPrcW = (weightedAvgCost > 0 && slsMargin < 1)
        ? weightedAvgCost / (1 - slsMargin)
        : 0;
      if (COL_AVG_COST) r2[COL_AVG_COST - 1] = subCurr(weightedAvgCost);
      if (COL_TOT_COST) r2[COL_TOT_COST - 1] = subCurr(totalCostSum);
      if (COL_SLS_PRC)  r2[COL_SLS_PRC  - 1] = subCurr(slsPrcW);
    }

    if (opts.trailing3) {
      let qty = 0, totalPrice = 0, totalCost = 0;
      for (const x of group) {
        const xT3 = t3Of(x.sku);
        qty += xT3.qty;
        totalPrice += xT3.totalPrice;
        totalCost += (x.avgCost ?? 0) * xT3.qty;
      }
      const price = qty > 0 ? totalPrice / qty : 0;
      const mrgnPct = totalPrice > 0 && totalCost > 0 ? ((totalPrice - totalCost) / totalPrice) * 100 : 0;
      if (COL_T3_QTY)     r2[COL_T3_QTY     - 1] = subCell(qty);
      if (COL_T3_PRICE)   r2[COL_T3_PRICE   - 1] = subCurr(price);
      if (COL_T3_TTL_SLS) r2[COL_T3_TTL_SLS - 1] = subCurr(totalPrice);
      if (COL_T3_MRGN)    r2[COL_T3_MRGN    - 1] = subPct(mrgnPct / 100);
    }
    if (opts.spLY) {
      let qty = 0, totalPrice = 0, totalCost = 0;
      for (const x of group) {
        const xLY = lyOf(x.sku);
        qty += xLY.qty;
        totalPrice += xLY.totalPrice;
        totalCost += (x.avgCost ?? 0) * xLY.qty;
      }
      const price = qty > 0 ? totalPrice / qty : 0;
      const mrgnPct = totalPrice > 0 && totalCost > 0 ? ((totalPrice - totalCost) / totalPrice) * 100 : 0;
      if (COL_LY_QTY)     r2[COL_LY_QTY     - 1] = subCell(qty);
      if (COL_LY_PRICE)   r2[COL_LY_PRICE   - 1] = subCurr(price);
      if (COL_LY_TTL_SLS) r2[COL_LY_TTL_SLS - 1] = subCurr(totalPrice);
      if (COL_LY_MRGN)    r2[COL_LY_MRGN    - 1] = subPct(mrgnPct / 100);
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
    const mult = r.ppkMult ?? 1;
    const isPrepack = mult > 1;

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
    const onHandV  = r.onHand  ?? 0;
    const onOrderV = r.onOrder ?? 0;
    const onPOV    = r.onPO    ?? 0;
    qtyRow[COL.onHand  - 1] = onHandV  === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onHandV,  t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    qtyRow[COL.onOrder - 1] = onOrderV === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onOrderV, t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    qtyRow[COL.onPO    - 1] = onPOV    === 0 ? { v: "", t: "s", s: bodyNumStyle(FILL_QTY_COL) } : { v: onPOV,    t: "n", s: bodyNumStyle(FILL_QTY_COL) };

    // Period cells. For prepack rows the qty sits at the BOTTOM of
    // its cell (anchored to the bottom edge) so the PPK suffix on the
    // row below visually sits flush against it. Non-prepack rows get
    // standard center alignment.
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      const n = periodValueOf(r, i);
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
      rowPeriodTotal += periodValueOf(r, i);
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
    const avgCostV = r.avgCost ?? 0;
    // Total cost = avgCost × the row's total qty across periods.
    // (Same Total the spreadsheet displays in COL.total.)
    const totalCostV = avgCostV > 0 ? avgCostV * rowPeriodTotal : 0;
    // Implied sale price needed to hit `slsMarginPct` against avgCost.
    // price = avgCost / (1 - margin). Guard against margin >= 100.
    const slsPrcV = (avgCostV > 0 && slsMargin < 1)
      ? avgCostV / (1 - slsMargin)
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

    // Trailing 3 — sales over the last 3 months from today, optionally
    // narrowed to one customer. Both sides of the margin formula
    // operate at UNIT grain: ip_sales_history_wholesale.qty is the
    // invoice's per-unit qty (not pack count) per xoro-sales-sync.js,
    // and avgCost on the row is per-unit. Do NOT multiply by ppkMult
    // — that's a leftover assumption from the right-click menu, which
    // reads pack-grain SOs from the operator upload.
    if (opts.trailing3) {
      const t3 = t3Of(r.sku);
      const t3Price = t3.qty > 0 ? t3.totalPrice / t3.qty : 0;
      const t3MrgnPct = (avgCostV > 0 && t3Price > 0)
        ? ((t3Price - avgCostV) / t3Price) * 100
        : 0;
      if (COL_T3_QTY)     qtyRow[COL_T3_QTY     - 1] = t3.qty === 0
        ? { v: "", t: "s", s: bodyNumStyle(fill) }
        : { v: t3.qty, t: "n", s: bodyNumStyle(fill) };
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

    // Same-Period Last Year — same window 12 months ago. Same
    // unit-grain math as T3 (sales history is per-unit, avgCost is
    // per-unit, no ppkMult adjustment).
    if (opts.spLY) {
      const ly = lyOf(r.sku);
      const lyPrice = ly.qty > 0 ? ly.totalPrice / ly.qty : 0;
      const lyMrgnPct = (avgCostV > 0 && lyPrice > 0)
        ? ((lyPrice - avgCostV) / lyPrice) * 100
        : 0;
      if (COL_LY_QTY)     qtyRow[COL_LY_QTY     - 1] = ly.qty === 0
        ? { v: "", t: "s", s: bodyNumStyle(fill) }
        : { v: ly.qty, t: "n", s: bodyNumStyle(fill) };
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
      for (const ci of [COL_AVG_COST, COL_TOT_COST, COL_SLS_PRC, COL_T3_QTY, COL_T3_PRICE, COL_T3_TTL_SLS, COL_T3_MRGN, COL_LY_QTY, COL_LY_PRICE, COL_LY_TTL_SLS, COL_LY_MRGN]) {
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
    const optCols = [COL_AVG_COST, COL_TOT_COST, COL_SLS_PRC, COL_T3_QTY, COL_T3_PRICE, COL_T3_TTL_SLS, COL_T3_MRGN, COL_LY_QTY, COL_LY_PRICE, COL_LY_TTL_SLS, COL_LY_MRGN];
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
    const slsPrcW = (avgCostW > 0 && slsMargin < 1) ? avgCostW / (1 - slsMargin) : 0;

    let t3Qty = 0, t3Tot = 0, t3CostBasis = 0;
    let lyQty = 0, lyTot = 0, lyCostBasis = 0;
    for (const r of rows) {
      const a = r.avgCost ?? 0;
      if (opts.trailing3) {
        const t = t3Of(r.sku);
        t3Qty += t.qty;
        t3Tot += t.totalPrice;
        t3CostBasis += a * t.qty;
      }
      if (opts.spLY) {
        const l = lyOf(r.sku);
        lyQty += l.qty;
        lyTot += l.totalPrice;
        lyCostBasis += a * l.qty;
      }
    }
    const t3Price = t3Qty > 0 ? t3Tot / t3Qty : 0;
    const lyPrice = lyQty > 0 ? lyTot / lyQty : 0;
    const t3Mrgn  = t3Tot > 0 && t3CostBasis > 0 ? (t3Tot - t3CostBasis) / t3Tot : 0;
    const lyMrgn  = lyTot > 0 && lyCostBasis > 0 ? (lyTot - lyCostBasis) / lyTot : 0;

    return { avgCostW, totalCostW: costSum, slsPrcW, t3Qty, t3Price, t3Tot, t3Mrgn, lyQty, lyPrice, lyTot, lyMrgn };
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
    setQty (COL_T3_QTY,      agg.t3Qty);
    setCurr(COL_T3_PRICE,    agg.t3Price);
    setCurr(COL_T3_TTL_SLS,  agg.t3Tot);
    setPct (COL_T3_MRGN,     agg.t3Mrgn);
    setQty (COL_LY_QTY,      agg.lyQty);
    setCurr(COL_LY_PRICE,    agg.lyPrice);
    setCurr(COL_LY_TTL_SLS,  agg.lyTot);
    setPct (COL_LY_MRGN,     agg.lyMrgn);
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
  // When the operator narrowed by customer, prepend a single text row
  // with the customer name in cell A, 22pt, left-justified. The row
  // sits OUTSIDE the bordered table — the outer rectangle still frames
  // header + data rows below it.
  let titleRow: any[] | null = null;
  if (customerFilter) {
    titleRow = new Array(totalColumnCount).fill(null).map(() => ({ v: "", t: "s" as const }));
    titleRow[0] = {
      v: customerFilter,
      t: "s",
      s: {
        font: { sz: 22, bold: true, color: { rgb: "1F497D" }, name: "Calibri" },
        alignment: { horizontal: "left", vertical: "center" },
      },
    };
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
    merges.push({
      s: { r: 0, c: 0 },
      e: { r: 0, c: lastColIdx },
    });
  }

  // ── Optional pass: drop columns whose body is entirely empty ──────────
  // Always-keep columns: the text identity block + every spacer.
  // Everything else stays only if at least one body row has a
  // non-empty value (numbers we'd render as blanks under the
  // zero-blanks policy are already stored as { v: "" }, so a true
  // "all zero" column has no v's to find here).
  let effectiveAllRows = allRows;
  let effectiveMerges  = merges;
  let columnIndexMap: Map<number, number> | null = null; // old 1-based → new 1-based
  if (opts.hideZeroColumns) {
    const alwaysKeep = new Set<number>([
      COL.category, COL.subCat, COL.style, COL.description, COL.color,
      COL.spacerF, COL.spacerH, COL.spacerJ, COL.spacerL,
    ]);
    const hasData = new Set<number>();
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
    const keptList: number[] = [];
    for (let c = 1; c <= totalColumnCount; c++) {
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
    if (hdrCell?.v != null) maxLen = String(hdrCell.v).length;
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
  const HEADER_HPT = 22;
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

  return { aoa, wb, filename: `ATS_Report_${fmtDate(new Date())}.xlsx` };
}
