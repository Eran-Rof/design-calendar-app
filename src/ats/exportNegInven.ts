import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate } from "./helpers";

// ── Palette ───────────────────────────────────────────────────────────────────
const NAVY    = "1F3864";
const SLATE   = "2E4A7A";
const TEAL    = "1D6B74";
const LGRAY   = "F2F4F7";
const WHITE   = "FFFFFF";
const SKU_COL = "1F3864";
const MUTED   = "5F5E5A";
const NEG_RED = "C0392B";
const NEG_BG  = "FDECEA";
const GRY_BRD = "D9DCE3";

const fl = (rgb: string) => ({ patternType: "solid" as const, fgColor: { rgb } });
const ft = (bold: boolean, sz: number, rgb: string) =>
  ({ bold, sz, name: "Arial", color: { rgb } });
const MED  = (rgb: string) => ({ style: "medium" as const, color: { rgb } });
const THIN = (rgb: string) => ({ style: "thin"   as const, color: { rgb } });

export function exportNegInven(
  rows: ATSRow[],
  displayPeriods: Array<{ endDate: string; label: string }>,
  atShip: boolean,
) {
  const today = new Date();
  const todayStr = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

  // Helper: get the effective ATS value for a row+period
  function atsVal(r: ATSRow, p: { endDate: string }): number | null {
    const v = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
    return v ?? null;
  }

  // ── Step 1: Filter rows where any of the first 6 display periods is negative ──
  const filterPeriods = displayPeriods.slice(0, 6);
  const filtered = rows.filter(r =>
    filterPeriods.some(p => { const v = atsVal(r, p); return v !== null && v < 0; })
  );
  if (filtered.length === 0) return;

  // ── Step 2: Per-row pipeline ──────────────────────────────────────────────────
  const processed = filtered.map(r => {
    // Step 3a: get all display-period values, remove positives / zeros
    const vals: (number | null)[] = displayPeriods.map(p => {
      const v = atsVal(r, p);
      return v !== null && v >= 0 ? null : v;
    });

    // Step 3b: find first negative whose ALL subsequent negatives equal it (≥1 sub)
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
    // Delete all negatives except the qualifying one
    const periodVals: (number | null)[] = vals.map((v, i) =>
      v !== null && v < 0 && i !== keepIdx ? null : v
    );

    return { row: r, periodVals };
  });

  // ── Step 3d: drop display-period columns with no surviving data ───────────────
  const livePeriodIdxs = displayPeriods
    .map((_, i) => i)
    .filter(i => processed.some(d => d.periodVals[i] !== null));
  const livePeriods = livePeriodIdxs.map(i => displayPeriods[i]);
  const TC = 7 + livePeriods.length;

  // ── Build AOA (array-of-arrays) for xlsx ──────────────────────────────────────
  const aoa: any[][] = [];

  // Row 0 — title banner
  aoa.push([
    { v: `NEG INVENTORY REPORT    ${todayStr}`, t: "s",
      s: { font: ft(true, 13, WHITE), fill: fl(NAVY),
           alignment: { horizontal: "center", vertical: "center" } } },
    ...Array(TC - 1).fill({ v: "", t: "s", s: { fill: fl(NAVY) } }),
  ]);

  // Row 1 — group labels
  aoa.push([
    ...Array(4).fill({ v: "", t: "s", s: { fill: fl(NAVY) } }),
    { v: "INVENTORY", t: "s",
      s: { font: ft(true, 9, WHITE), fill: fl(SLATE),
           alignment: { horizontal: "center", vertical: "center" } } },
    ...Array(2).fill({ v: "", t: "s", s: { fill: fl(SLATE) } }),
    ...(livePeriods.length > 0 ? [
      { v: "ATS BY MONTH", t: "s",
        s: { font: ft(true, 9, WHITE), fill: fl(TEAL),
             alignment: { horizontal: "center", vertical: "center" } } },
      ...Array(Math.max(0, livePeriods.length - 1)).fill({ v: "", t: "s", s: { fill: fl(TEAL) } }),
    ] : []),
  ]);

  // Row 2 — column headers
  const COL_HDRS = ["SKU", "Description", "Category", "Store",
                    "On Hand", "On Order (SO)", "On PO"];
  aoa.push([
    ...COL_HDRS.map((h, i) => ({
      v: h, t: "s",
      s: { font: ft(true, 9, WHITE),
           fill: fl(i < 4 ? NAVY : SLATE),
           alignment: { horizontal: "center", vertical: "center" },
           border: { bottom: MED(NAVY) } },
    })),
    ...livePeriods.map(p => ({
      v: p.label.replace(/\n/g, " "), t: "s",
      s: { font: ft(true, 9, WHITE), fill: fl(TEAL),
           alignment: { horizontal: "center", vertical: "center" },
           border: { bottom: MED(NAVY) } },
    })),
  ]);

  // Data rows
  processed.forEach(({ row, periodVals }, ri) => {
    const rf = ri % 2 === 0 ? WHITE : LGRAY;
    aoa.push([
      { v: row.sku ?? "",         t: "s", s: { font: ft(true,  9, SKU_COL), fill: fl(rf), alignment: { horizontal: "left",   vertical: "center" } } },
      { v: row.description ?? "", t: "s", s: { font: ft(false, 9, "000000"), fill: fl(rf), alignment: { horizontal: "left",   vertical: "center" } } },
      { v: row.category ?? "",    t: "s", s: { font: ft(false, 9, MUTED),   fill: fl(rf), alignment: { horizontal: "center", vertical: "center" } } },
      { v: row.store ?? "",       t: "s", s: { font: ft(false, 9, MUTED),   fill: fl(rf), alignment: { horizontal: "center", vertical: "center" } } },
      { v: row.onHand       ?? 0, t: "n", s: { font: ft(false, 9, "000000"), fill: fl(rf), alignment: { horizontal: "right",  vertical: "center" }, numFmt: "#,##0" } },
      { v: row.onCommitted  ?? 0, t: "n", s: { font: ft(false, 9, "000000"), fill: fl(rf), alignment: { horizontal: "right",  vertical: "center" }, numFmt: "#,##0" } },
      { v: row.onOrder      ?? 0, t: "n", s: { font: ft(false, 9, "000000"), fill: fl(rf), alignment: { horizontal: "right",  vertical: "center" }, numFmt: "#,##0" } },
      ...livePeriodIdxs.map(pi => {
        const val = periodVals[pi];
        const neg = val !== null && val < 0;
        return {
          v: val ?? "", t: val !== null ? "n" as const : "s" as const,
          s: { font: ft(neg, 9, neg ? NEG_RED : "000000"),
               fill: fl(neg ? NEG_BG : rf),
               alignment: { horizontal: "right", vertical: "center" },
               numFmt: "#,##0" },
        };
      }),
    ]);
  });

  const ws: any = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

  // ── Merges ────────────────────────────────────────────────────────────────────
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: TC - 1 } },          // title
    { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },                // A-D navy
    { s: { r: 1, c: 4 }, e: { r: 1, c: 6 } },                // INVENTORY
    ...(livePeriods.length > 1
      ? [{ s: { r: 1, c: 7 }, e: { r: 1, c: TC - 1 } }]     // ATS BY MONTH
      : []),
  ];

  // ── Group outer borders (rows 1–last, skip title row 0) ───────────────────────
  const GROUPS: [number, number][] = [[0, 3], [4, 6]];
  if (livePeriods.length > 0) GROUPS.push([7, TC - 1]);

  const getGroup = (c: number): [number, number] =>
    GROUPS.find(([g0, g1]) => g0 <= c && c <= g1) ?? [c, c];

  const LAST_R = 2 + processed.length; // 0-indexed last row

  for (let r = 1; r <= LAST_R; r++) {
    for (let c = 0; c < TC; c++) {
      const addr = XLSXStyle.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { v: "", t: "s", s: {} };
      const cell = ws[addr];
      const [g0, g1] = getGroup(c);
      const isHdr = r === 2;
      cell.s = {
        ...(cell.s ?? {}),
        border: {
          left:   c === g0            ? MED(NAVY)   : THIN(GRY_BRD),
          right:  c === g1            ? MED(NAVY)   : THIN(GRY_BRD),
          top:    r === 1             ? MED(NAVY)   : THIN(GRY_BRD),
          bottom: r === LAST_R || isHdr ? MED(NAVY) : THIN(GRY_BRD),
        },
      };
    }
  }

  // ── Column widths & row heights ───────────────────────────────────────────────
  ws["!cols"] = [
    { wch: 28 }, { wch: 28 }, { wch: 16 }, { wch: 8 },
    { wch: 11 }, { wch: 13 }, { wch: 10 },
    ...livePeriods.map(() => ({ wch: 11 })),
  ];
  ws["!rows"] = [
    { hpt: 24 }, { hpt: 16 }, { hpt: 16 },
    ...processed.map(() => ({ hpt: 15 })),
  ];

  ws["!freeze"] = { xSplit: 0, ySplit: 3 };

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, "Neg Inventory Report");

  const buf  = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `Neg_Inventory_${fmtDate(today)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
