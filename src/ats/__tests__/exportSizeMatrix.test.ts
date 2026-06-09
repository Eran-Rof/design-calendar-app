import { describe, it, expect } from "vitest";
import { buildExportPayload, type AtsSizeMatrixResponse } from "../exportExcel";
import type { ExportOptions } from "../panels/ExportOptionsModal";
import type { ATSRow } from "../types";

// The "By Size Matrix" worksheet: a color × size grid of ATS-available eaches
// per style, with bulk SO/PO overlay and a separate PPK pack column. Verifies
// the layout the operator locked (Style·Color·SO·PO·ATS·<sizes>·PPK·Total
// Eachs·Total PPK<n> + Subtotal) and that loose eaches and PPK packs stay in
// their own columns (packs are NOT folded into the size cells).

function baseOpts(over: Partial<ExportOptions> = {}): ExportOptions {
  return {
    subtotals: true, avgCost: false, slsPrcAtMrgn: false, slsMarginPct: 21,
    trailing3: false, spLY: false, customerEnabled: false, customer: "",
    showCustomerMargin: true, customerFacing: false, hideZeroColumns: false,
    hideATSData: false, hideEmptyHistoryRows: false, customSalesRangeEnabled: false,
    customSalesRangeStart: "", customSalesRangeEnd: "", bySizeMatrix: true,
    ...over,
  };
}

const row = (over: Partial<ATSRow> = {}): ATSRow => ({
  sku: "RYB0412 - Charcoal", description: "Delano", dates: {},
  onPO: 1000, onOrder: 1000, onHand: 3915, ppkMult: 1,
  master_style: "RYB0412", master_color: "Charcoal", ...over,
});

const matrix: AtsSizeMatrixResponse = {
  as_of: "2026-05-31",
  styles: [{
    style_code: "RYB0412", style_name: "Delano", sizes: ["28", "30", "32"], pack_size: 24,
    colors: [{ color: "Charcoal", by_size: { "30": 564, "32": 1112 }, total_eachs: 1676, ppk_packs: 48 }],
  }],
};

// The matrix tabs now live in payload.extraSheets as styled Cell[][] arrays.
const names = (p: any): string[] => (p?.wb?.worksheets ?? []).map((w: any) => w.name);
const sheetCells = (p: any, name: string): any[][] => (p?.extraSheets ?? []).find((s: any) => s.name === name)?.aoa ?? [];
const sheetAoa = (p: any, name: string): any[][] =>
  sheetCells(p, name).map((row) => (row ?? []).map((cell: any) => (cell == null ? "" : cell.v ?? "")));

describe("By Size Matrix worksheet", () => {
  const bulk = new Map([["RYB0412|CHARCOAL", { so: 1000, po: 1000 }]]);

  it("appends a 'By Size Matrix' sheet only when the option + data are present", () => {
    const off = buildExportPayload([row()], [], [], null, baseOpts({ bySizeMatrix: false }), null, undefined, true, undefined, matrix, bulk);
    expect(names(off)).not.toContain("By Size Matrix");

    const noData = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, undefined, bulk);
    expect(names(noData)).not.toContain("By Size Matrix");

    const on = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk);
    expect(names(on)).toContain("By Size Matrix");
    // The main report is always present + untouched.
    expect(names(on)).toContain("ATS Report");
  });

  it("renders header, color row, and subtotal exactly per the locked layout (with spacer cols)", () => {
    const payload = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk)!;
    const aoa = sheetAoa(payload, "By Size Matrix");

    const header = aoa.find((r) => r[0] === "Style" && r.includes("ATS"));
    expect(header).toBeTruthy();
    // Style·Color·SO·_·PO·_·ATS·_·28·30·32·PPK·Total Eachs·Total PPK24
    expect(header).toEqual(["Style", "Color", "SO", "", "PO", "", "ATS", "", "28", "30", "32", "PPK", "Total Eachs", "Total PPK24"]);

    const c = aoa.find((r) => r[1] === "Charcoal")!;
    expect(c[0]).toBe("Delano");   // Style name
    expect(c[2]).toBe(1000);       // SO (bulk overlay)
    expect(c[3]).toBe("");         // spacer
    expect(c[4]).toBe(1000);       // PO (bulk overlay)
    expect(c[5]).toBe("");         // spacer
    expect(c[6]).toBe(1676);       // ATS = total eachs
    expect(c[7]).toBe("");         // spacer
    expect(c[8]).toBe("");         // size 28 → no SKU → blank
    expect(c[9]).toBe(564);        // size 30
    expect(c[10]).toBe(1112);      // size 32
    expect(c[11]).toBe(48);        // PPK packs (SEPARATE from sizes)
    expect(c[12]).toBe(1676);      // Total Eachs
    expect(c[13]).toBe(48);        // Total PPK24

    // Size cells sum to ATS; packs are NOT folded into them.
    expect((c[9] as number) + (c[10] as number)).toBe(c[6]);

    const sub = aoa.find((r) => r[0] === "Subtotal")!;
    expect(sub[2]).toBe(1000);  // Σ SO
    expect(sub[6]).toBe(1676);  // Σ ATS
    expect(sub[11]).toBe(48);   // Σ PPK
  });

  it("title row names the style + section", () => {
    const payload = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk)!;
    const aoa = sheetAoa(payload, "By Size Matrix");
    expect(String(aoa[0][0])).toContain("RYB0412");
    expect(String(aoa[0][0])).toContain("ATS Available by Size");
  });

  it("adds one tab per period with a 22pt dark-blue/white period banner", () => {
    const periodMatrices = [{ name: "June 2026", matrix }, { name: "July 2026", matrix }];
    const payload = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk, periodMatrices)!;
    expect(names(payload)).toContain("By Size Matrix"); // snapshot stays
    expect(names(payload)).toContain("June 2026");
    expect(names(payload)).toContain("July 2026");
    const june = sheetAoa(payload, "June 2026");
    expect(String(june[0][0])).toBe("June 2026");             // banner text
    const a1 = sheetCells(payload, "June 2026")[0][0];
    expect(a1.s.font.sz).toBe(22);                            // 22pt
    expect(a1.s.font.color.rgb).toBe("FFFFFF");               // white font
    expect(a1.s.fill.fgColor.rgb).toBe("1F497D");             // dark-blue fill
  });
});
