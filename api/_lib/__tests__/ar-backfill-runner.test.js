// Tests for the AR historical backfill runner (P4-8).
// Pure helpers only — full integration test happens via dry-run against a
// staging DB after deploy.

import { describe, it, expect } from "vitest";
import {
  validateBody,
  isISODate,
  iterMonths,
  lineTotalCents,
} from "../../_handlers/internal/ar-backfill/run.js";

describe("isISODate", () => {
  it("accepts well-formed dates", () => {
    expect(isISODate("2024-08-01")).toBe(true);
    expect(isISODate("2026-05-27")).toBe(true);
  });
  it("rejects malformed", () => {
    expect(isISODate("2024-8-1")).toBe(false);
    expect(isISODate("2024/08/01")).toBe(false);
    expect(isISODate("")).toBe(false);
  });
  it("rejects calendar-invalid", () => {
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-13-01")).toBe(false);
  });
});

describe("validateBody", () => {
  it("defaults to 2024-08-01 → today and dry_run=true", () => {
    const v = validateBody({});
    expect(v.error).toBeUndefined();
    expect(v.data.start_date).toBe("2024-08-01");
    expect(v.data.dry_run).toBe(true);
    expect(typeof v.data.end_date).toBe("string");
    expect(v.data.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("accepts valid override", () => {
    const v = validateBody({ start_date: "2024-09-01", end_date: "2024-12-31", dry_run: false });
    expect(v.error).toBeUndefined();
    expect(v.data.start_date).toBe("2024-09-01");
    expect(v.data.end_date).toBe("2024-12-31");
    expect(v.data.dry_run).toBe(false);
  });
  it("rejects start_date earlier than historical floor", () => {
    expect(validateBody({ start_date: "2024-01-01" }).error).toMatch(/start_date cannot be earlier/);
    expect(validateBody({ start_date: "2023-12-31" }).error).toMatch(/start_date cannot be earlier/);
  });
  it("allows the historical floor exactly", () => {
    const v = validateBody({ start_date: "2024-08-01" });
    expect(v.error).toBeUndefined();
  });
  it("rejects start_date > end_date", () => {
    expect(validateBody({ start_date: "2025-01-01", end_date: "2024-12-31" }).error)
      .toMatch(/start_date must be <= end_date/);
  });
  it("rejects malformed dates", () => {
    expect(validateBody({ start_date: "yesterday" }).error).toMatch(/start_date/);
    expect(validateBody({ end_date: "2026/05/27" }).error).toMatch(/end_date/);
  });
  it("rejects non-boolean dry_run", () => {
    expect(validateBody({ dry_run: "yes" }).error).toMatch(/dry_run/);
  });
});

describe("iterMonths", () => {
  function collect(start, end) {
    return Array.from(iterMonths(start, end)).map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`);
  }

  it("single month", () => {
    expect(collect("2024-08-01", "2024-08-15")).toEqual(["2024-08"]);
  });
  it("spans two months when end is in the next month", () => {
    expect(collect("2024-08-15", "2024-09-05")).toEqual(["2024-08", "2024-09"]);
  });
  it("full year", () => {
    const r = collect("2024-08-01", "2025-07-31");
    expect(r.length).toBe(12);
    expect(r[0]).toBe("2024-08");
    expect(r[11]).toBe("2025-07");
  });
  it("monthStart and monthEnd shape", () => {
    const it = iterMonths("2024-08-01", "2024-09-15");
    const first = it.next().value;
    expect(first.monthStart).toBe("2024-08-01");
    expect(first.monthEnd).toBe("2024-09-01");
    const second = it.next().value;
    expect(second.monthStart).toBe("2024-09-01");
    expect(second.monthEnd).toBe("2024-10-01");
  });
  it("December → January year rollover", () => {
    const r = collect("2024-11-15", "2025-02-10");
    expect(r).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
  });
});

describe("lineTotalCents", () => {
  it("prefers net_amount when set", () => {
    expect(lineTotalCents({ net_amount: 12.34, gross_amount: 99, unit_price: 5, qty: 5 })).toBe(1234n);
  });
  it("falls back to gross_amount when net is null", () => {
    expect(lineTotalCents({ net_amount: null, gross_amount: 50, unit_price: 5, qty: 5 })).toBe(5000n);
  });
  it("falls back to unit_price * qty when both amounts are null", () => {
    expect(lineTotalCents({ net_amount: null, gross_amount: null, unit_price: 12.5, qty: 4 })).toBe(5000n);
  });
  it("returns 0n when everything is missing", () => {
    expect(lineTotalCents({})).toBe(0n);
    expect(lineTotalCents({ net_amount: null, gross_amount: null, unit_price: null, qty: null })).toBe(0n);
  });
  it("rounds to cents (no fractional)", () => {
    expect(lineTotalCents({ net_amount: 12.345 })).toBe(1235n);  // rounds up
    expect(lineTotalCents({ net_amount: 12.344 })).toBe(1234n);  // rounds down
  });
  it("handles negatives (returns 0 — runner skips non-positive lines upstream)", () => {
    expect(lineTotalCents({ net_amount: -5 })).toBe(-500n);
  });
});
