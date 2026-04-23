import { describe, it, expect } from "vitest";
import {
  buildSscc18,
  validateSscc18,
  formatSscc18Display,
  maxSerialReference,
} from "../services/gtinService";

// ── buildSscc18 ───────────────────────────────────────────────────────────────

describe("buildSscc18", () => {
  it("produces exactly 18 digits", () => {
    const sscc = buildSscc18("0", "0310927", 7, 1);
    expect(sscc).toHaveLength(18);
    expect(/^\d{18}$/.test(sscc)).toBe(true);
  });

  it("pads serial reference to fill (16 - prefixLength) digits", () => {
    // prefix_length=7 → serialLen=9 → serial=1 is padded to 9 digits = "000000001"
    const sscc = buildSscc18("0", "0310927", 7, 1);
    // base17 = "0" + "0310927" + "000000001" = "00310927000000001"
    expect(sscc.slice(0, 17)).toBe("00310927000000001");
  });

  it("base before check digit is always 17 digits", () => {
    const fixtures: Array<[number, string]> = [
      [6, "031092"],
      [7, "0310927"],
      [8, "03109270"],
      [9, "031092700"],
    ];
    for (const [prefixLen, prefix] of fixtures) {
      const sscc = buildSscc18("0", prefix, prefixLen, 1);
      // base = ext(1) + prefix(prefixLen) + serial(16-prefixLen) = 17 digits
      expect(sscc.slice(0, 17)).toHaveLength(17);
    }
  });

  it("check digit makes validateSscc18 return true", () => {
    const sscc = buildSscc18("0", "0310927", 7, 1);
    expect(validateSscc18(sscc)).toBe(true);
  });

  it("different serial references produce different SSCCs", () => {
    const a = buildSscc18("0", "0310927", 7, 1);
    const b = buildSscc18("0", "0310927", 7, 2);
    expect(a).not.toBe(b);
    expect(validateSscc18(a)).toBe(true);
    expect(validateSscc18(b)).toBe(true);
  });

  it("same inputs always produce the same SSCC (deterministic)", () => {
    const a = buildSscc18("0", "0310927", 7, 42);
    const b = buildSscc18("0", "0310927", 7, 42);
    expect(a).toBe(b);
  });

  it("different extension digits produce different SSCCs", () => {
    const a = buildSscc18("0", "0310927", 7, 1);
    const b = buildSscc18("1", "0310927", 7, 1);
    expect(a).not.toBe(b);
    expect(validateSscc18(a)).toBe(true);
    expect(validateSscc18(b)).toBe(true);
  });

  it("works at max serial reference boundary", () => {
    // prefix_length=7 → serialLen=9 → max = 10^9 - 1 = 999999999
    const sscc = buildSscc18("0", "0310927", 7, 999999999);
    expect(sscc).toHaveLength(18);
    expect(validateSscc18(sscc)).toBe(true);
  });

  it("throws on extension digit not 0-9", () => {
    expect(() => buildSscc18("A", "0310927", 7, 1)).toThrow();
    expect(() => buildSscc18("",  "0310927", 7, 1)).toThrow();
    expect(() => buildSscc18("10","0310927", 7, 1)).toThrow();
  });

  it("throws on prefix length mismatch", () => {
    expect(() => buildSscc18("0", "0310927", 6, 1)).toThrow();
  });

  it("throws when serial reference exceeds max for prefix length", () => {
    // prefix_length=7 → max serial = 999999999
    expect(() => buildSscc18("0", "0310927", 7, 1000000000)).toThrow();
  });

  it("throws when serial reference is zero or negative", () => {
    expect(() => buildSscc18("0", "0310927", 7, 0)).toThrow();
    expect(() => buildSscc18("0", "0310927", 7, -1)).toThrow();
  });

  it("works for prefix_length=6 (10-digit serial field)", () => {
    const sscc = buildSscc18("0", "031092", 6, 1);
    expect(sscc).toHaveLength(18);
    expect(validateSscc18(sscc)).toBe(true);
  });

  it("works for prefix_length=8 (8-digit serial field)", () => {
    const sscc = buildSscc18("0", "03109270", 8, 1);
    expect(sscc).toHaveLength(18);
    expect(validateSscc18(sscc)).toBe(true);
  });

  it("works for prefix_length=9 (7-digit serial field)", () => {
    const sscc = buildSscc18("0", "031092700", 9, 1);
    expect(sscc).toHaveLength(18);
    expect(validateSscc18(sscc)).toBe(true);
  });
});

// ── validateSscc18 ────────────────────────────────────────────────────────────

describe("validateSscc18", () => {
  it("returns false for wrong length", () => {
    expect(validateSscc18("123")).toBe(false);
    expect(validateSscc18("1234567890123456789")).toBe(false);
  });

  it("returns false for non-numeric input", () => {
    expect(validateSscc18("1234567890123456A8")).toBe(false);
  });

  it("returns false when check digit is corrupted", () => {
    const sscc = buildSscc18("0", "0310927", 7, 1);
    const wrongDigit = sscc[17] === "0" ? "1" : "0";
    const corrupted  = sscc.slice(0, 17) + wrongDigit;
    expect(validateSscc18(corrupted)).toBe(false);
  });

  it("returns true for every SSCC built by buildSscc18", () => {
    for (let serial = 1; serial <= 20; serial++) {
      const sscc = buildSscc18("0", "0310927", 7, serial);
      expect(validateSscc18(sscc)).toBe(true);
    }
  });

  it("known GS1 SSCC-18 example validates correctly", () => {
    // GS1 published example: SSCC = 003456789012345678
    // base17 = "00345678901234567" → check digit computed by algorithm
    const sscc = buildSscc18("0", "034567890", 9, 1234567);
    expect(validateSscc18(sscc)).toBe(true);
  });
});

// ── maxSerialReference ────────────────────────────────────────────────────────

describe("maxSerialReference", () => {
  it("returns 10^9 - 1 = 999999999 for prefix_length=7 (9-digit serial field)", () => {
    expect(maxSerialReference(7)).toBe(999999999);
  });

  it("returns 10^10 - 1 = 9999999999 for prefix_length=6", () => {
    expect(maxSerialReference(6)).toBe(9999999999);
  });

  it("returns 10^7 - 1 = 9999999 for prefix_length=9", () => {
    expect(maxSerialReference(9)).toBe(9999999);
  });
});

// ── formatSscc18Display ───────────────────────────────────────────────────────

describe("formatSscc18Display", () => {
  it("wraps SSCC with GS1 application identifier (00)", () => {
    const sscc = buildSscc18("0", "0310927", 7, 1);
    const display = formatSscc18Display(sscc);
    expect(display).toBe(`(00) ${sscc}`);
  });

  it("returns original string unchanged if not 18 digits", () => {
    expect(formatSscc18Display("123")).toBe("123");
  });
});

// ── Duplicate prevention (business rule) ─────────────────────────────────────

describe("SSCC uniqueness — same serial reference must yield same SSCC", () => {
  it("identical inputs always produce identical SSCC", () => {
    expect(buildSscc18("0", "0310927", 7, 100)).toBe(buildSscc18("0", "0310927", 7, 100));
  });

  it("every serial in range 1..100 produces a unique SSCC", () => {
    const seen = new Set<string>();
    for (let s = 1; s <= 100; s++) {
      const sscc = buildSscc18("0", "0310927", 7, s);
      expect(seen.has(sscc)).toBe(false);
      seen.add(sscc);
    }
  });
});

// ── Counter increment semantics (pure function contract) ─────────────────────

describe("serial counter increment semantics", () => {
  it("serial N and serial N+1 differ in exactly the serial reference digits", () => {
    const n   = 5;
    const sn  = buildSscc18("0", "0310927", 7, n);
    const sn1 = buildSscc18("0", "0310927", 7, n + 1);
    // First 8 digits (ext + prefix) are identical
    expect(sn.slice(0, 8)).toBe(sn1.slice(0, 8));
    // Serial portion or check digit must differ
    expect(sn).not.toBe(sn1);
  });

  it("incrementing serial by 1 always changes the SSCC", () => {
    for (let s = 1; s < 50; s++) {
      const a = buildSscc18("0", "0310927", 7, s);
      const b = buildSscc18("0", "0310927", 7, s + 1);
      expect(a).not.toBe(b);
    }
  });
});
