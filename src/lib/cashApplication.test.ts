import { describe, it, expect } from "vitest";
import {
  parseArInvoiceRef,
  parseApBillPayment,
  magnitudeCents,
  allocateInvoiceApplications,
  overApplicationCents,
} from "./cashApplication";

describe("parseArInvoiceRef", () => {
  it("extracts the invoice number from an exact ref leg", () => {
    expect(parseArInvoiceRef("Invoice Ref # ROF-I000390")).toBe("ROF-I000390");
    expect(parseArInvoiceRef("Invoice Ref #   ROF-I000392  ")).toBe("ROF-I000392");
  });
  it("returns null for the cash leg, blanks and dilution legs", () => {
    // Multi-invoice cash leg (SO|invoice pairs) — not an application leg.
    expect(parseArInvoiceRef("ROF-S000031|ROF-I000390,ROF-S000331|ROF-I000392")).toBeNull();
    expect(parseArInvoiceRef("")).toBeNull();
    expect(parseArInvoiceRef("Invoice Ref # ")).toBeNull();
    expect(parseArInvoiceRef(null)).toBeNull();
    expect(parseArInvoiceRef(undefined)).toBeNull();
    expect(parseArInvoiceRef("4100 Dilution:Chargebacks - Macy's 491")).toBeNull();
  });
});

describe("parseApBillPayment", () => {
  it("extracts bill number and paid cents (magnitude) from a bill-payment leg", () => {
    expect(parseApBillPayment("|Bill# ROF-B000055 Amount Paid 107782.7")).toEqual({
      billNumber: "ROF-B000055",
      amountPaidCents: 10778270,
    });
  });
  it("handles a bill number with internal spaces via the non-greedy stop at Amount Paid", () => {
    expect(parseApBillPayment("Bill# INV 12 34 Amount Paid 10.00")).toEqual({
      billNumber: "INV 12 34",
      amountPaidCents: 1000,
    });
  });
  it("returns null when the memo is not a bill-payment leg", () => {
    expect(parseApBillPayment(" ")).toBeNull();
    expect(parseApBillPayment("Bank Leumi  7801 Main")).toBeNull();
    expect(parseApBillPayment(null)).toBeNull();
    expect(parseApBillPayment("Bill#  Amount Paid 5.00")).toBeNull();
  });
});

describe("magnitudeCents", () => {
  it("rounds absolute dollars to integer cents", () => {
    expect(magnitudeCents(-19953)).toBe(1995300);
    expect(magnitudeCents(17275.2)).toBe(1727520);
    expect(magnitudeCents("-107782.7")).toBe(10778270);
    expect(magnitudeCents(null)).toBe(0);
    expect(magnitudeCents("n/a")).toBe(0);
  });
});

describe("allocateInvoiceApplications", () => {
  it("applies fully when legs fit under the invoice total", () => {
    const out = allocateInvoiceApplications([6000, 4000], 10000);
    expect(out).toEqual([
      { appliedCents: 6000, parkedCents: 0 },
      { appliedCents: 4000, parkedCents: 0 },
    ]);
  });

  it("parks the excess when cumulative legs exceed the invoice total (multi-payment)", () => {
    // total 100.00; legs 60 / 60 / 10 → 60 applied, 40 applied+20 parked, 10 parked.
    const out = allocateInvoiceApplications([6000, 6000, 1000], 10000);
    expect(out).toEqual([
      { appliedCents: 6000, parkedCents: 0 },
      { appliedCents: 4000, parkedCents: 2000 },
      { appliedCents: 0, parkedCents: 1000 },
    ]);
    const appliedTotal = out.reduce((a, l) => a + l.appliedCents, 0);
    expect(appliedTotal).toBe(10000); // never exceeds the invoice total
  });

  it("a single over-sized payment is clamped to the total, remainder parked", () => {
    const out = allocateInvoiceApplications([12000], 10000);
    expect(out).toEqual([{ appliedCents: 10000, parkedCents: 2000 }]);
  });

  it("empty legs → empty allocation", () => {
    expect(allocateInvoiceApplications([], 10000)).toEqual([]);
  });
});

describe("overApplicationCents", () => {
  it("reports the excess over the invoice total, floored at zero", () => {
    expect(overApplicationCents([6000, 6000], 10000)).toBe(2000);
    expect(overApplicationCents([6000, 3000], 10000)).toBe(0);
    expect(overApplicationCents([], 10000)).toBe(0);
  });
});
