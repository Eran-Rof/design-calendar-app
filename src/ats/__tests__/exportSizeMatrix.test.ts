import { describe, it, expect } from "vitest";
import XLSXStyle from "xlsx-js-style";
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

function sheetAoa(wb: any, name: string): any[][] {
  const ws = wb.Sheets[name];
  return ws ? (XLSXStyle.utils.sheet_to_json(ws, { header: 1, defval: "" }) as any[][]) : [];
}

describe("By Size Matrix worksheet", () => {
  const bulk = new Map([["RYB0412|CHARCOAL", { so: 1000, po: 1000 }]]);

  it("appends a 'By Size Matrix' sheet only when the option + data are present", () => {
    const off = buildExportPayload([row()], [], [], null, baseOpts({ bySizeMatrix: false }), null, undefined, true, undefined, matrix, bulk);
    expect(off!.wb.SheetNames).not.toContain("By Size Matrix");

    const noData = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, undefined, bulk);
    expect(noData!.wb.SheetNames).not.toContain("By Size Matrix");

    const on = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk);
    expect(on!.wb.SheetNames).toContain("By Size Matrix");
    // The main report is always present + untouched.
    expect(on!.wb.SheetNames).toContain("ATS Report");
  });

  it("renders header, color row, and subtotal exactly per the locked layout", () => {
    const payload = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk)!;
    const aoa = sheetAoa(payload.wb, "By Size Matrix");

    const header = aoa.find((r) => r[0] === "Style" && r.includes("ATS"));
    expect(header).toBeTruthy();
    // Style·Color·SO·PO·ATS · 28·30·32 · PPK·Total Eachs·Total PPK24
    expect(header).toEqual(["Style", "Color", "SO", "PO", "ATS", "28", "30", "32", "PPK", "Total Eachs", "Total PPK24"]);

    const charcoal = aoa.find((r) => r[1] === "Charcoal");
    expect(charcoal).toBeTruthy();
    expect(charcoal![0]).toBe("Delano");      // Style name
    expect(charcoal![2]).toBe(1000);          // SO (bulk overlay)
    expect(charcoal![3]).toBe(1000);          // PO (bulk overlay)
    expect(charcoal![4]).toBe(1676);          // ATS = total eachs
    expect(charcoal![5]).toBe("");            // size 28 → no SKU → blank
    expect(charcoal![6]).toBe(564);           // size 30 (loose eaches)
    expect(charcoal![7]).toBe(1112);          // size 32
    expect(charcoal![8]).toBe(48);            // PPK packs (SEPARATE from sizes)
    expect(charcoal![9]).toBe(1676);          // Total Eachs
    expect(charcoal![10]).toBe(48);           // Total PPK24

    // Size cells sum to ATS; packs are NOT added into them.
    expect((charcoal![6] as number) + (charcoal![7] as number)).toBe(charcoal![4]);

    const subtotal = aoa.find((r) => r[0] === "Subtotal");
    expect(subtotal).toBeTruthy();
    expect(subtotal![2]).toBe(1000);  // Σ SO
    expect(subtotal![4]).toBe(1676);  // Σ ATS
    expect(subtotal![8]).toBe(48);    // Σ PPK
  });

  it("title row names the style + section", () => {
    const payload = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk)!;
    const aoa = sheetAoa(payload.wb, "By Size Matrix");
    expect(String(aoa[0][0])).toContain("RYB0412");
    expect(String(aoa[0][0])).toContain("ATS Available by Size");
  });
});
