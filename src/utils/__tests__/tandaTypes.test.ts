import { describe, it, expect } from "vitest";
import { itemQty, isLineClosed, poTotal, normalizeSize, sizeSort, milestoneUid, fmtDate, fmtCurrency, mapXoroRaw } from "../tandaTypes";
import type { XoroPO } from "../tandaTypes";

describe("itemQty", () => {
  it("returns QtyRemaining when available", () => {
    expect(itemQty({ QtyRemaining: 50, QtyOrder: 100, QtyReceived: 50 })).toBe(50);
  });
  it("calculates remaining from QtyOrder - QtyReceived when QtyReceived > 0", () => {
    expect(itemQty({ QtyOrder: 100, QtyReceived: 30 })).toBe(70);
  });
  it("returns QtyOrder when nothing received", () => {
    expect(itemQty({ QtyOrder: 200 })).toBe(200);
  });
  it("returns 0 when no qty fields", () => {
    expect(itemQty({})).toBe(0);
  });
  it("returns QtyRemaining even when 0", () => {
    expect(itemQty({ QtyRemaining: 0, QtyOrder: 100 })).toBe(0);
  });
  it("returns 0 for closed lines regardless of remaining qty", () => {
    expect(itemQty({ QtyOrder: 288, QtyRemaining: 288, StatusName: "Closed" })).toBe(0);
  });
});

describe("isLineClosed", () => {
  it("detects Closed status (case-insensitive)", () => {
    expect(isLineClosed({ StatusName: "Closed" })).toBe(true);
    expect(isLineClosed({ StatusName: "closed" })).toBe(true);
  });
  it("detects Cancelled / Canceled", () => {
    expect(isLineClosed({ StatusName: "Cancelled" })).toBe(true);
    expect(isLineClosed({ StatusName: "Canceled" })).toBe(true);
  });
  it("returns false for open / partial / received / missing", () => {
    expect(isLineClosed({ StatusName: "Open" })).toBe(false);
    expect(isLineClosed({ StatusName: "Received" })).toBe(false);
    expect(isLineClosed({})).toBe(false);
  });
  it("falls back to bare Status field", () => {
    expect(isLineClosed({ Status: "Closed" })).toBe(true);
  });
});

describe("poTotal", () => {
  it("uses TotalAmount when no items have been received", () => {
    const po: XoroPO = { TotalAmount: 5000, Items: [{ QtyOrder: 100, UnitPrice: 50 }] };
    expect(poTotal(po)).toBe(5000);
  });
  it("calculates from remaining qty when items partially received", () => {
    const po: XoroPO = {
      TotalAmount: 5000,
      Items: [
        { QtyOrder: 100, QtyReceived: 60, QtyRemaining: 40, UnitPrice: 50 },
      ],
    };
    // 40 remaining * $50 = $2000
    expect(poTotal(po)).toBe(2000);
  });
  it("sums multiple items", () => {
    const po: XoroPO = {
      Items: [
        { QtyOrder: 10, UnitPrice: 100 },
        { QtyOrder: 20, UnitPrice: 50 },
      ],
    };
    // 10*100 + 20*50 = 2000
    expect(poTotal(po)).toBe(2000);
  });
  it("uses PoLineArr as fallback", () => {
    const po: XoroPO = {
      PoLineArr: [{ QtyOrder: 5, UnitPrice: 200 }],
    };
    expect(poTotal(po)).toBe(1000);
  });
});

describe("normalizeSize", () => {
  it("normalizes common size abbreviations", () => {
    expect(normalizeSize("s")).toBe("Small");
    expect(normalizeSize("SM")).toBe("Small");
    expect(normalizeSize("m")).toBe("Medium");
    expect(normalizeSize("MED")).toBe("Medium");
    expect(normalizeSize("l")).toBe("Large");
    expect(normalizeSize("LG")).toBe("Large");
    expect(normalizeSize("xl")).toBe("Xlarge");
    expect(normalizeSize("xxl")).toBe("XXL");
    expect(normalizeSize("2XL")).toBe("XXL");
    expect(normalizeSize("3xl")).toBe("3XL");
    expect(normalizeSize("4xl")).toBe("4XL");
  });
  it("preserves numeric sizes", () => {
    expect(normalizeSize("30")).toBe("30");
    expect(normalizeSize("32")).toBe("32");
  });
  it("preserves unrecognized sizes", () => {
    expect(normalizeSize("One Size")).toBe("One Size");
  });
});

describe("sizeSort", () => {
  it("sorts numeric sizes numerically", () => {
    const sizes = ["32", "28", "36", "30"];
    expect(sizes.sort(sizeSort)).toEqual(["28", "30", "32", "36"]);
  });
  it("sorts alpha sizes in order", () => {
    const sizes = ["Large", "Small", "Xlarge", "Medium"];
    expect(sizes.sort(sizeSort)).toEqual(["Small", "Medium", "Large", "Xlarge"]);
  });
  it("puts numeric before alpha", () => {
    const sorted = ["Small", "30"].sort(sizeSort);
    expect(sorted[0]).toBe("30");
  });
});

describe("milestoneUid", () => {
  it("starts with ms_ prefix", () => {
    expect(milestoneUid().startsWith("ms_")).toBe(true);
  });
  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => milestoneUid()));
    expect(ids.size).toBe(100);
  });
});

describe("fmtDate", () => {
  it("formats date as MM/DD/YYYY", () => {
    // Use ISO format with time to avoid timezone shifts
    expect(fmtDate("2026-03-05T12:00:00")).toBe("03/05/2026");
  });
  it("returns dash for empty input", () => {
    expect(fmtDate()).toBe("—");
    expect(fmtDate("")).toBe("—");
  });
  it("returns original for invalid date", () => {
    expect(fmtDate("garbage")).toBe("garbage");
  });
});

describe("fmtCurrency", () => {
  it("formats as USD", () => {
    expect(fmtCurrency(1234.56)).toBe("$1,234.56");
  });
  it("returns dash for null/undefined", () => {
    expect(fmtCurrency()).toBe("—");
    expect(fmtCurrency(null as any)).toBe("—");
  });
});

describe("mapXoroRaw", () => {
  it("maps raw Xoro data to XoroPO format", () => {
    const raw = [{
      poHeader: {
        OrderNumber: "PO123",
        VendorName: "Test Vendor",
        DateOrder: "2026-01-01",
        StatusName: "Open",
      },
      poLines: [
        { PoItemNumber: "SKU-1", Description: "Item 1", QtyOrder: 100, UnitPrice: 50 },
      ],
    }];
    const result = mapXoroRaw(raw);
    expect(result).toHaveLength(1);
    expect(result[0].PoNumber).toBe("PO123");
    expect(result[0].VendorName).toBe("Test Vendor");
    expect(result[0].Items).toHaveLength(1);
    expect(result[0].Items![0].ItemNumber).toBe("SKU-1");
    expect(result[0].Items![0].QtyOrder).toBe(100);
  });

  it("calculates QtyRemaining", () => {
    const raw = [{
      poHeader: { OrderNumber: "PO1" },
      poLines: [{ QtyOrder: 100, QtyReceived: 30 }],
    }];
    const result = mapXoroRaw(raw);
    expect(result[0].Items![0].QtyRemaining).toBe(70);
  });
});
