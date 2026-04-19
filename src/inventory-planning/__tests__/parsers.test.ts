import { describe, it, expect } from "vitest";
import {
  toOptionalNumber,
  toOptionalString,
  toNumberOrZero,
  toIsoDate,
  toIsoDateTime,
  toBool,
} from "../mapping/parsers";

describe("toOptionalNumber", () => {
  it("handles string numbers with commas", () => {
    expect(toOptionalNumber("1,234.5")).toBe(1234.5);
  });
  it("returns null for empty / bad", () => {
    expect(toOptionalNumber("")).toBeNull();
    expect(toOptionalNumber("abc")).toBeNull();
    expect(toOptionalNumber(null)).toBeNull();
  });
  it("passes through numbers", () => {
    expect(toOptionalNumber(42)).toBe(42);
  });
});

describe("toNumberOrZero", () => {
  it("defaults to 0", () => {
    expect(toNumberOrZero(null)).toBe(0);
    expect(toNumberOrZero("")).toBe(0);
  });
});

describe("toOptionalString", () => {
  it("trims and returns null for blank", () => {
    expect(toOptionalString("  hi  ")).toBe("hi");
    expect(toOptionalString("   ")).toBeNull();
  });
});

describe("toIsoDate", () => {
  it("accepts YYYY-MM-DD fast path", () => {
    expect(toIsoDate("2026-04-19")).toBe("2026-04-19");
  });
  it("parses Xoro-style datetime", () => {
    expect(toIsoDate("2026-04-19 12:34:56")).toBe("2026-04-19");
  });
  it("returns null for garbage", () => {
    expect(toIsoDate("not a date")).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });
});

describe("toIsoDateTime", () => {
  it("returns ISO datetime", () => {
    const v = toIsoDateTime("2026-04-19T12:00:00Z");
    expect(v).toMatch(/^2026-04-19T12:00:00/);
  });
});

describe("toBool", () => {
  it("maps common truthy strings", () => {
    expect(toBool("true")).toBe(true);
    expect(toBool("YES")).toBe(true);
    expect(toBool("active")).toBe(true);
    expect(toBool("false")).toBe(false);
    expect(toBool("no")).toBe(false);
  });
  it("uses fallback when uninterpretable", () => {
    expect(toBool("maybe", true)).toBe(true);
  });
});
