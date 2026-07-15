// Tests for the pure AR due-date helper (invoice date + payment_terms.due_days).

import { describe, it, expect } from "vitest";
import { computeDueDate } from "../arDueDate";

describe("computeDueDate", () => {
  it("adds NET30 days to the invoice date", () => {
    expect(computeDueDate("2026-07-15", 30)).toBe("2026-08-14");
  });

  it("handles NET0 (due on receipt) as same day", () => {
    expect(computeDueDate("2026-07-15", 0)).toBe("2026-07-15");
  });

  it("rolls across month + year boundaries", () => {
    expect(computeDueDate("2026-12-20", 30)).toBe("2027-01-19");
  });

  it("crosses a leap-day correctly (UTC math, no TZ drift)", () => {
    expect(computeDueDate("2028-02-15", 30)).toBe("2028-03-16");
  });

  it("returns null when the anchor date is missing or malformed", () => {
    expect(computeDueDate("", 30)).toBeNull();
    expect(computeDueDate("07/15/2026", 30)).toBeNull();
    expect(computeDueDate(null, 30)).toBeNull();
    expect(computeDueDate(undefined, 30)).toBeNull();
  });

  it("returns null for missing / negative / non-finite due days", () => {
    expect(computeDueDate("2026-07-15", null)).toBeNull();
    expect(computeDueDate("2026-07-15", undefined)).toBeNull();
    expect(computeDueDate("2026-07-15", -5)).toBeNull();
    expect(computeDueDate("2026-07-15", Number.NaN)).toBeNull();
  });

  it("rounds fractional due days to whole calendar days", () => {
    expect(computeDueDate("2026-07-15", 30.4)).toBe("2026-08-14");
  });
});
