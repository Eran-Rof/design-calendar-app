import { describe, it, expect } from "vitest";
import { monthOf, monthsBetween, monthOffset, monthsDiff } from "../compute/periods";

describe("periods", () => {
  it("monthOf returns start/end correctly for a 30-day month", () => {
    const m = monthOf("2026-04-19");
    expect(m.period_code).toBe("2026-04");
    expect(m.period_start).toBe("2026-04-01");
    expect(m.period_end).toBe("2026-04-30");
  });
  it("monthOf handles 31-day months", () => {
    expect(monthOf("2026-01-05").period_end).toBe("2026-01-31");
  });
  it("monthOf handles February non-leap", () => {
    expect(monthOf("2026-02-10").period_end).toBe("2026-02-28");
  });
  it("monthOf handles February leap year", () => {
    expect(monthOf("2024-02-10").period_end).toBe("2024-02-29");
  });
  it("monthsBetween is inclusive and iterates month-by-month", () => {
    const months = monthsBetween("2026-01-15", "2026-04-01");
    expect(months.map((m) => m.period_code)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
  });
  it("monthsBetween returns [] when reversed", () => {
    expect(monthsBetween("2026-05-01", "2026-03-01")).toEqual([]);
  });
  it("monthOffset steps backwards across year boundary", () => {
    expect(monthOffset("2026-01-15", 2).period_code).toBe("2025-11");
  });
  it("monthsDiff counts months between two dates", () => {
    expect(monthsDiff("2026-01-15", "2026-04-02")).toBe(3);
  });
});
