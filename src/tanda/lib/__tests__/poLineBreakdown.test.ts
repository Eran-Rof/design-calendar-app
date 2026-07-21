import { describe, it, expect } from "vitest";
import { openQty, poHasReceipts, poFullyReceived, groupPoLines, poBreakdownGrandTotalCents, deriveReceiptDateSummary, type PoBreakdownLine } from "../poLineBreakdown";

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

  it("carries the style NAME onto the style block (received-PO header parity)", () => {
    const { byStyle } = groupPoLines([
      line({ style_code: "RYB1416", style_name: "Cargo Jogger", qty_ordered: 5 }),
      line({ style_code: "RYB1416", style_name: null, size: "LARGE", qty_ordered: 3 }),
    ]);
    expect(byStyle.get("RYB1416")!.styleName).toBe("Cargo Jogger");
  });
});

// ROF-P001133 shape (verified prod PO): pack-grain PPK lines ($171.60/pack) +
// each-grain waist-size lines ($6.95/$7.15, inseam 30) + unlinked lines that
// carry costs. Asserts the receipt-editor grouping surfaces per-cell costs and a
// grand total (the money a received PO previously never showed in that view).
describe("groupPoLines + poBreakdownGrandTotalCents — ROF-P001133 costed shape", () => {
  const ppk = (style: string, packs: number) =>
    ({ style_code: style, color: "Assorted", size: `${style} PPK24`, qty_ordered: packs, qty_received: packs, unit_cost_cents: 17160 } as PoBreakdownLine);
  const waist = (size: string, qty: number, unit: number) =>
    ({ style_code: "RYB0900", color: "Indigo", size, inseam: "30", qty_ordered: qty, qty_received: 0, unit_cost_cents: unit } as PoBreakdownLine);

  const lines: PoBreakdownLine[] = [
    ppk("RYB1533PPK", 10), ppk("RYB1619PPK", 8), ppk("RYB1416PPK", 6), ppk("RYB1906PPK", 4),
    waist("30", 12, 695), waist("32", 18, 695), waist("34", 9, 715),
    { style_code: null, size: null, description: "Freight surcharge", qty_ordered: 1, qty_received: 1, unit_cost_cents: 250000 },
  ];

  it("surfaces per-cell ordered/received cost on the PPK pack cells", () => {
    const { byStyle } = groupPoLines(lines);
    const cell = byStyle.get("RYB1533PPK")!.colors.get("Assorted")!.get("RYB1533PPK PPK24")!;
    expect(cell.ordered).toBe(10);
    expect(cell.orderedCost).toBe(171600);   // 10 packs × $171.60
    expect(cell.received).toBe(10);
    expect(cell.receivedCost).toBe(171600);
  });

  it("keeps inseam-30 waist styles as one header inseam with costed cells", () => {
    const { byStyle } = groupPoLines(lines);
    const s = byStyle.get("RYB0900")!;
    expect(s.inseam).toBe("30");
    expect(s.colors.get("Indigo")!.get("32")!.orderedCost).toBe(18 * 695);
  });

  it("routes the costed freight line to unlinkedLines (kept, not dropped)", () => {
    const { unlinkedLines } = groupPoLines(lines);
    expect(unlinkedLines).toHaveLength(1);
    expect(Number(unlinkedLines[0].unit_cost_cents)).toBe(250000);
  });

  it("grand total = every matrix cell + unlinked line, grain-invariant", () => {
    const breakdown = groupPoLines(lines);
    const ppkCost = (10 + 8 + 6 + 4) * 17160;                 // packs × per-pack
    const waistCost = 12 * 695 + 18 * 695 + 9 * 715;
    const freight = 250000;
    expect(poBreakdownGrandTotalCents(breakdown)).toBe(ppkCost + waistCost + freight);
  });
});

describe("deriveReceiptDateSummary — LRD from posted receipts", () => {
  it("groups per date, sums same-date receipts, sorts oldest→newest, LRD = last", () => {
    const s = deriveReceiptDateSummary([
      { date: "2026-07-02", qty: 3800 },
      { date: "2026-06-12", qty: 1000 },
      { date: "2026-06-12", qty: 240 }, // second receipt same day → summed
    ]);
    expect(s.lastReceivedDate).toBe("2026-07-02");
    expect(s.byDate).toEqual([
      { date: "2026-06-12", qty: 1240 },
      { date: "2026-07-02", qty: 3800 },
    ]);
  });

  it("ignores blank dates and coerces non-numeric qty to zero", () => {
    const s = deriveReceiptDateSummary([
      { date: "", qty: 99 },
      { date: "2026-05-01", qty: Number("x") },
    ]);
    expect(s.byDate).toEqual([{ date: "2026-05-01", qty: 0 }]);
    expect(s.lastReceivedDate).toBe("2026-05-01");
  });

  it("returns an empty summary for no receipts (a PO received off-system)", () => {
    expect(deriveReceiptDateSummary([])).toEqual({ lastReceivedDate: null, byDate: [] });
    expect(deriveReceiptDateSummary(null)).toEqual({ lastReceivedDate: null, byDate: [] });
  });
});

describe("groupPoLines — inseam (jeans buyer needs to see the inseam)", () => {
  it("UNIFORM: a style whose every line shares one inseam shows it once in the header (DMB0013 / ROF-P001281 shape)", () => {
    // Waist sizes 30–36 are the columns; inseam 30 is uniform → header, not a row.
    const { byStyle } = groupPoLines([
      line({ style_code: "DMB0013", color: "Neptune - Medium Wash", size: "31", inseam: "30", qty_ordered: 12 }),
      line({ style_code: "DMB0013", color: "Neptune - Medium Wash", size: "32", inseam: "30", qty_ordered: 18 }),
      line({ style_code: "DMB0013", color: "Skylark - Light Wash", size: "30", inseam: "30", qty_ordered: 6 }),
    ]);
    const s = byStyle.get("DMB0013")!;
    expect(s.inseam).toBe("30");
    // Colors stay plain (inseam is NOT appended to each row).
    expect([...s.colors.keys()].sort()).toEqual(["Neptune - Medium Wash", "Skylark - Light Wash"]);
  });

  it("MIXED: a style that mixes inseams keeps them as distinct color rows and shows no header inseam", () => {
    const { byStyle } = groupPoLines([
      line({ style_code: "DMB0013", color: "Black", size: "32", inseam: "30", qty_ordered: 5 }),
      line({ style_code: "DMB0013", color: "Black", size: "32", inseam: "32", qty_ordered: 7 }),
    ]);
    const s = byStyle.get("DMB0013")!;
    expect(s.inseam).toBeNull();
    expect([...s.colors.keys()].sort()).toEqual([`Black · 30"`, `Black · 32"`]);
    // The two inseams stay SEPARATE cells (not merged into one Black/32 cell).
    expect(s.colors.get(`Black · 30"`)!.get("32")!.ordered).toBe(5);
    expect(s.colors.get(`Black · 32"`)!.get("32")!.ordered).toBe(7);
  });

  it("ABSENT: a non-inseam product (tops / composite-code rows with null inseam) shows no inseam anywhere", () => {
    const { byStyle } = groupPoLines([
      line({ style_code: "TOP001", color: "White", size: "MEDIUM", inseam: null, qty_ordered: 4 }),
      line({ style_code: "TOP001", color: "White", size: "LARGE", inseam: undefined, qty_ordered: 3 }),
    ]);
    const s = byStyle.get("TOP001")!;
    expect(s.inseam).toBeNull();
    expect([...s.colors.keys()]).toEqual(["White"]);
  });
});
