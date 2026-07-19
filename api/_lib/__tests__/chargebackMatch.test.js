import { describe, it, expect } from "vitest";
import {
  normalizeAlnum,
  numericSuffix,
  invoiceSuffix,
  buildInvoiceIndex,
  matchChargeback,
  aggregateDilution,
  isFactorChurnChargeback,
  resolveDrillRow,
  drillRowInGroup,
  drillRowInMeasure,
  drillMeasureCents,
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

  it("excludes factor-churn rows from chargeback/net/dilution, tracks excluded_cents", () => {
    const churnRows = [
      { group: "cust-1", label: "Backstage", amount_cents: 100_00 },                    // real deduction
      { group: "cust-1", label: "Backstage", amount_cents: 2341200, excluded: true },   // 610 churn — full invoice
      { group: "cust-1", label: "Backstage", amount_cents: -10_00 },                    // creditback
    ];
    const out = aggregateDilution(churnRows, { "cust-1": 1_000_00 });
    const c1 = out.find((r) => r.group === "cust-1");
    expect(c1.chargeback_cents).toBe(100_00);     // churn NOT counted
    expect(c1.excluded_cents).toBe(2341200);      // tracked separately
    expect(c1.creditback_cents).toBe(-10_00);
    expect(c1.net_cents).toBe(90_00);             // churn NOT in net
    expect(c1.dilution_pct).toBe(10);             // 100_00 / 1_000_00, churn-free
    expect(c1.count).toBe(3);
  });
});

describe("isFactorChurnChargeback", () => {
  it("flags Rosenthal Manual Charge Back (code 610)", () => {
    expect(isFactorChurnChargeback({ reason_code: "610", reason: "Manual Charge Back" })).toBe(true);
    expect(isFactorChurnChargeback({ reason_code: 610 })).toBe(true);
    expect(isFactorChurnChargeback({ reason_code: " 610 " })).toBe(true);
  });
  it("flags on the reason text alone (defensive)", () => {
    expect(isFactorChurnChargeback({ reason_code: null, reason: "Manual Charge Back" })).toBe(true);
    expect(isFactorChurnChargeback({ reason: "MANUAL CHARGEBACK" })).toBe(true);
  });
  it("does NOT flag ordinary customer deductions", () => {
    expect(isFactorChurnChargeback({ reason_code: "597", reason: "Short Pay" })).toBe(false);
    expect(isFactorChurnChargeback({ reason_code: null, reason: null })).toBe(false);
    expect(isFactorChurnChargeback(null)).toBe(false);
  });
});

// ── Drill-through helpers (#1744 audit drill) ────────────────────────────────
describe("resolveDrillRow", () => {
  const reasonById = new Map([["rc-short", { id: "rc-short", code: "shortpay" }]]);

  it("resolves the effective customer, period, reason group and churn flag", () => {
    const rr = resolveDrillRow(
      { id: "cb-1", customer_id: "cust-1", report_month: "2026-03-01", amount_cents: 100_00, reason_code_id: "rc-short" },
      reasonById,
    );
    expect(rr).toEqual({ id: "cb-1", cid: "cust-1", period: "2026-03", amount: 100_00, excluded: false, reason_group: "shortpay" });
  });

  it("falls back to the matched invoice's customer when the row has none", () => {
    const rr = resolveDrillRow(
      { id: "cb-2", customer_id: null, matched: { customer_id: "cust-9" }, report_month: "2026-04-01", amount_cents: -5_00 },
      reasonById,
    );
    expect(rr.cid).toBe("cust-9");
    expect(rr.period).toBe("2026-04");
    expect(rr.reason_group).toBe("__uncoded__");
  });

  it("flags factor churn with the dedicated reason group", () => {
    const rr = resolveDrillRow(
      { id: "cb-3", customer_id: "cust-1", report_month: "2026-04-01", amount_cents: 900_00, reason_code: "610" },
      reasonById,
    );
    expect(rr.excluded).toBe(true);
    expect(rr.reason_group).toBe("__factor_churn__");
  });
});

describe("drillRowInGroup", () => {
  const rr = { id: "x", cid: "cust-1", period: "2026-03", amount: 10, excluded: false, reason_group: "shortpay" };
  it("matches each facet on its key", () => {
    expect(drillRowInGroup(rr, "total", "")).toBe(true);
    expect(drillRowInGroup(rr, "customer", "cust-1")).toBe(true);
    expect(drillRowInGroup(rr, "customer", "cust-2")).toBe(false);
    expect(drillRowInGroup(rr, "customer_month", "cust-1|2026-03")).toBe(true);
    expect(drillRowInGroup(rr, "customer_month", "cust-1|2026-04")).toBe(false);
    expect(drillRowInGroup(rr, "month", "2026-03")).toBe(true);
    expect(drillRowInGroup(rr, "reason", "shortpay")).toBe(true);
    expect(drillRowInGroup(rr, "reason", "freight")).toBe(false);
  });
  it("a null-customer row never joins a customer facet", () => {
    expect(drillRowInGroup({ ...rr, cid: null }, "customer", "cust-1")).toBe(false);
  });
});

describe("drill measure reconciliation", () => {
  // A realistic mixed set for one customer/month, mirroring dilution semantics.
  const resolved = [
    { id: "a", cid: "c1", period: "2026-03", amount: 100_00, excluded: false, reason_group: "shortpay" },
    { id: "b", cid: "c1", period: "2026-03", amount: 20_00, excluded: false, reason_group: "shortpay" },
    { id: "c", cid: "c1", period: "2026-03", amount: -40_00, excluded: false, reason_group: "__uncoded__" },
    { id: "d", cid: "c1", period: "2026-03", amount: 900_00, excluded: true, reason_group: "__factor_churn__" },
  ];
  const sumFor = (measure) =>
    resolved.filter((r) => drillRowInGroup(r, "customer", "c1") && drillRowInMeasure(r, measure))
      .reduce((acc, r) => acc + drillMeasureCents(r, measure), 0);
  const countFor = (measure) =>
    resolved.filter((r) => drillRowInGroup(r, "customer", "c1") && drillRowInMeasure(r, measure)).length;

  it("chargeback measure sums the positive non-excluded rows (= aggregateDilution chargeback_cents)", () => {
    const agg = aggregateDilution(resolved.map((r) => ({ group: r.cid, amount_cents: r.amount, excluded: r.excluded })), {})[0];
    expect(sumFor("chargeback")).toBe(120_00);
    expect(sumFor("chargeback")).toBe(agg.chargeback_cents);
    expect(countFor("chargeback")).toBe(2);
  });
  it("creditback measure sums the negative non-excluded rows", () => {
    expect(sumFor("creditback")).toBe(-40_00);
    expect(countFor("creditback")).toBe(1);
  });
  it("excluded measure sums only the factor-churn rows", () => {
    expect(sumFor("excluded")).toBe(900_00);
    expect(countFor("excluded")).toBe(1);
  });
  it("net measure sums all non-excluded rows (chargeback + creditback)", () => {
    expect(sumFor("net")).toBe(80_00);
    expect(countFor("net")).toBe(3);
  });
  it("dilution measure reuses the chargeback numerator", () => {
    expect(sumFor("dilution")).toBe(sumFor("chargeback"));
  });
  it("count measure includes every row; matched requires a resolved customer", () => {
    expect(countFor("count")).toBe(4);
    const withUnmatched = [...resolved, { id: "e", cid: null, period: "2026-03", amount: 5_00, excluded: false, reason_group: "__uncoded__" }];
    const matched = withUnmatched.filter((r) => drillRowInMeasure(r, "matched")).length;
    expect(matched).toBe(4);
  });
});
