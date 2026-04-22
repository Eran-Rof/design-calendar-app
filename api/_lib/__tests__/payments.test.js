import { describe, it, expect } from "vitest";
import {
  nextStatus, validatePaymentInput, validatePreferenceInput,
  PAYMENT_STATUSES, PAYMENT_METHODS, PAYMENT_PREF_FX_MODES,
} from "../payments.js";

describe("nextStatus", () => {
  it("allows initiated → processing / cancelled", () => {
    expect(nextStatus("initiated", "processing")).toBe("processing");
    expect(nextStatus("initiated", "cancelled")).toBe("cancelled");
  });
  it("allows processing → completed / failed", () => {
    expect(nextStatus("processing", "completed")).toBe("completed");
    expect(nextStatus("processing", "failed")).toBe("failed");
  });
  it("rejects illegal transitions", () => {
    expect(() => nextStatus("completed", "failed")).toThrow();
    expect(() => nextStatus("initiated", "completed")).toThrow(); // skip processing
    expect(() => nextStatus("cancelled", "processing")).toThrow();
  });
  it("rejects unknown current status", () => {
    expect(() => nextStatus("bogus", "completed")).toThrow();
  });
});

describe("validatePaymentInput", () => {
  it("requires entity_id + vendor_id + positive amount", () => {
    const errs = validatePaymentInput({});
    expect(errs.some((e) => e.includes("entity_id"))).toBe(true);
    expect(errs.some((e) => e.includes("vendor_id"))).toBe(true);
    expect(errs.some((e) => e.includes("amount"))).toBe(true);
  });
  it("skips requirements in partial mode", () => {
    expect(validatePaymentInput({ method: "ach" }, { partial: true })).toEqual([]);
  });
  it("rejects unknown methods and bad currency length", () => {
    expect(validatePaymentInput({ entity_id: "e", vendor_id: "v", amount: 10, method: "crypto" }).some((e) => e.includes("method"))).toBe(true);
    expect(validatePaymentInput({ entity_id: "e", vendor_id: "v", amount: 10, currency: "DOLLAR" }).some((e) => e.includes("currency"))).toBe(true);
  });
  it("accepts all PAYMENT_METHODS", () => {
    for (const m of PAYMENT_METHODS) {
      expect(validatePaymentInput({ entity_id: "e", vendor_id: "v", amount: 10, method: m })).toEqual([]);
    }
  });
});

describe("validatePreferenceInput", () => {
  it("rejects bad currency and unknown method / fx_handling", () => {
    expect(validatePreferenceInput({ preferred_currency: "US" }).some((e) => e.includes("currency"))).toBe(true);
    expect(validatePreferenceInput({ preferred_payment_method: "bitcoin" }).some((e) => e.includes("payment_method"))).toBe(true);
    expect(validatePreferenceInput({ fx_handling: "mystery" }).some((e) => e.includes("fx_handling"))).toBe(true);
  });
  it("accepts every valid fx_handling mode", () => {
    for (const m of PAYMENT_PREF_FX_MODES) {
      expect(validatePreferenceInput({ fx_handling: m })).toEqual([]);
    }
  });
  it("empty body is valid (all fields optional)", () => {
    expect(validatePreferenceInput({})).toEqual([]);
  });
});

describe("PAYMENT_STATUSES", () => {
  it("covers the documented status vocabulary", () => {
    expect(PAYMENT_STATUSES).toEqual(["initiated", "processing", "completed", "failed", "cancelled"]);
  });
});
