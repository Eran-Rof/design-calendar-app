import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { fmtDate } from "./helpers";
import {
  PALETTE, ROW_HEIGHTS, BORDER_BODY, BORDER_HEADER, EXTRA_THICK,
  headerStyle, bodyTextStyle, bodyStyleStyle, bodyNumStyle,
  autofitColumns, zebraFill, numOrBlank, buildMultiSheetWorkbook,
} from "./exportTheme";
import type { ReportPayload } from "./reportPayload";

// Semantic accents (kept out of the theme — Neg Inven owns the meaning).
const NEG_RED  = "C0392B";
const NEG_BG   = "FDECEA";
const PO_GREEN = "059669";

// Per-period PO arrival qty for one SKU. Walks the eventIndex's
// per-date PO buckets and sums anything whose receive date falls in
// (periodStart, endDate]. Returns 0 when the index has no data for
// the SKU (e.g. row not yet sliced or pre-cache state).
function poQtyInPeriod(
  eventIndex: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null,
  sku: string,
  periodStart: string,
  endDate: string,
): number {
  const skuBuckets = eventIndex?.[sku];
  if (!skuBuckets) return 0;
  let total = 0;
  for (const [date, bucket] of Object.entries(skuBuckets)) {
    if (date >= periodStart && date <= endDate) {
      for (const po of bucket.pos) total += po.qty || 0;
    }
  }
  return total;
}

export function exportNegInven(
  rows: ATSRow[],
  displayPeriods: Array<{ periodStart: string; endDate: string; label: string }>,
  eventIndex: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null = null,
): ReportPayload | null {
  const today = new Date();
  const todayStr = `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`;

  function atsVal(r: ATSRow, p: { endDate: string }): number | null {
    const v = r.freeMap?.[p.endDate] ?? r.dates[p.endDate];
    return v ?? null;
  }

  // ── Step 1: filter rows where any of the first 6 display periods is negative ──
  const filterPeriods = displayPeriods.slice(0, 6);
  const filtered = rows.filter(r =>
    filterPeriods.some(p => { const v = atsVal(r, p); return v !== null && v < 0; })
  );
  if (filtered.length === 0) return null;

  // ── Step 2: per-row pipeline ──────────────────────────────────────────────
  const processed = filtered.map(r => {
    const vals: (number | null)[] = displayPeriods.map(p => {
      const v = atsVal(r, p);
      return v !== null && v >= 0 ? null : v;
    });

    const negs: [number, number][] = [];
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v !== null && v < 0) negs.push([i, v]);
    }
    let keepIdx: number | null = null;
    for (let j = 0; j < negs.length; j++) {
      const [idx, val] = negs[j];
      const subs = negs.slice(j + 1);
      if (subs.length >= 1 && subs.every(([, sv]) => sv === val)) {
        keepIdx = idx;
        break;
      }
    }
    const periodVals: (number | null)[] = vals.map((v, i) =>
      v !== null && v < 0 && i !== keepIdx ? null : v
    );

    return { row: r, periodVals, keepIdx };
  });

  // Drop period columns where no row has surviving data.
  const livePeriodIdxs = displayPeriods
    .map((_, i) => i)
    .filter(i => processed.some(d => d.periodVals[i] !== null));
  const livePeriods = livePeriodIdxs.map(i => displayPeriods[i]);

  // ── Column layout ─────────────────────────────────────────────────────────
  // Same 7-fixed-col + N-period layout as before; no spacer cols (would
  // break the existing 3-row banner merges and add no value at this
  // width). Group separation reads via header tier color + thick group
  // bottom-borders on the column header row.
  const FIXED_COLS = 7;          // SKU / Desc / Cat / Store / On Hand / On Order / On PO
  const TC = FIXED_COLS + livePeriods.length;
  const COL = {
    sku: 0, desc: 1, cat: 2, store: 3,
    onHand: 4, onOrder: 5, onPO: 6,
    firstPeriod: 7,
    lastPeriod: 7 + livePeriods.length - 1,
  };

  const aoa: any[][] = [];

  // ── Title banner row ─────────────────────────────────────────────────────
  const titleStyle: any = {
    font:      { bold: true, sz: 13, color: { rgb: "FFFFFF" }, name: "Calibri" },
    fill:      { fgColor: { rgb: PALETTE.HEADER_DARK }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_HEADER,
  };
  aoa.push([
    { v: `NEG INVENTORY REPORT    ${todayStr}`, t: "s", s: titleStyle },
    ...Array(TC - 1).fill(null).map(() => ({ v: "", t: "s", s: titleStyle })),
  ]);

  // ── Group label row ──────────────────────────────────────────────────────
  // A-D: HEADER_TEXT band (SKU group, no group label needed).
  // E-G: HEADER_ONHAND band labelled "INVENTORY".
  // H+:  HEADER_DARK  band labelled "ATS BY MONTH".
  const groupSku: any = { v: "", t: "s", s: headerStyle(PALETTE.HEADER_TEXT, "center") };
  const groupInvL: any = { v: "INVENTORY",     t: "s", s: headerStyle(PALETTE.HEADER_ONHAND, "center") };
  const groupInvF: any = { v: "",              t: "s", s: headerStyle(PALETTE.HEADER_ONHAND, "center") };
  const groupAtsL: any = { v: "ATS BY MONTH",  t: "s", s: headerStyle(PALETTE.HEADER_DARK,   "center") };
  const groupAtsF: any = { v: "",              t: "s", s: headerStyle(PALETTE.HEADER_DARK,   "center") };
  aoa.push([
    groupSku, groupSku, groupSku, groupSku,
    groupInvL, groupInvF, groupInvF,
    ...(livePeriods.length > 0
      ? [groupAtsL, ...Array(Math.max(0, livePeriods.length - 1)).fill(groupAtsF)]
      : []),
  ]);

  // ── Column header row ────────────────────────────────────────────────────
  const colHdrs = [
    { label: "SKU",           fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Description",   fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Category",      fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Warehouse",         fill: PALETTE.HEADER_TEXT,   align: "center" as const },
    { label: "On Hand",       fill: PALETTE.HEADER_ONHAND, align: "center" as const },
    { label: "On Order (SO)", fill: PALETTE.HEADER_ONHAND, align: "center" as const },
    { label: "On PO",         fill: PALETTE.HEADER_ONHAND, align: "center" as const },
  ];
  aoa.push([
    ...colHdrs.map((h) => ({ v: h.label, t: "s", s: headerStyle(h.fill, h.align) })),
    ...livePeriods.map((p) => ({
      v: p.label.replace(/\n/g, " "),
      t: "s",
      s: headerStyle(PALETTE.HEADER_DARK, "center"),
    })),
  ]);

  const HEADER_ROW_COUNT = 3;
  const poSubRowIndexes: number[] = [];

  // ── Data rows ────────────────────────────────────────────────────────────
  processed.forEach(({ row, periodVals, keepIdx }, ri) => {
    const fill = zebraFill(ri);
    aoa.push([
      { v: row.sku ?? "",         t: "s", s: bodyStyleStyle(fill) },
      { v: row.description ?? "", t: "s", s: bodyTextStyle(fill, "left") },
      { v: row.category ?? "",    t: "s", s: bodyTextStyle(fill, "left") },
      { v: row.store ?? "",       t: "s", s: bodyTextStyle(fill, "center") },
      numOrBlank(row.onHand  ?? 0, bodyNumStyle(PALETTE.QTY_BAND), { numFmt: "#,##0" }),
      numOrBlank(row.onOrder ?? 0, bodyNumStyle(PALETTE.QTY_BAND), { numFmt: "#,##0" }),
      numOrBlank(row.onPO    ?? 0, bodyNumStyle(PALETTE.QTY_BAND), { numFmt: "#,##0" }),
      ...livePeriodIdxs.map((pi) => {
        const val = periodVals[pi];
        const neg = val !== null && val < 0;
        if (neg) {
          return {
            v: val,
            t: "n" as const,
            s: {
              ...bodyNumStyle(NEG_BG),
              font: { bold: true, sz: 11, color: { rgb: NEG_RED }, name: "Calibri" },
              numFmt: "#,##0",
            },
          };
        }
        return {
          v: val ?? "",
          t: val !== null ? "n" as const : "s" as const,
          s: { ...bodyNumStyle(fill), numFmt: "#,##0" },
        };
      }),
    ]);

    // PO sub-row — only emit when at least one live period has incoming
    // supply for this SKU. Green "+N" cells make it instantly readable
    // against the red neg cells above.
    //
    // Scope to months SUBSEQUENT to the qualifying negative period
    // (keepIdx). PO arrivals in/before the neg period are already
    // baked into the displayed ATS value at that period — surfacing
    // them again on the sub-row was double-counting from the
    // operator's POV.
    const poByPeriod = livePeriodIdxs.map((pi) => {
      if (keepIdx === null || pi <= keepIdx) return 0;
      return poQtyInPeriod(eventIndex, row.sku, displayPeriods[pi].periodStart, displayPeriods[pi].endDate);
    });
    if (poByPeriod.some((q) => q > 0)) {
      poSubRowIndexes.push(aoa.length);
      const poLabelStyle: any = {
        ...bodyTextStyle(fill, "right"),
        font: { bold: true, sz: 9, color: { rgb: PO_GREEN }, name: "Calibri" },
      };
      const poQtyStyle: any = {
        ...bodyNumStyle(fill),
        font: { bold: true, sz: 11, color: { rgb: PO_GREEN }, name: "Calibri" },
        // "+#,##0" prefixes positives; ";;" silences zero and negative.
        numFmt: '"+"#,##0;;',
      };
      aoa.push([
        { v: "+ PO", t: "s", s: poLabelStyle },
        ...Array(FIXED_COLS - 1).fill(null).map(() => ({
          v: "", t: "s", s: bodyTextStyle(fill, "left"),
        })),
        ...poByPeriod.map((q) => ({
          v: q > 0 ? q : "",
          t: q > 0 ? "n" as const : "s" as const,
          s: poQtyStyle,
        })),
      ]);
    }
  });

  // ── Merges (title banner + group label spans), in AOA coords ─────────────
  // (buildMultiSheetWorkbook stamps the logo banner on top and offsets these.)
  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: TC - 1 } },              // title
    { s: { r: 1, c: COL.sku },     e: { r: 1, c: COL.store } }, // SKU group span
    { s: { r: 1, c: COL.onHand },  e: { r: 1, c: COL.onPO } },  // INVENTORY span
    ...(livePeriods.length > 1
      ? [{ s: { r: 1, c: COL.firstPeriod }, e: { r: 1, c: COL.lastPeriod } }]
      : []),
  ];

  // ── Outer + group-column outlines (applied to the AOA cells directly) ────
  // Three column groups: A-D (SKU info), E-G (Inventory qty), H+ (ATS
  // periods). Each gets a thick LEFT/RIGHT outline; outer rectangle
  // closes the whole sheet. Each cell is cloned so shared style refs in
  // the group-label row don't bleed borders across columns.
  const GROUPS: [number, number][] = [
    [COL.sku, COL.store],
    [COL.onHand, COL.onPO],
  ];
  if (livePeriods.length > 0) GROUPS.push([COL.firstPeriod, COL.lastPeriod]);

  const LAST_R = aoa.length - 1;
  for (let r = 0; r <= LAST_R; r++) {
    for (let c = 0; c < TC; c++) {
      const cell = aoa[r][c] ?? { v: "", t: "s", s: {} };
      const existing = cell.s?.border ?? { ...BORDER_BODY };
      const border: any = { ...existing };
      // Outer rectangle.
      if (c === 0)      border.left   = EXTRA_THICK;
      if (c === TC - 1) border.right  = EXTRA_THICK;
      if (r === 0)      border.top    = EXTRA_THICK;
      if (r === LAST_R) border.bottom = EXTRA_THICK;
      // Group left/right thick separators (between the three groups).
      for (const [g0, g1] of GROUPS) {
        if (c === g0 && c !== 0) border.left = EXTRA_THICK;
        if (c === g1 && c !== TC - 1) border.right = EXTRA_THICK;
      }
      // Thick bottom under the column header row (visually closes the
      // 3-row header band).
      if (r === HEADER_ROW_COUNT - 1) border.bottom = EXTRA_THICK;
      aoa[r][c] = { ...cell, s: { ...cell.s, border } };
    }
  }

  // ── Col widths + row heights ────────────────────────────────────────────
  // Run autofit so newly-introduced theme padding doesn't truncate
  // existing labels (e.g. "ATS BY MONTH" + period names).
  const headerForFit = aoa[2];          // col-headers row drives most widths
  const bodyForFit = aoa.slice(3);
  const cols = autofitColumns({ headerRow: headerForFit, bodyRows: bodyForFit });

  const rowHeights = [
    { hpt: ROW_HEIGHTS.HEADER },
    { hpt: ROW_HEIGHTS.BODY },
    { hpt: ROW_HEIGHTS.HEADER },
    ...Array(aoa.length - HEADER_ROW_COUNT).fill(null).map((_, i) =>
      poSubRowIndexes.includes(i + HEADER_ROW_COUNT) ? { hpt: ROW_HEIGHTS.PPK } : { hpt: ROW_HEIGHTS.BODY }
    ),
  ];

  const filename = `Neg_Inventory_${fmtDate(today)}.xlsx`;
  const { wb } = buildMultiSheetWorkbook(filename, [{
    sheetName: "Neg Inventory Report",
    allRows: aoa,
    cols,
    rowHeights,
    merges,
    freeze: { xSplit: 0, ySplit: HEADER_ROW_COUNT },
  }]);

  return {
    title: "Negative Inventory",
    aoa,
    wb,
    filename,
  };
}
