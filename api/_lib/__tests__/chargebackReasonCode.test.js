// Unit tests for the pattern-based chargeback reason-code auto-coder (#1744).

import { describe, it, expect } from "vitest";
import { mapReasonToCode, REASON_CODE_RULES } from "../chargebackReasonCode.js";

describe("mapReasonToCode — the 10 migration literals still map to their code", () => {
  const cases = [
    ["Short Pay (Inv/Ck Difference)", "shortpay"],
    ["Discount taken - (chargeback)", "discount"],
    ["Packing Violation", "packing"],
    ["Freight", "freight"],
    ["Warehouse Allowance", "pricing"],
    ["Processing Charge", "fees"],
    ["Return/refused", "returns"],
    ["No Reason Given", "unknown"],
    ["Miscellaneous", "misc"],
    ["Miscellaneous credit / chargeback", "misc"],
  ];
  for (const [raw, code] of cases) {
    it(`"${raw}" → ${code}`, () => {
      expect(mapReasonToCode(raw)).toBe(code);
    });
  }
});

describe("mapReasonToCode — generalized keyword patterns", () => {
  it("classifies shortages / non-receipt", () => {
    expect(mapReasonToCode("Shortage claim")).toBe("shortage");
    expect(mapReasonToCode("Non-Receipt of goods")).toBe("shortage");
    expect(mapReasonToCode("Short shipped units")).toBe("shortage");
  });
  it("classifies markdown / margin allowances", () => {
    expect(mapReasonToCode("Markdown allowance")).toBe("markdown");
    expect(mapReasonToCode("MKDN money")).toBe("markdown");
    expect(mapReasonToCode("Margin allowance agreement")).toBe("markdown");
  });
  it("classifies compliance / vendor violations (but packing wins first)", () => {
    expect(mapReasonToCode("Compliance chargeback")).toBe("compliance");
    expect(mapReasonToCode("ASN violation")).toBe("compliance");
    expect(mapReasonToCode("Chargeback fine")).toBe("compliance");
    expect(mapReasonToCode("Packing Violation")).toBe("packing"); // packing beats generic "violation"
  });
  it("classifies freight / routing / carriers", () => {
    expect(mapReasonToCode("Freight charge")).toBe("freight");
    expect(mapReasonToCode("FedEx collect")).toBe("freight");
    expect(mapReasonToCode("UPS routing fee")).toBe("freight");
    expect(mapReasonToCode("Routing deduction")).toBe("freight");
  });
  it("classifies co-op / advertising", () => {
    expect(mapReasonToCode("Co-op advertising")).toBe("coop");
    expect(mapReasonToCode("Coop allowance")).toBe("coop");
    expect(mapReasonToCode("Marketing fund")).toBe("coop");
  });
  it("classifies defective / RTV before a plain return", () => {
    expect(mapReasonToCode("Defective merchandise")).toBe("defective");
    expect(mapReasonToCode("Damaged goods")).toBe("defective");
    expect(mapReasonToCode("RTV authorization")).toBe("defective");
    expect(mapReasonToCode("Return to vendor")).toBe("defective");
    expect(mapReasonToCode("Return/refused")).toBe("returns"); // plain return
  });
  it("classifies pricing / allowance differences", () => {
    expect(mapReasonToCode("Price difference")).toBe("pricing");
    expect(mapReasonToCode("Pricing discrepancy")).toBe("pricing");
    expect(mapReasonToCode("Warehouse Allowance")).toBe("pricing");
  });
  it("classifies interest / processing fees", () => {
    expect(mapReasonToCode("Interest charge")).toBe("fees");
    expect(mapReasonToCode("Finance charge")).toBe("fees");
    expect(mapReasonToCode("Processing Charge")).toBe("fees");
  });
  it("is case-insensitive", () => {
    expect(mapReasonToCode("SHORT PAY (INV/CK DIFFERENCE)")).toBe("shortpay");
    expect(mapReasonToCode("freight")).toBe("freight");
  });
});

describe("mapReasonToCode — never maps factor churn or unknown text", () => {
  it("declines factor churn by reason text", () => {
    expect(mapReasonToCode("Manual Charge Back")).toBeNull();
  });
  it("declines factor churn by raw reason_code 610 even with mappable text", () => {
    expect(mapReasonToCode("Freight", "610")).toBeNull();
  });
  it("returns null for text that matches no rule", () => {
    expect(mapReasonToCode("Non-Factored Invoice (credit) - NC")).toBeNull();
    expect(mapReasonToCode("Zorblax")).toBeNull();
  });
  it("returns null for empty / nullish input", () => {
    expect(mapReasonToCode("")).toBeNull();
    expect(mapReasonToCode(null)).toBeNull();
    expect(mapReasonToCode(undefined)).toBeNull();
  });
});

describe("REASON_CODE_RULES", () => {
  it("exposes the ordered rule set (shortpay before shortage, packing before compliance)", () => {
    const codes = REASON_CODE_RULES.map((r) => r.code);
    expect(codes.indexOf("shortpay")).toBeLessThan(codes.indexOf("shortage"));
    expect(codes.indexOf("packing")).toBeLessThan(codes.indexOf("compliance"));
    expect(codes.indexOf("defective")).toBeLessThan(codes.indexOf("returns"));
  });
  it("only references governed codes", () => {
    const governed = new Set(["shortage", "pricing", "shortpay", "discount", "markdown", "compliance", "packing", "freight", "coop", "defective", "returns", "fees", "misc", "unknown"]);
    for (const r of REASON_CODE_RULES) expect(governed.has(r.code)).toBe(true);
  });
});
