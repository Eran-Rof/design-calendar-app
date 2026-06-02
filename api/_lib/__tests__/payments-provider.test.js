// Tests for the P7-1 payment provider resolver + interface skeleton.

import { describe, it, expect } from "vitest";
import { NORMALIZED_EVENTS, PROCESSOR_NAMES, PaymentProviderError } from "../payments/provider.js";
import { getProvider, resolveProviderForCustomer, listProviderStatus } from "../payments/index.js";

describe("provider interface contract", () => {
  it("NORMALIZED_EVENTS is the documented set", () => {
    expect(NORMALIZED_EVENTS).toEqual([
      "charge.succeeded",
      "charge.failed",
      "charge.refunded",
      "charge.disputed",
      "charge.dispute_closed",
      "payout.posted",
    ]);
  });
  it("PROCESSOR_NAMES matches the CHECK constraint values", () => {
    expect(PROCESSOR_NAMES).toEqual(["stripe", "square", "authnet"]);
  });
  it("PaymentProviderError carries kind/code/status", () => {
    const e = new PaymentProviderError("bad", { kind: "card_declined", code: "X", status: 402 });
    expect(e.kind).toBe("card_declined");
    expect(e.code).toBe("X");
    expect(e.status).toBe(402);
    expect(e.name).toBe("PaymentProviderError");
  });
});

describe("resolveProviderForCustomer", () => {
  it("picks per-customer override first", () => {
    expect(resolveProviderForCustomer({ payment_processor: "square" }, { default_payment_processor: "stripe" })).toBe("square");
  });
  it("falls back to entity default", () => {
    expect(resolveProviderForCustomer({}, { default_payment_processor: "authnet" })).toBe("authnet");
  });
  it("ROF-fallback to 'stripe' when neither set", () => {
    expect(resolveProviderForCustomer({}, {})).toBe("stripe");
    expect(resolveProviderForCustomer(null, null)).toBe("stripe");
  });
  it("ignores unknown processor names", () => {
    expect(resolveProviderForCustomer({ payment_processor: "venmo" }, {})).toBe("stripe");
    expect(resolveProviderForCustomer({}, { default_payment_processor: "paypal" })).toBe("stripe");
  });
});

describe("getProvider", () => {
  it("rejects unknown provider names", () => {
    expect(() => getProvider("venmo")).toThrow(/Unknown payment provider/);
  });
  it("rejects providers not yet implemented", () => {
    // None implemented in P7-1; P7-2 will land Stripe.
    expect(() => getProvider("stripe")).toThrow(/not yet implemented/);
    expect(() => getProvider("square")).toThrow(/not yet implemented/);
    expect(() => getProvider("authnet")).toThrow(/not yet implemented/);
  });
});

describe("listProviderStatus", () => {
  it("returns implemented + configured booleans for each known provider", () => {
    const out = listProviderStatus();
    expect(out.length).toBe(3);
    expect(out.map((p) => p.name).sort()).toEqual(["authnet", "square", "stripe"]);
    for (const p of out) {
      expect(p.implemented).toBe(false);
      expect(p.configured).toBe(false);
    }
  });
});
