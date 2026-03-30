import { describe, it, expect } from "vitest";
import { addDays, fmtDate, fmtDateDisplay, fmtDateShort, isToday, isWeekend, getQtyColor, getQtyBg, xoroSkuToExcel, normalizeSku } from "../helpers";

describe("addDays", () => {
  it("adds positive days", () => {
    const d = new Date("2026-03-30T00:00:00");
    const r = addDays(d, 5);
    expect(r.toISOString().split("T")[0]).toBe("2026-04-04");
  });
  it("subtracts negative days", () => {
    const d = new Date("2026-03-30T00:00:00");
    const r = addDays(d, -10);
    expect(r.toISOString().split("T")[0]).toBe("2026-03-20");
  });
  it("does not mutate original date", () => {
    const d = new Date("2026-01-01T00:00:00");
    addDays(d, 30);
    expect(d.getDate()).toBe(1);
  });
});

describe("fmtDate", () => {
  it("formats date as YYYY-MM-DD", () => {
    const d = new Date("2026-03-05T12:00:00Z");
    expect(fmtDate(d)).toBe("2026-03-05");
  });
});

describe("fmtDateDisplay", () => {
  it("formats ISO date as MMM/DD/YYYY", () => {
    expect(fmtDateDisplay("2026-03-05")).toBe("Mar/05/2026");
  });
  it("returns dash for empty input", () => {
    expect(fmtDateDisplay("")).toBe("—");
  });
  it("returns original for invalid date", () => {
    expect(fmtDateDisplay("not-a-date")).toBe("not-a-date");
  });
});

describe("fmtDateShort", () => {
  it("formats as short month + day", () => {
    const r = fmtDateShort("2026-12-25");
    expect(r).toContain("Dec");
    expect(r).toContain("25");
  });
});

describe("isToday", () => {
  it("returns true for today's date", () => {
    expect(isToday(fmtDate(new Date()))).toBe(true);
  });
  it("returns false for other dates", () => {
    expect(isToday("2020-01-01")).toBe(false);
  });
});

describe("isWeekend", () => {
  it("returns true for Saturday", () => {
    // 2026-03-28 is a Saturday
    expect(isWeekend("2026-03-28")).toBe(true);
  });
  it("returns true for Sunday", () => {
    expect(isWeekend("2026-03-29")).toBe(true);
  });
  it("returns false for Monday", () => {
    expect(isWeekend("2026-03-30")).toBe(false);
  });
});

describe("getQtyColor", () => {
  it("red for zero or negative", () => {
    expect(getQtyColor(0)).toBe("#EF4444");
    expect(getQtyColor(-5)).toBe("#EF4444");
  });
  it("amber for low stock (1-10)", () => {
    expect(getQtyColor(1)).toBe("#F59E0B");
    expect(getQtyColor(10)).toBe("#F59E0B");
  });
  it("blue for moderate (11-50)", () => {
    expect(getQtyColor(11)).toBe("#3B82F6");
    expect(getQtyColor(50)).toBe("#3B82F6");
  });
  it("green for high (>50)", () => {
    expect(getQtyColor(51)).toBe("#10B981");
    expect(getQtyColor(1000)).toBe("#10B981");
  });
});

describe("xoroSkuToExcel", () => {
  it("converts 3-part SKU: strips size, adds spaces", () => {
    expect(xoroSkuToExcel("RYB0185-Black-30")).toBe("RYB0185 - Black");
  });
  it("converts 4-part SKU: strips last part", () => {
    expect(xoroSkuToExcel("RYB059430-Bark-Grey w Tint-32")).toBe("RYB059430 - Bark - Grey w Tint");
  });
  it("handles 2-part SKU", () => {
    expect(xoroSkuToExcel("RYB0185-Black")).toBe("RYB0185 - Black");
  });
  it("returns as-is for single part", () => {
    expect(xoroSkuToExcel("RYB0185")).toBe("RYB0185");
  });
});

describe("normalizeSku", () => {
  it("collapses double spaces around dashes", () => {
    expect(normalizeSku("RYB059430PPK - Bark  -  Grey w Tint")).toBe("RYB059430PPK - Bark - Grey w Tint");
  });
  it("standardizes dash spacing (no space before dash)", () => {
    expect(normalizeSku("RYB059430 - Media Park- Drk Wash")).toBe("RYB059430 - Media Park - Drk Wash");
  });
  it("standardizes dash spacing (extra space after dash)", () => {
    expect(normalizeSku("RYB059430 - MARINE -  MD WASH")).toBe("RYB059430 - Marine - md Wash");
  });
  it("title-cases ALL CAPS color names", () => {
    expect(normalizeSku("RYB0412 - ESPRESSO")).toBe("RYB0412 - Espresso");
  });
  it("title-cases mixed case", () => {
    expect(normalizeSku("RYB059430 - BUENOS AIRES  -  LT WASH")).toBe("RYB059430 - Buenos Aires - lt Wash");
  });
  it("preserves base part as-is", () => {
    expect(normalizeSku("RYB059430PPK - Sandlot - Med Wash")).toBe("RYB059430PPK - Sandlot - Med Wash");
  });
  it("handles already-normalized SKU", () => {
    expect(normalizeSku("RYB059430 - Bark - Grey w Tint")).toBe("RYB059430 - Bark - Grey w Tint");
  });
  it("handles single-part SKU", () => {
    expect(normalizeSku("RYB0185")).toBe("RYB0185");
  });
  it("keeps small words lowercase", () => {
    expect(normalizeSku("RYB059430 - Bark - Grey W Tint")).toBe("RYB059430 - Bark - Grey w Tint");
  });
});
