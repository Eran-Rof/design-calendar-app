import type { ATSRow } from "./types";
import { fmtDate } from "./helpers";
import {
  INTEREST_RATE, PALLET_PCS, STORAGE_PER_PALLET_MONTH, DEFAULT_LAST_RECEIVED,
  calcAgedCosts, calcAgedDays, parseSku,
} from "./agedInvenMath";
import {
  PALETTE, ROW_HEIGHTS, BORDER_BODY, BORDER_HEADER, EXTRA_THICK,
  headerStyle, bodyTextStyle, bodyNumStyle, bodyStyleStyle,
  subtotalTextStyle, subtotalNumStyle,
  autofitColumns, buildMultiSheetWorkbook, zebraFill, numOrBlank,
} from "./exportTheme";
import type { ReportPayload } from "./reportPayload";

// ── Semantic cost-group colors (operators read the workbook by group) ────
// Kept out of the shared theme — these are domain-specific tier markers,
// not part of the general ATS palette. Each color tags a vertical band
// of related metrics so the eye can jump between cost types quickly.
const GROUP_RATE_INPUT   = "375623"; // green — Rate Input
const GROUP_INTEREST     = "244185"; // blue  — Interest Cost
const GROUP_STORAGE      = "2E75B6"; // teal  — Storage Cost + per-base subtotals
const GROUP_COMBINED     = "843C0C"; // orange — Combined Annual Cost
const GRAND_TOTAL_FILL   = PALETTE.HEADER_DARK; // navy — grand totals + title band
const DETAIL_BANNER_FILL = "404040"; // dark gray — "N+ Days" banner on detail sheets

function semHeader(fill: string, align: "left" | "center" | "right"): any {
  return {
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center", wrapText: true },
    border:    BORDER_HEADER,
  };
}

function grandTotalStyle(num: boolean): any {
  return {
    font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
    fill:      { fgColor: { rgb: GRAND_TOTAL_FILL }, patternType: "solid" },
    alignment: { horizontal: num ? "center" : "left", vertical: "center" },
    border:    BORDER_BODY,
  };
}

function teallSubtotalStyle(num: boolean): any {
  return {
    font:      { bold: true, sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
    fill:      { fgColor: { rgb: GROUP_STORAGE }, patternType: "solid" },
    alignment: { horizontal: num ? "center" : "left", vertical: "center" },
    border:    BORDER_BODY,
  };
}

function fmtMMDDYYYY(iso: string): string {
  // Canonical app-wide date format: MM/DD/YYYY (matches fmtDateDisplay).
  // Name kept for back-compat with existing call sites in this file.
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

export type AgedInvenResult = "empty" | ReportPayload;

export function exportAgedInven(rows: ATSRow[], ageDaysThreshold: number, category = "All"): AgedInvenResult {
  const today    = new Date();
  const todayStr = `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`;

  const categoryLabel = category !== "All" ? ` – ${category}` : "";

  // ── 1. Explode each ATSRow into a colour-level record, filter by age ──
  interface ColorRecord {
    store: string;
    gender: string;
    base: string;
    color: string;
    description: string;
    lastReceivedIso: string;
    aged: number;
    qty: number;
    avgCost: number;
  }

  const exploded: ColorRecord[] = [];
  for (const r of rows) {
    if (!r.onHand || r.onHand <= 0) continue;
    // Match the Category dropdown, which lists master_category values (the
    // item-master-resolved "truth"), NOT the freeform r.category from the
    // raw feed. Comparing against r.category here made every single-category
    // run come back empty because the two fields differ. Fall back to
    // r.category for rows the master didn't resolve.
    if (category !== "All" && (r.master_category ?? r.category) !== category) continue;
    const { base, color } = parseSku(r.sku);

    let lrIso = DEFAULT_LAST_RECEIVED;
    if (r.lastReceiptDate) {
      const mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(r.lastReceiptDate);
      lrIso = mm
        ? `${mm[3]}-${mm[1].padStart(2, "0")}-${mm[2].padStart(2, "0")}`
        : r.lastReceiptDate;
    }

    const aged = calcAgedDays(lrIso, today);
    if (aged < ageDaysThreshold) continue;

    exploded.push({
      store:           r.store ?? "Unknown",
      gender:          r.master_gender ?? r.gender ?? r.category ?? "?",
      base,
      color,
      description:     r.description ?? "",
      lastReceivedIso: lrIso,
      aged,
      qty:             r.onHand,
      avgCost:         r.avgCost ?? 0,
    });
  }

  if (exploded.length === 0) return "empty";

  // ── 2. Aggregate to (store, gender, base, color) level ────────────────
  type GroupKey = string;
  const agg = new Map<GroupKey, { store: string; gender: string; base: string; color: string; description: string; lastReceivedIso: string; aged: number; qty: number; costSum: number }>();

  for (const r of exploded) {
    const key: GroupKey = `${r.store}|||${r.gender}|||${r.base}|||${r.color}`;
    const ex = agg.get(key);
    if (ex) {
      ex.qty     += r.qty;
      ex.costSum += r.qty * r.avgCost;
      if (r.aged > ex.aged) { ex.aged = r.aged; ex.lastReceivedIso = r.lastReceivedIso; }
    } else {
      agg.set(key, {
        store: r.store, gender: r.gender, base: r.base, color: r.color,
        description: r.description, lastReceivedIso: r.lastReceivedIso,
        aged: r.aged, qty: r.qty, costSum: r.qty * r.avgCost,
      });
    }
  }

  const aggRows = Array.from(agg.values()).map((a) => ({
    ...a,
    avgCost: a.qty > 0 ? a.costSum / a.qty : 0,
    ohValue: a.costSum,
  }));

  // ── 3. Group by (store, gender) for summary + detail sheets ──────────
  const storeGenderMap = new Map<string, typeof aggRows>();
  for (const r of aggRows) {
    const k = `${r.store}|||${r.gender}`;
    if (!storeGenderMap.has(k)) storeGenderMap.set(k, []);
    storeGenderMap.get(k)!.push(r);
  }

  // ── 4. Build sheet specs ──────────────────────────────────────────────
  const sheets: Array<Parameters<typeof buildMultiSheetWorkbook>[1][number]> = [];

  // ── Summary sheet ─────────────────────────────────────────────────────
  {
    const TC = 15; // A-O

    const aoa: any[][] = [];

    // Row 0 — Title banner
    const titleStyle = semHeader(GRAND_TOTAL_FILL, "center");
    aoa.push([
      { v: `${ageDaysThreshold}+ Day Aged Inventory${categoryLabel} – Summary by Warehouse & Gender`, t: "s", s: titleStyle },
      ...Array(TC - 1).fill(null).map(() => ({ v: "", t: "s", s: titleStyle })),
    ]);
    // Row 1 — Subtitle
    const subtitleStyle: any = {
      ...semHeader(GRAND_TOTAL_FILL, "left"),
      font: { sz: 11, color: { rgb: "FFFFFF" }, name: "Calibri" },
    };
    aoa.push([
      { v: `As of ${todayStr}  |  Interest: ${(INTEREST_RATE * 100).toFixed(0)}% / 360-Day Year  |  Storage: $${STORAGE_PER_PALLET_MONTH} / Pallet / Month (${PALLET_PCS} pcs/pallet)`, t: "s", s: subtitleStyle },
      ...Array(TC - 1).fill(null).map(() => ({ v: "", t: "s", s: subtitleStyle })),
    ]);
    // Row 2 — empty separator (kept for visual breathing room)
    aoa.push(new Array(TC).fill(null).map(() => ({ v: "", t: "s", s: bodyTextStyle(PALETTE.ZEBRA_ODD) })));

    // Row 3 — group header band (semantic cost-group colors)
    const groupStyleByFill: Record<string, any> = {
      [GROUP_RATE_INPUT]: semHeader(GROUP_RATE_INPUT, "center"),
      [GROUP_INTEREST]:   semHeader(GROUP_INTEREST,   "center"),
      [GROUP_STORAGE]:    semHeader(GROUP_STORAGE,    "center"),
      [GROUP_COMBINED]:   semHeader(GROUP_COMBINED,   "center"),
    };
    const blankNavy = { v: "", t: "s", s: semHeader(GRAND_TOTAL_FILL, "center") };
    aoa.push([
      blankNavy, blankNavy, blankNavy, blankNavy, blankNavy, blankNavy,
      { v: "Rate Input",                                                                       t: "s", s: groupStyleByFill[GROUP_RATE_INPUT] },
      { v: `Interest Cost  (${(INTEREST_RATE * 100).toFixed(0)}% / 360-Day Year)`,             t: "s", s: groupStyleByFill[GROUP_INTEREST] },
      { v: "", t: "s", s: groupStyleByFill[GROUP_INTEREST] },
      { v: "", t: "s", s: groupStyleByFill[GROUP_INTEREST] },
      { v: `Storage Cost  ($${STORAGE_PER_PALLET_MONTH} / Pallet / Month – ${PALLET_PCS} pcs)`, t: "s", s: groupStyleByFill[GROUP_STORAGE] },
      { v: "", t: "s", s: groupStyleByFill[GROUP_STORAGE] },
      { v: "", t: "s", s: groupStyleByFill[GROUP_STORAGE] },
      { v: "Combined Annual Cost",                                                             t: "s", s: groupStyleByFill[GROUP_COMBINED] },
      { v: "", t: "s", s: groupStyleByFill[GROUP_COMBINED] },
    ]);

    // Row 4 — column headers (inherit each col's group color)
    const colHdrs: Array<[string, "left" | "center" | "right", string]> = [
      ["Warehouse",                "left",   PALETTE.HEADER_TEXT],
      ["Gender",               "left",   PALETTE.HEADER_TEXT],
      ["Total Qty\nOn Hand",   "center", PALETTE.HEADER_TEXT],
      ["Avg Unit\nCost",       "center", PALETTE.HEADER_TEXT],
      ["Avg Days\nOld",        "center", PALETTE.HEADER_TEXT],
      ["Total OH\nValue",      "center", PALETTE.HEADER_TEXT],
      ["Interest\nRate",       "center", GROUP_RATE_INPUT],
      ["Daily $",              "center", GROUP_INTEREST],
      ["Monthly $",            "center", GROUP_INTEREST],
      ["Annual $",             "center", GROUP_INTEREST],
      ["Daily $",              "center", GROUP_STORAGE],
      ["Monthly $",            "center", GROUP_STORAGE],
      ["Annual $",             "center", GROUP_STORAGE],
      ["% Cost\nPer Item",     "center", GROUP_COMBINED],
      ["$ Cost\nPer Item",     "center", GROUP_COMBINED],
    ];
    aoa.push(colHdrs.map(([v, al, fill]) => ({ v, t: "s", s: semHeader(fill, al) })));

    // Aggregate per-summary-row values
    const summaryRows = Array.from(storeGenderMap.entries()).map(([k, items]) => {
      const [store, gender] = k.split("|||");
      const totalQty   = items.reduce((s, r) => s + r.qty, 0);
      const totalVal   = items.reduce((s, r) => s + r.ohValue, 0);
      const avgCost    = totalQty > 0 ? totalVal / totalQty : 0;
      const avgAgeDays = totalQty > 0 ? items.reduce((s, r) => s + r.aged * r.qty, 0) / totalQty : 0;
      const costs      = calcAgedCosts(totalQty, totalVal);
      return { store, gender, totalQty, avgCost, avgAgeDays, totalVal, ...costs };
    });

    // Data rows (zebra)
    summaryRows.forEach((row, ri) => {
      const fill = zebraFill(ri);
      const num = (v: number, fmt: string): any => numOrBlank(v, bodyNumStyle(fill), { numFmt: fmt });
      aoa.push([
        { v: row.store,                       t: "s", s: bodyStyleStyle(fill) },
        { v: row.gender,                      t: "s", s: bodyTextStyle(fill, "center") },
        num(row.totalQty,                     "#,##0"),
        num(row.avgCost,                      "#,##0.00"),
        num(Math.round(row.avgAgeDays),       "#,##0"),
        num(row.totalVal,                     "#,##0.00"),
        num(INTEREST_RATE,                    "0%"),
        num(row.intDaily,                     "#,##0.00"),
        num(row.intMonthly,                   "#,##0.00"),
        num(row.intAnnual,                    "#,##0.00"),
        num(row.stoDaily,                     "#,##0.00"),
        num(row.stoMonthly,                   "#,##0.00"),
        num(row.stoAnnual,                    "#,##0.00"),
        num(row.pctCost,                      "0.00%"),
        num(row.dolCost,                      "#,##0.00"),
      ]);
    });

    // Grand total row (Navy)
    {
      const gtQty   = summaryRows.reduce((s, r) => s + r.totalQty,   0);
      const gtVal   = summaryRows.reduce((s, r) => s + r.totalVal,   0);
      const gtIntA  = summaryRows.reduce((s, r) => s + r.intAnnual,  0);
      const gtStoA  = summaryRows.reduce((s, r) => s + r.stoAnnual,  0);
      const gtPct   = gtVal > 0 ? (gtIntA + gtStoA) / gtVal : 0;
      const gtDol   = gtQty > 0 ? (gtIntA + gtStoA) / gtQty : 0;
      const gtN = (v: number, fmt: string): any => numOrBlank(v, grandTotalStyle(true), { numFmt: fmt });
      aoa.push([
        { v: "GRAND TOTAL", t: "s", s: grandTotalStyle(false) },
        { v: "", t: "s", s: grandTotalStyle(false) },
        gtN(gtQty,  "#,##0"),
        { v: "", t: "s", s: grandTotalStyle(false) },
        { v: "", t: "s", s: grandTotalStyle(false) },
        gtN(gtVal,  "#,##0.00"),
        { v: "", t: "s", s: grandTotalStyle(false) },
        gtN(summaryRows.reduce((s, r) => s + r.intDaily,   0), "#,##0.00"),
        gtN(summaryRows.reduce((s, r) => s + r.intMonthly, 0), "#,##0.00"),
        gtN(gtIntA, "#,##0.00"),
        gtN(summaryRows.reduce((s, r) => s + r.stoDaily,   0), "#,##0.00"),
        gtN(summaryRows.reduce((s, r) => s + r.stoMonthly, 0), "#,##0.00"),
        gtN(gtStoA, "#,##0.00"),
        gtN(gtPct,  "0.00%"),
        gtN(gtDol,  "#,##0.00"),
      ]);
    }

    // Outer + group outlines
    const LAST_R = aoa.length - 1;
    // Cost-group column ranges (0-based): A-F core, G rate, H-J interest,
    // K-M storage, N-O combined. Draw thick separators between them.
    const GROUPS: [number, number][] = [[0, 5], [6, 6], [7, 9], [10, 12], [13, 14]];
    for (let r = 0; r <= LAST_R; r++) {
      for (let c = 0; c < TC; c++) {
        const cell = aoa[r]?.[c];
        if (!cell || !cell.s) continue;
        const border: any = { ...(cell.s.border ?? BORDER_BODY) };
        if (c === 0)       border.left   = EXTRA_THICK;
        if (c === TC - 1)  border.right  = EXTRA_THICK;
        if (r === 0)       border.top    = EXTRA_THICK;
        if (r === LAST_R)  border.bottom = EXTRA_THICK;
        for (const [g0, g1] of GROUPS) {
          if (c === g0 && c !== 0)        border.left  = EXTRA_THICK;
          if (c === g1 && c !== TC - 1)   border.right = EXTRA_THICK;
        }
        // Close the header band with a thick bottom under row 4
        // (col header row), so the data block reads as a separate
        // section under it.
        if (r === 4) border.bottom = EXTRA_THICK;
        cell.s = { ...cell.s, border };
      }
    }

    const merges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: TC - 1 } },  // title
      { s: { r: 1, c: 0 }, e: { r: 1, c: TC - 1 } },  // subtitle
      { s: { r: 3, c: 7 }, e: { r: 3, c: 9 } },       // Interest group
      { s: { r: 3, c: 10}, e: { r: 3, c: 12 } },      // Storage group
      { s: { r: 3, c: 13}, e: { r: 3, c: 14 } },      // Combined group
    ];

    const headerForFit = aoa[4]; // col header row
    const bodyForFit = aoa.slice(5);
    const cols = autofitColumns({ headerRow: headerForFit, bodyRows: bodyForFit });

    const rowHeights = [
      { hpt: ROW_HEIGHTS.HEADER + 4 }, // title — a touch taller
      { hpt: ROW_HEIGHTS.HEADER },      // subtitle
      { hpt: 8 },                       // separator
      { hpt: ROW_HEIGHTS.HEADER + 6 }, // group band — fits the longer "Interest Cost (...)" label
      { hpt: ROW_HEIGHTS.HEADER + 14 },// col headers — taller for wrapped text
      ...Array(summaryRows.length + 1).fill({ hpt: ROW_HEIGHTS.BODY + 1 }),
    ];

    sheets.push({
      sheetName: "Summary",
      allRows: aoa,
      cols,
      rowHeights,
      merges,
      freeze: { xSplit: 0, ySplit: 5 },
    });
  }

  // ── Detail sheets (one per store+gender) ─────────────────────────────
  for (const [sgKey, items] of storeGenderMap.entries()) {
    const [store, gender] = sgKey.split("|||");

    const sorted = [...items].sort((a, b) =>
      a.base.localeCompare(b.base) || a.color.localeCompare(b.color),
    );

    const byBase = new Map<string, typeof sorted>();
    for (const r of sorted) {
      if (!byBase.has(r.base)) byBase.set(r.base, []);
      byBase.get(r.base)!.push(r);
    }

    const TC = 11;
    const aoa: any[][] = [];

    const colHdrLabels: Array<[string, "left" | "center" | "right"]> = [
      ["Gender",              "center"],
      ["Warehouse",               "left"],
      ["Base Part Number",    "left"],
      ["Color",               "center"],
      ["Description",         "left"],
      ["Date",                "center"],
      ["Last Received Date",  "center"],
      ["Aged Days",           "center"],
      ["Total Sum of\nOn Hand", "center"],
      ["Total Sum of\nAvg Cost","center"],
      ["OH $ Value",          "center"],
    ];

    // Row 0 — column headers
    aoa.push(colHdrLabels.map(([v, al]) => ({
      v, t: "s", s: semHeader(PALETTE.HEADER_TEXT, al),
    })));

    // Row 1 — age banner (merged)
    const bannerStyle: any = {
      font:      { bold: true, sz: 12, color: { rgb: "FFFFFF" }, name: "Calibri" },
      fill:      { fgColor: { rgb: DETAIL_BANNER_FILL }, patternType: "solid" },
      alignment: { horizontal: "center", vertical: "center" },
      border:    BORDER_HEADER,
    };
    aoa.push([
      { v: `--- ${ageDaysThreshold}+ Days Since Last Received ---`, t: "s", s: bannerStyle },
      ...Array(TC - 1).fill(null).map(() => ({ v: "", t: "s", s: bannerStyle })),
    ]);

    // Data + per-base subtotals
    let globalQty = 0, globalVal = 0;
    let rowIdx = 2;

    for (const [base, baseItems] of byBase.entries()) {
      const baseDesc = baseItems[0].description;
      let baseQty = 0, baseVal = 0;

      for (const r of baseItems) {
        const val = r.ohValue;
        baseQty += r.qty;
        baseVal += val;
        const fill = zebraFill(rowIdx);
        const num = (v: number, fmt: string): any => numOrBlank(v, bodyNumStyle(fill), { numFmt: fmt });
        aoa.push([
          { v: gender,                      t: "s", s: bodyTextStyle(fill, "center") },
          { v: store,                       t: "s", s: bodyTextStyle(fill, "left") },
          { v: base,                        t: "s", s: bodyStyleStyle(fill) },
          { v: r.color,                     t: "s", s: bodyTextStyle(fill, "left") },
          { v: baseDesc,                    t: "s", s: bodyTextStyle(fill, "left") },
          { v: todayStr,                    t: "s", s: bodyTextStyle(fill, "center") },
          { v: fmtMMDDYYYY(r.lastReceivedIso), t: "s", s: bodyTextStyle(fill, "center") },
          num(r.aged,                       "#,##0"),
          num(r.qty,                        "#,##0"),
          num(r.avgCost,                    "#,##0.00"),
          num(val,                          "#,##0.00"),
        ]);
        rowIdx++;
      }

      // Subtotal row — teal band (semantic, matches Storage Cost group color)
      const stN = (v: number, fmt: string): any => numOrBlank(v, teallSubtotalStyle(true), { numFmt: fmt });
      aoa.push([
        { v: `Subtotal: ${base}`, t: "s", s: teallSubtotalStyle(false) },
        ...Array(7).fill(null).map(() => ({ v: "", t: "s", s: teallSubtotalStyle(false) })),
        stN(baseQty, "#,##0"),
        { v: "", t: "s", s: teallSubtotalStyle(false) },
        stN(baseVal, "#,##0.00"),
      ]);
      rowIdx++;

      globalQty += baseQty;
      globalVal += baseVal;
    }

    // Grand total row (Navy)
    const gtN = (v: number, fmt: string): any => numOrBlank(v, grandTotalStyle(true), { numFmt: fmt });
    aoa.push([
      { v: "GRAND TOTAL", t: "s", s: grandTotalStyle(false) },
      ...Array(7).fill(null).map(() => ({ v: "", t: "s", s: grandTotalStyle(false) })),
      gtN(globalQty, "#,##0"),
      { v: "", t: "s", s: grandTotalStyle(false) },
      gtN(globalVal, "#,##0.00"),
    ]);

    // Outer rectangle + thick bottom under the col header row (row 0)
    // and the banner row (row 1).
    const LAST_R = aoa.length - 1;
    for (let r = 0; r <= LAST_R; r++) {
      for (let c = 0; c < TC; c++) {
        const cell = aoa[r]?.[c];
        if (!cell || !cell.s) continue;
        const border: any = { ...(cell.s.border ?? BORDER_BODY) };
        if (c === 0)       border.left   = EXTRA_THICK;
        if (c === TC - 1)  border.right  = EXTRA_THICK;
        if (r === 0)       border.top    = EXTRA_THICK;
        if (r === LAST_R)  border.bottom = EXTRA_THICK;
        if (r === 1)       border.bottom = EXTRA_THICK; // close banner
        cell.s = { ...cell.s, border };
      }
    }

    const merges = [{ s: { r: 1, c: 0 }, e: { r: 1, c: TC - 1 } }];

    const headerForFit = aoa[0];
    const bodyForFit = aoa.slice(2);
    const cols = autofitColumns({ headerRow: headerForFit, bodyRows: bodyForFit });

    const rowHeights: Array<{ hpt: number }> = [
      { hpt: ROW_HEIGHTS.HEADER + 14 }, // col headers — wrapped text
      { hpt: ROW_HEIGHTS.HEADER },      // banner
      ...Array(aoa.length - 2).fill({ hpt: ROW_HEIGHTS.BODY }),
    ];

    sheets.push({
      sheetName: `${store} - ${gender}`,
      allRows: aoa,
      cols,
      rowHeights,
      merges,
      freeze: { xSplit: 0, ySplit: 2 },
    });
  }

  const catSlug = category !== "All" ? `_${category.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
  const filename = `Aged_Inventory_${ageDaysThreshold}days${catSlug}_${fmtDate(today)}.xlsx`;
  const { wb } = buildMultiSheetWorkbook(filename, sheets);

  // Preview AOA = the Summary tab (first sheet). The downloaded
  // workbook still includes every detail-store/gender tab unchanged;
  // operators preview the at-a-glance summary, then click Download to
  // get the full multi-sheet workbook.
  return {
    title: `Aged Inventory (${ageDaysThreshold}+ Days)`,
    aoa: sheets[0].allRows,
    wb,
    filename,
  };
}
