import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate } from "./helpers";

// ── Palette (matches target file) ─────────────────────────────────────────────
const DARK_NAVY  = "0D2F4F";   // title row
const NAVY       = "1F4E79";   // header rows, grand total
const DARK_GRAY  = "404040";   // "--- N+ Days ---" banner
const EVEN_ROW   = "DCE6F1";   // summary even row / detail data row
const WHITE      = "FFFFFF";
const GREEN_HDR  = "375623";   // Rate Input group
const BLUE_HDR   = "244185";   // Interest Cost group
const TEAL_HDR   = "2E75B6";   // Storage Cost group + subtotals
const ORANGE_HDR = "843C0C";   // Combined Annual Cost group
const GRY_BRD    = "B8C4D0";

const fl  = (rgb: string) => ({ patternType: "solid" as const, fgColor: { rgb } });
const ft  = (bold: boolean, sz: number, rgb: string) =>
  ({ bold, sz, name: "Arial", color: { rgb } });
const al  = (h: "left"|"center"|"right") => ({ horizontal: h, vertical: "center" as const, wrapText: true });
const MED = (rgb: string) => ({ style: "medium" as const, color: { rgb } });
const THN = (rgb: string) => ({ style: "thin"   as const, color: { rgb } });

const DEFAULT_LAST_RECEIVED = "2024-09-30";
const INTEREST_RATE = 0.09;
const PALLET_PCS    = 864;
const STORAGE_PER_PALLET_MONTH = 20;

// ── Parse SKU into base part + color (strip size) ─────────────────────────────
function parseSku(sku: string): { base: string; color: string } {
  const parts = sku.split("-");
  if (parts.length < 2) return { base: sku, color: "" };
  const sizeIdx = parts.slice(1).findIndex(p => p.includes("("));
  let colorParts: string[];
  if (sizeIdx !== -1) {
    colorParts = parts.slice(1, sizeIdx + 1);
  } else if (parts.length >= 3) {
    colorParts = parts.slice(1, -1);
  } else {
    colorParts = parts.slice(1);
  }
  return { base: parts[0], color: colorParts.join("-") };
}

// ── Compute aged days from lastReceiptDate (or fallback) ──────────────────────
function agedDays(lastReceived: string | undefined, today: Date): number {
  const src = lastReceived || DEFAULT_LAST_RECEIVED;
  // normalise to YYYY-MM-DD if it came in as MM/DD/YYYY
  let iso = src;
  const mmddyyyy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(src);
  if (mmddyyyy) iso = `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2,"0")}-${mmddyyyy[2].padStart(2,"0")}`;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return 0;
  return Math.floor((today.getTime() - d.getTime()) / 86400000);
}

function fmtMMDDYYYY(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;
}

// ── Main export ───────────────────────────────────────────────────────────────
export function exportAgedInven(rows: ATSRow[], ageDaysThreshold: number) {
  const today     = new Date();
  const todayStr  = `${String(today.getMonth()+1).padStart(2,"0")}/${String(today.getDate()).padStart(2,"0")}/${today.getFullYear()}`;
  const todayIso  = fmtDate(today);

  // ── 1. Explode each ATSRow into a colour-level record, filter by age ────────
  interface Record {
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

  const exploded: Record[] = [];
  for (const r of rows) {
    if (!r.onHand || r.onHand <= 0) continue;
    const { base, color } = parseSku(r.sku);

    // normalise lastReceiptDate to ISO
    let lrIso = DEFAULT_LAST_RECEIVED;
    if (r.lastReceiptDate) {
      const mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(r.lastReceiptDate);
      lrIso = mm
        ? `${mm[3]}-${mm[1].padStart(2,"0")}-${mm[2].padStart(2,"0")}`
        : r.lastReceiptDate;
    }

    const aged = agedDays(lrIso, today);
    if (aged < ageDaysThreshold) continue;

    exploded.push({
      store:           r.store ?? "Unknown",
      gender:          r.category ?? "?",
      base,
      color,
      description:     r.description ?? "",
      lastReceivedIso: lrIso,
      aged,
      qty:             r.onHand,
      avgCost:         r.avgCost ?? 0,
    });
  }

  if (exploded.length === 0) return;

  // ── 2. Aggregate to (store, gender, base, color) level ────────────────────
  type GroupKey = string;
  const agg = new Map<GroupKey, { store:string; gender:string; base:string; color:string; description:string; lastReceivedIso:string; aged:number; qty:number; costSum:number }>();

  for (const r of exploded) {
    const key: GroupKey = `${r.store}|||${r.gender}|||${r.base}|||${r.color}`;
    const ex = agg.get(key);
    if (ex) {
      ex.qty     += r.qty;
      ex.costSum += r.qty * r.avgCost;
      if (r.aged > ex.aged) { ex.aged = r.aged; ex.lastReceivedIso = r.lastReceivedIso; }
    } else {
      agg.set(key, { store: r.store, gender: r.gender, base: r.base, color: r.color,
        description: r.description, lastReceivedIso: r.lastReceivedIso,
        aged: r.aged, qty: r.qty, costSum: r.qty * r.avgCost });
    }
  }

  const aggRows = Array.from(agg.values()).map(a => ({
    ...a,
    avgCost: a.qty > 0 ? a.costSum / a.qty : 0,
    ohValue: a.costSum,
  }));

  // ── 3. Group by (store, gender) for summary + detail sheets ───────────────
  const storeGenderMap = new Map<string, typeof aggRows>();
  for (const r of aggRows) {
    const k = `${r.store}|||${r.gender}`;
    if (!storeGenderMap.has(k)) storeGenderMap.set(k, []);
    storeGenderMap.get(k)!.push(r);
  }

  // ── 4. Build workbook ──────────────────────────────────────────────────────
  const wb = XLSXStyle.utils.book_new();

  // ── Summary sheet ──────────────────────────────────────────────────────────
  {
    type Cell = { v: any; t: "s"|"n"|"b"; s?: any };
    const aoa: Cell[][] = [];

    const TC = 15; // A-O
    const hdrBase = { font: ft(true, 10, WHITE), alignment: al("center") };

    // Row 1 — Title
    aoa.push([
      { v: `${ageDaysThreshold}+ Day Aged Inventory – Summary by Store & Gender`, t: "s",
        s: { font: ft(true, 13, WHITE), fill: fl(DARK_NAVY), alignment: al("center") } },
      ...Array(TC-1).fill({ v: "", t: "s", s: { fill: fl(DARK_NAVY) } }),
    ]);
    // Row 2 — Subtitle
    aoa.push([
      { v: `As of ${todayStr}  |  Interest: ${(INTEREST_RATE*100).toFixed(0)}% / 360-Day Year  |  Storage: $${STORAGE_PER_PALLET_MONTH} / Pallet / Month (${PALLET_PCS} pcs/pallet)`, t: "s",
        s: { font: ft(false, 10, WHITE), fill: fl(DARK_NAVY), alignment: al("left") } },
      ...Array(TC-1).fill({ v: "", t: "s", s: { fill: fl(DARK_NAVY) } }),
    ]);
    // Row 3 — empty
    aoa.push(Array(TC).fill({ v: "", t: "s", s: {} }));

    // Row 4 — group headers (A-F empty dark-navy, G rate, H-J interest, K-M storage, N-O combined)
    const grp4: Cell[] = [
      ...Array(6).fill({ v: "", t: "s", s: { fill: fl(DARK_NAVY) } }),
      { v: "Rate Input",                                          t: "s", s: { ...hdrBase, fill: fl(GREEN_HDR) } },
      { v: `Interest Cost  (${(INTEREST_RATE*100).toFixed(0)}% / 360-Day Year)`, t: "s", s: { ...hdrBase, fill: fl(BLUE_HDR) } },
      { v: "", t: "s", s: { fill: fl(BLUE_HDR) } },
      { v: "", t: "s", s: { fill: fl(BLUE_HDR) } },
      { v: `Storage Cost  ($${STORAGE_PER_PALLET_MONTH} / Pallet / Month – ${PALLET_PCS} pcs)`, t: "s", s: { ...hdrBase, fill: fl(TEAL_HDR) } },
      { v: "", t: "s", s: { fill: fl(TEAL_HDR) } },
      { v: "", t: "s", s: { fill: fl(TEAL_HDR) } },
      { v: "Combined Annual Cost", t: "s", s: { ...hdrBase, fill: fl(ORANGE_HDR) } },
      { v: "", t: "s", s: { fill: fl(ORANGE_HDR) } },
    ];
    aoa.push(grp4);

    // Row 5 — column headers
    const colHdrs = [
      ["Store","A"],["Gender","A"],["Total Qty\nOn Hand","R"],["Avg Unit\nCost","R"],
      ["Avg Days\nOld","R"],["Total OH\nValue","R"],["Interest\nRate","C"],
      ["Daily $","R"],["Monthly $","R"],["Annual $","R"],
      ["Daily $","R"],["Monthly $","R"],["Annual $","R"],
      ["% Cost\nPer Item","R"],["$ Cost\nPer Item","R"],
    ] as [string, "A"|"R"|"C"][];
    const hdrFills = [NAVY,NAVY,NAVY,NAVY,NAVY,NAVY,GREEN_HDR,BLUE_HDR,BLUE_HDR,BLUE_HDR,TEAL_HDR,TEAL_HDR,TEAL_HDR,ORANGE_HDR,ORANGE_HDR];
    aoa.push(colHdrs.map(([v, ha], i) => ({
      v, t: "s" as const,
      s: { font: ft(true, 10, WHITE), fill: fl(hdrFills[i]),
           alignment: { horizontal: ha === "A" ? "left" : ha === "R" ? "right" : "center", vertical: "center", wrapText: true },
           border: { bottom: MED(WHITE) } },
    })));

    // Data rows
    const summaryRows = Array.from(storeGenderMap.entries()).map(([k, items]) => {
      const [store, gender] = k.split("|||");
      const totalQty   = items.reduce((s, r) => s + r.qty, 0);
      const totalVal   = items.reduce((s, r) => s + r.ohValue, 0);
      const avgCost    = totalQty > 0 ? totalVal / totalQty : 0;
      const avgAgeDays = totalQty > 0 ? items.reduce((s, r) => s + r.aged * r.qty, 0) / totalQty : 0;
      const intDaily   = totalVal * INTEREST_RATE / 360;
      const intMonthly = totalVal * INTEREST_RATE / 12;
      const intAnnual  = totalVal * INTEREST_RATE;
      const stoDaily   = totalQty / PALLET_PCS * STORAGE_PER_PALLET_MONTH / 30;
      const stoMonthly = totalQty / PALLET_PCS * STORAGE_PER_PALLET_MONTH;
      const stoAnnual  = totalQty / PALLET_PCS * STORAGE_PER_PALLET_MONTH * 12;
      const pctCost    = totalVal > 0 ? (intAnnual + stoAnnual) / totalVal : 0;
      const dolCost    = totalQty > 0 ? (intAnnual + stoAnnual) / totalQty : 0;
      return { store, gender, totalQty, avgCost, avgAgeDays, totalVal,
               intDaily, intMonthly, intAnnual, stoDaily, stoMonthly, stoAnnual, pctCost, dolCost };
    });

    summaryRows.forEach((row, ri) => {
      const bg = ri % 2 === 0 ? EVEN_ROW : WHITE;
      const nFmt = (v: number, fmt: string, bold = false) => ({
        v, t: "n" as const,
        s: { font: ft(bold, 10, "000000"), fill: fl(bg),
             alignment: al("right"), numFmt: fmt },
      });
      const sFmt = (v: string, ha: "left"|"center"|"right" = "left") => ({
        v, t: "s" as const,
        s: { font: ft(false, 10, "000000"), fill: fl(bg), alignment: al(ha) },
      });
      aoa.push([
        sFmt(row.store),
        sFmt(row.gender, "center"),
        nFmt(row.totalQty,   "#,##0"),
        nFmt(row.avgCost,    "#,##0.00"),
        nFmt(Math.round(row.avgAgeDays), "#,##0"),
        nFmt(row.totalVal,   "#,##0.00"),
        nFmt(INTEREST_RATE,  "0%"),
        nFmt(row.intDaily,   "#,##0.00"),
        nFmt(row.intMonthly, "#,##0.00"),
        nFmt(row.intAnnual,  "#,##0.00"),
        nFmt(row.stoDaily,   "#,##0.00"),
        nFmt(row.stoMonthly, "#,##0.00"),
        nFmt(row.stoAnnual,  "#,##0.00"),
        nFmt(row.pctCost,    "0.00%"),
        nFmt(row.dolCost,    "#,##0.00"),
      ]);
    });

    // Grand total row
    {
      const gtQty  = summaryRows.reduce((s,r) => s + r.totalQty,   0);
      const gtVal  = summaryRows.reduce((s,r) => s + r.totalVal,   0);
      const gtIntA = summaryRows.reduce((s,r) => s + r.intAnnual,  0);
      const gtStoA = summaryRows.reduce((s,r) => s + r.stoAnnual,  0);
      const gtPct  = gtVal  > 0 ? (gtIntA + gtStoA) / gtVal  : 0;
      const gtDol  = gtQty  > 0 ? (gtIntA + gtStoA) / gtQty  : 0;
      const gtFmt = (v: number, fmt: string) => ({
        v, t: "n" as const,
        s: { font: ft(true, 10, WHITE), fill: fl(NAVY), alignment: al("right"), numFmt: fmt },
      });
      aoa.push([
        { v: "GRAND TOTAL", t: "s", s: { font: ft(true, 10, WHITE), fill: fl(NAVY), alignment: al("left") } },
        { v: "", t: "s", s: { fill: fl(NAVY) } },
        gtFmt(gtQty,  "#,##0"),
        { v: "", t: "s", s: { fill: fl(NAVY) } },
        { v: "", t: "s", s: { fill: fl(NAVY) } },
        gtFmt(gtVal,  "#,##0.00"),
        { v: "", t: "s", s: { fill: fl(NAVY) } },
        gtFmt(summaryRows.reduce((s,r) => s + r.intDaily,   0), "#,##0.00"),
        gtFmt(summaryRows.reduce((s,r) => s + r.intMonthly, 0), "#,##0.00"),
        gtFmt(gtIntA, "#,##0.00"),
        gtFmt(summaryRows.reduce((s,r) => s + r.stoDaily,   0), "#,##0.00"),
        gtFmt(summaryRows.reduce((s,r) => s + r.stoMonthly, 0), "#,##0.00"),
        gtFmt(gtStoA, "#,##0.00"),
        gtFmt(gtPct,  "0.00%"),
        gtFmt(gtDol,  "#,##0.00"),
      ]);
    }

    const ws: any = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

    // Merges
    ws["!merges"] = [
      { s: { r:0, c:0 }, e: { r:0, c:TC-1 } },          // title
      { s: { r:1, c:0 }, e: { r:1, c:TC-1 } },           // subtitle
      { s: { r:3, c:7 }, e: { r:3, c:9  } },             // Interest group
      { s: { r:3, c:10}, e: { r:3, c:12 } },             // Storage group
      { s: { r:3, c:13}, e: { r:3, c:14 } },             // Combined
    ];

    // Col widths
    ws["!cols"] = [20,8,13,12,10,14,9,12,12,14,12,12,14,12,13].map(wch => ({ wch }));
    // Row heights
    ws["!rows"] = [
      { hpt: 26 }, { hpt: 20 }, { hpt: 14 }, { hpt: 28 }, { hpt: 36 },
      ...Array(summaryRows.length + 1).fill({ hpt: 16 }),
    ];
    ws["!freeze"] = { xSplit: 0, ySplit: 5 };

    // Thin borders on data rows (rows 5 to last)
    const dataStart = 5;
    const dataEnd   = 5 + summaryRows.length;
    for (let r = dataStart; r <= dataEnd; r++) {
      for (let c = 0; c < TC; c++) {
        const addr = XLSXStyle.utils.encode_cell({ r, c });
        if (!ws[addr]) ws[addr] = { v: "", t: "s", s: {} };
        const cell = ws[addr];
        cell.s = { ...(cell.s ?? {}),
          border: {
            top:    THN(GRY_BRD), bottom: THN(GRY_BRD),
            left:   THN(GRY_BRD), right:  THN(GRY_BRD),
          },
        };
      }
    }

    XLSXStyle.utils.book_append_sheet(wb, ws, "Summary");
  }

  // ── Detail sheets (one per store+gender) ──────────────────────────────────
  for (const [sgKey, items] of storeGenderMap.entries()) {
    const [store, gender] = sgKey.split("|||");

    // Sort by base part number then color
    const sorted = [...items].sort((a, b) =>
      a.base.localeCompare(b.base) || a.color.localeCompare(b.color)
    );

    // Group by base part
    const byBase = new Map<string, typeof sorted>();
    for (const r of sorted) {
      if (!byBase.has(r.base)) byBase.set(r.base, []);
      byBase.get(r.base)!.push(r);
    }

    type DCell = { v: any; t: "s"|"n"; s: any };
    const aoa: DCell[][] = [];
    const TC = 11;

    const colHdrs = ["Gender","Store","Base Part Number","Color","Description",
                     "Date","Last Received Date","Aged Days",
                     "Total Sum of\nOn Hand","Total Sum of\nAvg Cost","OH $ Value"];

    // Row 1 — column headers
    aoa.push(colHdrs.map((v, i) => ({
      v, t: "s" as const,
      s: { font: ft(true, 10, WHITE), fill: fl(NAVY),
           alignment: { horizontal: i < 2 ? "left" : "center", vertical: "center", wrapText: true },
           border: { bottom: MED(WHITE) } },
    })));

    // Row 2 — age banner (merged)
    aoa.push([
      { v: `--- ${ageDaysThreshold}+ Days Since Last Received ---`, t: "s",
        s: { font: ft(true, 11, WHITE), fill: fl(DARK_GRAY), alignment: al("center") } },
      ...Array(TC-1).fill({ v: "", t: "s", s: { fill: fl(DARK_GRAY) } }),
    ]);

    // Data + subtotals
    let globalQty = 0, globalVal = 0;
    let rowIdx = 2; // 0-based, rows 0 and 1 already pushed

    for (const [base, baseItems] of byBase.entries()) {
      const baseDesc = baseItems[0].description;
      let baseQty = 0, baseVal = 0;

      for (const r of baseItems) {
        const val = r.ohValue;
        baseQty += r.qty;
        baseVal += val;
        const bg = rowIdx % 2 === 0 ? "F2F9FF" : WHITE;
        const cell = (v: any, t: "s"|"n", ha: "left"|"center"|"right", fmt?: string) => ({
          v, t,
          s: { font: ft(false, 10, "000000"), fill: fl(bg),
               alignment: { horizontal: ha, vertical: "center" as const, wrapText: false },
               numFmt: fmt ?? "" },
        });
        aoa.push([
          cell(gender,                      "s", "center"),
          cell(store,                       "s", "left"),
          cell(base,                        "s", "left"),
          cell(r.color,                     "s", "left"),
          cell(baseDesc,                    "s", "left"),
          cell(todayStr,                    "s", "center"),
          cell(fmtMMDDYYYY(r.lastReceivedIso), "s", "center"),
          cell(r.aged,                      "n", "right", "#,##0"),
          cell(r.qty,                       "n", "right", "#,##0"),
          cell(r.avgCost,                   "n", "right", "#,##0.00"),
          cell(val,                         "n", "right", "#,##0.00"),
        ]);
        rowIdx++;
      }

      // Subtotal row
      const stCell = (v: any, t: "s"|"n", ha: "left"|"center"|"right", fmt?: string) => ({
        v, t,
        s: { font: ft(true, 10, WHITE), fill: fl(TEAL_HDR),
             alignment: { horizontal: ha, vertical: "center" as const, wrapText: false },
             numFmt: fmt ?? "" },
      });
      aoa.push([
        stCell(`Subtotal: ${base}`, "s", "left"),
        stCell("", "s", "left"),
        stCell("", "s", "left"),
        stCell("", "s", "left"),
        stCell("", "s", "left"),
        stCell("", "s", "left"),
        stCell("", "s", "left"),
        stCell("", "s", "left"),
        stCell(baseQty, "n", "right", "#,##0"),
        stCell("", "s", "left"),
        stCell(baseVal, "n", "right", "#,##0.00"),
      ]);
      rowIdx++;

      // Empty spacer
      aoa.push(Array(TC).fill({ v: "", t: "s" as const, s: { fill: fl(WHITE) } }));
      rowIdx++;

      globalQty += baseQty;
      globalVal += baseVal;
    }

    // Grand total row
    const gtCell = (v: any, t: "s"|"n", ha: "left"|"center"|"right", fmt?: string) => ({
      v, t,
      s: { font: ft(true, 10, WHITE), fill: fl(NAVY),
           alignment: { horizontal: ha, vertical: "center" as const, wrapText: false },
           numFmt: fmt ?? "" },
    });
    aoa.push([
      gtCell("GRAND TOTAL", "s", "left"),
      gtCell("", "s", "left"),
      gtCell("", "s", "left"),
      gtCell("", "s", "left"),
      gtCell("", "s", "left"),
      gtCell("", "s", "left"),
      gtCell("", "s", "left"),
      gtCell("", "s", "left"),
      gtCell(globalQty, "n", "right", "#,##0"),
      gtCell("", "s", "left"),
      gtCell(globalVal, "n", "right", "#,##0.00"),
    ]);

    const ws: any = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

    ws["!merges"] = [{ s: { r:1, c:0 }, e: { r:1, c:TC-1 } }]; // age banner

    ws["!cols"] = [10,14,16,20,22,12,18,10,20,22,14].map(wch => ({ wch }));
    ws["!rows"] = [{ hpt: 26 }, { hpt: 20 }, ...Array(aoa.length - 2).fill({ hpt: 15 })];
    ws["!freeze"] = { xSplit: 0, ySplit: 2 };

    // Safe sheet name: max 31 chars, no invalid chars
    const sheetName = `${store} - ${gender}`.replace(/[\\/*?:[\]]/g, "-").slice(0, 31);
    XLSXStyle.utils.book_append_sheet(wb, ws, sheetName);
  }

  // ── Write & download ───────────────────────────────────────────────────────
  const buf  = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `Aged_Inventory_${ageDaysThreshold}days_${fmtDate(today)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
