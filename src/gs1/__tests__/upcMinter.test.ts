import { describe, it, expect } from "vitest";
// The UPC-A minter is shared server-side under api/_lib so the style-master
// create handler can use it. These tests cover the check-digit math, the
// 12-digit layout, range guards, and the uniqueness property of the counter.
import {
  upcACheckDigit,
  buildUpcA,
  buildUpcAFromSettings,
  validateUpcA,
  maxUpcItemReference,
} from "../../../api/_lib/gs1/upc.js";

describe("upcACheckDigit", () => {
  it("computes a known UPC-A check digit", () => {
    // 03600029145 → check digit 2 → "036000291452" (classic GS1 example)
    expect(upcACheckDigit("03600029145")).toBe(2);
  });

  it("returns 0 when the weighted sum is divisible by 10", () => {
    expect(upcACheckDigit("00000000000")).toBe(0);
  });

  it("throws on wrong length or non-numeric", () => {
    expect(() => upcACheckDigit("123")).toThrow();
    expect(() => upcACheckDigit("abcdefghijk")).toThrow();
    expect(() => upcACheckDigit("123456789012")).toThrow(); // 12 digits
  });
});

describe("buildUpcA", () => {
  const PREFIX = "0192401"; // ROF production prefix (length 7)
  const LEN = 7;

  it("builds a valid 12-digit UPC-A that round-trips through validateUpcA", () => {
    const upc = buildUpcA(PREFIX, LEN, 1);
    expect(upc).toHaveLength(12);
    expect(/^\d{12}$/.test(upc)).toBe(true);
    expect(upc.startsWith(PREFIX)).toBe(true);
    expect(validateUpcA(upc)).toBe(true);
  });

  it("zero-pads the item reference to fill the remaining digits", () => {
    // prefix len 7 → 4 ref digits → "0001"
    const upc = buildUpcA(PREFIX, LEN, 1);
    expect(upc.slice(0, 11)).toBe("01924010001");
  });

  it("produces a DISTINCT, valid UPC for every distinct reference (uniqueness)", () => {
    const seen = new Set<string>();
    for (let ref = 1; ref <= 500; ref++) {
      const upc = buildUpcA(PREFIX, LEN, ref);
      expect(validateUpcA(upc)).toBe(true);
      expect(seen.has(upc)).toBe(false); // never collides
      seen.add(upc);
    }
    expect(seen.size).toBe(500);
  });

  it("rejects an item reference that does not fit the prefix width", () => {
    // len 7 → 4 ref digits → max 9999
    expect(maxUpcItemReference(LEN)).toBe(9999);
    expect(() => buildUpcA(PREFIX, LEN, 10000)).toThrow();
    expect(() => buildUpcA(PREFIX, LEN, 0)).toThrow();
  });

  it("rejects a prefix whose length disagrees with prefixLength", () => {
    expect(() => buildUpcA("019240", LEN, 1)).toThrow();
  });

  it("rejects a prefix length that leaves no room for a reference", () => {
    expect(() => buildUpcA("01234567890", 11, 1)).toThrow();
  });

  it("builds from a company_settings-shaped object", () => {
    const upc = buildUpcAFromSettings({ gs1_prefix: PREFIX, prefix_length: LEN }, 42);
    expect(validateUpcA(upc)).toBe(true);
    expect(upc.slice(0, 11)).toBe("01924010042");
  });
});

describe("validateUpcA", () => {
  it("rejects malformed strings", () => {
    expect(validateUpcA("12345")).toBe(false);
    expect(validateUpcA("abcdefghijkl")).toBe(false);
    expect(validateUpcA("036000291453")).toBe(false); // wrong check digit
  });
});
