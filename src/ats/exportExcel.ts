import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate, displayColor } from "./helpers";
import type { GridTotals } from "./computeTotals";

// Export the ATS grid to an Excel workbook. Layout matches the on-screen
// table: Category / Sub Cat / Style / Description / Color, blank spacer,
// On Hand, blank spacer, On Order, blank spacer, On PO, blank spacer,
// every visible period column, then either a row-total column + a
// one-line bottom Total row (no-totals mode) OR a 5-row totals stack
// (Qty / Cost $ / Sale $ / Mrgn $ / Mrgn %, totals-on mode). Column
// widths auto-fit to the widest content the planner can see.
export function exportToExcel(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  atShip = false,
  hiddenColumns: string[] = [],
  // When provided (TOTALS toggle on), append a 5-row Cost/Sale/Margin
  // stack and DROP the right-side Total column + simple bottom Total
  // row — the rich stack supersedes them. Null = simple totals layout.
  totals: GridTotals | null = null,
) {
  // Skip rows whose availability is zero across every visible period —
  // they contribute nothing to a planning conversation. Negatives are
  // KEPT (shortages matter); positives are kept (visible stock).
  // Uses the same atShip-aware value lookup the grid does.
  const hasAnyAvailability = (r: ATSRow): boolean => {
    for (const p of periods) {
      const v = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
      if (v !== 0 && v != null) return true;
    }
    return false;
  };
  rows = rows.filter(hasAnyAvailability);

  // ── Styles ──────────────────────────────────────────────────────────────
  // Reference image specifies:
  //   - Each column gets a thick blue outline (border around the
  //     COLUMN, not individual cells). So every cell's left+right are
  //     thick; tops + bottoms are thick only on the header and total
  //     rows. Data rows have NO horizontal borders between them —
  //     each column reads as one continuous block.
  //   - Three tiered fill colors getting lighter as you go right:
  //     text cols (darkest blue tint) → On Hand/Order/PO (3 shades
  //     lighter) → period cols (3 shades lighter still).
  //   - Two separator columns: dark blue fill from top to bottom, no
  //     text, no internal borders — only the thick column outline.
  //     One between Color and On Hand, one between On PO and the
  //     first period.
  //   - On Hand + right-side Total headers in orange; every other
  //     header in dark blue. Every header cell gets bold borders all
  //     around (the column-outline rule applies AND header adds its
  //     own thick top/bottom).
  //   - Numeric cells (On Hand rightward) center-align; text cells
  //     left-align.
  const BORDER_THICK: any = { style: "medium", color: { rgb: "1F497D" } };
  const BORDER_THIN: any = { style: "thin", color: { rgb: "B4C7E7" } };
  const NO_BORDER: any = { style: "none" };

  // Header fills — three-tier gradient with markedly more contrast
  // between tiers so the groups read at a glance. On Hand sits in the
  // qty tier; the right-side Total header sits one shade DARKER than
  // qty so the planner can spot the row-summary column at a glance
  // without it blending into the qty tier.
  const HDR_TEXT_FILL   = "1F3864"; // tier 1 — deep navy
  const HDR_QTY_FILL    = "4472C4"; // tier 2 — clearly lighter mid-blue
  const HDR_PERIOD_FILL = "8FAADC"; // tier 3 — distinctly lighter
  const HDR_TOTAL_FILL  = "2F5496"; // a notch darker than qty, visibly distinct
  const HDR_BLUE_FILL   = HDR_TEXT_FILL; // alias used by separator columns

  // Body cell fills — three tiers with the same widened contrast as
  // the headers. Each tier has TWO shades to drive alternating-row
  // stripes (matches the original ATS export look the user wants
  // back). _ODD = white-ish; _EVEN = the tier's tint.
  const FILL_TEXT_ODD     = "FFFFFF"; // white stripe
  const FILL_TEXT_EVEN    = "D9E1F2"; // light navy tint
  const FILL_QTY_ODD      = "FFFFFF";
  const FILL_QTY_EVEN     = "DEEBF7"; // light mid-blue tint
  const FILL_PERIOD_ODD   = "FFFFFF";
  const FILL_PERIOD_EVEN  = "F2F8FD"; // very light sky tint
  const FILL_TOTAL  = "BDD7EE"; // total-row tint — distinct from any data tier

  // Border builders. A cell's borders depend on (a) where it sits in
  // the column (header / middle data / total) and (b) what kind of
  // column it is (regular vs separator). The column-outline rule is
  // always "thick left + thick right"; the rest varies.
  function bordersForHeader(): any {
    return { top: BORDER_THICK, bottom: BORDER_THICK, left: BORDER_THICK, right: BORDER_THICK };
  }
  function bordersForDataMiddle(): any {
    // Thick blue borders on every side per the planner's spec — the
    // worksheet reads as a heavy gridded table where every cell is
    // outlined in the same blue as the column rules.
    return { top: BORDER_THICK, bottom: BORDER_THICK, left: BORDER_THICK, right: BORDER_THICK };
  }
  function bordersForTotalRow(): any {
    return { top: BORDER_THICK, bottom: BORDER_THICK, left: BORDER_THICK, right: BORDER_THICK };
  }
  function bordersForSeparatorHeader(): any {
    // Separator block has no internal cell borders — just the column
    // outline. So header gets thick top + left + right, NO bottom (the
    // fill continues into the data area uninterrupted).
    return { top: BORDER_THICK, bottom: NO_BORDER, left: BORDER_THICK, right: BORDER_THICK };
  }
  function bordersForSeparatorDataMiddle(): any {
    return { top: NO_BORDER, bottom: NO_BORDER, left: BORDER_THICK, right: BORDER_THICK };
  }
  function bordersForSeparatorTotalRow(): any {
    // Bottom edge of the column outline lives here.
    return { top: NO_BORDER, bottom: BORDER_THICK, left: BORDER_THICK, right: BORDER_THICK };
  }

  // Header cell factory.
  function headerStyle(fill: string, align: "left" | "center"): any {
    return {
      font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
      fill:      { fgColor: { rgb: fill }, patternType: "solid" },
      alignment: { horizontal: align, vertical: "center", wrapText: false },
      border:    bordersForHeader(),
    };
  }
  // Body cell factory. The wrap flag is on so PPK rich-text cells
  // render their second line correctly without needing per-cell
  // overrides; rows without a "\n" just show one line of content.
  function bodyStyle(fill: string, align: "left" | "center"): any {
    return {
      fill:      { fgColor: { rgb: fill }, patternType: "solid" },
      alignment: { horizontal: align, vertical: "center", wrapText: true },
      border:    bordersForDataMiddle(),
    };
  }
  function totalStyle(align: "left" | "center"): any {
    return {
      font:      { bold: true, color: { rgb: "1F497D" }, sz: 11, name: "Calibri" },
      fill:      { fgColor: { rgb: FILL_TOTAL }, patternType: "solid" },
      alignment: { horizontal: align, vertical: "center", wrapText: false },
      border:    bordersForTotalRow(),
    };
  }
  // Separator cells — solid dark blue rectangle, no text, no internal
  // borders. Header / middle / total each carry a different border
  // portion of the column outline.
  function separatorStyle(borders: any): any {
    return {
      fill:      { fgColor: { rgb: HDR_BLUE_FILL }, patternType: "solid" },
      alignment: { horizontal: "center", vertical: "center" },
      border:    borders,
    };
  }

  // Heat-map overlays for the period cells (low / out of stock / neg).
  // These ride on top of the base fill — fill replacement, not blend —
  // because Excel doesn't support blending.
  const negStyle = (base: any): any => ({ ...base, font: { bold: true, color: { rgb: "C00000" }, sz: 11, name: "Calibri" } });
  const lowStyle = (base: any): any => ({ ...base, font: { bold: true, color: { rgb: "7F6000" }, sz: 11, name: "Calibri" }, fill: { fgColor: { rgb: "FFEB9C" }, patternType: "solid" } });

  // ── Column model ────────────────────────────────────────────────────────
  // Build one ordered list that drives header, data, total row, and the
  // !cols width array. Each entry knows its kind so the spacers + Total
  // column behavior stays declarative.
  type ColumnKind = "text" | "qty" | "spacer" | "period" | "rowTotal";
  interface Col {
    key: string;       // unique id; spacers get "_sp1" / "_sp2" etc.
    label: string;     // header label ("" for spacers)
    kind: ColumnKind;
    width?: number;    // wch hint (auto-fit overrides)
    // Returns the raw value for a given row. Numbers for qty / period /
    // rowTotal; strings for text; "" for spacer.
    getValue: (r: ATSRow) => string | number;
    // Column sum for the bottom TOTAL row. Returns "" to leave blank.
    totalValue: (rows: ATSRow[]) => string | number;
  }

  const hidden = new Set(hiddenColumns);
  const today = fmtDate(new Date());
  const periodValueOf = (r: ATSRow, endDate: string): number => {
    const v = atShip ? (r.freeMap?.[endDate] ?? r.dates[endDate]) : r.dates[endDate];
    return typeof v === "number" ? v : 0;
  };
  const sumPeriods = (r: ATSRow): number => {
    let s = 0;
    for (const p of periods) s += periodValueOf(r, p.endDate);
    return s;
  };

  const TEXT_COLS: Col[] = ([
    { key: "category",    label: "Category",    kind: "text" as ColumnKind, getValue: (r: ATSRow) => r.master_category ?? r.category ?? "" },
    { key: "subCategory", label: "Sub Cat",     kind: "text" as ColumnKind, getValue: (r: ATSRow) => r.master_sub_category ?? "" },
    { key: "style",       label: "Style",       kind: "text" as ColumnKind, getValue: (r: ATSRow) => r.master_style ?? "" },
    { key: "description", label: "Description", kind: "text" as ColumnKind, getValue: (r: ATSRow) => r.description },
    { key: "color",       label: "Color",       kind: "text" as ColumnKind, getValue: (r: ATSRow) => displayColor(r) },
  ] as Array<Omit<Col, "totalValue">>).filter((c) => !hidden.has(c.key))
    .map((c) => ({ ...c, totalValue: () => "" }));

  const QTY_COLS: Col[] = ([
    { key: "onHand",  label: "On Hand",  getValue: (r: ATSRow) => r.onHand },
    { key: "onOrder", label: "On Order", getValue: (r: ATSRow) => r.onOrder || 0 },
    { key: "onPO",    label: "On PO",    getValue: (r: ATSRow) => r.onPO || 0 },
  ] as Array<{ key: string; label: string; getValue: (r: ATSRow) => number }>)
    .filter((c) => !hidden.has(c.key))
    .map((c) => ({
      key: c.key,
      label: c.label,
      kind: "qty" as ColumnKind,
      getValue: c.getValue,
      totalValue: (rs: ATSRow[]) => rs.reduce((acc, r) => acc + (Number(c.getValue(r)) || 0), 0),
    }));

  const PERIOD_COLS: Col[] = periods.map((p) => ({
    key: `period:${p.endDate}`,
    label: p.label.replace(/\n/g, " "),
    kind: "period" as ColumnKind,
    getValue: (r: ATSRow) => periodValueOf(r, p.endDate),
    totalValue: (rs: ATSRow[]) => rs.reduce((acc, r) => acc + periodValueOf(r, p.endDate), 0),
  }));

  const TOTAL_COL: Col = {
    key: "rowTotal",
    label: "Total",
    kind: "rowTotal",
    getValue: (r: ATSRow) => sumPeriods(r),
    totalValue: (rs: ATSRow[]) => rs.reduce((acc, r) => acc + sumPeriods(r), 0),
  };

  // Spacer columns sit between each group: after Color (last text), after
  // every QTY col, and after the last QTY col before the period block.
  // If a group is empty (e.g. operator hid all qty cols) we skip the
  // corresponding spacer so the worksheet doesn't carry an orphan blank.
  const SPACER = (key: string): Col => ({
    key,
    label: "",
    kind: "spacer",
    getValue: () => "",
    totalValue: () => "",
  });

  const totalsMode = totals !== null;
  // Two separator columns (dark blue, no data, no internal borders):
  // one between the text-column block and the qty block, one between
  // the qty block and the period block. They serve as visual gutters
  // matching the reference image. If a flanking group is empty
  // (operator hid every text or qty col), the corresponding separator
  // is skipped so the worksheet doesn't carry an orphan stripe.
  const cols: Col[] = [];
  cols.push(...TEXT_COLS);
  if (TEXT_COLS.length && QTY_COLS.length) cols.push(SPACER("_sep_text_qty"));
  cols.push(...QTY_COLS);
  if (QTY_COLS.length && PERIOD_COLS.length) cols.push(SPACER("_sep_qty_periods"));
  cols.push(...PERIOD_COLS);
  // Row Total column is for the simple-totals layout only — the rich
  // 5-row stack carries totals on its own rows, so the right-side
  // column is redundant when totals are on.
  if (!totalsMode) cols.push(TOTAL_COL);

  // Index of the "label cell" for the bottom TOTAL row — sits in the
  // Color column (last text col) so the row reads like the attached
  // file: ",,,,Total,," for the unhidden default. If Color is hidden,
  // falls back to the last surviving text col; if no text cols, falls
  // back to the first column overall.
  const colorIdx = cols.findIndex((c) => c.key === "color");
  const lastTextIdx = (() => {
    for (let i = cols.length - 1; i >= 0; i--) if (cols[i].kind === "text") return i;
    return 0;
  })();
  const totalLabelIdx = colorIdx >= 0 ? colorIdx : lastTextIdx;

  // ── Header row ──────────────────────────────────────────────────────────
  // Three-tier gradient on header fills, matching the body tier
  // system: text cols (darkest navy), qty cols incl. On Hand
  // (mid-blue), period cols (lightest blue). The right-side Total
  // header sits in the qty tier — anchors-via-orange were removed
  // per the planner's latest spec because the gradient itself is
  // strong enough to read at a glance.
  // Text columns left-align their header label; numeric columns from
  // On Hand onward center-align. Separator columns carry the dark
  // tier-1 blue with no label.
  const headerRow = cols.map((c) => {
    if (c.kind === "spacer") {
      return { v: "", t: "s", s: separatorStyle(bordersForSeparatorHeader()) };
    }
    if (c.kind === "text") return { v: c.label, t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
    if (c.kind === "qty") return { v: c.label, t: "s", s: headerStyle(HDR_QTY_FILL, "center") };
    if (c.kind === "period") return { v: c.label, t: "s", s: headerStyle(HDR_PERIOD_FILL, "center") };
    // rowTotal — slightly darker than qty so the planner can see it
    // as a distinct column, not a sibling of On Hand / On Order / On PO.
    return { v: c.label, t: "s", s: headerStyle(HDR_TOTAL_FILL, "center") };
  });

  // Format helper for the PPK suffix line. Mirrors renderQty in
  // GridTable.tsx (unit-grain mode): "PPK24 × 15" for prepack rows.
  // The grid's "pack-grain" mode ("PPK24 = 120") is only relevant when
  // explodePpk is off in the UI, and the export rows already carry
  // unit-grain values, so this single form covers the common case.
  function ppkSuffix(qty: number, mult: number): string {
    if (!mult || mult <= 1 || qty == null) return "";
    const packs = Math.round(qty / mult);
    return `PPK${mult} × ${packs.toLocaleString()}`;
  }

  // Build a numeric cell. If the row is a prepack (ppkMult > 1) AND
  // the value is non-zero, render rich text: line 1 is the qty, line 2
  // is the PPK suffix at half size and muted color. Otherwise plain
  // number. Single style for all qty / period / rowTotal cells.
  function numericCell(r: ATSRow, n: number, cellStyle: any, fontColor: string = "000000", bold: boolean = false): any {
    const mult = r.ppkMult ?? 1;
    const showPpk = mult > 1 && n !== 0;
    if (!showPpk) {
      return {
        v: n,
        t: "n",
        s: {
          ...cellStyle,
          font: { bold, color: { rgb: fontColor }, sz: 11, name: "Calibri" },
        },
      };
    }
    const suffix = ppkSuffix(n, mult);
    // Rich text: SheetJS / xlsx-js-style use the `r` array of text
    // runs with per-run font. The plain `v` is kept as a fallback for
    // consumers that can't parse rich text.
    return {
      v: `${n.toLocaleString()}\n${suffix}`,
      t: "s",
      s: cellStyle,
      r: [
        { t: n.toLocaleString(), s: { font: { sz: 11, bold, color: { rgb: fontColor }, name: "Calibri" } } },
        // PPK suffix — matches the on-screen grid hint (9px at 75%
        // opacity over white). Excel has no font opacity, so picking
        // the pre-blended slate value and sizing it ~64% of the qty
        // line. #B0BAC9 is the pre-blended "ghosted" gray that reads
        // as the faded hint the planner sees on screen.
        { t: "\n" + suffix, s: { font: { sz: 7, color: { rgb: "B0BAC9" }, name: "Calibri" } } },
      ],
    };
  }

  // ── Data rows ───────────────────────────────────────────────────────────
  // Alternating-row stripes: even rows carry the tier's tint, odd
  // rows are white. Stripe pattern matches the original ATS export.
  const dataRows = rows.map((r, ri) => {
    const isEven = ri % 2 === 0;
    const textFill   = isEven ? FILL_TEXT_EVEN   : FILL_TEXT_ODD;
    const qtyFill    = isEven ? FILL_QTY_EVEN    : FILL_QTY_ODD;
    const periodFill = isEven ? FILL_PERIOD_EVEN : FILL_PERIOD_ODD;
    return cols.map((c) => {
      const v = c.getValue(r);
      if (c.kind === "spacer") {
        return { v: "", t: "s", s: separatorStyle(bordersForSeparatorDataMiddle()) };
      }
      if (c.kind === "text") {
        const textStyle = bodyStyle(textFill, "left");
        const styleForText = c.key === "style"
          ? { ...textStyle, font: { bold: true, color: { rgb: "1F497D" }, sz: 11, name: "Calibri" } }
          : textStyle;
        return { v, t: "s", s: styleForText };
      }
      // qty / period / rowTotal — numeric
      const n = typeof v === "number" ? v : 0;
      if (c.kind === "qty") {
        return numericCell(r, n, bodyStyle(qtyFill, "center"));
      }
      if (c.kind === "period") {
        // Blank-out zero period cells so the export reads like a
        // planning grid (matches the attached file's empty cells).
        if (v == null || n === 0) {
          return { v: "", t: "s", s: bodyStyle(periodFill, "center") };
        }
        let baseStyle = bodyStyle(periodFill, "center");
        let color = "000000";
        let bold = false;
        if (n < 0) { color = "C00000"; bold = true; }
        else if (n <= 10) {
          baseStyle = { ...baseStyle, fill: { fgColor: { rgb: "FFEB9C" }, patternType: "solid" } };
          color = "7F6000";
          bold = true;
        }
        return numericCell(r, n, baseStyle, color, bold);
      }
      // rowTotal — bold blue, sits in the qty tier visually
      return numericCell(r, n, bodyStyle(qtyFill, "center"), "1F497D", true);
    });
  });

  // ── Bottom totals ───────────────────────────────────────────────────────
  // Two modes:
  //   (a) totalsMode=false — one simple "Total" row of column sums,
  //       label sits in the Color column. Matches the attached layout.
  //   (b) totalsMode=true  — five rows of TOTAL Qty / Cost / Sale /
  //       Mrgn $ / Mrgn % derived from the GridTotals supplied by the
  //       caller. Label sits in the Color column on every row so the
  //       block reads like a labeled summary table.
  const totalsRows: any[][] = [];

  function buildSummaryRow(label: string, periodFn: (key: string) => string | number, qtyFns: { onHand: () => string | number; onOrder: () => string | number; onPO: () => string | number }) {
    const totalLabel = totalStyle("left");
    const totalNum = totalStyle("center");
    return cols.map((c, idx) => {
      if (c.kind === "spacer") {
        return { v: "", t: "s", s: separatorStyle(bordersForSeparatorTotalRow()) };
      }
      if (idx === totalLabelIdx) {
        return { v: label, t: "s", s: totalLabel };
      }
      if (c.kind === "text") {
        return { v: "", t: "s", s: totalLabel };
      }
      if (c.kind === "qty") {
        const v = c.key === "onHand" ? qtyFns.onHand() : c.key === "onOrder" ? qtyFns.onOrder() : qtyFns.onPO();
        return { v, t: typeof v === "number" ? "n" : "s", s: totalNum };
      }
      if (c.kind === "period") {
        // c.key is "period:<endDate>" — strip the prefix to match the
        // GridTotals map (keyed by period.endDate, same as period.key).
        const endDate = c.key.replace(/^period:/, "");
        const v = periodFn(endDate);
        return { v, t: typeof v === "number" ? "n" : "s", s: totalNum };
      }
      // rowTotal — only present in no-totals mode. Use the column's
      // declared totalValue so the right-side Total reads the same as
      // the in-row Total column.
      const sum = c.totalValue(rows);
      if (typeof sum === "number") return { v: sum, t: "n", s: totalNum };
      return { v: sum, t: "s", s: totalNum };
    });
  }

  if (!totalsMode) {
    // Simple one-line Total — just column sums (qty per column).
    // Matches the attached file exactly.
    totalsRows.push(buildSummaryRow(
      "Total",
      (k) => {
        let s = 0;
        for (const r of rows) s += periodValueOf(r, k);
        return s;
      },
      {
        onHand:  () => rows.reduce((acc, r) => acc + (r.onHand || 0), 0),
        onOrder: () => rows.reduce((acc, r) => acc + (r.onOrder || 0), 0),
        onPO:    () => rows.reduce((acc, r) => acc + (r.onPO || 0), 0),
      },
    ));
  } else {
    const t = totals!;
    const fmtUSD = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const safePct = (sale: number, mrgnDollars: number) =>
      sale > 0 ? `${((mrgnDollars / sale) * 100).toFixed(1)}%` : "—";
    totalsRows.push(buildSummaryRow(
      "TOTAL Qty",
      (k) => t.periodQty[k] ?? 0,
      { onHand: () => t.onHand.qty, onOrder: () => t.onOrder.qty, onPO: () => t.onPO.qty },
    ));
    totalsRows.push(buildSummaryRow(
      "TOTAL Cost",
      (k) => fmtUSD(t.periodCost[k] ?? 0),
      { onHand: () => fmtUSD(t.onHand.cost), onOrder: () => fmtUSD(t.onOrder.cost), onPO: () => fmtUSD(t.onPO.cost) },
    ));
    totalsRows.push(buildSummaryRow(
      "TOTAL Sale",
      (k) => fmtUSD(t.periodSale[k] ?? 0),
      { onHand: () => fmtUSD(t.onHand.sale), onOrder: () => fmtUSD(t.onOrder.sale), onPO: () => fmtUSD(t.onPO.sale) },
    ));
    totalsRows.push(buildSummaryRow(
      "TOTAL Mrgn $",
      (k) => fmtUSD((t.periodSale[k] ?? 0) - (t.periodCost[k] ?? 0)),
      {
        onHand:  () => fmtUSD(t.onHand.sale - t.onHand.cost),
        onOrder: () => fmtUSD(t.onOrder.sale - t.onOrder.cost),
        onPO:    () => fmtUSD(t.onPO.sale - t.onPO.cost),
      },
    ));
    totalsRows.push(buildSummaryRow(
      "TOTAL Mrgn %",
      (k) => safePct(t.periodSale[k] ?? 0, (t.periodSale[k] ?? 0) - (t.periodCost[k] ?? 0)),
      {
        onHand:  () => safePct(t.onHand.sale,  t.onHand.sale  - t.onHand.cost),
        onOrder: () => safePct(t.onOrder.sale, t.onOrder.sale - t.onOrder.cost),
        onPO:    () => safePct(t.onPO.sale,    t.onPO.sale    - t.onPO.cost),
      },
    ));
  }

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = [headerRow, ...dataRows, ...totalsRows];
  const ws  = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

  // ── Auto-fit column widths ──────────────────────────────────────────────
  // Walk every cell in the column (header + data + total) and pick the
  // longest rendered string length. Spacer columns get a fixed narrow
  // width so they read visually as gaps without taking real space.
  const SPACER_WIDTH = 2;     // wch — about half a "0" character wide
  const MIN_WIDTH = 6;
  const MAX_WIDTH = 60;       // cap so a long description doesn't blow out the row
  const PAD = 2;
  const widthOf = (v: string | number): number => {
    if (v == null) return 0;
    const s = typeof v === "number"
      ? v.toLocaleString()
      : String(v);
    return s.length;
  };
  // For prepack rows the column also has to fit the PPK suffix
  // ("PPK24 × N,NNN") on one line — without bumping width for that,
  // Excel wraps the suffix and the planner sees "PPK24 ×" + "4,272"
  // split across two visual lines inside the cell. Compute the PPK
  // suffix for each (row, col) where applicable and include it in
  // the width calc.
  const ppkSuffixForCell = (r: ATSRow, c: Col): string => {
    const mult = r.ppkMult ?? 1;
    if (mult <= 1) return "";
    if (c.kind !== "qty" && c.kind !== "period" && c.kind !== "rowTotal") return "";
    const n = Number(c.getValue(r)) || 0;
    if (n === 0) return "";
    return `PPK${mult} × ${Math.round(n / mult).toLocaleString()}`;
  };

  ws["!cols"] = cols.map((c) => {
    if (c.kind === "spacer") return { wch: SPACER_WIDTH };
    let maxLen = widthOf(c.label);
    for (const r of rows) {
      const v = c.getValue(r);
      const len = widthOf(v);
      if (len > maxLen) maxLen = len;
      const ppkLen = ppkSuffixForCell(r, c).length;
      if (ppkLen > maxLen) maxLen = ppkLen;
    }
    const sum = c.totalValue(rows);
    if (sum !== "") {
      const len = widthOf(sum);
      if (len > maxLen) maxLen = len;
    }
    const wch = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, maxLen + PAD));
    return { wch };
  });

  // Row heights — header is taller, prepack data rows get extra room
  // so the rich-text "PPKn × packs" suffix line doesn't clip when
  // Excel wraps. Default ~15pt isn't enough for a 6pt second line +
  // padding; 26pt comfortably fits both lines without crowding.
  const PREPACK_ROW_HPT = 26;
  const NORMAL_ROW_HPT = 15;
  const HEADER_HPT = 22;
  const rowsHeight: any[] = [{ hpt: HEADER_HPT }];
  for (const r of rows) {
    rowsHeight.push({ hpt: (r.ppkMult ?? 1) > 1 ? PREPACK_ROW_HPT : NORMAL_ROW_HPT });
  }
  // Total row(s) at the end — same height as header for visual weight.
  for (let i = 0; i < totalsRows.length; i++) rowsHeight.push({ hpt: HEADER_HPT });
  ws["!rows"] = rowsHeight;

  // Freeze: row 1 (header) + through the Style column so the planner
  // can scroll right while keeping row identity on screen.
  const styleIdx = cols.findIndex((c) => c.key === "style");
  ws["!freeze"] = { xSplit: styleIdx >= 0 ? styleIdx + 1 : TEXT_COLS.length, ySplit: 1 };

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, atShip ? "AT Ship Report" : "ATS Report");

  const buf  = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${atShip ? "ATShip" : "ATS"}_Report_${fmtDate(new Date())}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
