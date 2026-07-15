import React, { useMemo } from "react";
import S from "../styles";
import { getQtyColor, getQtyBg, displayColor, pickColorImage } from "../helpers";
import { useArrowKeyScroll } from "../../shared/grid/useArrowKeyScroll";
import { GridScrollbarStyles } from "../../shared/grid/GridScrollbarStyles";
import type { ATSRow, ATSPoEvent, ATSSoEvent, CtxMenu } from "../types";
import { computeGridTotals } from "../computeTotals";
import { periodAvail } from "../compute";
import { StyleThumb } from "../../shared/ui/StyleThumb";
import { useStyleThumbsByCode } from "../hooks/useStyleThumbsByCode";
import { useCanSeeMargins } from "../../hooks/useCanSeeMargins";

// Renders a qty cell that shows either the unit-grain or pack-grain
// number based on the EXPLODE PPK toggle, with a small faded hint
// underneath telling the operator the other-side conversion.
//
//   non-prepack (mult=1)          → just the number
//   prepack + explode=true        → "120" + faded "PPK24 × 5"
//   prepack + explode=false       → "5"   + faded "PPK24 = 120"
//
// `qty` is always passed in unit grain (compute.ts already exploded
// it). The pack-grain value is qty / mult.
function renderQty(opts: {
  qty: number;
  mult: number;
  explode: boolean;
  color: string;
  prefix?: string;
  zeroDisplay?: string;
}): React.ReactNode {
  const { qty, mult, explode, color, prefix = "", zeroDisplay } = opts;
  const baseStyle: React.CSSProperties = { color, fontWeight: 600, fontFamily: "monospace", fontSize: 13 };
  const formatNum = (n: number) => Number.isFinite(n) ? n.toLocaleString() : "—";

  // Non-prepack — match the previous render exactly.
  if (mult <= 1) {
    return (
      <span style={baseStyle}>
        {qty > 0 || zeroDisplay == null ? `${prefix}${formatNum(qty)}` : zeroDisplay}
      </span>
    );
  }

  // Prepack — primary + faded hint. Round packs because source qty
  // is no longer guaranteed to be a clean multiple of pack_size after
  // the 2026-05-21 Xoro grain switch (qty is in eaches, may include
  // odd-unit residuals). Matches the Math.round in exportExcel.ts.
  const packs = Math.round(qty / mult);
  const primary = explode ? qty : packs;
  const hint = explode
    ? `PPK${mult} × ${formatNum(packs)}`
    : `PPK${mult} = ${formatNum(qty)}`;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", lineHeight: 1.15 }}>
      <span style={baseStyle}>
        {qty > 0 || zeroDisplay == null ? `${prefix}${formatNum(primary)}` : zeroDisplay}
      </span>
      {qty > 0 && (
        <span style={{ color: "#6B7280", fontSize: 9, fontFamily: "monospace", opacity: 0.75, marginTop: 1 }}>
          {hint}
        </span>
      )}
    </span>
  );
}

// Height of the totals row at the top of the table. Used to push the
// regular sticky header down so the two stack without overlap. Holds
// seven stacked content lines (Qty / B Inven / Cost / Sale / Mrgn $ /
// Mrgn / E Inven) plus breathing room above and below. Sized so each
// line gets the same ~17px slot as the original 5-line layout.
const TOTALS_ROW_HEIGHT = 120;

// Sticky-left column metadata. Order matters — drives both the
// header rendering and the data-row cell order. autoFit:true columns
// (onHand / onOrder / onPO) compute width per render from largest
// visible content + the totals row; everything else uses a fixed
// width since text cols (descriptions, color names) can be long and
// auto-fitting them blows out the layout. Long text content is
// allowed to truncate visually rather than push the grid wider.
const STICKY_COL_META = [
  { key: "category",    label: "Category",    charType: "text", autoFit: false, minPx:  90, fixedPx:  90 },
  { key: "subCategory", label: "Sub Cat",     charType: "text", autoFit: false, minPx: 100, fixedPx: 100 },
  // "X" exclude checkbox column — between Sub Cat and Style. Narrow,
  // fixed width; checked rows are dropped from every aggregation + report.
  { key: "exclude",     label: "X",           charType: "text", autoFit: false, minPx:  34, fixedPx:  34 },
  { key: "style",       label: "Style",       charType: "mono", autoFit: false, minPx:  90, fixedPx:  90 },
  { key: "description", label: "Description", charType: "text", autoFit: false, minPx: 160, fixedPx: 160 },
  { key: "color",       label: "Color",       charType: "text", autoFit: false, minPx: 110, fixedPx: 110 },
  { key: "onHand",      label: "On Hand",     charType: "mono", autoFit: true,  minPx:  80, fixedPx:  80 },
  { key: "onOrder",     label: "On Order",    charType: "mono", autoFit: true,  minPx:  80, fixedPx:  80 },
  { key: "onPO",        label: "On PO",       charType: "mono", autoFit: true,  minPx:  80, fixedPx:  80 },
] as const;
type StickyKey = typeof STICKY_COL_META[number]["key"];

// Per-character width estimates (px). Tuned against the rendered
// font; "mono" is slightly wider because of the bold style + monospace
// digits. PAD_CHARS = 2 char-widths on each side per operator spec.
const TEXT_CHAR_PX = 7;
const MONO_CHAR_PX = 8.5;
const PAD_CHARS = 4;

// Pixel size of the per-row style thumbnail + the widened Style column
// width that hosts it. Style is normally 90px (fixedPx); when images are
// on it grows to fit the 32px tile beside the style code.
const STYLE_THUMB_PX = 32;
const STYLE_COL_IMG_PX = 138;

// Compute left offset for a given column given the visible widths
// map and the current hidden set. Hidden columns drop their width
// out of the running sum so visible siblings reflow flush.
function colLeftFrom(
  key: StickyKey,
  widths: Record<StickyKey, number>,
  hidden: Set<string>,
): number | null {
  if (hidden.has(key)) return null;
  let left = 0;
  for (const c of STICKY_COL_META) {
    if (c.key === key) return left;
    if (!hidden.has(c.key)) left += widths[c.key];
  }
  return null;
}

// Format dollars for the totals header. Whole-dollar precision keeps
// the rows scannable when totals run into millions.
function fmtUSD(v: number): string {
  if (!v) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString()}`;
}

interface Period {
  key: string;
  periodStart: string;
  endDate: string;
  label: string;
  isToday: boolean;
  isWeekend: boolean;
}

interface GridTableProps {
  loading: boolean;
  filtered: ATSRow[];
  // Rows that feed the TOTALS row — the filtered set MINUS excluded ("X")
  // rows. Display (pageRows) still includes excluded rows; only the
  // aggregation excludes them. Falls back to `filtered` when omitted.
  totalsRows?: ATSRow[];
  pageRows: ATSRow[];
  // SKUs the operator has excluded via the "X" column. Excluded rows render
  // greyed with the box checked, and drop out of every total.
  excludedSet: ReadonlySet<string>;
  onToggleExclude: (sku: string) => void;
  // Bulk toggle from clicking the "X" column header — select-all / clear-all
  // the currently-filtered (visible, non-aggregate) rows.
  onToggleExcludeAll: (skus: string[], exclude: boolean) => void;
  displayPeriods: Period[];
  tableRef: React.RefObject<HTMLDivElement>;

  // sort
  sortCol: string | null;
  sortDir: "asc" | "desc";
  handleThClick: (col: string) => void;
  rangeUnit: "days" | "weeks" | "months";

  // row UI state
  pinnedSku: string | null;
  setPinnedSku: (v: string | null) => void;
  dragSku: string | null;
  setDragSku: (v: string | null) => void;
  dragOverSku: string | null;
  setDragOverSku: (v: string | null) => void;
  hoveredCell: { sku: string; date: string } | null;
  setHoveredCell: (v: { sku: string; date: string } | null) => void;

  // cell behavior
  todayKey: string;
  // Grid cell content selector. "ats" = per-period availability via
  // periodAvail (cumulative free at period 0; per-period new-receipt
  // delta after). "so" / "po" = sum of SO/PO qty within each period
  // via getEventsInPeriod, so the column labelled e.g. "Mar 2026"
  // shows the SO (or PO receipt) qty falling in March across the
  // filtered SKUs. The totals-row Qty mirrors this.
  viewMode: "ats" | "so" | "po";
  // Negative-ATS card active (activeSort === "negATS"). When on, the ATS
  // period cells render the TRUE running balance (row.dates, which can go
  // negative) instead of the clamped periodAvail — so the oversold sizes the
  // card filtered to are actually visible (red). Off → normal clamped view.
  negMode: boolean;
  showTotalsRow: boolean;
  // Whether to render prepack qtys as units (exploded) or as packs.
  // ON shows packs × units-per-pack; OFF shows pack count + faded
  // "PPKn = N" hint with the unit-grain equivalent.
  explodePpk: boolean;
  // Show a per-row style image thumbnail inside the Style column.
  // Thumbnails are fetched live (by style code) from the PIM; click one
  // to open the full image gallery. OFF hides them for a denser grid.
  showImages: boolean;
  // Rightmost column that should remain sticky-left when scrolling
  // horizontally. null = no freeze (no sticky columns); a key from
  // STICKY_COL_META = freeze through that column inclusive.
  freezeKey: StickyKey | null;
  // Per-column hide list for the sticky-left columns. Operator toggles
  // these via the Toolbar's "Columns" dropdown.
  hiddenColumns: string[];
  // Target gross margin % used as a fallback in the totals row when a
  // SKU is missing SO sale prices or cost basis. SKUs with NO SOs, NO
  // avg cost, AND NO PO cost are excluded — the Mrgn label gets a *
  // when any cell had to skip SKUs because of this.
  generalMarginPct: number;
  eventIndex: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null;
  getEventsInPeriod: (sku: string, periodStart: string, endDate: string, rowStore?: string) => { pos: ATSPoEvent[]; sos: ATSSoEvent[] };
  ctxMenu: CtxMenu | null;
  setCtxMenu: (v: CtxMenu | null) => void;
  setSummaryCtx: (v: any) => void;
  openSummaryCtx: (e: React.MouseEvent, type: "onHand" | "onOrder" | "onPO", row: ATSRow) => void;
  handleSkuDrop: (fromSku: string, toSku: string) => void;
  toggleExpandGroup: (key: string) => void;
  expandedGroupSet: ReadonlySet<string>;
}

export const GridTable: React.FC<GridTableProps> = ({
  loading, filtered, totalsRows, pageRows, excludedSet, onToggleExclude, onToggleExcludeAll, displayPeriods, tableRef,
  sortCol, sortDir, handleThClick, rangeUnit,
  pinnedSku, setPinnedSku, dragSku, setDragSku, dragOverSku, setDragOverSku,
  hoveredCell, setHoveredCell,
  todayKey, viewMode, negMode, showTotalsRow, explodePpk, showImages, freezeKey, hiddenColumns, generalMarginPct, eventIndex, getEventsInPeriod,
  ctxMenu, setCtxMenu, setSummaryCtx,
  openSummaryCtx, handleSkuDrop, toggleExpandGroup, expandedGroupSet,
}) => {
  // Wire arrow / pgup-pgdn / shift-home/end to scroll the grid when
  // no input has focus. See useArrowKeyScroll above.
  useArrowKeyScroll(tableRef);

  // Margin visibility gate (P14 RBAC `margins:read`) — the totals-row cells
  // show Mrgn $ / Mrgn % lines; both are absent without the grant.
  const { canView: canViewMargin } = useCanSeeMargins();

  // Per-row style thumbnails. Fetch primary thumbs for the styles on the
  // CURRENT PAGE only (page size is bounded, so the request stays small)
  // keyed by style code. Gated on showImages so the toggle-off path makes
  // no network call. Re-fetches only when the visible style set changes.
  const visibleStyleCodes = useMemo(
    () => (showImages ? pageRows.map(r => r.master_style).filter((s): s is string => !!s) : []),
    [showImages, pageRows],
  );
  const styleThumbs = useStyleThumbsByCode(visibleStyleCodes);

  // Convert hiddenColumns to a Set for O(1) lookups in colLeft + the
  // per-cell render guards below.
  const hidden = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  const isHidden = (key: StickyKey) => hidden.has(key);

  // "X" header select-all / clear-all. Operates on every currently-FILTERED
  // leaf row (not just the page, and skipping aggregate roll-ups). If they're
  // all already excluded, clicking the header includes them all; otherwise it
  // excludes them all.
  const excludableLeafSkus = useMemo(
    () => filtered.filter(r => !r.__collapsed).map(r => r.sku),
    [filtered],
  );
  const allVisibleExcluded = excludableLeafSkus.length > 0 && excludableLeafSkus.every(s => excludedSet.has(s));
  const someVisibleExcluded = excludableLeafSkus.some(s => excludedSet.has(s));
  const toggleAllExclude = () => {
    if (excludableLeafSkus.length > 0) onToggleExcludeAll(excludableLeafSkus, !allVisibleExcluded);
  };

  // Derived freeze guard + override. Columns past the freeze line
  // get an inline override that disables sticky positioning while
  // leaving the rest of the cell's style (background, minWidth,
  // alignment) intact. Spread AFTER ...S.stickyCol in each cell so
  // it wins. When freezeKey is null nothing is unfrozen — all 8
  // sticky cols stay sticky (historical default).
  const isFrozen = (key: StickyKey): boolean => {
    if (freezeKey == null) return true;
    const i = STICKY_COL_META.findIndex(c => c.key === key);
    const f = STICKY_COL_META.findIndex(c => c.key === freezeKey);
    return i >= 0 && f >= 0 && i <= f;
  };
  const unfreezeStyle = (key: StickyKey): React.CSSProperties => (
    isFrozen(key)
      ? {}
      : { position: "static" as const, left: undefined, zIndex: undefined }
  );

  // Totals across the filtered set (not just the current page). The
  // computation lives in ./computeTotals so the Excel export can reuse
  // it — the two views always see the same numbers.
  // Totals exclude the "X"-marked rows: use totalsRows (filtered minus
  // excluded) when provided, falling back to the full filtered set.
  const rowsForTotals = totalsRows ?? filtered;
  const sums = useMemo(() => computeGridTotals({
    filtered: rowsForTotals,
    displayPeriods,
    viewMode,
    eventIndex,
    generalMarginPct: generalMarginPct ?? 50,
  }), [rowsForTotals, displayPeriods, viewMode, eventIndex, generalMarginPct]);

  // Per-column widths. Auto-fit columns (numeric: onHand/onOrder/onPO)
  // compute width from the largest content + 2 char-widths padding on
  // each side, including the 5 stacked totals lines when TOTALS is on.
  // Fixed-width columns (text: category/subCategory/style/description/
  // color) just use their fixedPx so long content truncates visually
  // instead of blowing out the grid layout.
  const stickyWidths = useMemo(() => {
    const w: Record<StickyKey, number> = {} as Record<StickyKey, number>;
    for (const meta of STICKY_COL_META) {
      if (!meta.autoFit) {
        // The Style column hosts the per-row image thumbnail; widen it
        // when images are on so the 32px tile sits beside the style code
        // (+ optional expand triangle / store badge) without crowding.
        w[meta.key] = (meta.key === "style" && showImages) ? STYLE_COL_IMG_PX : meta.fixedPx;
        continue;
      }
      let maxLen = meta.label.length;
      for (const r of filtered) {
        let s = "";
        switch (meta.key) {
          case "onHand":  s = (r.onHand ?? 0).toLocaleString(); break;
          case "onOrder": s = r.onOrder > 0 ? r.onOrder.toLocaleString() : "—"; break;
          case "onPO":    s = r.onPO > 0 ? `+${r.onPO.toLocaleString()}` : "—"; break;
        }
        if (s.length > maxLen) maxLen = s.length;
      }
      if (showTotalsRow) {
        const slot = meta.key === "onHand" ? sums.onHand : meta.key === "onOrder" ? sums.onOrder : sums.onPO;
        // The sticky bucket totals cell renders 7 stacked rows of
        // "<label> <value>" via a 2-column grid. The autoFit measure
        // needs to fit BOTH halves, not just the value. Pick the
        // widest combined width across all 7 rows so neither the
        // label nor the value gets clipped.
        //   E Inven dominates because it's the cumulative end-period
        //   inventory $ — often the largest number on screen and
        //   previously omitted from this loop, which is why On Hand /
        //   On Order / On PO totals were being truncated. For sticky
        //   bucket cells B Inven = E Inven = slot.cost (no period
        //   flow), so we approximate eInven with slot.cost — the
        //   actual displayed value in this render context.
        const sticky_eInven_approx = slot.cost;
        const pairs: Array<[string, string]> = [
          ["Qty:",     slot.qty.toLocaleString()],
          ["B Inven:", fmtUSD(slot.cost)],
          ["Cost:",    fmtUSD(slot.cost)],
          ["Sale:",    fmtUSD(slot.sale)],
          ["Mrgn $:",  fmtUSD(slot.sale - slot.cost)],
          ["Mrgn:",    slot.sale > 0 ? `${(((slot.sale - slot.cost) / slot.sale) * 100).toFixed(1)}%` : "—"],
          ["E Inven:", fmtUSD(sticky_eInven_approx)],
        ];
        for (const [label, val] of pairs) {
          // "label value" — +1 for the space between them.
          const combined = label.length + 1 + val.length;
          if (combined > maxLen) maxLen = combined;
        }
      }
      const charPx = meta.charType === "mono" ? MONO_CHAR_PX : TEXT_CHAR_PX;
      w[meta.key] = Math.max(meta.minPx, Math.ceil((maxLen + PAD_CHARS) * charPx));
    }
    return w;
  }, [filtered, showTotalsRow, sums, showImages]);

  // Slim status bar instead of the centered "no SKUs" card. The card
  // dominated the page on initial load (when data hadn't streamed in
  // yet) and looked like an error rather than a transient state.
  // The bar reads as a notification, leaves the rest of the page
  // visible (filters / toolbar still usable), and unobtrusively
  // disappears once rows arrive.
  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#1E293B", border: "1px solid #334155", borderRadius: 8, color: "#94A3B8", fontSize: 13 }}>
      <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 6, border: "2px solid #334155", borderTopColor: "#10B981", animation: "ats-spin 0.8s linear infinite" }} />
      <span>Loading ATS data…</span>
      <style>{`@keyframes ats-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
  if (filtered.length === 0) return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#1E293B", border: "1px solid #334155", borderRadius: 8, color: "#94A3B8", fontSize: 13 }}>
      <span style={{ fontSize: 14, lineHeight: 1 }}>▦</span>
      <span>No SKUs match your filters.</span>
    </div>
  );

  // Style helper for cells in the totals row. Totals row sits at top: 0;
  // the regular header row below uses top: TOTALS_ROW_HEIGHT. Background
  // matches the main header (#1E293B) per design.
  const totalsThBase: React.CSSProperties = {
    ...S.th,
    top: 0,
    height: TOTALS_ROW_HEIGHT,
    boxSizing: "border-box",
    padding: "4px 10px",
    // backgroundColor (not shorthand) so S.stickyCol's gradient stripe
    // survives when the totals cell is also a sticky-left cell. The
    // shorthand `background:` would reset background-image to none.
    backgroundColor: "#1E293B",
    // No borderBottom / no boxShadow divider here. Previous attempts to
    // draw the divider via cell-level styling kept failing because Chrome
    // culls borders/shadows on sticky <th> elements during scroll-stack
    // composites. Divider now lives on its own dedicated <tr> below — a
    // solid-fill 3px cell that's part of the table layout and doesn't
    // depend on any per-cell border rendering.
    fontSize: 12,
    textTransform: "none",
    letterSpacing: 0,
    verticalAlign: "middle",
  };
  // Vertical offset for the column-header row when the divider row is
  // present. The divider row sits at top: TOTALS_ROW_HEIGHT with height 3,
  // so the column header has to start 3px lower to leave room.
  // 2px slate-600 — subtle separator between the totals row and the
  // column-header row. The diagnostic 5px slate-400 confirmed the
  // dedicated <tr> approach renders reliably; toning back now that
  // we know the mechanism works.
  const DIVIDER_HEIGHT = 2;
  const headerRowTop = showTotalsRow ? TOTALS_ROW_HEIGHT + DIVIDER_HEIGHT : 0;
  // Total visible column count for the divider cell's colSpan. Counts
  // the visible sticky-left cols plus the period cols. Updates when
  // operator hides cols or changes the horizon — that's why it's
  // computed per render rather than memoized.
  const dividerColSpan = STICKY_COL_META.filter(c => !isHidden(c.key)).length + displayPeriods.length;

  // Renders a single totals cell with stacked lines:
  //   Qty / B Inven / Cost / Sale / Mrgn $ / Mrgn % / E Inven
  // B Inven = inventory $ at start of the period (= previous period's
  // E Inven, or current on-hand × avg-cost for the first period).
  // E Inven = B Inven + receipts$ − COGS$ (= the period's ending
  // inventory $). The B/E chain is threaded in from GridTable's render
  // — this component just displays whatever the parent passes.
  //
  // For sticky on-hand / on-order / on-po cells, B and E both equal
  // Cost (the slot represents a single snapshot, no flow), which we
  // surface so the cell still renders the labels for visual consistency.
  type TotalsCellProps = {
    qty: number;
    cost: number;
    sale: number;
    bInven: number;
    eInven: number;
    qtyColor: string;
    qtyPrefix?: string; // for "+" on On PO
    skipped: number;    // SKUs ignored due to no SO/avgCost/PO cost
  };
  const TotalsCell: React.FC<TotalsCellProps> = ({ qty, cost, sale, bInven, eInven, qtyColor, qtyPrefix, skipped }) => {
    const marginDollars = sale - cost;
    const margin = sale > 0 ? (marginDollars / sale) * 100 : 0;
    const marginColor = !sale ? "#475569" : margin >= 30 ? "#10B981" : margin >= 10 ? "#F59E0B" : "#F87171";
    const dollarColor = !sale ? "#475569" : marginDollars >= 0 ? "#10B981" : "#F87171";
    const labelStyle: React.CSSProperties = { color: "#6B7280", fontSize: 10, textAlign: "right" };
    const valueStyle: React.CSSProperties = { textAlign: "right", fontFamily: "monospace" };
    const skipTitle = skipped > 0
      ? `${skipped} SKU${skipped === 1 ? "" : "s"} skipped — no SO sale price, no avg cost, no PO cost`
      : undefined;
    // Renders a label that appends a red * when the cell had to
    // skip SKUs. Keeps colon alignment because the * sits inside
    // the label cell to the right of the colon.
    const Label: React.FC<{ children: string }> = ({ children }) => (
      <span style={labelStyle} title={skipTitle}>
        {children}
        {skipped > 0 && <span style={{ color: "#EF4444", fontWeight: 700 }}>*</span>}
      </span>
    );
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto auto", columnGap: 4, rowGap: 1, justifyContent: "end", alignItems: "baseline", fontFamily: "monospace", lineHeight: 1.2 }}>
        <span style={labelStyle}>Qty:</span>
        <span style={{ ...valueStyle, color: qtyColor, fontWeight: 700, fontSize: 12 }}>
          {qty === 0 ? "—" : `${qtyPrefix ?? ""}${qty.toLocaleString()}`}
        </span>
        <span style={labelStyle} title="Beginning inventory $ for the period (= previous period's E Inven, or on-hand × avg cost for the first period)">B Inven:</span>
        <span style={{ ...valueStyle, color: "#A78BFA", fontWeight: 600, fontSize: 11 }}>{bInven > 0 ? fmtUSD(bInven) : "—"}</span>
        <span style={labelStyle}>Cost:</span>
        <span style={{ ...valueStyle, color: "#94A3B8", fontWeight: 600, fontSize: 11 }}>{fmtUSD(cost)}</span>
        <span style={labelStyle}>Sale:</span>
        <span style={{ ...valueStyle, color: "#3B82F6", fontWeight: 600, fontSize: 11 }}>{fmtUSD(sale)}</span>
        {canViewMargin && (
          <>
            <Label>Mrgn $:</Label>
            <span style={{ ...valueStyle, color: dollarColor, fontWeight: 600, fontSize: 11 }} title={skipTitle}>
              {sale > 0 ? fmtUSD(marginDollars) : "—"}
            </span>
            <Label>Mrgn:</Label>
            <span style={{ ...valueStyle, color: marginColor, fontWeight: 600, fontSize: 11 }} title={skipTitle}>
              {sale > 0 ? `${margin.toFixed(1)}%` : "—"}
            </span>
          </>
        )}
        <span style={labelStyle} title="Ending inventory $ for the period (= B Inven + receipts$ − COGS$). Flows to the next period's B Inven.">E Inven:</span>
        <span style={{ ...valueStyle, color: "#F472B6", fontWeight: 600, fontSize: 11 }}>{eInven > 0 ? fmtUSD(eInven) : "—"}</span>
      </div>
    );
  };

  return (
    <>
      <GridScrollbarStyles scope="ats-grid-wrap" />
      <div className="ats-grid-wrap" style={S.tableWrap} ref={tableRef}>
      <table className="ats-grid" style={S.table}>
        <thead>
          {/* Totals row — sticky top: 0, sums across the filtered set.
             Column geometry mirrors the column-header row below; both
             use STICKY_COLS + colLeft so hidden columns drop out and
             siblings reflow consistently. */}
          {showTotalsRow && (
          <tr>
            {/* Empty placeholders for the ID columns (incl. the X column) + Color */}
            {(["category","subCategory","exclude","style","description","color"] as const).map(k => {
              if (isHidden(k)) return null;
              const left = colLeftFrom(k, stickyWidths, hidden) ?? 0;
              return <th key={k} style={{ ...totalsThBase, ...S.stickyCol, left, minWidth: stickyWidths[k], zIndex: 4, ...unfreezeStyle(k) }} />;
            })}
            {/* Sticky bucket cells (On Hand / On Order / On PO) all
                share the same B and E Inven — there's a single
                inventory state across all three:
                  • B Inven = sum(onHand_qty × avg_cost)  per the
                    planner's rule (= sums.onHand.cost)
                  • E Inven = B + receipts$ − COGS$, both totalled over
                    the SAME displayed window as the period chain below.
                    Receipts$ = sum of periodReceiptsValue (PO arrivals
                    DATED INSIDE the visible window), NOT sums.onPO.cost
                    (the entire open-PO book). Using the full open-PO
                    commitment over-stated the badge by the $ of POs
                    arriving AFTER the window while only subtracting the
                    in-window COGS — so the sticky E never matched the
                    last period column's cumulative E. Now they tie out
                    exactly: stickyE == E of the final displayed period.
                    Deductions use periodCogsValue summed over the
                    horizon (not sums.onOrder.cost — open-SO qty isn't
                    the same as the SO-events shipping in the window).
                Period cells below each carry their own per-period B/E
                via the running chain — first period inherits B from
                the sticky's B. */}
            {(() => {
              const stickyB = sums.onHand.cost;
              let totalPeriodCogs = 0;
              let totalPeriodReceipts = 0;
              for (const p of displayPeriods) {
                totalPeriodCogs += sums.periodCogsValue[p.key] ?? 0;
                totalPeriodReceipts += sums.periodReceiptsValue[p.key] ?? 0;
              }
              // Mirror the period chain (B + Σreceipts − Σcogs) so the
              // badge equals the end-of-window column to the dollar.
              const stickyE = stickyB + totalPeriodReceipts - totalPeriodCogs;
              return (
                <>
                  {!isHidden("onHand") && (
                    <th style={{ ...totalsThBase, ...S.stickyCol, left: colLeftFrom("onHand", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onHand, zIndex: 4, ...unfreezeStyle("onHand") }}>
                      <TotalsCell qty={sums.onHand.qty} cost={sums.onHand.cost} sale={sums.onHand.sale} bInven={stickyB} eInven={stickyE} skipped={sums.onHand.skipped} qtyColor="#F1F5F9" />
                    </th>
                  )}
                  {!isHidden("onOrder") && (
                    <th style={{ ...totalsThBase, ...S.stickyCol, left: colLeftFrom("onOrder", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onOrder, zIndex: 4, ...unfreezeStyle("onOrder") }}>
                      <TotalsCell qty={sums.onOrder.qty} cost={sums.onOrder.cost} sale={sums.onOrder.sale} bInven={stickyB} eInven={stickyE} skipped={sums.onOrder.skipped} qtyColor="#F59E0B" />
                    </th>
                  )}
                  {!isHidden("onPO") && (
                    <th style={{ ...totalsThBase, ...S.stickyCol, left: colLeftFrom("onPO", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onPO, zIndex: 4, ...unfreezeStyle("onPO") }}>
                      <TotalsCell qty={sums.onPO.qty} cost={sums.onPO.cost} sale={sums.onPO.sale} bInven={stickyB} eInven={stickyE} skipped={sums.onPO.skipped} qtyColor="#10B981" qtyPrefix="+" />
                    </th>
                  )}
                </>
              );
            })()}
            {/* Period sums. B / E Inven chain across periods:
                  • B[period 1] = sticky's B Inven (= sums.onHand.cost,
                    the current on-hand × avg cost). Per planner: the
                    first date column inherits B from the sticky's B,
                    NOT the sticky's E — so open POs/SOs flow into the
                    chain through their per-period events rather than
                    being pre-applied at horizon start.
                  • B[period i+1] = E[period i] for i ≥ 1
                  • E[period i]   = B + receipts$_i − COGS$_i
                      where receipts$_i = sum of PO event qty in this
                      period × avg cost, and COGS$_i = sum of SO event
                      qty in this period × avg cost (both computed
                      independent of viewMode in computeGridTotals).
                Chain is built once during render so each map iteration
                sees the correct prior E. */}
            {(() => {
              const stickyB = sums.onHand.cost;
              let prevEInven = stickyB;
              return displayPeriods.map(p => {
                const q = sums.periodQty[p.key]     ?? 0;
                const c = sums.periodCost[p.key]    ?? 0;
                const s = sums.periodSale[p.key]    ?? 0;
                const sk = sums.periodSkipped[p.key] ?? 0;
                const receipts = sums.periodReceiptsValue[p.key] ?? 0;
                const cogs     = sums.periodCogsValue[p.key]     ?? 0;
                const isNeg = q < 0;
                const qtyColor = isNeg ? "#F87171" : (q === 0 ? "#475569" : getQtyColor(q));
                const bInven = prevEInven;
                const eInven = bInven + receipts - cogs;
                prevEInven = eInven;
                return (
                  <th
                    key={`tot-${p.key}`}
                    style={{
                      ...totalsThBase,
                      minWidth: rangeUnit === "days" ? 68 : rangeUnit === "weeks" ? 120 : 100,
                      backgroundColor: p.isToday ? "#1a2a1e" : p.isWeekend ? "#141e2e" : "#1E293B",
                    }}
                  >
                    <TotalsCell qty={q} cost={c} sale={s} bInven={bInven} eInven={eInven} qtyColor={qtyColor} skipped={sk} />
                  </th>
                );
              });
            })()}
          </tr>
          )}
          {/* Dedicated divider row — solid 3px slate-600 band between the
              totals row and the column-header row. Built as its own sticky
              <tr> after every prior border/shadow attempt was culled by
              Chrome on sticky <th> cells during scroll. A single colSpan
              cell with a background fill is reliably composited because
              it's the cell's CONTENT, not a border. zIndex 5 keeps it
              above data rows (z 2) and column header row sticky cells
              (z 3) so nothing can paint over it during horizontal scroll. */}
          {showTotalsRow && (
            <tr>
              <th
                colSpan={dividerColSpan}
                style={{
                  position: "sticky",
                  top: TOTALS_ROW_HEIGHT,
                  height: DIVIDER_HEIGHT,
                  padding: 0,
                  background: "#475569",
                  border: "none",
                  zIndex: 5,
                  // line-height: 0 so any stray ASCII (whitespace) in this
                  // empty cell can't expand its height past 3px.
                  lineHeight: 0,
                  fontSize: 0,
                }}
              />
            </tr>
          )}
          {/* Column headers — pushed below the totals row + divider */}
          <tr>
            {/* Sticky left columns. Hidden columns (operator-toggled
                via the Toolbar's "Columns" dropdown) are dropped here
                and their widths fall out of the cumulative `left`
                offset, so visible siblings shift left to fill the gap. */}
            {STICKY_COL_META.map((c) => {
              if (isHidden(c.key)) return null;
              const left = colLeftFrom(c.key, stickyWidths, hidden) ?? 0;
              const isActive = sortCol === c.key;
              // Numeric buckets + the X checkbox column center; text cols left.
              const centered = c.key === "exclude" || c.key === "onHand" || c.key === "onOrder" || c.key === "onPO";
              // The X column header is a select-all / clear-all toggle, not a sort key.
              const isExcludeCol = c.key === "exclude";
              const sortable = !isExcludeCol;
              // X header reflects + flips the exclusion of every visible row.
              const excludeTitle = allVisibleExcluded
                ? `Click to INCLUDE all ${excludableLeafSkus.length} visible row(s) — they're all excluded from totals & reports right now`
                : `Click to EXCLUDE all ${excludableLeafSkus.length} visible row(s) from every total, calculation & report${someVisibleExcluded ? " (some already excluded)" : ""}`;
              const excludeColor = allVisibleExcluded ? "#F87171" : someVisibleExcluded ? "#FBBF24" : "#6B7280";
              return (
                <th
                  key={c.key}
                  title={isExcludeCol ? excludeTitle : undefined}
                  style={{
                    ...S.th, ...S.stickyCol,
                    top: headerRowTop,
                    left, minWidth: stickyWidths[c.key], zIndex: 3,
                    textAlign: centered ? "center" : "left",
                    cursor: (sortable || isExcludeCol) ? "pointer" : "default",
                    color: isActive ? "#F1F5F9" : "#6B7280",
                    // backgroundColor (not shorthand) so S.stickyCol's
                    // gradient stripe survives — see styles.ts:stickyCol.
                    backgroundColor: isActive ? "#243048" : "#1E293B",
                    userSelect: isExcludeCol ? "none" : undefined,
                    ...unfreezeStyle(c.key),
                  }}
                  onClick={isExcludeCol ? () => toggleAllExclude() : (sortable ? () => handleThClick(c.key) : undefined)}
                >
                  {isExcludeCol
                    ? <span style={{ color: excludeColor, fontWeight: 800, fontSize: 13 }}>X</span>
                    : <>{c.label}{sortable && isActive ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</>}
                </th>
              );
            })}
            {/* Period columns */}
            {displayPeriods.map(p => {
              const isActive = sortCol === p.endDate;
              return (
                <th
                  key={p.key}
                  style={{
                    ...S.th,
                    top: headerRowTop,
                    minWidth: rangeUnit === "days" ? 68 : rangeUnit === "weeks" ? 120 : 100,
                    textAlign: "center",
                    backgroundColor: isActive ? "#243048" : p.isToday ? "#1a2a1e" : p.isWeekend ? "#141e2e" : "#1E293B",
                    color: isActive ? "#F1F5F9" : p.isToday ? "#10B981" : p.isWeekend ? "#475569" : "#6B7280",
                    borderBottom: p.isToday ? "2px solid #10B981" : "1px solid #334155",
                    whiteSpace: "pre-line",
                    lineHeight: 1.3,
                    fontSize: rangeUnit === "days" ? 10 : 11,
                    padding: "8px 6px",
                    cursor: "pointer",
                  }}
                  onClick={() => handleThClick(p.endDate)}
                >
                  {p.label}{isActive ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, ri) => {
            const isPinned = pinnedSku === row.sku;
            const isDragging = dragSku === row.sku;
            const isDropTarget = dragOverSku === row.sku && dragSku !== row.sku;
            const isAggregate = !!row.__collapsed;
            // Excluded ("X") leaf rows stay visible but greyed, so the
            // operator can see + uncheck them. Aggregates can't be excluded.
            const isExcluded = !isAggregate && excludedSet.has(row.sku);
            const aggLevel = row.__collapsed?.level ?? null;
            const aggKey = row.__collapsed?.key ?? "";
            const isExpanded = aggKey ? expandedGroupSet.has(aggKey) : false;
            // Heavy row-bg alternation — slate-900 vs slate-800 — instead
            // of relying on hairline dividers between rows. Sticky cells
            // under horizontal scroll keep dropping their painted
            // borders/shadows on Chrome no matter how many redundant
            // paint paths we layer on, so the strategy here is to make
            // the rows visually distinct on their own. With #0F172A
            // (slate-900) vs #1E293B (slate-800) the rows read as clearly
            // separate stripes; the 2px divider line is now a bonus on
            // top, not the only signal.
            // Tint aggregate rows so they read as group headers, not leaves.
            const baseBg = isAggregate
              ? (ri % 2 === 0 ? "#22304A" : "#2A3A57")
              : (ri % 2 === 0 ? "#0F172A" : "#1E293B");
            const stickyBg = isPinned ? "#1a2332" : baseBg;
            return (
              <tr
                key={`${row.sku}::${row.store ?? "ROF"}`}
                draggable={!isAggregate}
                onDragStart={e => {
                  if (isAggregate) { e.preventDefault(); return; }
                  // Carry the source sku on the event itself so the drop
                  // handler is independent of React state flush timing.
                  // This fixes the intermittent "row 2 → row 1 doesn't
                  // merge" case where the drop handler's closure ran before
                  // dragSku state had propagated.
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("application/x-ats-sku", row.sku);
                  setDragSku(row.sku);
                }}
                onDragEnd={() => { setDragSku(null); setDragOverSku(null); }}
                onDragOver={e => {
                  // Aggregate rows are synthetic (__group:...); merging into
                  // them is meaningless. Block the drop target entirely.
                  if (isAggregate) return;
                  e.preventDefault();
                  if (dragSku && dragSku !== row.sku && dragOverSku !== row.sku) {
                    setDragOverSku(row.sku);
                  }
                }}
                onDragLeave={() => setDragOverSku(null)}
                onDrop={e => {
                  if (isAggregate) return;
                  e.preventDefault();
                  // Prefer the dataTransfer payload; fall back to React state.
                  const fromSku = e.dataTransfer.getData("application/x-ats-sku") || dragSku || "";
                  if (fromSku && fromSku !== row.sku) {
                    handleSkuDrop(fromSku, row.sku);
                  }
                  setDragSku(null);
                  setDragOverSku(null);
                }}
                style={{
                  background: isDropTarget ? "#1e3a2a" : stickyBg,
                  // Excluded rows dim to read as "not counted"; dragging also dims.
                  opacity: isDragging ? 0.45 : isExcluded ? 0.4 : 1,
                  outline: isDropTarget ? "2px solid #10B981" : "none",
                  transition: "background 0.1s, opacity 0.1s",
                  cursor: isAggregate ? "default" : "grab",
                  fontWeight: isAggregate ? 600 : 400,
                }}
              >
                {/* Category */}
                {!isHidden("category") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("category", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.category, backgroundColor: stickyBg, color: "#9CA3AF", fontSize: 12, ...unfreezeStyle("category") }}
                  onClick={() => { if (!isAggregate) setPinnedSku(isPinned ? null : row.sku); }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {aggLevel === "category" ? (
                      <button
                        onClick={e => { e.stopPropagation(); toggleExpandGroup(aggKey); }}
                        style={{ background: "transparent", border: "none", color: "#60A5FA", cursor: "pointer", padding: 0, fontSize: 11, width: 14, textAlign: "center" }}
                        aria-label={isExpanded ? "Collapse group" : "Expand group"}
                      >
                        {isExpanded ? "▼" : "▶"}
                      </button>
                    ) : (
                      <div style={{ width: 6, height: 6, borderRadius: 2, background: getQtyColor(row.dates[todayKey] ?? row.onHand), flexShrink: 0 }} />
                    )}
                    <span style={{ color: isAggregate ? "#F1F5F9" : "#9CA3AF" }}>{row.master_category ?? "—"}</span>
                  </div>
                </td>
                )}
                {/* Sub Cat */}
                {!isHidden("subCategory") && (
                <td style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("subCategory", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.subCategory, backgroundColor: stickyBg, color: "#9CA3AF", fontSize: 12, ...unfreezeStyle("subCategory") }}>
                  {aggLevel === "category" ? "" : (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {aggLevel === "subCategory" && (
                        <button
                          onClick={e => { e.stopPropagation(); toggleExpandGroup(aggKey); }}
                          style={{ background: "transparent", border: "none", color: "#60A5FA", cursor: "pointer", padding: 0, fontSize: 11, width: 14, textAlign: "center" }}
                          aria-label={isExpanded ? "Collapse group" : "Expand group"}
                        >
                          {isExpanded ? "▼" : "▶"}
                        </button>
                      )}
                      <span style={{ color: isAggregate ? "#F1F5F9" : "#9CA3AF" }}>{row.master_sub_category ?? "—"}</span>
                    </div>
                  )}
                </td>
                )}
                {/* X — exclude checkbox. Aggregate rows can't be excluded
                    (they're synthetic roll-ups). Full opacity even on a
                    greyed (excluded) row so the operator can always see +
                    click it to re-include. Stops propagation so toggling
                    doesn't also pin/expand the row. */}
                {!isHidden("exclude") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("exclude", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.exclude, backgroundColor: stickyBg, textAlign: "center", padding: "4px 2px", opacity: 1, ...unfreezeStyle("exclude") }}
                  onClick={e => e.stopPropagation()}
                  title={isAggregate ? undefined : (isExcluded ? "Excluded from all totals & reports — click to include" : "Exclude this row from all totals, calculations, and reports")}
                >
                  {!isAggregate && (
                    <input
                      type="checkbox"
                      checked={isExcluded}
                      onChange={e => { e.stopPropagation(); onToggleExclude(row.sku); }}
                      style={{ accentColor: "#EF4444", cursor: "pointer", width: 14, height: 14 }}
                    />
                  )}
                </td>
                )}
                {/* Style — primary identifier; raw SKU on hover for traceability;
                   store badge stays here */}
                {!isHidden("style") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("style", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.style, backgroundColor: stickyBg, ...unfreezeStyle("style") }}
                  title={isAggregate ? undefined : row.sku}
                >
                  {(aggLevel === "category" || aggLevel === "subCategory") ? "" : (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {aggLevel === "style" && (
                        <button
                          onClick={e => { e.stopPropagation(); toggleExpandGroup(aggKey); }}
                          style={{ background: "transparent", border: "none", color: "#60A5FA", cursor: "pointer", padding: 0, fontSize: 11, width: 14, textAlign: "center" }}
                          aria-label={isExpanded ? "Collapse group" : "Expand group"}
                        >
                          {isExpanded ? "▼" : "▶"}
                        </button>
                      )}
                      {/* Per-row style thumbnail. Color-matched (uses the
                          row's color image when the style has one, else the
                          style default). A blank tile reserves the same
                          space for styles with no image so the column stays
                          aligned. Click opens the full gallery. */}
                      {showImages && (() => {
                        const code = (row.master_style ?? "").toUpperCase();
                        const info = code ? styleThumbs.get(code) : undefined;
                        // Tolerant per-color match (PIM "Black Camo" ↔ Xoro "Blk Camo").
                        const url = info ? pickColorImage(info.byColor, displayColor(row), info.default) : null;
                        // Fixed-width wrapper so StyleThumb's `margin: 0 auto`
                        // resolves within the tile's own width instead of
                        // absorbing the flex row's free space (which would
                        // shove the style code to the right).
                        return (
                          <span style={{ width: STYLE_THUMB_PX, flexShrink: 0, display: "block" }}>
                            <StyleThumb
                              styleId={info?.style_id ?? ""}
                              label={row.master_style ?? ""}
                              url={url}
                              size={STYLE_THUMB_PX}
                            />
                          </span>
                        );
                      })()}
                      <span style={{ fontFamily: "monospace", color: "#60A5FA", fontSize: 12, fontWeight: 700 }}>
                        {row.master_style ?? "—"}
                      </span>
                      {!isAggregate && row.store && row.store !== "ROF" && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#FBBF24", background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", borderRadius: 3, padding: "1px 5px", letterSpacing: 0.3 }}>
                          {row.store}
                        </span>
                      )}
                    </div>
                  )}
                </td>
                )}
                {/* Description — prefer the clean style-level master
                    description (e.g. "LAIDBACK Baggy Fit") over the
                    Xoro variant description, which packs SKU + color
                    + size into the field and reads as garbage. */}
                {!isHidden("description") && (
                <td style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("description", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.description, backgroundColor: stickyBg, color: isAggregate ? "#94A3B8" : "#D1D5DB", fontSize: 13, fontStyle: isAggregate ? "italic" : "normal", ...unfreezeStyle("description") }}>
                  {row.master_description ?? row.description}
                </td>
                )}
                {/* Color */}
                {!isHidden("color") && (
                <td style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("color", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.color, backgroundColor: stickyBg, color: "#D1D5DB", fontSize: 12, ...unfreezeStyle("color") }}>
                  {isAggregate ? "" : (displayColor(row) || "—")}
                </td>
                )}
                {/* On Hand */}
                {!isHidden("onHand") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("onHand", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onHand, backgroundColor: stickyBg, textAlign: "center", cursor: "context-menu", ...unfreezeStyle("onHand") }}
                  onContextMenu={e => openSummaryCtx(e, "onHand", row)}
                >
                  {renderQty({ qty: row.onHand, mult: row.ppkMult ?? 1, explode: explodePpk, color: "#F1F5F9" })}
                </td>
                )}
                {/* On Order (committed SOs) */}
                {!isHidden("onOrder") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("onOrder", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onOrder, backgroundColor: stickyBg, textAlign: "center", cursor: row.onOrder > 0 ? "context-menu" : "default", ...unfreezeStyle("onOrder") }}
                  onContextMenu={e => { if (row.onOrder > 0) openSummaryCtx(e, "onOrder", row); }}
                >
                  {renderQty({ qty: row.onOrder, mult: row.ppkMult ?? 1, explode: explodePpk, color: "#F59E0B", zeroDisplay: "—" })}
                </td>
                )}
                {/* On PO (open purchase orders) */}
                {!isHidden("onPO") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("onPO", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onPO, backgroundColor: stickyBg, textAlign: "center", cursor: row.onPO > 0 ? "context-menu" : "default", ...unfreezeStyle("onPO") }}
                  onContextMenu={e => { if (row.onPO > 0) openSummaryCtx(e, "onPO", row); }}
                >
                  {renderQty({ qty: row.onPO, mult: row.ppkMult ?? 1, explode: explodePpk, color: "#10B981", prefix: "+", zeroDisplay: "—" })}
                </td>
                )}
                {/* Period cells */}
                {displayPeriods.map((p, periodIdx) => {
                  const ev = eventIndex ? getEventsInPeriod(row.sku, p.periodStart, p.endDate, row.store) : null;
                  const hasPO = (ev?.pos.length ?? 0) > 0;
                  const hasSO = (ev?.sos.length ?? 0) > 0;
                  // viewMode "ats" → per-period availability via
                  // periodAvail (cumulative free at period 0; new-
                  // receipt delta after). "so" / "po" → bucketed event
                  // qty for this period. Aggregate rows skip SO/PO mode
                  // (no sku/store to query) and fall back to undefined →
                  // renders as "—".
                  let qty: number | undefined;
                  if (viewMode === "ats") {
                    // Neg ATS card active → show the true running balance
                    // (signed, can be negative) so the oversold cells the
                    // card filtered to actually render in red. Otherwise the
                    // clamped per-period availability (periodAvail).
                    qty = negMode
                      ? (row.dates[p.endDate] ?? undefined)
                      : periodAvail(row, displayPeriods, periodIdx);
                  } else if (!row.__collapsed && ev) {
                    const list = viewMode === "so" ? ev.sos : ev.pos;
                    qty = list.reduce((a, e) => a + (e.qty || 0), 0);
                  }
                  const isNeg = qty != null && qty < 0;
                  const isHov = hoveredCell?.sku === row.sku && hoveredCell?.date === p.key;
                  const isEmpty = qty === undefined || qty === null;
                  const canClick = hasPO || hasSO || isNeg;
                  const baseBg = p.isToday
                    ? (isEmpty ? "#12201a" : isNeg ? "rgba(239,68,68,0.18)cc" : getQtyBg(qty!) + "cc")
                    : (isEmpty ? "#0F172A"  : isNeg ? "rgba(239,68,68,0.12)"  : getQtyBg(qty!));
                  const cellBg = hasPO && hasSO
                    ? `repeating-linear-gradient(45deg, rgba(245,158,11,0.22) 0px, rgba(245,158,11,0.22) 4px, rgba(59,130,246,0.22) 4px, rgba(59,130,246,0.22) 8px)`
                    : hasPO ? "rgba(245,158,11,0.18)"
                    : hasSO ? "rgba(59,130,246,0.18)"
                    : baseBg;
                  return (
                    <td
                      key={p.key}
                      style={{
                        ...S.td,
                        textAlign: "center",
                        padding: "4px",
                        background: cellBg,
                        cursor: canClick ? "context-menu" : "default",
                        transition: "all 0.1s",
                        outline: isHov ? `1px solid ${isEmpty ? "#334155" : isNeg ? "#EF4444" : getQtyColor(qty!)}` : "none",
                        outlineOffset: -1,
                        position: "relative",
                        boxShadow: hasPO && hasSO ? "inset 0 0 0 1px rgba(245,158,11,0.5)"
                          : hasPO ? "inset 0 0 0 1px rgba(245,158,11,0.4)"
                          : hasSO ? "inset 0 0 0 1px rgba(59,130,246,0.4)"
                          : isNeg ? "inset 0 0 0 1px rgba(239,68,68,0.5)"
                          : undefined,
                      }}
                      onMouseEnter={() => setHoveredCell({ sku: row.sku, date: p.key })}
                      onMouseLeave={() => setHoveredCell(null)}
                      onContextMenu={e => {
                        if (!canClick) return;
                        e.preventDefault();
                        const cellKey = `${row.sku}::${p.key}`;
                        if (ctxMenu?.cellKey === cellKey) { setCtxMenu(null); return; }
                        const cellEl = e.currentTarget as HTMLElement;
                        const cellRect = cellEl.getBoundingClientRect();
                        setSummaryCtx(null);
                        // Compute blended unit cost using full row history
                        // (on-hand at avgCost + ALL incoming POs at their unitCost)
                        // so margin reflects the full replenishment picture, not
                        // just this cell's POs.
                        const poList = ev?.pos ?? [];
                        const allRowPos = eventIndex?.[row.sku]
                          ? Object.values(eventIndex[row.sku]).flatMap(v => v.pos.filter(p => !row.store || (p.store ?? "ROF") === row.store))
                          : [];
                        // Reconcile PPK grain: row.onHand is unit-grain
                        // (multiplied by ppkMult) and row.avgCost is
                        // per-unit (divided by ppkMult); raw PO events
                        // are still pack-grain. Without converting, the
                        // weighted average mixes packs and units and
                        // the SO margin downstream came out wildly
                        // wrong (97% on a 35%-real prepack). ppkMult=1
                        // for non-prepacks so the math is unchanged.
                        const ppkMult = row.ppkMult ?? 1;
                        const poQtySumUnits = allRowPos.reduce((a, p) => a + (p.qty || 0) * ppkMult, 0);
                        const poCostSum = allRowPos.reduce((a, p) => a + (p.qty || 0) * (p.unitCost || 0), 0);
                        const onHandCostSum = (row.onHand || 0) * (row.avgCost || 0);
                        const totalQtyUnits = (row.onHand || 0) + poQtySumUnits;
                        let effectiveCost = totalQtyUnits > 0 ? (onHandCostSum + poCostSum) / totalQtyUnits : 0;
                        if (!effectiveCost && poList.length) {
                          const priced = poList.filter(p => p.unitCost > 0);
                          const totQtyPacks = priced.reduce((a, p) => a + p.qty, 0);
                          // poList.unitCost is per-pack; divide by
                          // ppkMult to land at per-unit so it's
                          // comparable with row.avgCost.
                          effectiveCost = totQtyPacks > 0
                            ? priced.reduce((a, p) => a + p.qty * p.unitCost, 0) / (totQtyPacks * ppkMult)
                            : 0;
                        }
                        setCtxMenu({
                          // y starts with the same -6 overlap that
                          // repositionCtxMenu later applies, so the
                          // first paint already shows the arrow tip
                          // inside the cell.
                          x: cellRect.left, y: cellRect.bottom - 6, anchorY: cellRect.top,
                          pos: poList, sos: ev?.sos ?? [],
                          onHand: row.onHand, skuStore: row.store ?? "ROF",
                          cellKey, cellEl, flipped: false, arrowLeft: 20,
                          unitCost: effectiveCost,
                          ppkMult,
                        });
                      }}
                    >
                      {(isEmpty || qty === 0) ? (
                        <span style={{ color: "#334155", fontSize: 11 }}>—</span>
                      ) : isNeg ? (
                        <span style={{
                          display: "inline-block",
                          background: "rgba(239,68,68,0.22)",
                          color: "#F87171",
                          fontSize: 11,
                          fontFamily: "monospace",
                          fontWeight: 700,
                          padding: "1px 5px",
                          borderRadius: 4,
                          border: "1px solid rgba(239,68,68,0.4)",
                        }}>
                          {qty!.toLocaleString()}
                        </span>
                      ) : (() => {
                        // Period cells get the same EXPLODE PPK treatment as
                        // the sticky On Hand / On Order / On PO columns.
                        // Inline (not via renderQty helper) because the
                        // negative-qty red-badge branch above lives in the
                        // same ternary and the period palette differs (uses
                        // getQtyColor and a weight-by-bucket rule).
                        const mult = row.ppkMult ?? 1;
                        const packs = mult > 1 ? Math.round(qty! / mult) : qty!;
                        const display = mult > 1 && !explodePpk ? packs : qty!;
                        const hint = mult > 1
                          ? (explodePpk
                              ? `PPK${mult} × ${packs.toLocaleString()}`
                              : `PPK${mult} = ${qty!.toLocaleString()}`)
                          : null;
                        return (
                          <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", lineHeight: 1.1 }}>
                            <span style={{
                              color: getQtyColor(qty!),
                              fontSize: 12,
                              fontFamily: "monospace",
                              fontWeight: qty! <= 10 ? 700 : 500,
                            }}>
                              {display.toLocaleString()}
                            </span>
                            {hint && (
                              <span style={{ color: "#6B7280", fontSize: 8, fontFamily: "monospace", opacity: 0.7, marginTop: 1 }}>
                                {hint}
                              </span>
                            )}
                          </span>
                        );
                      })()}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
};
