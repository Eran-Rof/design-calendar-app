// Sales Comps Excel export — styled to match the main ATS report family
// (exportExcel.ts + the four PR #280 exports). The exportTheme.ts
// builders provide every palette / header / body / total / border atom;
// this file is purely layout: title banner row, window banners,
// scope/explode banners, totals stack (with grain-split when mixed),
// per-dim CompsTable sections, and SO section.
//
// Preview-parity rule: the modal's on-screen render is the source of
// truth for sections / row splits / numbers. This file styles them.
// Don't change shape / dimensions / sectioning here.

import { fmtDateDisplay } from "./helpers";
import {
  PALETTE, ROW_HEIGHTS, BORDER_BODY, BORDER_HEADER, BORDER_TOTAL, EXTRA_THICK,
  headerStyle, bodyTextStyle, bodyNumStyle,
  subtotalTextStyle, subtotalNumStyle,
  totalLabelStyle, totalNumStyle,
  zebraFill, numOrBlank,
  autofitColumns, buildMultiSheetWorkbook, writeWorkbookToFile,
} from "./exportTheme";
import type { DimRow, DimTotals } from "./salesCompsAggregate";

// ── SO row shape (kept in sync with SalesCompsModal's SoRow) ───────────
export type SoRowDetail = {
  kind: "row";
  key: string;
  label: string;
  style?: string;
  orderNumber?: string;
  customer?: string;
  cancelDate?: string;
  tyQty: number; tyRev: number; tyMrgn: number;
  lyQty: number; lyRev: number; lyMrgn: number;
};
export type SoRowSubtotal = {
  kind: "subtotal";
  key: string;
  label: string;
  tyQty: number; tyRev: number; tyMrgn: number;
  lyQty: number; lyRev: number; lyMrgn: number;
};
export type SoRow = SoRowDetail | SoRowSubtotal;

// Catch-all subtotal row appended to the SO section: aggregates LY ship
// $ for styles that exist in the LY ship history but have ZERO open TY
// SOs in the current scope. Without this, the SO TOTAL LY would
// systematically undercount vs the Customer / Style / Sub-Cat sections
// (which already include those styles via the per-style ship-history
// match). The row is detected by SO_CATCHALL_KEY in the TOTAL emitters
// so its LY contribution is folded into the bottom TOTAL row.
export const SO_CATCHALL_KEY = "__catchall::no_ty_so";
export const SO_CATCHALL_LABEL = "LY shipped, no TY SO";

// Pure helper — returns a catch-all subtotal row (or null) for every
// style in lyRevByStyle that is NOT covered by a TY SO in the current
// scope. Exported for unit tests and called from the modal's soRows
// useMemo for each groupBy variant.
export function computeSoCatchallRow(
  tyStyles: Set<string>,
  lyRevByStyle: Map<string, { qty: number; rev: number; mrgn: number }>,
): SoRowSubtotal | null {
  let qty = 0, rev = 0, mrgn = 0;
  for (const [style, agg] of lyRevByStyle) {
    if (tyStyles.has(style)) continue;
    if (agg.qty <= 0 && agg.rev <= 0) continue;
    qty += agg.qty;
    rev += agg.rev;
    mrgn += agg.mrgn;
  }
  if (qty === 0 && rev === 0 && mrgn === 0) return null;
  return {
    kind: "subtotal",
    key: SO_CATCHALL_KEY,
    label: SO_CATCHALL_LABEL,
    tyQty: 0, tyRev: 0, tyMrgn: 0,
    lyQty: qty, lyRev: rev, lyMrgn: mrgn,
  };
}

export type ViewByKey = "customer" | "category" | "sub_category" | "style" | "sku" | "so";

const VIEW_BY_LABELS: Record<ViewByKey, string> = {
  customer:     "Customer",
  category:     "Category",
  sub_category: "Sub-Category",
  style:        "Style",
  sku:          "Style/Color",
  so:           "SO (open vs LY ship)",
};

export interface SalesCompsExportInput {
  start: string;
  end:   string;
  scope: {
    customer:        string[];
    selStores:       string[];
    selCategories:   string[];
    selSubCategories:string[];
    selStyles:       string[];
  };
  customerFacing: boolean;
  explodePpk:     boolean;
  // Permission gate (P14 RBAC `margins:export`). When true, every actual-
  // margin row/column (Margin $, Margin %, TY/LY Mrgn, Δ Margin pp) is
  // dropped from the workbook; COGS stays. Optional so existing callers/tests
  // stay valid (defaults false = margins included).
  hideMargins?: boolean;
  // Totals stack at the top of the workbook.
  dimTotals: DimTotals;
  // Per-View By dimension. Order is the operator's selection order.
  // Each dim resolves its own dataRows + totals (passed in pre-computed
  // by the modal so the modal stays the source of truth).
  viewSections: Array<
    | { kind: "dim"; dim: Exclude<ViewByKey, "so">; dataRows: DimRow[]; dataTotals: DimTotals }
    | { kind: "so"; viewBy: ViewByKey[]; soRows: SoRow[] }
  >;
}

// ── Date / number formatting helpers ───────────────────────────────────
// MMM/DD/YYYY for header banner dates (cross-app convention — see
// feedback_export_header_conventions.md).
function fmtBannerDate(iso: string): string {
  return fmtDateDisplay(iso);
}

// Match the modal's fmtGrowth: (ty - ly) / ty. NEW when ty > 0, ly = 0.
function growthCell(ty: number, ly: number, style: any): any {
  if (!Number.isFinite(ty)) ty = 0;
  if (!Number.isFinite(ly)) ly = 0;
  if (ty <= 0 && ly <= 0) return { v: "", t: "s", s: style };
  // "Only LY" matches the modal's fmtGrowth label (was "GONE", drifted from modal).
  if (ty <= 0) return { v: "Only LY", t: "s", s: style };
  const frac = (ty - ly) / ty;
  return { v: frac, t: "n", s: { ...style, numFmt: "+0.0%;-0.0%;0.0%" } };
}

// Margin-points cell: (tyMrgn/tyRev) - (lyMrgn/lyRev). Stored as fraction
// with a "pp" suffix via custom numFmt — readable to the operator as
// percentage points (Excel formats 0.03 → "+3.0pp").
function marginPointsCell(tyMrgn: number, tyRev: number, lyMrgn: number, lyRev: number, style: any): any {
  const tyPct = tyRev > 0 ? tyMrgn / tyRev : 0;
  const lyPct = lyRev > 0 ? lyMrgn / lyRev : 0;
  if (tyPct === 0 || lyPct === 0) return { v: "", t: "s", s: style };
  const diff = tyPct - lyPct;
  return { v: diff, t: "n", s: { ...style, numFmt: '+0.0"pp";-0.0"pp";0.0"pp"' } };
}

// Currency / qty / pct formatters.
const NUMFMT_USD = '"$"#,##0';
const NUMFMT_QTY = "#,##0";
const NUMFMT_PCT = "0.0%";

// ── Banner / header style atoms ────────────────────────────────────────
// Big title-row banner: 20pt bold navy on a light fill, centered.
function titleBannerStyle(): any {
  return {
    font:      { bold: true, sz: 20, color: { rgb: PALETTE.HEADER_DARK }, name: "Calibri" },
    alignment: { horizontal: "center", vertical: "center" },
    fill:      { fgColor: { rgb: PALETTE.ZEBRA_EVEN }, patternType: "solid" },
    border:    BORDER_HEADER,
  };
}
// Window banner (TY / LY rows): 12pt bold, left-justified.
function windowBannerStyle(): any {
  return {
    font:      { bold: true, sz: 12, color: { rgb: PALETTE.HEADER_DARK }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
    fill:      { fgColor: { rgb: PALETTE.ZEBRA_EVEN }, patternType: "solid" },
    border:    BORDER_BODY,
  };
}
// Scope / explode banner row — slightly muted under the window banner.
function scopeBannerStyle(): any {
  return {
    font:      { sz: 11, italic: true, color: { rgb: "566580" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
    fill:      { fgColor: { rgb: PALETTE.ZEBRA_ODD }, patternType: "solid" },
    border:    BORDER_BODY,
  };
}
// Section banner that announces a per-dim block (e.g. "-- Customer --").
function sectionBannerStyle(): any {
  return {
    font:      { bold: true, sz: 13, color: { rgb: "FFFFFF" }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
    fill:      { fgColor: { rgb: PALETTE.HEADER_DARK }, patternType: "solid" },
    border:    BORDER_HEADER,
  };
}
// Totals-stack label cell for the top combined-totals block.
function totalsRowLabelStyle(): any {
  return {
    font:      { bold: true, sz: 11, color: { rgb: PALETTE.STYLE_TEXT }, name: "Calibri" },
    alignment: { horizontal: "left", vertical: "center" },
    fill:      { fgColor: { rgb: PALETTE.QTY_BAND }, patternType: "solid" },
    border:    BORDER_BODY,
  };
}
function totalsRowNumStyle(): any {
  return {
    font:      { bold: true, sz: 11, color: { rgb: PALETTE.STYLE_TEXT }, name: "Calibri" },
    alignment: { horizontal: "center", vertical: "center" },
    fill:      { fgColor: { rgb: PALETTE.QTY_BAND }, patternType: "solid" },
    border:    BORDER_BODY,
  };
}
// Margin-% row in the top totals stack — closes each stack with the
// total-row border treatment.
function totalsBottomLabelStyle(): any {
  return { ...totalsRowLabelStyle(), border: BORDER_TOTAL };
}
function totalsBottomNumStyle(): any {
  return { ...totalsRowNumStyle(), border: BORDER_TOTAL };
}

// ── Header builder with auto-wrap for > 10 chars ───────────────────────
// Returns a header cell. wrapText is set at construction time (NOT via
// post-walk) per the cross-app convention. The fmt callback can apply
// extra style props before the wrap-flag is added.
function headerCell(value: string, fill: string, align: "left" | "center" = "center"): any {
  const wrap = value.length > 10;
  const style = headerStyle(fill, align);
  if (wrap) {
    style.alignment = { ...style.alignment, wrapText: true };
  }
  return { v: value, t: "s", s: style };
}

// Width-fit input — tracks whether any header is wrapped so we can cap
// the header contribution at 12 chars (lets the wrap actually engage).
function widthsForRows(headerRow: any[], bodyRows: any[][]): Array<{ wch: number }> {
  const cols = headerRow.length;
  const widths: Array<{ wch: number }> = [];
  for (let ci = 0; ci < cols; ci++) {
    const hdr = headerRow[ci];
    const hdrWraps = !!hdr?.s?.alignment?.wrapText;
    const hdrLen = hdr?.v != null ? String(hdr.v).length : 0;
    let maxLen = hdrWraps ? Math.min(hdrLen, 12) : hdrLen;
    for (const row of bodyRows) {
      const cell = row[ci];
      if (!cell) continue;
      const v = cell.v;
      let s: string;
      if (typeof v === "number") s = v.toLocaleString();
      else s = String(v ?? "");
      if (s.length > maxLen) maxLen = s.length;
    }
    widths.push({ wch: Math.min(60, maxLen + 2) });
  }
  return widths;
}

// ── Per-stack totals row emitter ───────────────────────────────────────
// One stack = 5 rows (Units / Revenue / COGS / Margin $ / Margin %) or
// 2 rows (Units / Revenue) when customerFacing is ON. The label column
// uses totalsRowLabelStyle; the TY / LY / Δ columns use totalsRowNumStyle.
// The bottom row of each stack gets the heavier TOTAL border.
function pushTotalsStack(
  aoa: any[][],
  label: string,
  t: DimTotals["combined"],
  customerFacing: boolean,
  hideMargins: boolean,
): void {
  const lbl = totalsRowLabelStyle();
  const num = totalsRowNumStyle();
  const lblBot = totalsBottomLabelStyle();
  const numBot = totalsBottomNumStyle();

  // Units row.
  aoa.push([
    { v: `Units — ${label}`, t: "s", s: lbl },
    numOrBlank(t.tyQty, num, { numFmt: NUMFMT_QTY }),
    numOrBlank(t.lyQty, num, { numFmt: NUMFMT_QTY }),
    growthCell(t.tyQty, t.lyQty, num),
  ]);
  // Revenue row.
  aoa.push([
    { v: `Revenue — ${label}`, t: "s", s: lbl },
    numOrBlank(t.tyRev, num, { numFmt: NUMFMT_USD }),
    numOrBlank(t.lyRev, num, { numFmt: NUMFMT_USD }),
    growthCell(t.tyRev, t.lyRev, num),
  ]);
  if (customerFacing) {
    // Bottom row of the customer-facing stack gets TOTAL border closure.
    // Re-style the just-pushed Revenue row labels to use bot styles.
    const last = aoa[aoa.length - 1];
    last[0] = { ...last[0], s: lblBot };
    for (let i = 1; i < last.length; i++) {
      last[i] = { ...last[i], s: { ...last[i].s, border: BORDER_TOTAL } };
    }
    return;
  }
  // COGS row.
  aoa.push([
    { v: `COGS — ${label}`, t: "s", s: lbl },
    numOrBlank(t.tyCogs, num, { numFmt: NUMFMT_USD }),
    numOrBlank(t.lyCogs, num, { numFmt: NUMFMT_USD }),
    growthCell(t.tyCogs, t.lyCogs, num),
  ]);
  if (hideMargins) {
    // Margin rows are permission-gated out — COGS becomes the bottom row of
    // the stack; close it with the heavier TOTAL border (same as the
    // customer-facing Revenue closure above).
    const last = aoa[aoa.length - 1];
    last[0] = { ...last[0], s: lblBot };
    for (let i = 1; i < last.length; i++) {
      last[i] = { ...last[i], s: { ...last[i].s, border: BORDER_TOTAL } };
    }
    return;
  }
  // Margin $ row.
  aoa.push([
    { v: `Margin $ — ${label}`, t: "s", s: lbl },
    numOrBlank(t.tyMrgn, num, { numFmt: NUMFMT_USD }),
    numOrBlank(t.lyMrgn, num, { numFmt: NUMFMT_USD }),
    growthCell(t.tyMrgn, t.lyMrgn, num),
  ]);
  // Margin % row — bottom of stack, heavier border.
  const tyPct = t.tyRev > 0 ? t.tyMrgn / t.tyRev : 0;
  const lyPct = t.lyRev > 0 ? t.lyMrgn / t.lyRev : 0;
  aoa.push([
    { v: `Margin % — ${label}`, t: "s", s: lblBot },
    tyPct > 0
      ? { v: tyPct, t: "n", s: { ...numBot, numFmt: NUMFMT_PCT } }
      : { v: "", t: "s", s: numBot },
    lyPct > 0
      ? { v: lyPct, t: "n", s: { ...numBot, numFmt: NUMFMT_PCT } }
      : { v: "", t: "s", s: numBot },
    marginPointsCell(t.tyMrgn, t.tyRev, t.lyMrgn, t.lyRev, numBot),
  ]);
}

// ── SO section header chooser (mirrors SalesCompsModal exactly) ────────
function soSectionHeader(viewBy: ViewByKey[]): { showSoMeta: boolean; soDimLabel: string } {
  const showSoMeta =
    viewBy.includes("style") ||
    !(viewBy.includes("customer") || viewBy.includes("category") || viewBy.includes("sub_category"));
  const soDimLabel =
    viewBy.includes("customer")     ? "Customer" :
    viewBy.includes("category")     ? "Category" :
    viewBy.includes("sub_category") ? "Sub-Category" :
    "SO";
  return { showSoMeta, soDimLabel };
}

// ── Main entry point ───────────────────────────────────────────────────
export function buildSalesCompsWorkbook(input: SalesCompsExportInput): { wb: any; filename: string } {
  const { start, end, scope, customerFacing, explodePpk, dimTotals, viewSections } = input;
  const hideMargins = input.hideMargins ?? false;

  // ── Layout setup ─────────────────────────────────────────────────────
  // The widest section drives the column count so every row pads to the
  // same width. The per-dim sections (customerFacing ? 6 : hideMargins ? 8
  // : 13 cols) are usually widest. SO with style co-selected is 9 cols
  // (showSoMeta).
  let maxCols = 4; // top totals stack: label + TY + LY + Δ
  for (const sec of viewSections) {
    if (sec.kind === "dim") {
      maxCols = Math.max(maxCols, customerFacing ? 6 : hideMargins ? 8 : 13);
    } else {
      const { showSoMeta } = soSectionHeader(sec.viewBy);
      maxCols = Math.max(maxCols, showSoMeta ? 9 : 6);
    }
  }

  const aoa: any[][] = [];
  // Merges accumulated for the title banner + window banners + scope rows
  // + section-banner rows so each one spans the full width.
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [];

  const padRow = (row: any[]): any[] => {
    if (row.length >= maxCols) return row;
    const padFill = row.length > 0 && row[row.length - 1]?.s
      ? { v: "", t: "s", s: row[row.length - 1].s }
      : { v: "", t: "s" };
    return [...row, ...Array(maxCols - row.length).fill(null).map(() => ({ ...padFill }))];
  };

  // ── Title row ────────────────────────────────────────────────────────
  const titleStyle = titleBannerStyle();
  aoa.push([{ v: "Sales Comps", t: "s", s: titleStyle }]);
  // Pad with empty cells carrying the same style so the banner reads as
  // one continuous bar; merge across the row.
  while (aoa[aoa.length - 1].length < maxCols) {
    aoa[aoa.length - 1].push({ v: "", t: "s", s: titleStyle });
  }
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: maxCols - 1 } });

  // ── Window banners (TY + LY) ─────────────────────────────────────────
  const winStyle = windowBannerStyle();
  const tyRow: any[] = [{ v: `TY window: ${fmtBannerDate(start)} .. ${fmtBannerDate(end)}`, t: "s", s: winStyle }];
  while (tyRow.length < maxCols) tyRow.push({ v: "", t: "s", s: winStyle });
  aoa.push(tyRow);
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: maxCols - 1 } });

  const lyStart = isoMinusMonths(start, 12);
  const lyEnd   = isoMinusMonths(end,   12);
  const lyRow: any[] = [{ v: `LY window: ${fmtBannerDate(lyStart)} .. ${fmtBannerDate(lyEnd)}`, t: "s", s: winStyle }];
  while (lyRow.length < maxCols) lyRow.push({ v: "", t: "s", s: winStyle });
  aoa.push(lyRow);
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: maxCols - 1 } });

  // ── Scope + Explode rows ─────────────────────────────────────────────
  const scopeText = buildScopeText(scope, customerFacing);
  const scopeStyle = scopeBannerStyle();
  const scopeAoaRow: any[] = [{ v: `Scope: ${scopeText}`, t: "s", s: scopeStyle }];
  while (scopeAoaRow.length < maxCols) scopeAoaRow.push({ v: "", t: "s", s: scopeStyle });
  aoa.push(scopeAoaRow);
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: maxCols - 1 } });

  const explodeText = explodePpk
    ? "Explode PPK: ON (qty in eaches, PPK + each siblings collapsed)"
    : "Explode PPK: OFF (qty in master native grain, PPK and each split)";
  const explodeAoaRow: any[] = [{ v: explodeText, t: "s", s: scopeStyle }];
  while (explodeAoaRow.length < maxCols) explodeAoaRow.push({ v: "", t: "s", s: scopeStyle });
  aoa.push(explodeAoaRow);
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: maxCols - 1 } });

  // Track header rows for autofit (only the first per-dim header row
  // is needed to compute widths; the rest are narrower or identical).
  let firstHeaderRow: any[] | null = null;
  let firstBodyRowsStart = -1;

  // ── Top totals stack ────────────────────────────────────────────────
  // Spacer row above the totals header.
  aoa.push(padRow([{ v: "", t: "s" }]));
  // Header row for the stack (TY / LY / Δ).
  const stackHeader = padRow([
    headerCell("", PALETTE.HEADER_TEXT, "left"),
    headerCell("TY", PALETTE.HEADER_DARK),
    headerCell("LY", PALETTE.HEADER_DARK),
    headerCell("Δ",  PALETTE.HEADER_DARK),
  ]);
  aoa.push(stackHeader);

  if (dimTotals.hasMixed) {
    pushTotalsStack(aoa, "PPK packs", dimTotals.ppk, customerFacing, hideMargins);
    aoa.push(padRow([{ v: "", t: "s" }])); // spacer between sub-stacks
    pushTotalsStack(aoa, "each",      dimTotals.each, customerFacing, hideMargins);
  } else {
    pushTotalsStack(aoa, "TOTAL", dimTotals.combined, customerFacing, hideMargins);
  }

  // Pad every totals row to maxCols.
  // (pushTotalsStack emits 4-col rows; pad those out here.)
  for (let r = 0; r < aoa.length; r++) {
    if (aoa[r].length < maxCols) {
      const last = aoa[r][aoa[r].length - 1];
      const fillStyle = last?.s ?? {};
      while (aoa[r].length < maxCols) {
        aoa[r].push({ v: "", t: "s", s: fillStyle });
      }
    }
  }

  // ── Per-View By dimension sections ───────────────────────────────────
  for (const sec of viewSections) {
    aoa.push(padRow([{ v: "", t: "s" }])); // spacer above each section

    if (sec.kind === "so") {
      pushSoSection(aoa, sec.viewBy, sec.soRows, maxCols, padRow, merges);
      continue;
    }

    // Dim section: banner + column header + body + section TOTAL.
    const { dim, dataRows, dataTotals } = sec;

    // Section banner row.
    aoa.push(padRow([{ v: `-- ${VIEW_BY_LABELS[dim]} --`, t: "s", s: sectionBannerStyle() }]));
    merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: maxCols - 1 } });

    // Column header row (changes shape based on customerFacing).
    const headerRow: any[] = customerFacing
      ? [
          headerCell(VIEW_BY_LABELS[dim], PALETTE.HEADER_TEXT, "left"),
          headerCell("TY Qty",        PALETTE.HEADER_DARK),
          headerCell("TY Rev",        PALETTE.HEADER_DARK),
          headerCell("LY Qty",        PALETTE.HEADER_DARK),
          headerCell("LY Rev",        PALETTE.HEADER_DARK),
          headerCell("Δ Rev",         PALETTE.HEADER_DARK),
        ]
      : [
          headerCell(VIEW_BY_LABELS[dim], PALETTE.HEADER_TEXT, "left"),
          headerCell("TY Qty",        PALETTE.HEADER_DARK),
          headerCell("TY Rev",        PALETTE.HEADER_DARK),
          headerCell("TY Cogs",       PALETTE.HEADER_DARK),
          ...(hideMargins ? [] : [
            headerCell("TY Mrgn $",   PALETTE.HEADER_DARK),
            headerCell("TY Mrgn %",   PALETTE.HEADER_DARK),
          ]),
          headerCell("LY Qty",        PALETTE.HEADER_DARK),
          headerCell("LY Rev",        PALETTE.HEADER_DARK),
          headerCell("LY Cogs",       PALETTE.HEADER_DARK),
          ...(hideMargins ? [] : [
            headerCell("LY Mrgn $",   PALETTE.HEADER_DARK),
            headerCell("LY Mrgn %",   PALETTE.HEADER_DARK),
          ]),
          headerCell("Δ Rev",         PALETTE.HEADER_DARK),
          ...(hideMargins ? [] : [
            headerCell("Δ Margin pp", PALETTE.HEADER_DARK),
          ]),
        ];
    aoa.push(padRow(headerRow));
    if (!firstHeaderRow) { firstHeaderRow = aoa[aoa.length - 1]; firstBodyRowsStart = aoa.length; }

    // Body rows with zebra fill.
    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      const fill = zebraFill(i);
      if (customerFacing) {
        aoa.push(padRow([
          { v: r.label, t: "s", s: bodyTextStyle(fill, "left") },
          numOrBlank(r.tyQty, bodyNumStyle(fill), { numFmt: NUMFMT_QTY }),
          numOrBlank(r.tyRev, bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
          numOrBlank(r.lyQty, bodyNumStyle(fill), { numFmt: NUMFMT_QTY }),
          numOrBlank(r.lyRev, bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
          growthCell(r.tyRev, r.lyRev, bodyNumStyle(fill)),
        ]));
      } else {
        const tyCogs = r.tyRev - r.tyMrgn;
        const lyCogs = r.lyRev - r.lyMrgn;
        const tyPct  = r.tyRev > 0 ? r.tyMrgn / r.tyRev : 0;
        const lyPct  = r.lyRev > 0 ? r.lyMrgn / r.lyRev : 0;
        aoa.push(padRow([
          { v: r.label, t: "s", s: bodyTextStyle(fill, "left") },
          numOrBlank(r.tyQty, bodyNumStyle(fill), { numFmt: NUMFMT_QTY }),
          numOrBlank(r.tyRev, bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
          numOrBlank(tyCogs,  bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
          ...(hideMargins ? [] : [
            numOrBlank(r.tyMrgn,bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
            tyPct > 0
              ? { v: tyPct, t: "n", s: { ...bodyNumStyle(fill), numFmt: NUMFMT_PCT } }
              : { v: "", t: "s", s: bodyNumStyle(fill) },
          ]),
          numOrBlank(r.lyQty, bodyNumStyle(fill), { numFmt: NUMFMT_QTY }),
          numOrBlank(r.lyRev, bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
          numOrBlank(lyCogs,  bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
          ...(hideMargins ? [] : [
            numOrBlank(r.lyMrgn,bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
            lyPct > 0
              ? { v: lyPct, t: "n", s: { ...bodyNumStyle(fill), numFmt: NUMFMT_PCT } }
              : { v: "", t: "s", s: bodyNumStyle(fill) },
          ]),
          growthCell(r.tyRev, r.lyRev, bodyNumStyle(fill)),
          ...(hideMargins ? [] : [
            marginPointsCell(r.tyMrgn, r.tyRev, r.lyMrgn, r.lyRev, bodyNumStyle(fill)),
          ]),
        ]));
      }
    }

    // Per-section TOTAL row(s). When mixed grain in explode-OFF, emit
    // two TOTAL rows (PPK packs + each); otherwise one combined.
    const emitTotalRow = (label: string, t: DimTotals["combined"]): void => {
      const lblS = totalLabelStyle();
      const numS = totalNumStyle();
      if (customerFacing) {
        aoa.push(padRow([
          { v: label, t: "s", s: lblS },
          numOrBlank(t.tyQty, numS, { numFmt: NUMFMT_QTY }),
          numOrBlank(t.tyRev, numS, { numFmt: NUMFMT_USD }),
          numOrBlank(t.lyQty, numS, { numFmt: NUMFMT_QTY }),
          numOrBlank(t.lyRev, numS, { numFmt: NUMFMT_USD }),
          growthCell(t.tyRev, t.lyRev, numS),
        ]));
      } else {
        const tyPct = t.tyRev > 0 ? t.tyMrgn / t.tyRev : 0;
        const lyPct = t.lyRev > 0 ? t.lyMrgn / t.lyRev : 0;
        aoa.push(padRow([
          { v: label, t: "s", s: lblS },
          numOrBlank(t.tyQty, numS, { numFmt: NUMFMT_QTY }),
          numOrBlank(t.tyRev, numS, { numFmt: NUMFMT_USD }),
          numOrBlank(t.tyCogs,numS, { numFmt: NUMFMT_USD }),
          ...(hideMargins ? [] : [
            numOrBlank(t.tyMrgn,numS, { numFmt: NUMFMT_USD }),
            tyPct > 0
              ? { v: tyPct, t: "n", s: { ...numS, numFmt: NUMFMT_PCT } }
              : { v: "", t: "s", s: numS },
          ]),
          numOrBlank(t.lyQty, numS, { numFmt: NUMFMT_QTY }),
          numOrBlank(t.lyRev, numS, { numFmt: NUMFMT_USD }),
          numOrBlank(t.lyCogs,numS, { numFmt: NUMFMT_USD }),
          ...(hideMargins ? [] : [
            numOrBlank(t.lyMrgn,numS, { numFmt: NUMFMT_USD }),
            lyPct > 0
              ? { v: lyPct, t: "n", s: { ...numS, numFmt: NUMFMT_PCT } }
              : { v: "", t: "s", s: numS },
          ]),
          growthCell(t.tyRev, t.lyRev, numS),
          ...(hideMargins ? [] : [
            marginPointsCell(t.tyMrgn, t.tyRev, t.lyMrgn, t.lyRev, numS),
          ]),
        ]));
      }
    };
    if (dataRows.length > 0) {
      if (dataTotals.hasMixed) {
        emitTotalRow("TOTAL (PPK packs)", dataTotals.ppk);
        emitTotalRow("TOTAL (each)",      dataTotals.each);
      } else {
        emitTotalRow("TOTAL", dataTotals.combined);
      }
    }
  }

  // ── Outer-rectangle outline (applied to the AOA cells directly) ─────
  // Each touched cell is cloned so we never mutate a shared style ref.
  // buildMultiSheetWorkbook stamps the logo banner on top and offsets
  // the merges; borders are per-cell so they move with their cells.
  const lastAoaRow = aoa.length - 1;
  const lastColIdx = maxCols - 1;
  for (let r = 0; r <= lastAoaRow; r++) {
    for (let c = 0; c <= lastColIdx; c++) {
      const cell = aoa[r]?.[c];
      if (!cell) continue;
      const existingBorder = cell.s?.border ?? {};
      const border: any = { ...existingBorder };
      if (c === 0)           border.left   = EXTRA_THICK;
      if (c === lastColIdx)  border.right  = EXTRA_THICK;
      if (r === 0)           border.top    = EXTRA_THICK;
      if (r === lastAoaRow)  border.bottom = EXTRA_THICK;
      aoa[r][c] = { ...cell, s: { ...(cell.s ?? {}), border } };
    }
  }

  // Column widths — use the widest per-dim header + body block. If no
  // dim section was emitted (e.g. SO-only), fall back to autofit across
  // the whole AOA.
  let cols: Array<{ wch: number }>;
  if (firstHeaderRow && firstBodyRowsStart > 0) {
    const bodyForFit = aoa.slice(firstBodyRowsStart);
    cols = widthsForRows(firstHeaderRow, bodyForFit);
  } else {
    cols = autofitColumns({ headerRow: aoa[0], bodyRows: aoa.slice(1) });
  }

  // Row heights — title taller, header band heavier, body standard.
  // Mark each row by walking the AOA shape: row index 0 = title banner;
  // row 1-2 = window banners; row 3-4 = scope/explode; everything after
  // is body with the column header / totals interspersed.
  const rowHeights: Array<{ hpt: number }> = [];
  for (let r = 0; r <= lastAoaRow; r++) {
    if (r === 0) { rowHeights.push({ hpt: 32 }); continue; }
    if (r === 1 || r === 2) { rowHeights.push({ hpt: 22 }); continue; }
    if (r === 3 || r === 4) { rowHeights.push({ hpt: 18 }); continue; }
    // Heuristic: a row whose first cell carries a wrapped header style
    // is a column header (give it the HEADER height). Bumped to 34 if
    // any header in the row wraps (mirrors exportExcel.ts convention).
    const firstCell = aoa[r]?.[0];
    const hasWrap = aoa[r]?.some((c: any) => !!c?.s?.alignment?.wrapText);
    if (firstCell?.s?.font?.bold && firstCell?.s?.font?.sz >= 13) {
      rowHeights.push({ hpt: 24 });            // section banner
    } else if (hasWrap && firstCell?.s?.font?.color?.rgb === "FFFFFF") {
      rowHeights.push({ hpt: 34 });            // wrapped column header
    } else if (firstCell?.s?.font?.color?.rgb === "FFFFFF" && firstCell?.s?.font?.bold) {
      rowHeights.push({ hpt: ROW_HEIGHTS.HEADER }); // single-line column header
    } else {
      rowHeights.push({ hpt: ROW_HEIGHTS.BODY });
    }
  }

  const cfSuffix = customerFacing ? "_customer" : "";
  const filename = `SalesComps_${start}_to_${end}${cfSuffix}.xlsx`;
  const { wb } = buildMultiSheetWorkbook(filename, [{
    sheetName: "Sales Comps",
    allRows: aoa,
    cols,
    rowHeights,
    merges,
  }]);
  return { wb, filename };
}

// ── SO section emitter ────────────────────────────────────────────────
// Mirrors the modal's SO table exactly: banner row → header row → body
// rows (with subtotal rows styled as the subtotal cells) → grand-total
// row computed via the same LY style-dedup the modal uses.
function pushSoSection(
  aoa: any[][],
  viewBy: ViewByKey[],
  soRows: SoRow[],
  maxCols: number,
  padRow: (row: any[]) => any[],
  merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>,
): void {
  const { showSoMeta, soDimLabel } = soSectionHeader(viewBy);

  // Section banner.
  aoa.push(padRow([{ v: `-- ${VIEW_BY_LABELS.so} --`, t: "s", s: sectionBannerStyle() }]));
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: maxCols - 1 } });

  // Column header row.
  const headerRow: any[] = showSoMeta
    ? [
        headerCell("Style",         PALETTE.HEADER_TEXT, "left"),
        headerCell("Order #",       PALETTE.HEADER_TEXT, "left"),
        headerCell("Cancel",        PALETTE.HEADER_TEXT, "left"),
        headerCell("Customer",      PALETTE.HEADER_TEXT, "left"),
        headerCell("TY Qty",        PALETTE.HEADER_DARK),
        headerCell("TY Open SO $",  PALETTE.HEADER_DARK),
        headerCell("LY Qty",        PALETTE.HEADER_DARK),
        headerCell("LY Ship $",     PALETTE.HEADER_DARK),
        headerCell("Δ Rev",         PALETTE.HEADER_DARK),
      ]
    : [
        headerCell(soDimLabel,      PALETTE.HEADER_TEXT, "left"),
        headerCell("TY Qty",        PALETTE.HEADER_DARK),
        headerCell("TY Open SO $",  PALETTE.HEADER_DARK),
        headerCell("LY Qty",        PALETTE.HEADER_DARK),
        headerCell("LY Ship $",     PALETTE.HEADER_DARK),
        headerCell("Δ Rev",         PALETTE.HEADER_DARK),
      ];
  aoa.push(padRow(headerRow));

  // Body rows.
  let bodyIdx = 0;
  for (const r of soRows) {
    if (r.kind === "subtotal") {
      const lblS = subtotalTextStyle();
      const numS = subtotalNumStyle();
      if (showSoMeta) {
        aoa.push(padRow([
          { v: r.label, t: "s", s: lblS },
          { v: "", t: "s", s: lblS },
          { v: "", t: "s", s: lblS },
          { v: "", t: "s", s: lblS },
          numOrBlank(r.tyQty, numS, { numFmt: NUMFMT_QTY }),
          numOrBlank(r.tyRev, numS, { numFmt: NUMFMT_USD }),
          numOrBlank(r.lyQty, numS, { numFmt: NUMFMT_QTY }),
          numOrBlank(r.lyRev, numS, { numFmt: NUMFMT_USD }),
          growthCell(r.tyRev, r.lyRev, numS),
        ]));
      } else {
        aoa.push(padRow([
          { v: r.label, t: "s", s: lblS },
          numOrBlank(r.tyQty, numS, { numFmt: NUMFMT_QTY }),
          numOrBlank(r.tyRev, numS, { numFmt: NUMFMT_USD }),
          numOrBlank(r.lyQty, numS, { numFmt: NUMFMT_QTY }),
          numOrBlank(r.lyRev, numS, { numFmt: NUMFMT_USD }),
          growthCell(r.tyRev, r.lyRev, numS),
        ]));
      }
      continue;
    }
    const fill = zebraFill(bodyIdx++);
    if (showSoMeta) {
      aoa.push(padRow([
        { v: r.style ?? "",       t: "s", s: bodyTextStyle(fill, "left") },
        { v: r.orderNumber ?? "", t: "s", s: bodyTextStyle(fill, "left") },
        { v: r.cancelDate ? fmtBannerDate(r.cancelDate) : "", t: "s", s: bodyTextStyle(fill, "left") },
        { v: r.customer ?? "",    t: "s", s: bodyTextStyle(fill, "left") },
        numOrBlank(r.tyQty, bodyNumStyle(fill), { numFmt: NUMFMT_QTY }),
        numOrBlank(r.tyRev, bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
        numOrBlank(r.lyQty, bodyNumStyle(fill), { numFmt: NUMFMT_QTY }),
        numOrBlank(r.lyRev, bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
        growthCell(r.tyRev, r.lyRev, bodyNumStyle(fill)),
      ]));
    } else {
      aoa.push(padRow([
        { v: r.label, t: "s", s: bodyTextStyle(fill, "left") },
        numOrBlank(r.tyQty, bodyNumStyle(fill), { numFmt: NUMFMT_QTY }),
        numOrBlank(r.tyRev, bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
        numOrBlank(r.lyQty, bodyNumStyle(fill), { numFmt: NUMFMT_QTY }),
        numOrBlank(r.lyRev, bodyNumStyle(fill), { numFmt: NUMFMT_USD }),
        growthCell(r.tyRev, r.lyRev, bodyNumStyle(fill)),
      ]));
    }
  }

  // Grand-total row. Each row's LY is now a per-SO ±30d window (see the
  // modal's soRows useMemo), so totals SUM across rows rather than
  // de-duping by style key — overlapping windows on same-style nearby
  // SOs do double-count their overlap days, but that's the tradeoff for
  // keeping the per-row signal. Matches SoCompsTable in the modal.
  // The catch-all subtotal (SO_CATCHALL_KEY) carries LY ship $ for
  // styles with NO TY SO — added in explicitly so the SO TOTAL LY
  // reconciles with the other dim TOTALs.
  const dataRows = soRows.filter((r): r is SoRowDetail => r.kind === "row");
  const catchallRow = soRows.find((r): r is SoRowSubtotal =>
    r.kind === "subtotal" && r.key === SO_CATCHALL_KEY);
  if (dataRows.length > 0 || catchallRow) {
    let tQ = 0, tR = 0, lQ = 0, lR = 0;
    for (const r of dataRows) {
      tQ += r.tyQty; tR += r.tyRev;
      lQ += r.lyQty; lR += r.lyRev;
    }
    if (catchallRow) {
      lQ += catchallRow.lyQty;
      lR += catchallRow.lyRev;
    }
    const lblS = totalLabelStyle();
    const numS = totalNumStyle();
    if (showSoMeta) {
      aoa.push(padRow([
        { v: "TOTAL", t: "s", s: lblS },
        { v: "", t: "s", s: lblS },
        { v: "", t: "s", s: lblS },
        { v: "", t: "s", s: lblS },
        numOrBlank(tQ, numS, { numFmt: NUMFMT_QTY }),
        numOrBlank(tR, numS, { numFmt: NUMFMT_USD }),
        numOrBlank(lQ, numS, { numFmt: NUMFMT_QTY }),
        numOrBlank(lR, numS, { numFmt: NUMFMT_USD }),
        growthCell(tR, lR, numS),
      ]));
    } else {
      aoa.push(padRow([
        { v: "TOTAL", t: "s", s: lblS },
        numOrBlank(tQ, numS, { numFmt: NUMFMT_QTY }),
        numOrBlank(tR, numS, { numFmt: NUMFMT_USD }),
        numOrBlank(lQ, numS, { numFmt: NUMFMT_QTY }),
        numOrBlank(lR, numS, { numFmt: NUMFMT_USD }),
        growthCell(tR, lR, numS),
      ]));
    }
  }
}

// ── Scope text builder (mirrors the modal's text) ──────────────────────
function buildScopeText(
  scope: SalesCompsExportInput["scope"],
  customerFacing: boolean,
): string {
  const parts: string[] = [];
  if (scope.customer.length > 0)        parts.push(`customer ${scope.customer.join("/")}`);
  if (scope.selStores.length > 0)       parts.push(`stores ${scope.selStores.join("/")}`);
  if (scope.selCategories.length > 0)   parts.push(`categories ${scope.selCategories.join("/")}`);
  if (scope.selSubCategories.length > 0)parts.push(`sub-cats ${scope.selSubCategories.join("/")}`);
  if (scope.selStyles.length > 0)       parts.push(`styles ${scope.selStyles.join("/")}`);
  const base = parts.length > 0 ? parts.join(" · ") : "all";
  return customerFacing ? `${base}  (customer-facing — margin hidden)` : base;
}

// ── Local ISO-shift helper (avoids a Date import cycle) ────────────────
function isoMinusMonths(iso: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso + "T00:00:00");
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Public trigger-download (branded ExcelJS flush via exportTheme) ──
export function downloadSalesCompsWorkbook(input: SalesCompsExportInput): void {
  const { wb, filename } = buildSalesCompsWorkbook(input);
  void writeWorkbookToFile(wb, filename);
}
