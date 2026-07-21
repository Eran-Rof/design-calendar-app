import { describe, it, expect } from "vitest";
import { formatQty } from "../components/styles";

// Regression guard for the Hist T3 / SP/LY "blank column" failure mode.
//
// PostgREST serialises `numeric`-typed columns as JSON *strings*. `historical_
// trailing_qty` (summed from ip_sales_history_wholesale.qty_units) and
// `ly_reference_qty` (ip_wholesale_forecast) feed straight into formatQty. The
// old guard `!Number.isFinite(n)` is TRUE for a numeric string, so a string
// value rendered blank ("–") — both columns going empty together. formatQty now
// coerces numeric strings first; genuine non-numbers still render "–".
describe("formatQty", () => {
  it("formats real numbers", () => {
    expect(formatQty(1816)).toBe("1,816");
    expect(formatQty(0)).toBe("0");
    expect(formatQty(7176)).toBe("7,176");
    expect(formatQty(2100.4)).toBe("2,100");
  });

  it("formats numeric STRINGS (the numeric-column serialisation case)", () => {
    // Previously these returned "–" (blank) — the exact reported symptom.
    expect(formatQty("1816")).toBe("1,816");
    expect(formatQty("1816.000")).toBe("1,816");
    expect(formatQty("0")).toBe("0");
    expect(formatQty("7176")).toBe("7,176");
  });

  it("renders '–' for null / undefined / genuinely non-numeric", () => {
    expect(formatQty(null)).toBe("–");
    expect(formatQty(undefined)).toBe("–");
    expect(formatQty(Number.NaN)).toBe("–");
    expect(formatQty("")).toBe("–");
    expect(formatQty("abc")).toBe("–");
  });
});
