// Unit tests for the column-metadata module + the pure width compute.
// Covers: label-map consistency, freeze-key membership, gender fallback,
// and width clamping (cap + floor + global floor + per-key edge cases).

import { describe, it, expect } from "vitest";
import {
  FREEZABLE_COLS,
  FREEZE_LABELS,
  GENDER_LABELS,
  TOGGLEABLE_COLUMNS,
  COLUMN_LABEL,
  COL_WIDTH_CAP,
  COL_WIDTH_FLOOR,
  COL_WIDTH_FLOOR_PX,
  COL_WIDTH_CHAR_PX,
  COL_WIDTH_PADDING_CHARS,
  genderLabel,
} from "../columns";
import { computeColumnWidth } from "../computeColumnWidth";

// ────────────────────────────────────────────────────────────────────────
// COLUMN_LABEL derived from TOGGLEABLE_COLUMNS
// ────────────────────────────────────────────────────────────────────────

describe("COLUMN_LABEL", () => {
  it("has an entry for every toggleable column", () => {
    for (const col of TOGGLEABLE_COLUMNS) {
      expect(COLUMN_LABEL[col.key]).toBe(col.label);
    }
  });

  it("contains no stale keys not in TOGGLEABLE_COLUMNS", () => {
    const keys = new Set(TOGGLEABLE_COLUMNS.map(c => c.key));
    for (const k of Object.keys(COLUMN_LABEL)) {
      expect(keys.has(k)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Freeze keys
// ────────────────────────────────────────────────────────────────────────

describe("FREEZABLE_COLS / FREEZE_LABELS", () => {
  it("FREEZE_LABELS has a label for every freezable column", () => {
    for (const col of FREEZABLE_COLS) {
      expect(FREEZE_LABELS[col]).toBeTruthy();
    }
  });

  it("every freezable column is also a toggleable column", () => {
    const toggleable = new Set(TOGGLEABLE_COLUMNS.map(c => c.key));
    for (const col of FREEZABLE_COLS) {
      expect(toggleable.has(col)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// genderLabel
// ────────────────────────────────────────────────────────────────────────

describe("genderLabel", () => {
  it("maps known codes", () => {
    expect(genderLabel("M")).toBe("Mens");
    expect(genderLabel("WMS")).toBe("Womens");
    expect(genderLabel("C")).toBe("Child");
    expect(genderLabel("B")).toBe("Boys");
    expect(genderLabel("G")).toBe("Girls");
  });

  it("falls back to the raw code for unknown values", () => {
    expect(genderLabel("X")).toBe("X");
    expect(genderLabel("")).toBe("");
    expect(genderLabel("UNKNOWN")).toBe("UNKNOWN");
  });

  it("registry stays exhaustive — every entry has a non-empty label", () => {
    for (const [code, label] of Object.entries(GENDER_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(code);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// computeColumnWidth
// ────────────────────────────────────────────────────────────────────────

describe("computeColumnWidth", () => {
  it("returns the raw computed width when no CAP / FLOOR for the key", () => {
    // 10 chars + 4 padding = 14 * 7.4 = 103.6 → ceil 104
    expect(computeColumnWidth("ats", 10)).toBe(104);
  });

  it("applies CAP when computed width exceeds it (description cap = 320)", () => {
    // 1000 chars * 7.4 ≈ 7430 — well over the 320 cap
    expect(computeColumnWidth("description", 1000)).toBe(COL_WIDTH_CAP.description);
  });

  it("applies per-column FLOOR when computed width is below it (buyer floor = 84)", () => {
    // 1 char + 4 padding = 5 * 7.4 = 37 → below 44 global floor, then bumped to 84 buyer floor
    expect(computeColumnWidth("buyer", 1)).toBe(COL_WIDTH_FLOOR.buyer);
  });

  it("applies global FLOOR_PX when neither CAP nor per-column FLOOR applies", () => {
    // 1 char + 4 padding = 5 * 7.4 = 37 → below 44, no CAP/FLOOR for "ats" → bumped to 44
    expect(computeColumnWidth("ats", 1)).toBe(COL_WIDTH_FLOOR_PX);
  });

  it("returns FLOOR when content is exactly zero chars", () => {
    expect(computeColumnWidth("ats", 0)).toBe(COL_WIDTH_FLOOR_PX);
  });

  it("CAP wins over per-column FLOOR when content is huge — caps below floor are clamped to cap (no key has both, but verify order: CAP applied before FLOOR)", () => {
    // method has CAP 160 but no FLOOR — at 1000 chars, raw is 7430+, caps to 160
    expect(computeColumnWidth("method", 1000)).toBe(160);
  });

  it("invariant — width is always >= FLOOR_PX regardless of input", () => {
    for (const k of Object.keys(COLUMN_LABEL)) {
      expect(computeColumnWidth(k, 0)).toBeGreaterThanOrEqual(COL_WIDTH_FLOOR_PX);
    }
  });

  it("invariant — capped columns never exceed their cap", () => {
    for (const [k, cap] of Object.entries(COL_WIDTH_CAP)) {
      expect(computeColumnWidth(k, 10_000)).toBeLessThanOrEqual(cap);
    }
  });

  it("uses the configured CHAR_PX + PADDING — sanity check (not magic)", () => {
    // "ats" has no CAP/FLOOR; with N chars the raw should match.
    const chars = 50;
    const expected = Math.max(
      COL_WIDTH_FLOOR_PX,
      Math.ceil((chars + COL_WIDTH_PADDING_CHARS) * COL_WIDTH_CHAR_PX),
    );
    expect(computeColumnWidth("ats", chars)).toBe(expected);
  });
});
