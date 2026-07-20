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
  netOpenByDocument,
  pairingToken,
  classifyChurn,
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

describe("netOpenByDocument", () => {
  it("a fully reversed document (same-doc credit) contributes offset, not net-open", () => {
    // PROD pattern: doc 573164 debited then re-credited identically.
    const out = netOpenByDocument([
      { item_num: "573164", amount_cents: 191_560_00, cb_date: "2025-09-25" },
      { item_num: "573164", amount_cents: -191_560_00, cb_date: "2025-10-30" },
    ]);
    expect(out.gross_cents).toBe(191_560_00);
    expect(out.offset_cents).toBe(191_560_00);
    expect(out.net_open_cents).toBe(0);
    expect(out.open_doc_count).toBe(0);
    expect(out.doc_count).toBe(1);
    expect(out.docs).toEqual([]);
  });

  it("a partially credited document stays open for the remainder", () => {
    const out = netOpenByDocument([
      { item_num: "150100", amount_cents: 37_910_00, cb_date: "2025-11-18" },
      { item_num: "150100", amount_cents: -10_000_00, cb_date: "2025-12-05" },
    ]);
    expect(out.offset_cents).toBe(10_000_00);
    expect(out.net_open_cents).toBe(27_910_00);
    expect(out.docs).toHaveLength(1);
    expect(out.docs[0]).toMatchObject({
      doc: "150100", gross_cents: 37_910_00, credit_cents: -10_000_00, net_cents: 27_910_00,
      count: 2, first_date: "2025-11-18", last_date: "2025-12-05",
    });
  });

  it("credits never net ACROSS documents (invariant: gross = offset + net_open)", () => {
    const out = netOpenByDocument([
      { item_num: "A", amount_cents: 100_00 },
      { item_num: "B", amount_cents: -100_00 }, // over-credited doc: cannot cancel A
    ]);
    expect(out.net_open_cents).toBe(100_00);
    expect(out.offset_cents).toBe(0);
    expect(out.gross_cents).toBe(out.offset_cents + out.net_open_cents);
  });

  it("distinct zero-padded document numbers are DIFFERENT documents", () => {
    const out = netOpenByDocument([
      { item_num: "00000017565", amount_cents: 50_00 },
      { item_num: "17565", amount_cents: -50_00 },
    ]);
    expect(out.doc_count).toBe(2);
    expect(out.net_open_cents).toBe(50_00); // the credit belongs to the other doc
  });

  it("skips factor-churn rows entirely and sorts open docs largest first", () => {
    const out = netOpenByDocument([
      { item_num: "BIG", amount_cents: 500_00 },
      { item_num: "SMALL", amount_cents: 100_00 },
      { item_num: "CHURN", amount_cents: 999_00, excluded: true },
    ]);
    expect(out.doc_count).toBe(2);
    expect(out.docs.map((d) => d.doc)).toEqual(["BIG", "SMALL"]);
    expect(out.net_open_cents).toBe(600_00);
  });

  it("handles blank/null item_num as one '(blank)' bucket and empty input", () => {
    const out = netOpenByDocument([
      { item_num: null, amount_cents: 10_00 },
      { item_num: "  ", amount_cents: 5_00 },
    ]);
    expect(out.doc_count).toBe(1);
    expect(out.docs[0].doc).toBe("(blank)");
    expect(out.docs[0].net_cents).toBe(15_00);
    expect(netOpenByDocument([])).toMatchObject({ docs: [], doc_count: 0, net_open_cents: 0 });
    expect(netOpenByDocument(null)).toMatchObject({ docs: [], doc_count: 0, net_open_cents: 0 });
  });
});

// ── Factor-churn classification: pairing token + classifyChurn ───────────────
describe("pairingToken", () => {
  it("uppercases, strips non-alnum, and strips leading zeros on all-numeric tokens", () => {
    expect(pairingToken("00000150100")).toBe("150100");
    expect(pairingToken("150100")).toBe("150100");            // pairs the zero-padded variant
    expect(pairingToken("ROF-I012509")).toBe("ROFI012509");
    expect(pairingToken("ROFI012509")).toBe("ROFI012509");    // dashless variant pairs too
    expect(pairingToken("407267_1447867")).toBe("4072671447867");
  });
  it("keeps leading zeros only via stripping — an all-numeric token never stays padded", () => {
    expect(pairingToken("00009393692")).toBe("9393692");
  });
  it("differs from netOpenByDocument's exact key: '00000017565' pairs with '17565'", () => {
    // (net-open keeps them distinct; pairing intentionally unifies the receivable)
    expect(pairingToken("00000017565")).toBe(pairingToken("17565"));
  });
  it("handles blank/null", () => {
    expect(pairingToken(null)).toBeNull();
    expect(pairingToken("")).toBeNull();
    expect(pairingToken("---")).toBeNull();
  });
});

describe("classifyChurn", () => {
  it("pairs a chargeback with its equal-and-opposite creditback across leading-zero variants", () => {
    const rows = [
      { id: "cb", item_num: "150100", amount_cents: 3790960, reason_code: null, cb_date: "2025-11-18" },
      { id: "cr", item_num: "00000150100", amount_cents: -3790960, reason_code: "204", cb_date: "2025-12-18" },
    ];
    const m = classifyChurn(rows);
    expect(m.get("cb").kind).toBe("offset_pair");
    expect(m.get("cr").kind).toBe("offset_pair");
    // both legs share a stable pair_key (sorted member ids)
    expect(m.get("cb").pair_key).toBe(m.get("cr").pair_key);
    expect(m.get("cb").pair_key).toBe(["cb", "cr"].sort().join(":"));
    // twins point at each other
    expect(m.get("cb").twin_id).toBe("cr");
    expect(m.get("cr").twin_id).toBe("cb");
    expect(m.get("cb").twin_item_num).toBe("00000150100");
  });

  it("offset_pair takes precedence over a code-based kind (a 610 leg that is also paired)", () => {
    const rows = [
      { id: "a", item_num: "ROF-I012509", amount_cents: 764800, reason_code: "610", cb_date: "2025-09-02" },
      { id: "b", item_num: "ROFI012509", amount_cents: -764800, reason_code: "200", cb_date: "2025-10-03" },
    ];
    const m = classifyChurn(rows);
    expect(m.get("a").kind).toBe("offset_pair");
    expect(m.get("b").kind).toBe("offset_pair");
  });

  it("greedy 1:1 pairing — 2 chargebacks + 1 creditback of the same token/amount pairs exactly one", () => {
    const rows = [
      { id: "c1", item_num: "555", amount_cents: 100_00, reason_code: null, cb_date: "2025-01-01" },
      { id: "c2", item_num: "555", amount_cents: 100_00, reason_code: null, cb_date: "2025-02-01" },
      { id: "r1", item_num: "555", amount_cents: -100_00, reason_code: null, cb_date: "2025-03-01" },
    ];
    const m = classifyChurn(rows);
    // earliest chargeback (c1) pairs with the credit; c2 stays unclassified
    expect(m.get("c1").kind).toBe("offset_pair");
    expect(m.get("r1").kind).toBe("offset_pair");
    expect(m.get("c1").twin_id).toBe("r1");
    expect(m.has("c2")).toBe(false);
  });

  it("does NOT pair across different tokens or unequal amounts", () => {
    const rows = [
      { id: "a", item_num: "111", amount_cents: 100_00, reason_code: null },
      { id: "b", item_num: "222", amount_cents: -100_00, reason_code: null }, // different token
      { id: "c", item_num: "333", amount_cents: 100_00, reason_code: null },
      { id: "d", item_num: "333", amount_cents: -90_00, reason_code: null },  // unequal amount
    ];
    const m = classifyChurn(rows);
    expect(m.size).toBe(0);
  });

  it("classifies factor admin codes (200/202/204) and recourse 610 when unpaired", () => {
    const rows = [
      { id: "a", item_num: "4622377", amount_cents: -22236285, reason_code: "200" },
      { id: "b", item_num: "ROFI145993", amount_cents: -3093720, reason_code: "202" },
      { id: "c", item_num: "CBR2574871", amount_cents: -2657458, reason_code: "204" },
      { id: "d", item_num: "ROF-I999", amount_cents: 500000, reason_code: "610" },
      { id: "e", item_num: "ROF-I998", amount_cents: 12345, reason_code: "597" }, // real deduction — NOT churn
      { id: "f", item_num: "ROF-I997", amount_cents: 6789, reason_code: "201" },  // 201 is NOT churn
    ];
    const m = classifyChurn(rows);
    expect(m.get("a").kind).toBe("factor_admin_code");
    expect(m.get("b").kind).toBe("factor_admin_code");
    expect(m.get("c").kind).toBe("factor_admin_code");
    expect(m.get("d").kind).toBe("recourse_610");
    expect(m.has("e")).toBe(false);
    expect(m.has("f")).toBe(false);
  });

  it("is deterministic across row order (same pair_key regardless of input order)", () => {
    const a = [
      { id: "x", item_num: "77", amount_cents: 50_00, reason_code: null, cb_date: "2025-05-01" },
      { id: "y", item_num: "77", amount_cents: -50_00, reason_code: null, cb_date: "2025-06-01" },
    ];
    const m1 = classifyChurn(a);
    const m2 = classifyChurn([a[1], a[0]]);
    expect(m1.get("x").pair_key).toBe(m2.get("x").pair_key);
  });
});

describe("resolveDrillRow prefers the persisted churn flag", () => {
  const reasonById = new Map();
  it("uses is_factor_churn when present, ignoring the raw code", () => {
    // A raw 610 that has been persisted as NOT churn (edge) → follows the flag.
    const rr = resolveDrillRow(
      { id: "z", customer_id: "c1", report_month: "2026-03-01", amount_cents: 100_00, reason_code: "610", is_factor_churn: false },
      reasonById,
    );
    expect(rr.excluded).toBe(false);
    // An offset-pair leg (no churn-y raw code) persisted as churn → excluded.
    const rr2 = resolveDrillRow(
      { id: "w", customer_id: "c1", report_month: "2026-03-01", amount_cents: -100_00, reason_code: "200", is_factor_churn: true },
      reasonById,
    );
    expect(rr2.excluded).toBe(true);
    expect(rr2.reason_group).toBe("__factor_churn__");
  });
  it("falls back to the code predicate when is_factor_churn is absent", () => {
    const rr = resolveDrillRow(
      { id: "v", customer_id: "c1", report_month: "2026-03-01", amount_cents: 100_00, reason_code: "610" },
      reasonById,
    );
    expect(rr.excluded).toBe(true);
  });
});
