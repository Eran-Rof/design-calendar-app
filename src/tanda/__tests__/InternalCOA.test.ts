// Tests for the InternalCOA balance column helpers — operator ask #15.
// Pure helpers only (no React); the panel itself is exercised by manual QA.

import { describe, it, expect } from "vitest";
import { formatBalanceCents, buildGLDetailHref } from "../InternalCOA";

describe("formatBalanceCents", () => {
  it("formats zero as $0.00", () => {
    expect(formatBalanceCents(0)).toBe("$0.00");
  });
  it("formats null / undefined as $0.00", () => {
    expect(formatBalanceCents(null)).toBe("$0.00");
    expect(formatBalanceCents(undefined)).toBe("$0.00");
  });
  it("formats positive thousands with separators", () => {
    expect(formatBalanceCents(100000)).toBe("$1,000.00");
    expect(formatBalanceCents(123456789)).toBe("$1,234,567.89");
  });
  it("formats sub-dollar amounts", () => {
    expect(formatBalanceCents(7)).toBe("$0.07");
    expect(formatBalanceCents(99)).toBe("$0.99");
  });
  it("formats negative balances with leading minus", () => {
    expect(formatBalanceCents(-50000)).toBe("-$500.00");
    expect(formatBalanceCents(-1)).toBe("-$0.01");
  });
  it("accepts numeric strings (PostgREST sometimes returns bigints as strings)", () => {
    expect(formatBalanceCents("250000")).toBe("$2,500.00");
    expect(formatBalanceCents("-7500")).toBe("-$75.00");
  });
  it("returns $0.00 for non-numeric input", () => {
    expect(formatBalanceCents("not a number")).toBe("$0.00");
    expect(formatBalanceCents(NaN)).toBe("$0.00");
  });
});

describe("buildGLDetailHref", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";

  it("builds /tangerine path with view=gl_detail", () => {
    const href = buildGLDetailHref(UUID, "2026-01-01", "2026-03-31");
    expect(href).toMatch(/^\/tangerine\?/);
    const qs = new URLSearchParams(href.split("?")[1]);
    expect(qs.get("view")).toBe("gl_detail");
    expect(qs.get("account_id")).toBe(UUID);
    expect(qs.get("from")).toBe("2026-01-01");
    expect(qs.get("to")).toBe("2026-03-31");
  });

  it("supplies a default 90-day window when dates omitted", () => {
    const href = buildGLDetailHref(UUID);
    const qs = new URLSearchParams(href.split("?")[1]);
    const from = qs.get("from") || "";
    const to = qs.get("to") || "";
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(from <= to).toBe(true);
    // ~90 days between (allow ±2 for month-length / DST drift).
    const diff = Math.round(
      (new Date(to + "T00:00:00Z").getTime() - new Date(from + "T00:00:00Z").getTime())
        / (1000 * 60 * 60 * 24),
    );
    expect(diff).toBeGreaterThanOrEqual(88);
    expect(diff).toBeLessThanOrEqual(92);
  });
});
