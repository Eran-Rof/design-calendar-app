// @vitest-environment jsdom
//
// Tests for <ExportPreviewModal /> worksheet tabs. The preview renders
// the main "ATS Report" sheet straight from payload.aoa; when the
// By-Size-Matrix export adds more sheets to payload.wb, a tab bar lets
// the operator switch between them, with each non-main sheet
// reconstructed from its stored cells. Single-sheet reports show no tab
// bar and render exactly as before.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ExportPreviewModal } from "../panels/ExportPreviewModal";
import { buildExportPayload, type AtsSizeMatrixResponse } from "../exportExcel";
import type { ExportOptions } from "../panels/ExportOptionsModal";
import type { ATSRow } from "../types";

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
const bulk = new Map([["RYB0412|CHARCOAL", { so: 1000, po: 1000 }]]);

function matrixPayload() {
  const periodMatrices = [{ name: "June 2026", matrix }];
  return buildExportPayload([row()], [], [], null, baseOpts(), null, undefined, true, undefined, matrix, bulk, periodMatrices)!;
}

function noop() {}

describe("<ExportPreviewModal /> worksheet tabs", () => {
  it("shows a tab per sheet when the workbook has more than one", () => {
    render(<ExportPreviewModal open payload={matrixPayload()} rowCount={1} onClose={noop} onCloseAll={noop} />);
    const tablist = screen.getByRole("tablist", { name: "Worksheets" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["ATS Report", "By Size Matrix", "June 2026"]);
    // Main sheet is selected by default.
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  it("renders no tab bar for a single-sheet report", () => {
    const payload = buildExportPayload([row()], [], [], null, baseOpts({ bySizeMatrix: false }), null, undefined, true, undefined, undefined)!;
    render(<ExportPreviewModal open payload={payload} rowCount={1} onClose={noop} onCloseAll={noop} />);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("switches the rendered sheet when a tab is clicked", () => {
    render(<ExportPreviewModal open payload={matrixPayload()} rowCount={1} onClose={noop} onCloseAll={noop} />);
    // The matrix-only locked header (Total Eachs) is not on the main sheet.
    expect(screen.queryByText("Total Eachs")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "By Size Matrix" }));
    expect(screen.getAllByText("Total Eachs").length).toBeGreaterThan(0);
    // The reconstructed grid carries the matrix's data values.
    expect(screen.getByRole("tab", { name: "By Size Matrix" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Charcoal")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "June 2026" }));
    // Period tab carries its banner text.
    expect(screen.getAllByText("June 2026").length).toBeGreaterThan(0);
  });
});
