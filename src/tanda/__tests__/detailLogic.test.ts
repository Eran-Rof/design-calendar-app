import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  daysUntil,
  computeMatrixRows,
  computeCascadeInfo,
  sortCategoryMilestones,
} from "../detailHelpers";

// ─── daysUntil ──────────────────────────────────────────────────────────────

describe("daysUntil", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns null for undefined input", () => {
    expect(daysUntil(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(daysUntil("")).toBeNull();
  });

  it("returns 0 for today's date (near midnight start)", () => {
    // Set to 2025-06-15 00:00:00 UTC
    vi.setSystemTime(new Date("2025-06-15T00:00:00Z"));
    // Same date string — should be 0 (ceiling of 0 / 86400000)
    expect(daysUntil("2025-06-15")).toBe(0);
  });

  it("returns positive days for future dates", () => {
    vi.setSystemTime(new Date("2025-06-15T00:00:00Z"));
    expect(daysUntil("2025-06-20")).toBe(5);
  });

  it("returns negative days for past dates", () => {
    vi.setSystemTime(new Date("2025-06-15T00:00:00Z"));
    expect(daysUntil("2025-06-10")).toBe(-5);
  });

  it("returns 1 for tomorrow", () => {
    vi.setSystemTime(new Date("2025-06-15T00:00:00Z"));
    expect(daysUntil("2025-06-16")).toBe(1);
  });

  it("returns -1 for yesterday", () => {
    vi.setSystemTime(new Date("2025-06-15T00:00:00Z"));
    expect(daysUntil("2025-06-14")).toBe(-1);
  });

  it("uses Math.ceil so partial days round up", () => {
    // Set to mid-day — a date 0.5 days away should ceil to 1
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    const result = daysUntil("2025-06-16");
    // 2025-06-16T00:00:00Z is 12h away = 0.5 days => ceil => 1
    expect(result).toBe(1);
  });

  it("handles far future dates", () => {
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const result = daysUntil("2026-01-01");
    expect(result).toBe(365);
  });
});

// ─── computeMatrixRows ─────────────────────────────────────────────────────

describe("computeMatrixRows", () => {
  it("returns empty array for empty items", () => {
    expect(computeMatrixRows([])).toEqual([]);
  });

  it("groups items by base-color key from 4-part SKU", () => {
    const items = [
      { ItemNumber: "ABC-RED-01-S", Description: "Tee Red", QtyOrder: 10, UnitPrice: 5 },
      { ItemNumber: "ABC-RED-01-M", Description: "Tee Red", QtyOrder: 20, UnitPrice: 5 },
    ];
    const rows = computeMatrixRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].base).toBe("ABC");
    expect(rows[0].color).toBe("RED-01");
    expect(rows[0].qty).toBe(30);
    expect(rows[0].price).toBe(5);
  });

  it("handles 2-part SKU (base-color)", () => {
    const items = [
      { ItemNumber: "SHOE-BLK", Description: "Shoe Black", QtyOrder: 5, UnitPrice: 20 },
    ];
    const rows = computeMatrixRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].base).toBe("SHOE");
    expect(rows[0].color).toBe("BLK");
  });

  it("handles single-part SKU (no dash)", () => {
    const items = [
      { ItemNumber: "HAT", Description: "Plain Hat", QtyOrder: 3, UnitPrice: 10 },
    ];
    const rows = computeMatrixRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].base).toBe("HAT");
    expect(rows[0].color).toBe("");
  });

  it("handles missing ItemNumber gracefully", () => {
    const items = [
      { Description: "Unknown", QtyOrder: 1, UnitPrice: 1 },
    ];
    const rows = computeMatrixRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].base).toBe("");
    expect(rows[0].color).toBe("");
  });

  it("uses QtyRemaining when available (itemQty logic)", () => {
    const items = [
      { ItemNumber: "X-Y", QtyOrder: 100, QtyRemaining: 40, UnitPrice: 2 },
    ];
    const rows = computeMatrixRows(items);
    expect(rows[0].qty).toBe(40);
  });

  it("subtracts QtyReceived when present and QtyRemaining is absent", () => {
    const items = [
      { ItemNumber: "X-Y", QtyOrder: 100, QtyReceived: 30, UnitPrice: 2 },
    ];
    const rows = computeMatrixRows(items);
    expect(rows[0].qty).toBe(70);
  });

  it("creates separate rows for different base-color combos", () => {
    const items = [
      { ItemNumber: "A-RED-01-S", QtyOrder: 5, UnitPrice: 1 },
      { ItemNumber: "A-BLU-02-S", QtyOrder: 3, UnitPrice: 1 },
      { ItemNumber: "B-RED-01-M", QtyOrder: 7, UnitPrice: 2 },
    ];
    const rows = computeMatrixRows(items);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => `${r.base}-${r.color}`)).toEqual(["A-RED-01", "A-BLU-02", "B-RED-01"]);
  });

  it("handles 3-part SKU (base-part1-part2 but not 4 parts)", () => {
    const items = [
      { ItemNumber: "TOP-NVY-LG", QtyOrder: 10, UnitPrice: 15 },
    ];
    const rows = computeMatrixRows(items);
    // 3 parts => color = parts[1] = "NVY"
    expect(rows[0].base).toBe("TOP");
    expect(rows[0].color).toBe("NVY");
  });
});

// ─── computeCascadeInfo ─────────────────────────────────────────────────────

describe("computeCascadeInfo", () => {
  const activeCats = ["Pre-Production", "Fabric T&A", "Samples", "Production", "Transit"];

  it("returns not blocked for the first category", () => {
    const grouped = {
      "Pre-Production": [{ status: "In Progress", expected_date: "2025-06-01" }],
    };
    const info = computeCascadeInfo("Pre-Production", activeCats, grouped);
    expect(info.blocked).toBe(false);
    expect(info.upstreamDelay).toBe(0);
    expect(info.delayedCat).toBe("");
  });

  it("returns blocked when prior category is incomplete", () => {
    const grouped = {
      "Pre-Production": [{ status: "In Progress", expected_date: "2025-06-01" }],
      "Fabric T&A": [{ status: "Not Started", expected_date: "2025-07-01" }],
    };
    // now = 2025-06-10 => Pre-Production is 9 days late
    const now = new Date("2025-06-10T00:00:00Z").getTime();
    const info = computeCascadeInfo("Fabric T&A", activeCats, grouped, now);
    expect(info.blocked).toBe(true);
    expect(info.upstreamDelay).toBe(9);
    expect(info.delayedCat).toBe("Pre-Production");
  });

  it("returns not blocked when all prior categories are complete", () => {
    const grouped = {
      "Pre-Production": [{ status: "Complete" }],
      "Fabric T&A": [{ status: "Complete" }],
      "Samples": [{ status: "In Progress", expected_date: "2025-08-01" }],
    };
    const info = computeCascadeInfo("Samples", activeCats, grouped);
    expect(info.blocked).toBe(false);
  });

  it("treats N/A as complete for blocking purposes", () => {
    const grouped = {
      "Pre-Production": [{ status: "N/A" }],
      "Fabric T&A": [{ status: "Not Started", expected_date: "2025-07-01" }],
    };
    const now = new Date("2025-07-05T00:00:00Z").getTime();
    const info = computeCascadeInfo("Fabric T&A", activeCats, grouped, now);
    expect(info.blocked).toBe(false);
  });

  it("picks the category with the largest delay", () => {
    const grouped = {
      "Pre-Production": [{ status: "In Progress", expected_date: "2025-06-01" }],
      "Fabric T&A": [{ status: "Delayed", expected_date: "2025-05-20" }],
      "Samples": [{ status: "Not Started" }],
    };
    const now = new Date("2025-06-10T00:00:00Z").getTime();
    const info = computeCascadeInfo("Samples", activeCats, grouped, now);
    expect(info.blocked).toBe(true);
    // Fabric T&A is 21 days late, Pre-Production is 9 days late
    expect(info.upstreamDelay).toBe(21);
    expect(info.delayedCat).toBe("Fabric T&A");
  });

  it("returns 0 upstream delay when prior cats are incomplete but not past due", () => {
    const grouped = {
      "Pre-Production": [{ status: "In Progress", expected_date: "2025-12-01" }],
      "Fabric T&A": [{ status: "Not Started" }],
    };
    const now = new Date("2025-06-01T00:00:00Z").getTime();
    const info = computeCascadeInfo("Fabric T&A", activeCats, grouped, now);
    expect(info.blocked).toBe(true);
    expect(info.upstreamDelay).toBe(0);
  });

  it("handles empty grouped milestones for a category", () => {
    const info = computeCascadeInfo("Fabric T&A", activeCats, {});
    expect(info.blocked).toBe(false);
  });

  it("handles category not in activeCats", () => {
    const info = computeCascadeInfo("Unknown", activeCats, {});
    expect(info.blocked).toBe(false);
  });
});

// ─── sortCategoryMilestones ─────────────────────────────────────────────────

describe("sortCategoryMilestones", () => {
  it("sorts by expected_date ascending", () => {
    const ms = [
      { expected_date: "2025-07-01", sort_order: 2 },
      { expected_date: "2025-06-01", sort_order: 1 },
      { expected_date: "2025-08-01", sort_order: 3 },
    ];
    const sorted = sortCategoryMilestones(ms);
    expect(sorted.map(m => m.expected_date)).toEqual(["2025-06-01", "2025-07-01", "2025-08-01"]);
  });

  it("puts milestones with dates before those without", () => {
    const ms = [
      { expected_date: null, sort_order: 1 },
      { expected_date: "2025-06-01", sort_order: 2 },
    ];
    const sorted = sortCategoryMilestones(ms);
    expect(sorted[0].expected_date).toBe("2025-06-01");
    expect(sorted[1].expected_date).toBeNull();
  });

  it("falls back to sort_order when dates are equal", () => {
    const ms = [
      { expected_date: "2025-06-01", sort_order: 3 },
      { expected_date: "2025-06-01", sort_order: 1 },
      { expected_date: "2025-06-01", sort_order: 2 },
    ];
    const sorted = sortCategoryMilestones(ms);
    expect(sorted.map(m => m.sort_order)).toEqual([1, 2, 3]);
  });

  it("falls back to sort_order when both have no date", () => {
    const ms = [
      { expected_date: null, sort_order: 5 },
      { expected_date: null, sort_order: 2 },
    ];
    const sorted = sortCategoryMilestones(ms);
    expect(sorted.map(m => m.sort_order)).toEqual([2, 5]);
  });

  it("does not mutate the original array", () => {
    const ms = [
      { expected_date: "2025-07-01", sort_order: 2 },
      { expected_date: "2025-06-01", sort_order: 1 },
    ];
    const sorted = sortCategoryMilestones(ms);
    expect(sorted).not.toBe(ms);
    expect(ms[0].expected_date).toBe("2025-07-01"); // original unchanged
  });

  it("returns empty array for empty input", () => {
    expect(sortCategoryMilestones([])).toEqual([]);
  });
});

// ─── styles.ts smoke test ───────────────────────────────────────────────────

describe("styles.ts", () => {
  // Dynamic import to keep the test file's top-level import clean
  let S: Record<string, any>;

  beforeEach(async () => {
    S = (await import("../styles")).default;
  });

  it("exports a valid object with expected keys", () => {
    expect(typeof S).toBe("object");
    expect(S).not.toBeNull();
    expect(Object.keys(S).length).toBeGreaterThan(0);
  });

  it("contains core layout keys", () => {
    expect(S.app).toBeDefined();
    expect(S.nav).toBeDefined();
    expect(S.detailPanel).toBeDefined();
    expect(S.card).toBeDefined();
  });

  it("each value is a CSSProperties-like object", () => {
    for (const [key, val] of Object.entries(S)) {
      expect(typeof val).toBe("object");
      expect(val).not.toBeNull();
    }
  });
});
