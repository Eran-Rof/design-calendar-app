import { describe, it, expect } from "vitest";
import { parseLocalDate, fmtDate, fmtMoney, daysUntil } from "../utils";

describe("parseLocalDate", () => {
  it("parses date-only strings as local midnight", () => {
    const dt = parseLocalDate("2026-05-15");
    expect(dt).not.toBeNull();
    expect(dt!.getFullYear()).toBe(2026);
    expect(dt!.getMonth()).toBe(4); // May, zero-indexed
    expect(dt!.getDate()).toBe(15);
    expect(dt!.getHours()).toBe(0);
    expect(dt!.getMinutes()).toBe(0);
  });

  it("parses full ISO timestamps with the JS default behavior", () => {
    const dt = parseLocalDate("2026-05-15T14:30:00Z");
    expect(dt).not.toBeNull();
    expect(dt!.getTime()).toBe(Date.UTC(2026, 4, 15, 14, 30));
  });

  it("returns null for empty / null / invalid inputs", () => {
    expect(parseLocalDate(undefined)).toBeNull();
    expect(parseLocalDate(null)).toBeNull();
    expect(parseLocalDate("")).toBeNull();
    expect(parseLocalDate("not a date")).toBeNull();
  });
});

describe("fmtDate", () => {
  it("returns em-dash for falsy input", () => {
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate("")).toBe("—");
  });

  it("formats a date-only string as the correct local calendar day", () => {
    // Key regression: in US TZs, "2026-05-15" should render as 5/15 not 5/14.
    // toLocaleDateString format varies by locale, so we check that the day
    // number "15" appears in the output.
    const formatted = fmtDate("2026-05-15");
    expect(formatted).toMatch(/15/);
    expect(formatted).toMatch(/5|May/);
  });

  it("passes through invalid strings unchanged", () => {
    expect(fmtDate("garbage")).toBe("garbage");
  });
});

describe("fmtMoney", () => {
  it("returns em-dash for null / undefined / NaN", () => {
    expect(fmtMoney(undefined)).toBe("—");
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney(Number.NaN)).toBe("—");
  });

  it("formats positive amounts as USD with no cents", () => {
    expect(fmtMoney(173395)).toContain("173,395");
    expect(fmtMoney(173395)).toMatch(/\$/);
    expect(fmtMoney(173395)).not.toMatch(/\.\d/);
  });

  it("formats zero as $0", () => {
    expect(fmtMoney(0)).toContain("0");
    expect(fmtMoney(0)).toMatch(/\$/);
  });
});

describe("daysUntil", () => {
  it("returns null for falsy / invalid input", () => {
    expect(daysUntil(undefined)).toBeNull();
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil("")).toBeNull();
    expect(daysUntil("not a date")).toBeNull();
  });

  it("returns 0 when the date is today (local)", () => {
    const now = new Date(2026, 4, 15, 14, 30); // May 15, 2:30pm local
    expect(daysUntil("2026-05-15", now)).toBe(0);
  });

  it("returns negative numbers for past dates (overdue)", () => {
    const now = new Date(2026, 4, 15, 14, 30);
    expect(daysUntil("2026-05-14", now)).toBe(-1);
    expect(daysUntil("2026-05-10", now)).toBe(-5);
  });

  it("returns positive numbers for future dates", () => {
    const now = new Date(2026, 4, 15, 14, 30);
    expect(daysUntil("2026-05-16", now)).toBe(1);
    expect(daysUntil("2026-05-22", now)).toBe(7);
  });

  it("is stable regardless of the hour of day", () => {
    // Regression: using Date.now() with raw diff caused the result to flip
    // sign as the day progressed. Anchoring to local midnight on both sides
    // keeps the count stable across the whole day.
    const early = new Date(2026, 4, 15, 1, 0);
    const late = new Date(2026, 4, 15, 23, 59);
    expect(daysUntil("2026-05-20", early)).toBe(daysUntil("2026-05-20", late));
  });
});
