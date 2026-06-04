import { describe, it, expect } from "vitest";
import XLSXStyle from "xlsx-js-style";
import { sheetToCellRows } from "../sheetToRows";
import { buildExportPayload, type AtsSizeMatrixResponse } from "../exportExcel";
import type { ExportOptions } from "../panels/ExportOptionsModal";
import type { ATSRow } from "../types";

// sheetToCellRows reconstructs a worksheet back into a styled Cell[][]
// grid so the View preview can render the "By Size Matrix" + per-period
// tabs (which live only inside payload.wb, not payload.aoa). It must
// preserve each cell's value, type and STYLE, and fill gaps with blanks.

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

describe("sheetToCellRows", () => {
  it("returns [] for a missing or range-less worksheet", () => {
    expect(sheetToCellRows(null)).toEqual([]);
    expect(sheetToCellRows({})).toEqual([]);
  });

  it("reconstructs values, types and styles from cell objects", () => {
    const aoa = [
      [{ v: "Style", t: "s", s: { font: { bold: true } } }, { v: "ATS", t: "s" }],
      [{ v: "Delano", t: "s" }, { v: 1676, t: "n", s: { numFmt: "#,##0" } }],
    ];
    const ws = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });
    const rows = sheetToCellRows(ws);
    expect(rows).toHaveLength(2);
    expect(rows[0][0].v).toBe("Style");
    expect(rows[0][0].s.font.bold).toBe(true);   // style preserved
    expect(rows[1][1].v).toBe(1676);
    expect(rows[1][1].t).toBe("n");
    expect(rows[1][1].s.numFmt).toBe("#,##0");
  });

  it("yields a dense grid (gaps become blank) so rows align by column", () => {
    // A sparse sheet: B2 set, A1/A2/B1 absent.
    const ws: any = { "!ref": "A1:B2", B2: { v: 5, t: "n" } };
    const rows = sheetToCellRows(ws);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0][0]).toBeUndefined();
    expect(rows[1][1]!.v).toBe(5);
  });

  it("round-trips the real 'By Size Matrix' sheet to the locked layout", () => {
    const bulk = new Map([["RYB0412|CHARCOAL", { so: 1000, po: 1000 }]]);
    const payload = buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk)!;
    const rows = sheetToCellRows(payload.wb.Sheets["By Size Matrix"]);

    const header = rows.find((r) => r[0]?.v === "Style" && r.some((c) => c?.v === "ATS"));
    expect(header).toBeTruthy();
    expect(header!.map((c) => c?.v ?? "")).toEqual(
      ["Style", "Color", "SO", "", "PO", "", "ATS", "", "28", "30", "32", "PPK", "Total Eachs", "Total PPK24"],
    );
    // Header cells keep their dark-blue report fill.
    const soHdr = header!.find((c) => c?.v === "SO")!;
    expect(soHdr.s.fill.fgColor.rgb).toBe("1F497D");

    const charcoal = rows.find((r) => r[1]?.v === "Charcoal")!;
    expect(charcoal[6]!.v).toBe(1676);   // ATS
    expect(charcoal[9]!.v).toBe(564);    // size 30
    expect(charcoal[11]!.v).toBe(48);    // PPK packs
  });
});
