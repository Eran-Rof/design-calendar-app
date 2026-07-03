import { describe, it, expect } from "vitest";
import { buildExportPayload } from "../exportExcel";
import type { ExportOptions } from "../panels/ExportOptionsModal";
import type { ATSRow } from "../types";

// Buyer worksheet = the live internal pricing view: Avg Cost INLINE + editable
// Sls Prc with LIVE Mrgn % / Total $ formulas (margin references the inline
// Avg Cost cell — no separate cost sheet). Customer Facing reverts to its safe
// original (strips cost + Sls Prc). The BP-max implied price is outlier-guarded
// so one corrupt cost can't poison a whole style (the RYB1416 bug).

function baseOpts(over: Partial<ExportOptions> = {}): ExportOptions {
  return {
    subtotals: true, avgCost: false, slsPrcAtMrgn: false, slsMarginPct: 21,
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

describe("Buyer worksheet — live formulas with inline cost", () => {
  it("Mrgn % is a same-sheet formula (no Cost tab); Avg Cost shows inline", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts({ buyerWorksheet: true }), null, undefined, true)!;
    // Avg Cost column is forced on and stays on the main sheet.
    expect(headerIdx(p, "Avg Cost")).toBeGreaterThanOrEqual(0);
    expect(headerIdx(p, "Sls Prc @ 21%")).toBeGreaterThanOrEqual(0);
    expect(headerIdx(p, "Total $")).toBeGreaterThanOrEqual(0);
    // No separate cost sheet — the margin references the inline Avg Cost cell.
    expect(wbNames(p)).not.toContain("Cost (delete before sending)");
    const mrgn = allCells(p).find((c) => typeof c.f === "string" && /\(([A-Z]+\d+)-([A-Z]+\d+)\)\//.test(c.f));
    expect(mrgn).toBeTruthy();
    expect(mrgn.f).not.toContain("Cost (");
  });

  it("Total $ is a live formula = Sls Prc × Total qty", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts({ buyerWorksheet: true }), null, undefined, true)!;
    const ttl = allCells(p).find((c) => typeof c.f === "string" && /^IF\([A-Z]+\d+="",0,[A-Z]+\d+\*[A-Z]+\d+\)$/.test(c.f));
    expect(ttl).toBeTruthy();
  });

  it("Customer Facing reverts to safe original — strips Avg Cost AND Sls Prc", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts({ customerFacing: true, slsPrcAtMrgn: true, avgCost: true }), null, undefined, true)!;
    expect(headerIdx(p, "Avg Cost")).toBe(-1);
    expect(headerIdx(p, "Sls Prc @ 21%")).toBe(-1);
    expect(headerIdx(p, "Total $")).toBe(-1);
  });

  it("plain Sls Prc @ Margin (no buyer worksheet) keeps static margin, no Total $", () => {
    const p = buildExportPayload([row()], PERIODS, [], null, baseOpts({ slsPrcAtMrgn: true }), null, undefined, true)!;
    expect(headerIdx(p, "Sls Prc @ 21%")).toBeGreaterThanOrEqual(0);
    expect(headerIdx(p, "Total $")).toBe(-1); // Total $ is buyer-worksheet-only
    // Mrgn % is a static value, not a formula.
    const hasMrgnFormula = allCells(p).some((c) => typeof c.f === "string" && /\)\/[A-Z]+\d+/.test(c.f));
    expect(hasMrgnFormula).toBe(false);
  });
});

describe("BP-max implied price is outlier-guarded (RYB1416 bug)", () => {
  it("one corrupt 20x cost does not set the whole style's Sls Prc", () => {
    // Two colors of one style: a normal $10 cost and a corrupt $200 (pack cost
    // mis-keyed as a unit cost). The implied price must come from $10, not $200.
    const rows: ATSRow[] = [
      row({ sku: "OUT - Good", master_color: "Good", master_style: "OUT", avgCost: 10 }),
      row({ sku: "OUT - Bad",  master_color: "Bad",  master_style: "OUT", avgCost: 200 }),
    ];
    const p = buildExportPayload(rows, PERIODS, [], null, baseOpts({ buyerWorksheet: true }), null, undefined, true)!;
    const slsIdx = headerIdx(p, "Sls Prc @ 21%");
    expect(slsIdx).toBeGreaterThanOrEqual(0);
    const slsValues = (p.aoa as any[][])
      .filter((r) => r && r[slsIdx] && typeof r[slsIdx].v === "number")
      .map((r) => r[slsIdx].v as number);
    expect(slsValues.length).toBeGreaterThan(0);
    // $10 / (1 − 0.21) rounded up to $0.05 = 12.70. The corrupt $200 would give
    // ~$253 — guard keeps every variant at the sane price.
    for (const v of slsValues) expect(v).toBeLessThan(20);
  });

  it("the corrupt-cost row shows the BP representative cost, not the 20x outlier", () => {
    const rows: ATSRow[] = [
      row({ sku: "OUT - Good", master_color: "Good", master_style: "OUT", avgCost: 10 }),
      row({ sku: "OUT - Bad",  master_color: "Bad",  master_style: "OUT", avgCost: 200 }),
    ];
    const p = buildExportPayload(rows, PERIODS, [], null, baseOpts({ buyerWorksheet: true }), null, undefined, true)!;
    const acIdx = headerIdx(p, "Avg Cost");
    expect(acIdx).toBeGreaterThanOrEqual(0);
    const costs = (p.aoa as any[][])
      .filter((r) => r && r[acIdx] && typeof r[acIdx].v === "number")
      .map((r) => r[acIdx].v as number);
    // No row (incl. the corrupt one) shows the 200 outlier — it falls back to
    // the BP's representative $10, so margins stay sane (no −1700% row).
    for (const c of costs) expect(c).toBeLessThan(50);
  });
});

describe("Buyer worksheet: subtotal + grand-total live formulas; Total column right-aligned", () => {
  // Two variants of style AAA (→ a subtotal) + one of BBB + a grand total.
  const rows: ATSRow[] = [
    row({ sku: "AAA - Red",   master_style: "AAA", master_color: "Red",   avgCost: 10 }),
    row({ sku: "AAA - Blue",  master_style: "AAA", master_color: "Blue",  avgCost: 10 }),
    row({ sku: "BBB - Green", master_style: "BBB", master_color: "Green", avgCost: 12 }),
  ];

  it("Mrgn % and Total $ are formulas on EVERY row — body, subtotal, and grand total", () => {
    const p = buildExportPayload(rows, PERIODS, [], null, baseOpts({ buyerWorksheet: true, subtotals: true }), null, undefined, true)!;
    const mrgnIdx = headerIdx(p, "Mrgn %");
    const ttlIdx = headerIdx(p, "Total $");
    expect(mrgnIdx).toBeGreaterThanOrEqual(0);
    expect(ttlIdx).toBeGreaterThanOrEqual(0);
    // 3 body rows + 1 subtotal (AAA) + 1 grand total = 5 rows carrying BOTH a
    // Mrgn % and a Total $ formula.
    const both = (p.aoa as any[][]).filter((r) => r && typeof r[mrgnIdx]?.f === "string" && typeof r[ttlIdx]?.f === "string");
    expect(both.length).toBeGreaterThanOrEqual(5);
    // Margin formula references the row's own Sls Prc + Avg Cost cells.
    expect(both.every((r) => /\([A-Z]+\d+-[A-Z]+\d+\)\/[A-Z]+\d+/.test(r[mrgnIdx].f))).toBe(true);
  });

  it("the Total column data cells are right-aligned (body + subtotal + grand total)", () => {
    const p = buildExportPayload(rows, PERIODS, [], null, baseOpts({ buyerWorksheet: true, subtotals: true }), null, undefined, true)!;
    const totalIdx = headerIdx(p, "Total");
    expect(totalIdx).toBeGreaterThanOrEqual(0);
    const totalCells = (p.aoa as any[][])
      .map((r) => r && r[totalIdx])
      .filter((c) => c && (typeof c.v === "number" || typeof c.f === "string"));
    expect(totalCells.length).toBeGreaterThan(0);
    for (const c of totalCells) expect(c.s?.alignment?.horizontal).toBe("right");
  });
});
