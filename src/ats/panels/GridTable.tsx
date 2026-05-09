import React, { useMemo } from "react";
import S from "../styles";
import { getQtyColor, getQtyBg, displayColor } from "../helpers";
import { useArrowKeyScroll } from "../../shared/grid/useArrowKeyScroll";
import { GridScrollbarStyles } from "../../shared/grid/GridScrollbarStyles";
import type { ATSRow, ATSPoEvent, ATSSoEvent, CtxMenu } from "../types";

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

  // Prepack — primary + faded hint.
  const packs = qty / mult;
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
// five stacked content lines (Qty / Cost / Sale / Mrgn $ / Mrgn) plus
// breathing room above and below — empty space is ~50% of the original
// (doubled from the 25%-tight version per operator follow-up).
const TOTALS_ROW_HEIGHT = 86;

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
  pageRows: ATSRow[];
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
  atShip: boolean;
  // Grid cell content selector. "ats" = running on-hand balance (uses
  // row.dates / row.freeMap depending on atShip). "so" / "po" = sum of
  // SO/PO qty within each period via getEventsInPeriod, so the column
  // labelled e.g. "Mar 2026" shows the SO (or PO receipt) qty falling
  // in March across the filtered SKUs. The totals-row Qty mirrors this.
  viewMode: "ats" | "so" | "po";
  showTotalsRow: boolean;
  // Whether to render prepack qtys as units (exploded) or as packs.
  // ON shows packs × units-per-pack; OFF shows pack count + faded
  // "PPKn = N" hint with the unit-grain equivalent.
  explodePpk: boolean;
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
  loading, filtered, pageRows, displayPeriods, tableRef,
  sortCol, sortDir, handleThClick, rangeUnit,
  pinnedSku, setPinnedSku, dragSku, setDragSku, dragOverSku, setDragOverSku,
  hoveredCell, setHoveredCell,
  todayKey, atShip, viewMode, showTotalsRow, explodePpk, freezeKey, hiddenColumns, generalMarginPct, eventIndex, getEventsInPeriod,
  ctxMenu, setCtxMenu, setSummaryCtx,
  openSummaryCtx, handleSkuDrop, toggleExpandGroup, expandedGroupSet,
}) => {
  // Wire arrow / pgup-pgdn / shift-home/end to scroll the grid when
  // no input has focus. See useArrowKeyScroll above.
  useArrowKeyScroll(tableRef);

  // Convert hiddenColumns to a Set for O(1) lookups in colLeft + the
  // per-cell render guards below.
  const hidden = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  const isHidden = (key: StickyKey) => hidden.has(key);

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

  // Totals across the filtered set (not just the current page).
  //
  // Per-SKU resolution chain (drives Cost and Sale):
  //   sale: SO avg price from events  →  cost / (1 − margin%)  if no SO
  //   cost: row.avgCost (inventory)   →  PO avg unitCost       →  sale × (1 − margin%) if no SO either
  //   skip: SKU with no SO, no avgCost, AND no PO cost → ignored
  //         and counted in `incompleteSkus` so the Mrgn label can
  //         show a `*`.
  const sums = useMemo(() => {
    const m = Math.max(0, Math.min(99, generalMarginPct ?? 50)) / 100;
    const oneMinusM = 1 - m;

    // Per-SKU PPK multiplier from filtered rows. Raw Xoro PO/SO events
    // come at PACK grain — soVal/soQty and poVal/poQty are per-pack
    // dollars. The qty fields on r (onHand / onOrder / onPO / dates)
    // are unit-grain (compute.ts already multiplies by ppkMult), so
    // multiplying unit qty × per-pack price would inflate cost/sale
    // totals by ppkMult on prepacks. Divide the per-pack price by
    // ppkMult here so soPriceBySku / poCostBySku land in per-unit
    // grain — matching avgCostBySku, which is already per-unit
    // because compute.ts divides r.avgCost by ppkMult on ingest.
    const ppkMultBySku = new Map<string, number>();
    for (const r of filtered) {
      const m = r.ppkMult ?? 1;
      if (m > 1) ppkMultBySku.set(r.sku, m);
    }

    // Per-SKU SO avg price + PO avg unit cost from event index.
    const soPriceBySku = new Map<string, number>();
    const poCostBySku  = new Map<string, number>();
    if (eventIndex) {
      for (const sku of Object.keys(eventIndex)) {
        let soQty = 0, soVal = 0, poQty = 0, poVal = 0;
        for (const buckets of Object.values(eventIndex[sku])) {
          for (const so of buckets.sos) {
            const v = so.totalPrice || (so.unitPrice * so.qty) || 0;
            if (so.qty > 0 && v > 0) { soQty += so.qty; soVal += v; }
          }
          for (const po of buckets.pos) {
            if (po.qty > 0 && po.unitCost > 0) { poQty += po.qty; poVal += po.qty * po.unitCost; }
          }
        }
        const mult = ppkMultBySku.get(sku) ?? 1;
        if (soQty > 0) soPriceBySku.set(sku, (soVal / soQty) / mult);
        if (poQty > 0) poCostBySku.set(sku, (poVal / poQty) / mult);
      }
    }

    // First pass: capture the BEST avgCost per SKU across every store
    // row in the filtered set. avgCost is per (sku, store) so a SKU
    // can have a $5 cost on its ROF row but $0 on its ROF ECOM row;
    // resolving on whichever row appears first would mis-skip half
    // the inventory.
    const avgCostBySku = new Map<string, number>();
    for (const r of filtered) {
      if (r.avgCost && r.avgCost > 0) {
        const cur = avgCostBySku.get(r.sku);
        if (cur == null || r.avgCost > cur) avgCostBySku.set(r.sku, r.avgCost);
      }
    }

    // Resolve cost + sale for each filtered SKU, returning null when
    // there's no signal at all (SO, avgCost, and PO cost all missing).
    type Resolved = { cost: number; sale: number };
    const resolved = new Map<string, Resolved | null>();
    for (const r of filtered) {
      if (resolved.has(r.sku)) continue;
      const so   = soPriceBySku.get(r.sku);
      const po   = poCostBySku.get(r.sku);
      const ac   = avgCostBySku.get(r.sku);
      const costKnown = ac ?? po ?? null;
      if (so == null && costKnown == null) {
        resolved.set(r.sku, null); // skip
        continue;
      }
      let cost: number, sale: number;
      if (so != null && costKnown != null) {
        cost = costKnown;
        sale = so;
      } else if (so != null) {
        // Have sale, no cost basis → derive cost from margin.
        cost = so * oneMinusM;
        sale = so;
      } else {
        // Have cost, no SO → derive sale from margin.
        cost = costKnown!;
        sale = oneMinusM > 0 ? costKnown! / oneMinusM : costKnown!;
      }
      resolved.set(r.sku, { cost, sale });
    }

    // Qty totals match the stat cards / row aggregates — every
    // filtered SKU contributes regardless of whether it has cost/sale
    // signals. Cost / Sale / Mrgn $ / Mrgn % only sum the resolvable
    // SKUs, with `skipped` counting how many were left out so the
    // cell can render the red * next to those labels.
    let onHandQty  = 0, onHandCost  = 0, onHandSale  = 0,  onHandSkipped  = 0;
    let onOrderQty = 0, onOrderCost = 0, onOrderSale = 0,  onOrderSkipped = 0;
    let onPOQty    = 0, onPOCost    = 0, onPOSale    = 0,  onPOSkipped    = 0;
    for (const r of filtered) {
      onHandQty  += r.onHand  || 0;
      onOrderQty += r.onOrder || 0;
      onPOQty    += r.onPO    || 0;
      const res = resolved.get(r.sku);
      if (!res) {
        if ((r.onHand  || 0) > 0) onHandSkipped++;
        if ((r.onOrder || 0) > 0) onOrderSkipped++;
        if ((r.onPO    || 0) > 0) onPOSkipped++;
        continue;
      }
      onHandCost  += (r.onHand  || 0) * res.cost; onHandSale  += (r.onHand  || 0) * res.sale;
      onOrderCost += (r.onOrder || 0) * res.cost; onOrderSale += (r.onOrder || 0) * res.sale;
      onPOCost    += (r.onPO    || 0) * res.cost; onPOSale    += (r.onPO    || 0) * res.sale;
    }

    const periodQty:     Record<string, number> = {};
    const periodCost:    Record<string, number> = {};
    const periodSale:    Record<string, number> = {};
    const periodSkipped: Record<string, number> = {};
    for (const p of displayPeriods) {
      let q = 0, c = 0, s = 0, skipped = 0;
      for (const r of filtered) {
        let v: number | undefined;
        if (viewMode === "ats") {
          v = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
        } else if (!r.__collapsed && eventIndex) {
          // SO / PO mode — sum event qty whose date falls inside the
          // period bucket [periodStart, endDate], scoped to the row's
          // store. Reads eventIndex directly to keep this memo free of
          // a function-identity dep that would invalidate every render.
          const skuIdx = eventIndex[r.sku];
          if (skuIdx) {
            let sum = 0;
            const rowStore = r.store;
            for (const date of Object.keys(skuIdx)) {
              if (date < p.periodStart || date > p.endDate) continue;
              const list = viewMode === "so" ? skuIdx[date].sos : skuIdx[date].pos;
              for (const e of list) {
                if (rowStore && (e.store ?? "ROF") !== rowStore) continue;
                sum += e.qty || 0;
              }
            }
            v = sum;
          } else {
            v = 0;
          }
        }
        if (v == null) continue;
        q += v;
        const res = resolved.get(r.sku);
        if (!res) { if (v !== 0) skipped++; continue; }
        c += v * res.cost;
        s += v * res.sale;
      }
      periodQty[p.key]     = q;
      periodCost[p.key]    = c;
      periodSale[p.key]    = s;
      periodSkipped[p.key] = skipped;
    }
    return {
      onHand:  { qty: onHandQty,  cost: onHandCost,  sale: onHandSale,  skipped: onHandSkipped  },
      onOrder: { qty: onOrderQty, cost: onOrderCost, sale: onOrderSale, skipped: onOrderSkipped },
      onPO:    { qty: onPOQty,    cost: onPOCost,    sale: onPOSale,    skipped: onPOSkipped    },
      periodQty, periodCost, periodSale, periodSkipped,
    };
  }, [filtered, displayPeriods, atShip, viewMode, eventIndex, generalMarginPct]);

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
        w[meta.key] = meta.fixedPx;
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
        const lines = [
          slot.qty.toLocaleString(),
          fmtUSD(slot.cost),
          fmtUSD(slot.sale),
          fmtUSD(slot.sale - slot.cost),
          slot.sale > 0 ? `${(((slot.sale - slot.cost) / slot.sale) * 100).toFixed(1)}%` : "—",
        ];
        for (const l of lines) {
          if (l.length > maxLen) maxLen = l.length;
        }
      }
      const charPx = meta.charType === "mono" ? MONO_CHAR_PX : TEXT_CHAR_PX;
      w[meta.key] = Math.max(meta.minPx, Math.ceil((maxLen + PAD_CHARS) * charPx));
    }
    return w;
  }, [filtered, showTotalsRow, sums]);

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
    // 4px top/bottom — doubled from the previous 2px tight version.
    // Keeps 10px horizontal padding so columns don't crowd borders.
    padding: "4px 10px",
    background: "#1E293B",
    // Slightly heavier border under the totals row so the divider
    // between totals and column headers stays visible.
    borderBottom: "2px solid #475569",
    fontSize: 12,
    textTransform: "none",
    letterSpacing: 0,
    verticalAlign: "middle",
  };

  // Renders a single totals cell with four stacked lines: Qty / Cost /
  // Sale / Mrgn. Each line is "Label: value". Color matches the
  // column's value accent. Margin % = (sale - cost) / sale × 100.
  type TotalsCellProps = {
    qty: number;
    cost: number;
    sale: number;
    qtyColor: string;
    qtyPrefix?: string; // for "+" on On PO
    skipped: number;    // SKUs ignored due to no SO/avgCost/PO cost
  };
  const TotalsCell: React.FC<TotalsCellProps> = ({ qty, cost, sale, qtyColor, qtyPrefix, skipped }) => {
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
        <span style={labelStyle}>Cost:</span>
        <span style={{ ...valueStyle, color: "#94A3B8", fontWeight: 600, fontSize: 11 }}>{fmtUSD(cost)}</span>
        <span style={labelStyle}>Sale:</span>
        <span style={{ ...valueStyle, color: "#3B82F6", fontWeight: 600, fontSize: 11 }}>{fmtUSD(sale)}</span>
        <Label>Mrgn $:</Label>
        <span style={{ ...valueStyle, color: dollarColor, fontWeight: 600, fontSize: 11 }} title={skipTitle}>
          {sale > 0 ? fmtUSD(marginDollars) : "—"}
        </span>
        <Label>Mrgn:</Label>
        <span style={{ ...valueStyle, color: marginColor, fontWeight: 600, fontSize: 11 }} title={skipTitle}>
          {sale > 0 ? `${margin.toFixed(1)}%` : "—"}
        </span>
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
            {/* Empty placeholders for the four ID columns + Color */}
            {(["category","subCategory","style","description","color"] as const).map(k => {
              if (isHidden(k)) return null;
              const left = colLeftFrom(k, stickyWidths, hidden) ?? 0;
              return <th key={k} style={{ ...totalsThBase, ...S.stickyCol, left, minWidth: stickyWidths[k], zIndex: 4, ...unfreezeStyle(k) }} />;
            })}
            {/* On Hand sum */}
            {!isHidden("onHand") && (
              <th style={{ ...totalsThBase, ...S.stickyCol, left: colLeftFrom("onHand", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onHand, zIndex: 4, ...unfreezeStyle("onHand") }}>
                <TotalsCell qty={sums.onHand.qty} cost={sums.onHand.cost} sale={sums.onHand.sale} skipped={sums.onHand.skipped} qtyColor="#F1F5F9" />
              </th>
            )}
            {/* On Order sum */}
            {!isHidden("onOrder") && (
              <th style={{ ...totalsThBase, ...S.stickyCol, left: colLeftFrom("onOrder", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onOrder, zIndex: 4, ...unfreezeStyle("onOrder") }}>
                <TotalsCell qty={sums.onOrder.qty} cost={sums.onOrder.cost} sale={sums.onOrder.sale} skipped={sums.onOrder.skipped} qtyColor="#F59E0B" />
              </th>
            )}
            {/* On PO sum */}
            {!isHidden("onPO") && (
              <th style={{ ...totalsThBase, ...S.stickyCol, left: colLeftFrom("onPO", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onPO, zIndex: 4, ...unfreezeStyle("onPO") }}>
                <TotalsCell qty={sums.onPO.qty} cost={sums.onPO.cost} sale={sums.onPO.sale} skipped={sums.onPO.skipped} qtyColor="#10B981" qtyPrefix="+" />
              </th>
            )}
            {/* Period sums */}
            {displayPeriods.map(p => {
              const q = sums.periodQty[p.key]     ?? 0;
              const c = sums.periodCost[p.key]    ?? 0;
              const s = sums.periodSale[p.key]    ?? 0;
              const sk = sums.periodSkipped[p.key] ?? 0;
              const isNeg = q < 0;
              const qtyColor = isNeg ? "#F87171" : (q === 0 ? "#475569" : getQtyColor(q));
              return (
                <th
                  key={`tot-${p.key}`}
                  style={{
                    ...totalsThBase,
                    minWidth: rangeUnit === "days" ? 68 : rangeUnit === "weeks" ? 120 : 100,
                    background: p.isToday ? "#1a2a1e" : p.isWeekend ? "#141e2e" : "#1E293B",
                  }}
                >
                  <TotalsCell qty={q} cost={c} sale={s} qtyColor={qtyColor} skipped={sk} />
                </th>
              );
            })}
          </tr>
          )}
          {/* Column headers — pushed below the totals row */}
          <tr>
            {/* Sticky left columns. Hidden columns (operator-toggled
                via the Toolbar's "Columns" dropdown) are dropped here
                and their widths fall out of the cumulative `left`
                offset, so visible siblings shift left to fill the gap. */}
            {STICKY_COL_META.map((c, ci) => {
              if (isHidden(c.key)) return null;
              const left = colLeftFrom(c.key, stickyWidths, hidden) ?? 0;
              const isActive = sortCol === c.key;
              return (
                <th
                  key={c.key}
                  style={{
                    ...S.th, ...S.stickyCol,
                    top: showTotalsRow ? TOTALS_ROW_HEIGHT : 0,
                    left, minWidth: stickyWidths[c.key], zIndex: 3,
                    textAlign: ci >= 5 ? "center" : "left",
                    cursor: "pointer",
                    color: isActive ? "#F1F5F9" : "#6B7280",
                    background: isActive ? "#243048" : "#1E293B",
                    ...unfreezeStyle(c.key),
                  }}
                  onClick={() => handleThClick(c.key)}
                >
                  {c.label}{isActive ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
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
                    top: showTotalsRow ? TOTALS_ROW_HEIGHT : 0,
                    minWidth: rangeUnit === "days" ? 68 : rangeUnit === "weeks" ? 120 : 100,
                    textAlign: "center",
                    background: isActive ? "#243048" : p.isToday ? "#1a2a1e" : p.isWeekend ? "#141e2e" : "#1E293B",
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
                  opacity: isDragging ? 0.45 : 1,
                  outline: isDropTarget ? "2px solid #10B981" : "none",
                  transition: "background 0.1s, opacity 0.1s",
                  cursor: isAggregate ? "default" : "grab",
                  fontWeight: isAggregate ? 600 : 400,
                }}
              >
                {/* Category */}
                {!isHidden("category") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("category", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.category, background: stickyBg, color: "#9CA3AF", fontSize: 12, ...unfreezeStyle("category") }}
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
                <td style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("subCategory", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.subCategory, background: stickyBg, color: "#9CA3AF", fontSize: 12, ...unfreezeStyle("subCategory") }}>
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
                {/* Style — primary identifier; raw SKU on hover for traceability;
                   store badge stays here */}
                {!isHidden("style") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("style", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.style, background: stickyBg, ...unfreezeStyle("style") }}
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
                {/* Description */}
                {!isHidden("description") && (
                <td style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("description", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.description, background: stickyBg, color: isAggregate ? "#94A3B8" : "#D1D5DB", fontSize: 13, fontStyle: isAggregate ? "italic" : "normal", ...unfreezeStyle("description") }}>
                  {row.description}
                </td>
                )}
                {/* Color */}
                {!isHidden("color") && (
                <td style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("color", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.color, background: stickyBg, color: "#D1D5DB", fontSize: 12, ...unfreezeStyle("color") }}>
                  {isAggregate ? "" : (displayColor(row) || "—")}
                </td>
                )}
                {/* On Hand */}
                {!isHidden("onHand") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("onHand", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onHand, background: stickyBg, textAlign: "center", cursor: "context-menu", ...unfreezeStyle("onHand") }}
                  onContextMenu={e => openSummaryCtx(e, "onHand", row)}
                >
                  {renderQty({ qty: row.onHand, mult: row.ppkMult ?? 1, explode: explodePpk, color: "#F1F5F9" })}
                </td>
                )}
                {/* On Order (committed SOs) */}
                {!isHidden("onOrder") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("onOrder", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onOrder, background: stickyBg, textAlign: "center", cursor: row.onOrder > 0 ? "context-menu" : "default", ...unfreezeStyle("onOrder") }}
                  onContextMenu={e => { if (row.onOrder > 0) openSummaryCtx(e, "onOrder", row); }}
                >
                  {renderQty({ qty: row.onOrder, mult: row.ppkMult ?? 1, explode: explodePpk, color: "#F59E0B", zeroDisplay: "—" })}
                </td>
                )}
                {/* On PO (open purchase orders) */}
                {!isHidden("onPO") && (
                <td
                  style={{ ...S.td, ...S.stickyCol, left: colLeftFrom("onPO", stickyWidths, hidden) ?? 0, minWidth: stickyWidths.onPO, background: stickyBg, textAlign: "center", cursor: row.onPO > 0 ? "context-menu" : "default", ...unfreezeStyle("onPO") }}
                  onContextMenu={e => { if (row.onPO > 0) openSummaryCtx(e, "onPO", row); }}
                >
                  {renderQty({ qty: row.onPO, mult: row.ppkMult ?? 1, explode: explodePpk, color: "#10B981", prefix: "+", zeroDisplay: "—" })}
                </td>
                )}
                {/* Period cells */}
                {displayPeriods.map(p => {
                  const ev = eventIndex ? getEventsInPeriod(row.sku, p.periodStart, p.endDate, row.store) : null;
                  const hasPO = (ev?.pos.length ?? 0) > 0;
                  const hasSO = (ev?.sos.length ?? 0) > 0;
                  // viewMode "ats" → running on-hand balance (existing).
                  // "so" / "po" → bucketed event qty for this period.
                  // Aggregate rows skip SO/PO mode (no sku/store to query)
                  // and fall back to undefined → renders as "—".
                  let qty: number | undefined;
                  if (viewMode === "ats") {
                    const fullQty = row.dates[p.endDate];
                    qty = atShip ? (row.freeMap?.[p.endDate] ?? fullQty) : fullQty;
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
                        const display = mult > 1 && !explodePpk ? qty! / mult : qty!;
                        const hint = mult > 1
                          ? (explodePpk
                              ? `PPK${mult} × ${(qty! / mult).toLocaleString()}`
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
