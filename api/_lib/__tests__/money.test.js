// Tests for the decimal-safe money helper used across vendor-portal
// handlers (invoice POST/PATCH, RFQ quotes, EDI outbound).

import { describe, it, expect } from "vitest";
import { toMoneyString, isAbsent, MoneyError } from "../money.js";

describe("toMoneyString", () => {
  describe("returns null for absent values", () => {
    it("null", () => expect(toMoneyString(null)).toBeNull());
    it("undefined", () => expect(toMoneyString(undefined)).toBeNull());
    it('empty string ""', () => expect(toMoneyString("")).toBeNull());
  });

  describe("accepts canonical decimal strings", () => {
    it.each([
      "0",
      "1",
      "1.5",
      "12.34",
      "1234567890.1234",
      "-1",
      "-12.34",
      "-0.0001",
    ])("%s", (input) => {
      expect(toMoneyString(input)).toBe(input);
    });
  });

  describe("converts numbers to canonical strings", () => {
    it("integer", () => expect(toMoneyString(42)).toBe("42"));
    it("float", () => expect(toMoneyString(12.34)).toBe("12.34"));
    it("zero", () => expect(toMoneyString(0)).toBe("0"));
  });

  describe("trims whitespace before validating", () => {
    it("leading/trailing spaces", () => expect(toMoneyString("  12.34  ")).toBe("12.34"));
  });

  describe("rejects garbage", () => {
    it.each([
      "1,234.56",          // thousand separator
      "$12.34",            // currency glyph
      "12.34 USD",         // suffix
      "abc",
      "12..34",
      "1.23456",           // > 4 decimal places
      "(123.45)",          // accountant negative
      "12 34.56",          // space mid-number
      "Infinity",
      "NaN",
    ])("%s", (input) => {
      expect(() => toMoneyString(input, "amount")).toThrow(MoneyError);
    });

    it("rejects non-finite numbers", () => {
      expect(() => toMoneyString(Infinity, "x")).toThrow(MoneyError);
      expect(() => toMoneyString(-Infinity, "x")).toThrow(MoneyError);
      expect(() => toMoneyString(NaN, "x")).toThrow(MoneyError);
    });
  });

  describe("error includes the field name", () => {
    it("propagates fieldName into the error", () => {
      try {
        toMoneyString("garbage", "subtotal");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(MoneyError);
        expect(e.message).toMatch(/subtotal/);
        expect(e.field).toBe("subtotal");
        expect(e.code).toBe("INVALID_MONEY");
      }
    });
  });
});

describe("isAbsent", () => {
  it.each([
    [null, true],
    [undefined, true],
    ["", true],
    [0, false],
    ["0", false],
    ["12.34", false],
    [false, false],
  ])("isAbsent(%p) === %p", (input, expected) => {
    expect(isAbsent(input)).toBe(expected);
  });
});
