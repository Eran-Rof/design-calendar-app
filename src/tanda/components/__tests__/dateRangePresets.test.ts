// Unit tests for cross-cutter T7-1 — pure date-range preset helpers.
//
// All tests pass a fixed `today` so they're deterministic in any TZ.

import { describe, it, expect } from "vitest";
import {
  iso,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  addDays,
  startOfQuarter,
  endOfQuarter,
  DEFAULT_PRESETS,
  mergePresets,
  type DatePresetMasterRow,
} from "../dateRangeMath";

// Anchor for most tests — Thu 2026-05-28 (Q2).
const TODAY = new Date(2026, 4, 28); // month is 0-indexed; 4 = May

function presetByKey(key: string) {
  const p = DEFAULT_PRESETS.find((p) => p.key === key);
  if (!p) throw new Error(`preset ${key} not found`);
  return p;
}

describe("iso()", () => {
  it("formats a date as local YYYY-MM-DD", () => {
    expect(iso(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(iso(new Date(2026, 11, 31))).toBe("2026-12-31");
    expect(iso(new Date(2026, 4, 28))).toBe("2026-05-28");
  });

  it("pads single-digit month/day", () => {
    expect(iso(new Date(2026, 2, 5))).toBe("2026-03-05");
  });
});

describe("date-math helpers", () => {
  it("startOfMonth", () => {
    expect(iso(startOfMonth(TODAY))).toBe("2026-05-01");
  });
  it("endOfMonth", () => {
    expect(iso(endOfMonth(TODAY))).toBe("2026-05-31");
    // Feb non-leap
    expect(iso(endOfMonth(new Date(2026, 1, 10)))).toBe("2026-02-28");
    // Feb leap
    expect(iso(endOfMonth(new Date(2024, 1, 10)))).toBe("2024-02-29");
  });
  it("startOfYear / endOfYear", () => {
    expect(iso(startOfYear(TODAY))).toBe("2026-01-01");
    expect(iso(endOfYear(TODAY))).toBe("2026-12-31");
  });
  it("addDays handles month + year rollover", () => {
    expect(iso(addDays(TODAY, -30))).toBe("2026-04-28");
    expect(iso(addDays(new Date(2026, 0, 5), -10))).toBe("2025-12-26");
    expect(iso(addDays(new Date(2026, 11, 28), 5))).toBe("2027-01-02");
  });
  it("startOfQuarter for each calendar quarter", () => {
    expect(iso(startOfQuarter(new Date(2026, 1, 15)))).toBe("2026-01-01"); // Q1
    expect(iso(startOfQuarter(new Date(2026, 4, 28)))).toBe("2026-04-01"); // Q2
    expect(iso(startOfQuarter(new Date(2026, 7, 1)))).toBe("2026-07-01");  // Q3
    expect(iso(startOfQuarter(new Date(2026, 10, 30)))).toBe("2026-10-01"); // Q4
  });
  it("endOfQuarter for each calendar quarter", () => {
    expect(iso(endOfQuarter(new Date(2026, 1, 15)))).toBe("2026-03-31"); // Q1
    expect(iso(endOfQuarter(new Date(2026, 4, 28)))).toBe("2026-06-30"); // Q2
    expect(iso(endOfQuarter(new Date(2026, 7, 1)))).toBe("2026-09-30");  // Q3
    expect(iso(endOfQuarter(new Date(2026, 10, 30)))).toBe("2026-12-31"); // Q4
  });
});

describe("DEFAULT_PRESETS — anchored to today=2026-05-28", () => {
  it("mtd → 2026-05-01 .. 2026-05-28", () => {
    expect(presetByKey("mtd").compute(TODAY)).toEqual({
      from: "2026-05-01",
      to: "2026-05-28",
    });
  });
  it("ytd → 2026-01-01 .. 2026-05-28", () => {
    expect(presetByKey("ytd").compute(TODAY)).toEqual({
      from: "2026-01-01",
      to: "2026-05-28",
    });
  });
  it("ty → 2026-01-01 .. 2026-12-31", () => {
    expect(presetByKey("ty").compute(TODAY)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });
  it("ly → 2025-01-01 .. 2025-12-31", () => {
    expect(presetByKey("ly").compute(TODAY)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });
  it("ty_to_last_month → 2026-01-01 .. 2026-04-30", () => {
    expect(presetByKey("ty_to_last_month").compute(TODAY)).toEqual({
      from: "2026-01-01",
      to: "2026-04-30",
    });
  });
  it("last_month → 2026-04-01 .. 2026-04-30", () => {
    expect(presetByKey("last_month").compute(TODAY)).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    });
  });
  it("last_30d → 2026-04-28 .. 2026-05-28", () => {
    expect(presetByKey("last_30d").compute(TODAY)).toEqual({
      from: "2026-04-28",
      to: "2026-05-28",
    });
  });
  it("last_60d → 2026-03-29 .. 2026-05-28", () => {
    expect(presetByKey("last_60d").compute(TODAY)).toEqual({
      from: "2026-03-29",
      to: "2026-05-28",
    });
  });
  it("last_90d → 2026-02-27 .. 2026-05-28", () => {
    expect(presetByKey("last_90d").compute(TODAY)).toEqual({
      from: "2026-02-27",
      to: "2026-05-28",
    });
  });
  it("last_quarter → 2026-01-01 .. 2026-03-31 (Q1, since today is Q2)", () => {
    expect(presetByKey("last_quarter").compute(TODAY)).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
  });
  it("custom → empty sentinel", () => {
    expect(presetByKey("custom").compute(TODAY)).toEqual({
      from: "",
      to: "",
    });
  });
});

describe("DEFAULT_PRESETS — edge cases", () => {
  it("leap year: last_month doesn't crash on Feb 29", () => {
    const leap = new Date(2024, 1, 29); // 2024-02-29
    const r = presetByKey("last_month").compute(leap);
    expect(r).toEqual({ from: "2024-01-01", to: "2024-01-31" });
  });

  it("year boundary: today=2026-01-15 → last_month is Dec 2025", () => {
    const jan15 = new Date(2026, 0, 15);
    expect(presetByKey("last_month").compute(jan15)).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("year boundary: today=2026-01-15 → ty_to_last_month ends 2025-12-31", () => {
    const jan15 = new Date(2026, 0, 15);
    expect(presetByKey("ty_to_last_month").compute(jan15)).toEqual({
      from: "2026-01-01",
      to: "2025-12-31",
    });
  });

  it("quarter boundary: today=2026-01-15 → last_quarter is Q4 2025", () => {
    const jan15 = new Date(2026, 0, 15);
    expect(presetByKey("last_quarter").compute(jan15)).toEqual({
      from: "2025-10-01",
      to: "2025-12-31",
    });
  });

  it("quarter boundary: today=2026-04-01 → last_quarter is Q1 2026", () => {
    const apr1 = new Date(2026, 3, 1);
    expect(presetByKey("last_quarter").compute(apr1)).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
  });

  it("DEFAULT_PRESETS has 11 entries (10 computed + custom) with unique keys", () => {
    // Arch §1 table enumerates 11 rows: MTD, YTD, TY, LY, TY→last month,
    // Last month, Last 30/60/90d, Last quarter, Custom. The "12 chips"
    // phrasing in the task brief counts Last 30/60/90 as three rows
    // (which matches the table). Either way the implementation set is
    // the 11-row table.
    expect(DEFAULT_PRESETS).toHaveLength(11);
    const keys = DEFAULT_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("mergePresets()", () => {
  const row = (o: Partial<DatePresetMasterRow>): DatePresetMasterRow => ({
    id: o.id ?? "id1",
    label: o.label ?? "Custom",
    kind: o.kind ?? "mtd",
    n: o.n ?? null,
    is_active: o.is_active,
    source_key: o.source_key ?? null,
    sort_order: o.sort_order,
  });

  it("appends an operator-added preset before the Custom sentinel", () => {
    const out = mergePresets(DEFAULT_PRESETS, [row({ id: "a", label: "Last 7d", kind: "last_n_days", n: 7 })]);
    expect(out[out.length - 1].key).toBe("custom"); // sentinel stays last
    expect(out.find((p) => p.label === "Last 7d")).toBeTruthy();
    // No built-in dropped — net +1 vs DEFAULT_PRESETS.
    expect(out).toHaveLength(DEFAULT_PRESETS.length + 1);
  });

  it("suppresses a built-in mirrored by a backfilled master row (source_key), shown once", () => {
    const backfill = row({ id: "b", label: "MTD", kind: "mtd", source_key: "mtd" });
    const out = mergePresets(DEFAULT_PRESETS, [backfill]);
    // The code built-in keyed 'mtd' is gone; the master mirror provides MTD.
    expect(out.find((p) => p.key === "mtd")).toBeUndefined();
    const mtdLabelled = out.filter((p) => p.label === "MTD");
    expect(mtdLabelled).toHaveLength(1);
    expect(mtdLabelled[0].key).toBe("custom:b");
    // Net count unchanged: one built-in dropped, one mirror added.
    expect(out).toHaveLength(DEFAULT_PRESETS.length);
  });

  it("an inactive backfilled row does NOT suppress its built-in (built-in reappears)", () => {
    const out = mergePresets(DEFAULT_PRESETS, [row({ id: "c", label: "MTD", kind: "mtd", source_key: "mtd", is_active: false })]);
    expect(out.find((p) => p.key === "mtd")).toBeTruthy();
  });
});
