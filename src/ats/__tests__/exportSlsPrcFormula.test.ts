import { describe, it, expect } from "vitest";
import { buildExportPayload } from "../exportExcel";
import type { ExportOptions } from "../panels/ExportOptionsModal";
import type { ATSRow } from "../types";

// Sls Prc @ Margin now ships LIVE Excel formulas: Mrgn % = (Sls Prc − unit
// cost)/Sls Prc and Total $ = Sls Prc × Total qty, both keyed off the editable
// Sls Prc cell. The unit cost is parked on a separate "Cost (delete before
// sending)" tab so a customer-facing export can be pasted-as-values and the
// cost tab deleted. Customer Facing no longer strips the Sls Prc column.

const COST_SHEET = "Cost (delete before sending)";

function baseOpts(over: Partial<ExportOptions> = {}): ExportOptions {
  return {
    subtotals: true, avgCost: false, slsPrcAtMrgn: true, slsMarginPct: 21,
    trailing3: false, spLY: false, customerEnabled: false, customer: "",
    showCustomerMargin: true, customerFacing: false, hideZeroColumns: false,
    hideATSData: false, hideEmptyHistoryRows: false, customSalesRangeEnabled: false,
    customSalesRangeStart: "", customSalesRangeEnd: "", bySizeMatrix: false,
    ...over,
  };
}

const PERIODS = [{ endDate: "2026-06-30", label: "Jun" }];
const row = (over: Partial<ATSRow> = {}): ATSRow => ({
  sku: "RYB0412 - Charcoal", description: "Delano", dates: { "2026-06-30": 100 },
  onPO: 0, onOrder: 0, onHand: 100, ppkMult: 1, avgCost: 10,
  master_style: "RYB0412", master_color: "Charcoal", ...over,
});

const wbNames = (p: any): string[] => (p?.wb?.worksheets ?? []).map((w: any) => w.name);
const allCells = (p: any): any[] => (p?.aoa ?? []).flat().filter(Boolean);
function headerIdx(p: any, label: string): number {
  for (const r of p?.aoa ?? []) {
    if (!r) continue;
    const i = r.findIndex((c: any) => c && c.v === label);
    if (i >= 0) return i;
  }
  return -1;
}
const costAoa = (p: any): any[][] => (p?.extraSheets ?? []).find((s: any) => s.name === COST_SHEET)?.aoa ?? [];

describe("Sls Prc @ Margin — live formulas + Cost sheet", () => {
  it("Mrgn % is a formula referencing the Cost sheet; Sls Prc stays a value", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts(), null, undefined, true)!;
    const mrgn = allCells(p).find((c) => typeof c.f === "string" && c.f.includes(COST_SHEET));
    expect(mrgn).toBeTruthy();
    // (SlsPrcCell − 'Cost ...'!A<row>) / SlsPrcCell
    expect(mrgn.f).toMatch(/-'Cost \(delete before sending\)'!A\d+\)\//);

    // The Sls Prc cell itself is a plain editable number (no formula).
    const slsIdx = headerIdx(p, "Sls Prc @ 21%");
    expect(slsIdx).toBeGreaterThanOrEqual(0);
    const slsBody = (p.aoa as any[][]).find((r) => r && r[slsIdx] && typeof r[slsIdx].v === "number" && !r[slsIdx].f);
    expect(slsBody).toBeTruthy();
  });

  it("Total $ is a live formula = Sls Prc × Total qty", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts(), null, undefined, true)!;
    expect(headerIdx(p, "Total $")).toBeGreaterThanOrEqual(0);
    const ttl = allCells(p).find((c) => typeof c.f === "string" && /^IF\([A-Z]+\d+="",0,[A-Z]+\d+\*[A-Z]+\d+\)$/.test(c.f));
    expect(ttl).toBeTruthy();
  });

  it("adds the Cost tab with the unit cost aligned to the formula's row", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts(), null, undefined, true)!;
    expect(wbNames(p)).toContain(COST_SHEET);
    const mrgn = allCells(p).find((c) => typeof c.f === "string" && c.f.includes(COST_SHEET));
    const refRow = Number(/!A(\d+)\)/.exec(mrgn.f)![1]);
    // The Cost sheet carries the unit cost (10) at the SAME AoA row the formula
    // points to (index = row − 1), so the cross-sheet reference resolves.
    const ca = costAoa(p);
    expect(ca[refRow - 1]?.[0]?.v).toBe(10);
    // A red "delete this sheet" warning sits at the top.
    expect(String(ca[0]?.[0]?.v ?? "")).toMatch(/DELETE THIS SHEET/i);
  });

  it("Customer Facing keeps Sls Prc @ Margin but drops Avg Cost from the main sheet", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts({ customerFacing: true }), null, undefined, true)!;
    expect(headerIdx(p, "Sls Prc @ 21%")).toBeGreaterThanOrEqual(0); // kept
    expect(headerIdx(p, "Total $")).toBeGreaterThanOrEqual(0);        // kept
    expect(headerIdx(p, "Avg Cost")).toBe(-1);                        // stripped from main
    expect(wbNames(p)).toContain(COST_SHEET);                         // cost moved to its own tab
  });

  it("no Cost tab and no Total $ / formulas when Sls Prc @ Margin is off", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts({ slsPrcAtMrgn: false }), null, undefined, true)!;
    expect(wbNames(p)).not.toContain(COST_SHEET);
    expect(headerIdx(p, "Total $")).toBe(-1);
    expect(allCells(p).some((c) => typeof c.f === "string" && c.f.includes(COST_SHEET))).toBe(false);
  });
});
