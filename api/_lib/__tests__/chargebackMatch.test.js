import { describe, it, expect } from "vitest";
import {
  normalizeAlnum,
  numericSuffix,
  invoiceSuffix,
  buildInvoiceIndex,
  matchChargeback,
  aggregateDilution,
} from "../chargebackMatch.js";

describe("normalizeAlnum", () => {
  it("uppercases and strips non-alphanumerics", () => {
    expect(normalizeAlnum("ROF-I141259")).toBe("ROFI141259");
    expect(normalizeAlnum("rofi145992")).toBe("ROFI145992");
    expect(normalizeAlnum("PT-I143371")).toBe("PTI143371");
    expect(normalizeAlnum("0000403555_696759")).toBe("0000403555696759");
  });
  it("handles null/empty", () => {
    expect(normalizeAlnum(null)).toBe("");
    expect(normalizeAlnum("")).toBe("");
  });
});

describe("numericSuffix", () => {
  it("strips leading zeros from a purely numeric item_num", () => {
    expect(numericSuffix("00000010360")).toBe("10360");
    expect(numericSuffix("4525050")).toBe("4525050");
  });
  it("returns null for anything with a non-digit", () => {
    expect(numericSuffix("ROF-I141259")).toBeNull();
    expect(numericSuffix("0000403555_696759")).toBeNull();
    expect(numericSuffix(null)).toBeNull();
  });
  it("returns null for all-zeros", () => {
    expect(numericSuffix("0000")).toBeNull();
  });
});

describe("invoiceSuffix", () => {
  it("extracts the trailing digit-run, leading zeros stripped", () => {
    expect(invoiceSuffix("ROF-I010360")).toBe("10360");
    expect(invoiceSuffix("ROF ECOM-I013379")).toBe("13379");
    expect(invoiceSuffix("PT-I000003")).toBe("3");
  });
  it("returns null when there is no trailing digit run", () => {
    expect(invoiceSuffix("ABC")).toBeNull();
    expect(invoiceSuffix(null)).toBeNull();
  });
});

describe("matchChargeback", () => {
  const invoices = [
    { id: "inv-a", invoice_number: "ROF-I010360" },     // suffix 10360
    { id: "inv-b", invoice_number: "ROF-I141259" },     // alnum ROFI141259
    { id: "inv-c", invoice_number: "PT-I000003" },      // suffix 3
    { id: "inv-dup1", invoice_number: "ROF-I000009" },  // suffix 9
    { id: "inv-dup2", invoice_number: "PT-I000009" },   // suffix 9 -> AMBIGUOUS
  ];
  const index = buildInvoiceIndex(invoices);

  it("matches a zero-padded numeric item_num via the numeric suffix", () => {
    expect(matchChargeback("00000010360", index)).toEqual({ invoiceId: "inv-a", method: "invoice_number_suffix" });
  });

  it("matches a prefixed item_num via alnum exact equality", () => {
    expect(matchChargeback("ROF-I141259", index)).toEqual({ invoiceId: "inv-b", method: "invoice_number_exact" });
    // even without the dash
    expect(matchChargeback("ROFI141259", index)).toEqual({ invoiceId: "inv-b", method: "invoice_number_exact" });
  });

  it("does NOT match an ambiguous numeric suffix (9 → ROF-I000009 and PT-I000009)", () => {
    expect(matchChargeback("00000000009", index)).toBeNull();
    expect(matchChargeback("9", index)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchChargeback("00088166823", index)).toBeNull();  // Macys internal doc #
    expect(matchChargeback("0000403555_696759", index)).toBeNull();
  });

  it("a purely numeric item_num never collides with a prefixed invoice alnum", () => {
    // '10360' alnum is '10360' which is not any invoice's alnum (they carry a prefix)
    expect(matchChargeback("10360", index)).toEqual({ invoiceId: "inv-a", method: "invoice_number_suffix" });
  });
});

describe("buildInvoiceIndex ambiguity", () => {
  it("marks a colliding key as null (ambiguous)", () => {
    const idx = buildInvoiceIndex([
      { id: "x", invoice_number: "ROF-I000009" },
      { id: "y", invoice_number: "PT-I000009" },
    ]);
    expect(idx.bySuffix.get("9")).toBeNull();
  });
  it("keeps a unique key resolvable", () => {
    const idx = buildInvoiceIndex([{ id: "x", invoice_number: "ROF-I010360" }]);
    expect(idx.bySuffix.get("10360")).toBe("x");
  });
});

describe("aggregateDilution", () => {
  const rows = [
    { group: "cust-1", label: "Macys", amount_cents: 100_00 },   // chargeback
    { group: "cust-1", label: "Macys", amount_cents: -40_00 },   // creditback
    { group: "cust-1", label: "Macys", amount_cents: 20_00 },    // chargeback
    { group: "cust-2", label: "Bealls", amount_cents: 50_00 },
  ];
  const gross = { "cust-1": 1_000_00, "cust-2": 500_00 };

  it("splits chargeback vs creditback and computes net", () => {
    const out = aggregateDilution(rows, gross);
    const c1 = out.find((r) => r.group === "cust-1");
    expect(c1.chargeback_cents).toBe(120_00);
    expect(c1.creditback_cents).toBe(-40_00);
    expect(c1.net_cents).toBe(80_00);
    expect(c1.count).toBe(3);
  });

  it("computes dilution % = gross chargeback deductions / gross sales", () => {
    const out = aggregateDilution(rows, gross);
    const c1 = out.find((r) => r.group === "cust-1");
    expect(c1.dilution_pct).toBe(12); // 120_00 / 1_000_00 = 12%
  });

  it("dilution % is null when gross sales are unknown/zero", () => {
    const out = aggregateDilution(rows, {});
    expect(out[0].dilution_pct).toBeNull();
  });

  it("ranks biggest gross-chargeback offender first", () => {
    const out = aggregateDilution(rows, gross);
    expect(out[0].group).toBe("cust-1");
  });

  it("ignores rows with a null group", () => {
    const out = aggregateDilution([{ group: null, amount_cents: 999 }], {});
    expect(out).toHaveLength(0);
  });
});
