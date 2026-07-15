import { describe, it, expect } from "vitest";
import { openQty, poHasReceipts, poFullyReceived, groupPoLines, type PoBreakdownLine } from "../poLineBreakdown";

const line = (o: Partial<PoBreakdownLine> & { qty_ordered: number }): PoBreakdownLine => ({
  style_code: "STY1", color: "Black", size: "MEDIUM", unit_cost_cents: 1000, qty_received: 0, ...o,
});

describe("openQty (remaining-to-ship)", () => {
  it("is ordered − received, floored at zero", () => {
    expect(openQty({ qty_ordered: 10, qty_received: 4 })).toBe(6);
    expect(openQty({ qty_ordered: 10, qty_received: 0 })).toBe(10);
    expect(openQty({ qty_ordered: 10, qty_received: 10 })).toBe(0);
  });
  it("never goes negative when over-received", () => {
    expect(openQty({ qty_ordered: 5, qty_received: 8 })).toBe(0);
  });
  it("treats null/undefined received as zero", () => {
    expect(openQty({ qty_ordered: 7, qty_received: null })).toBe(7);
    expect(openQty({ qty_ordered: 7 } as PoBreakdownLine)).toBe(7);
  });
});

describe("poHasReceipts", () => {
  it("is true on partially_received / received status", () => {
    expect(poHasReceipts("partially_received", [])).toBe(true);
    expect(poHasReceipts("received", [])).toBe(true);
  });
  it("is true when any line has qty_received even if status lags", () => {
    expect(poHasReceipts("issued", [{ qty_received: 3 }])).toBe(true);
  });
  it("is false for a clean issued/draft PO", () => {
    expect(poHasReceipts("issued", [{ qty_received: 0 }])).toBe(false);
    expect(poHasReceipts("draft", [{ qty_received: 0 }])).toBe(false);
  });
});

describe("poFullyReceived", () => {
  it("is true when status is received", () => {
    expect(poFullyReceived("received", [{ qty_ordered: 1, qty_received: 0 }])).toBe(true);
  });
  it("is true when every line is fully received (and some received)", () => {
    expect(poFullyReceived("partially_received", [
      { qty_ordered: 5, qty_received: 5 },
      { qty_ordered: 3, qty_received: 3 },
    ])).toBe(true);
  });
  it("is false while any line still has remain-to-ship", () => {
    expect(poFullyReceived("partially_received", [
      { qty_ordered: 5, qty_received: 5 },
      { qty_ordered: 3, qty_received: 1 },
    ])).toBe(false);
  });
  it("is false when there are no lines", () => {
    expect(poFullyReceived("issued", [])).toBe(false);
  });
});

describe("groupPoLines", () => {
  it("groups by style → color → size with Issued/Received/Open cell metrics", () => {
    const { byStyle, matrixLines, unlinkedLines } = groupPoLines([
      line({ color: "Black", size: "SMALL", qty_ordered: 10, qty_received: 4, unit_cost_cents: 1000 }),
      line({ color: "Black", size: "MEDIUM", qty_ordered: 8, qty_received: 8, unit_cost_cents: 1000 }),
    ]);
    expect(matrixLines).toHaveLength(2);
    expect(unlinkedLines).toHaveLength(0);
    const cellS = byStyle.get("STY1")!.colors.get("Black")!.get("SMALL")!;
    expect(cellS.ordered).toBe(10);
    expect(cellS.received).toBe(4);
    expect(cellS.remaining).toBe(6);
    expect(cellS.orderedCost).toBe(10000);
    expect(cellS.remainingCost).toBe(6000);
    expect(cellS.lines).toHaveLength(1);
    const cellM = byStyle.get("STY1")!.colors.get("Black")!.get("MEDIUM")!;
    expect(cellM.remaining).toBe(0);
  });

  it("collapses legacy size spellings (SML → SMALL) into one column", () => {
    const { byStyle } = groupPoLines([
      line({ size: "SML", qty_ordered: 3, qty_received: 0 }),
      line({ size: "SMALL", qty_ordered: 2, qty_received: 0 }),
    ]);
    const black = byStyle.get("STY1")!.colors.get("Black")!;
    expect([...black.keys()]).toEqual(["SMALL"]);
    expect(black.get("SMALL")!.ordered).toBe(5);
    expect(black.get("SMALL")!.lines).toHaveLength(2);
  });

  it("routes SKU-less rows (no style/size) to unlinkedLines", () => {
    const { byStyle, unlinkedLines } = groupPoLines([
      { style_code: null, size: null, description: "Freight", qty_ordered: 1, qty_received: 0 },
      line({ qty_ordered: 4, qty_received: 0 }),
    ]);
    expect(unlinkedLines).toHaveLength(1);
    expect(unlinkedLines[0].description).toBe("Freight");
    expect(byStyle.size).toBe(1);
  });
});
