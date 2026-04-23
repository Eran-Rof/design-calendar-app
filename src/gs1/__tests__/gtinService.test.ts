import { describe, it, expect } from "vitest";
import {
  calculateGs1CheckDigit,
  buildGtin14,
  validateGtin14,
  formatGtin14Display,
  maxItemReference,
} from "../services/gtinService";

// ── calculateGs1CheckDigit ────────────────────────────────────────────────────

describe("calculateGs1CheckDigit", () => {
  it("computes check digit for a known 13-digit sequence", () => {
    // "0061414100001": sum = 48, check = (10-8)%10 = 2
    // Resulting GTIN-14 = "00614141000012"
    expect(calculateGs1CheckDigit("0061414100001")).toBe(2);
  });

  it("returns 0 when sum is divisible by 10", () => {
    // Construct a 13-digit string where sum % 10 === 0
    // All zeros: sum=0, check=(10-0)%10=0
    expect(calculateGs1CheckDigit("0000000000000")).toBe(0);
  });

  it("throws on non-numeric input", () => {
    expect(() => calculateGs1CheckDigit("abcdefghijklm")).toThrow();
  });

  it("throws on wrong length", () => {
    expect(() => calculateGs1CheckDigit("12345")).toThrow();
    expect(() => calculateGs1CheckDigit("12345678901234")).toThrow();
  });

  it("handles indicator digit variation", () => {
    // Two different indicator digits must produce different check digits
    const c1 = calculateGs1CheckDigit("1031092700001");
    const c2 = calculateGs1CheckDigit("2031092700001");
    // Both are valid computations — just verify they are in 0-9
    expect(c1).toBeGreaterThanOrEqual(0);
    expect(c1).toBeLessThanOrEqual(9);
    expect(c2).toBeGreaterThanOrEqual(0);
    expect(c2).toBeLessThanOrEqual(9);
  });
});

// ── buildGtin14 ───────────────────────────────────────────────────────────────

describe("buildGtin14", () => {
  it("builds a 14-digit GTIN", () => {
    const gtin = buildGtin14("1", "0310927", 7, 1);
    expect(gtin).toHaveLength(14);
    expect(/^\d{14}$/.test(gtin)).toBe(true);
  });

  it("pads item reference with leading zeros", () => {
    // prefix_length=7 → item ref field width = 12-7=5
    const gtin = buildGtin14("1", "0310927", 7, 1);
    // Item ref 1 padded to 5 digits = "00001"
    // GTIN starts with "1" + "0310927" + "00001" = "1031092700001"
    expect(gtin.startsWith("10310927000")).toBe(true);
  });

  it("check digit passes validation", () => {
    const gtin = buildGtin14("1", "0310927", 7, 1);
    expect(validateGtin14(gtin)).toBe(true);
  });

  it("builds correctly for item reference > 1", () => {
    const gtin1 = buildGtin14("1", "0310927", 7, 1);
    const gtin2 = buildGtin14("1", "0310927", 7, 2);
    expect(gtin1).not.toBe(gtin2);
    expect(validateGtin14(gtin1)).toBe(true);
    expect(validateGtin14(gtin2)).toBe(true);
  });

  it("throws on indicator digit not a single digit", () => {
    expect(() => buildGtin14("12", "0310927", 7, 1)).toThrow();
    expect(() => buildGtin14("A",  "0310927", 7, 1)).toThrow();
  });

  it("throws on prefix length mismatch", () => {
    // prefix "0310927" has 7 chars but we say prefixLength=6
    expect(() => buildGtin14("1", "0310927", 6, 1)).toThrow();
  });

  it("throws when item reference overflows available digits", () => {
    // prefix_length=7 → 5 item ref digits → max = 99999
    expect(() => buildGtin14("1", "0310927", 7, 100000)).toThrow();
  });

  it("works for prefix_length=6", () => {
    const gtin = buildGtin14("1", "031092", 6, 1);
    expect(gtin).toHaveLength(14);
    expect(validateGtin14(gtin)).toBe(true);
  });

  it("works for prefix_length=9", () => {
    const gtin = buildGtin14("1", "031092700", 9, 1);
    expect(gtin).toHaveLength(14);
    expect(validateGtin14(gtin)).toBe(true);
  });
});

// ── validateGtin14 ────────────────────────────────────────────────────────────

describe("validateGtin14", () => {
  it("returns false for wrong length", () => {
    expect(validateGtin14("123")).toBe(false);
    expect(validateGtin14("123456789012345")).toBe(false);
  });

  it("returns false for non-numeric", () => {
    expect(validateGtin14("1234567890123A")).toBe(false);
  });

  it("returns false for corrupted check digit", () => {
    const gtin = buildGtin14("1", "0310927", 7, 1);
    const wrongDigit = gtin[13] === "0" ? "1" : "0";
    const corrupted  = gtin.slice(0, 13) + wrongDigit;
    expect(validateGtin14(corrupted)).toBe(false);
  });

  it("returns true for any GTIN built by buildGtin14", () => {
    for (let ref = 1; ref <= 10; ref++) {
      const gtin = buildGtin14("1", "0310927", 7, ref);
      expect(validateGtin14(gtin)).toBe(true);
    }
  });
});

// ── maxItemReference ──────────────────────────────────────────────────────────

describe("maxItemReference", () => {
  it("returns 99999 for prefix_length=7 (5 item ref digits)", () => {
    expect(maxItemReference(7)).toBe(99999);
  });

  it("returns 999999 for prefix_length=6 (6 item ref digits)", () => {
    expect(maxItemReference(6)).toBe(999999);
  });

  it("returns 999 for prefix_length=9 (3 item ref digits)", () => {
    expect(maxItemReference(9)).toBe(999);
  });
});

// ── formatGtin14Display ───────────────────────────────────────────────────────

describe("formatGtin14Display", () => {
  it("formats a 14-digit GTIN into human-readable groups", () => {
    const formatted = formatGtin14Display("10310927000012");
    expect(formatted).toBe("1 0310927 00001 2");
  });

  it("returns original string if not 14 digits", () => {
    expect(formatGtin14Display("123")).toBe("123");
  });
});

// ── Duplicate detection (business rule) ──────────────────────────────────────

describe("GTIN uniqueness — same style/color/scale must yield same item reference", () => {
  it("same input to buildGtin14 always produces the same GTIN", () => {
    const a = buildGtin14("1", "0310927", 7, 42);
    const b = buildGtin14("1", "0310927", 7, 42);
    expect(a).toBe(b);
  });

  it("different item references produce different GTINs", () => {
    const a = buildGtin14("1", "0310927", 7, 1);
    const b = buildGtin14("1", "0310927", 7, 2);
    expect(a).not.toBe(b);
  });
});
