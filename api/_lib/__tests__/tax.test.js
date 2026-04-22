import { describe, it, expect } from "vitest";
import {
  selectApplicableRules, filterByThreshold, filterByVendorExemptions,
  calculateTaxForInvoice, aggregateRemittance, TAX_TYPES,
} from "../tax.js";

const rule = (over = {}) => ({
  id: "r", jurisdiction: "US-CA", tax_type: "sales_tax", rate_pct: 7.25,
  applies_to: "all", threshold_amount: null, vendor_type_exemptions: [],
  is_active: true, effective_from: "2026-01-01", effective_to: null,
  ...over,
});

describe("selectApplicableRules", () => {
  const now = new Date("2026-04-19T00:00:00Z");
  const rules = [
    rule({ id: "active-ca" }),
    rule({ id: "inactive", is_active: false }),
    rule({ id: "other-juris", jurisdiction: "US-NY" }),
    rule({ id: "goods-only", applies_to: "goods" }),
    rule({ id: "too-early", effective_from: "2026-06-01" }),
    rule({ id: "expired", effective_to: "2026-03-31" }),
  ];

  it("filters by jurisdiction + is_active + effective window", () => {
    const out = selectApplicableRules(rules, { jurisdiction: "US-CA", effectiveDate: now });
    expect(out.map((r) => r.id)).toEqual(["active-ca"]);
  });
  it("applies_to='all' is universal; rule.applies_to must match otherwise", () => {
    const goods = selectApplicableRules(rules, { jurisdiction: "US-CA", appliesTo: "goods", effectiveDate: now });
    expect(goods.map((r) => r.id).sort()).toEqual(["active-ca", "goods-only"]);
    const services = selectApplicableRules(rules, { jurisdiction: "US-CA", appliesTo: "services", effectiveDate: now });
    expect(services.map((r) => r.id)).toEqual(["active-ca"]);
  });
});

describe("filterByThreshold", () => {
  it("keeps rules with no threshold, drops those where amount < threshold", () => {
    const rules = [rule({ id: "no-thr" }), rule({ id: "big", threshold_amount: 10000 })];
    expect(filterByThreshold(rules, 5000).map((r) => r.id)).toEqual(["no-thr"]);
    expect(filterByThreshold(rules, 15000).map((r) => r.id).sort()).toEqual(["big", "no-thr"]);
  });
});

describe("filterByVendorExemptions", () => {
  it("drops rules where the vendor's business_types overlap with vendor_type_exemptions", () => {
    const rules = [
      rule({ id: "no-exempt" }),
      rule({ id: "exempt-small", vendor_type_exemptions: ["small_business"] }),
      rule({ id: "exempt-women", vendor_type_exemptions: ["women_owned"] }),
    ];
    const out = filterByVendorExemptions(rules, ["small_business"]);
    expect(out.map((r) => r.id).sort()).toEqual(["exempt-women", "no-exempt"]);
  });
  it("empty business_types keeps everything", () => {
    expect(filterByVendorExemptions([rule({ vendor_type_exemptions: ["small_business"] })], [])).toHaveLength(1);
  });
});

describe("calculateTaxForInvoice", () => {
  const invoice = { id: "inv1", entity_id: "e1", total: 10000, __jurisdiction: "US-CA" };
  const ruleset = [
    rule({ id: "sales", rate_pct: 7.25, tax_type: "sales_tax" }),
    rule({ id: "withholding", rate_pct: 2, tax_type: "withholding" }),
    rule({ id: "big-only", rate_pct: 5, threshold_amount: 50000, tax_type: "sales_tax" }),
    rule({ id: "services-only", rate_pct: 8, applies_to: "services", tax_type: "sales_tax" }),
    rule({ id: "inactive", rate_pct: 99, is_active: false, tax_type: "sales_tax" }),
    rule({ id: "ny", rate_pct: 4, jurisdiction: "US-NY", tax_type: "sales_tax" }),
    rule({ id: "exempt-small", rate_pct: 6, vendor_type_exemptions: ["small_business"], tax_type: "sales_tax" }),
  ];

  it("applies every qualifying rule and sums tax", () => {
    const { calculations, total_tax } = calculateTaxForInvoice({
      invoice, rules: ruleset, appliesTo: "goods", effectiveDate: new Date("2026-04-19"),
    });
    // qualifying: sales (7.25%) + withholding (2%)
    // big-only dropped by threshold; services-only by applies_to; inactive by is_active; ny by jurisdiction; exempt — no exemption match
    const ids = calculations.map((c) => c.rule_id).sort();
    expect(ids).toEqual(["exempt-small", "sales", "withholding"].sort());
    // Expected tax: 7.25% + 2% + 6% of 10000 = 1525
    expect(total_tax).toBeCloseTo(1525, 2);
  });

  it("vendor exemption removes the exempt rule", () => {
    const { calculations } = calculateTaxForInvoice({
      invoice, rules: ruleset, vendorBusinessTypes: ["small_business"],
      appliesTo: "goods", effectiveDate: new Date("2026-04-19"),
    });
    const ids = calculations.map((c) => c.rule_id).sort();
    expect(ids).toEqual(["sales", "withholding"]);
  });

  it("threshold respected: low-value invoice doesn't trigger threshold rules", () => {
    const { calculations } = calculateTaxForInvoice({
      invoice: { ...invoice, total: 100 }, rules: ruleset,
      appliesTo: "goods", effectiveDate: new Date("2026-04-19"),
    });
    expect(calculations.every((c) => c.rule_id !== "big-only")).toBe(true);
  });

  it("empty rule set returns no calculations", () => {
    const out = calculateTaxForInvoice({ invoice, rules: [], effectiveDate: new Date("2026-04-19") });
    expect(out.calculations).toEqual([]);
    expect(out.total_tax).toBe(0);
  });
});

describe("aggregateRemittance", () => {
  it("groups by (jurisdiction, tax_type) and rolls up taxable + tax", () => {
    const calcs = [
      { jurisdiction: "US-CA", tax_type: "sales_tax",   taxable_amount: 1000, tax_amount: 72.5 },
      { jurisdiction: "US-CA", tax_type: "sales_tax",   taxable_amount: 2000, tax_amount: 145  },
      { jurisdiction: "US-CA", tax_type: "withholding", taxable_amount: 3000, tax_amount: 60   },
      { jurisdiction: "US-NY", tax_type: "sales_tax",   taxable_amount: 1500, tax_amount: 60   },
    ];
    const out = aggregateRemittance(calcs);
    expect(out.total_taxable).toBe(7500);
    expect(out.total_tax).toBeCloseTo(337.5, 2);
    expect(out.by_jurisdiction).toHaveLength(3);
    const ca_sales = out.by_jurisdiction.find((r) => r.jurisdiction === "US-CA" && r.tax_type === "sales_tax");
    expect(ca_sales.taxable).toBe(3000);
    expect(ca_sales.tax).toBeCloseTo(217.5, 2);
  });
});

describe("TAX_TYPES", () => {
  it("documents the four tax types", () => {
    expect(TAX_TYPES).toEqual(["vat", "gst", "sales_tax", "withholding"]);
  });
});
