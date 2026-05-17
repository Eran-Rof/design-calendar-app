// Tests for the spec-tab + spec-sheet detail row/column transforms.
// The renderers in TechPack.tsx now delegate every measurement-grid
// mutation to these helpers, so changing the row factory or the
// behaviour of an "add size column" backfill has to come through here.

import { describe, it, expect } from "vitest";
import {
  createMeasurementRow,
  addSizeToMeasurements,
  removeSizeFromMeasurements,
  createSpecSheetRow,
  addSizeToSpecSheet,
  removeSizeFromSpecSheet,
  DEFAULT_TOLERANCE,
} from "../specOps";
import type { Measurement, SpecSheetRow } from "../types";

// ── Measurement (Spec tab) ──────────────────────────────────────────────────

describe("createMeasurementRow", () => {
  it("seeds an empty value for every size", () => {
    const m = createMeasurementRow(["S", "M", "L"]);
    expect(m.sizes).toEqual({ S: "", M: "", L: "" });
  });

  it("uses the default tolerance + blank POM", () => {
    const m = createMeasurementRow([]);
    expect(m.tolerance).toBe(DEFAULT_TOLERANCE);
    expect(m.pointOfMeasure).toBe("");
    expect(m.id).toBeTruthy();
  });
});

describe("addSizeToMeasurements", () => {
  const seed: Measurement[] = [
    { id: "a", pointOfMeasure: "Chest",  tolerance: "±0.5", sizes: { S: "20", M: "21" } },
    { id: "b", pointOfMeasure: "Length", tolerance: "±0.5", sizes: { S: "30", M: "31" } },
  ];

  it("appends the new size with empty string in every row", () => {
    const out = addSizeToMeasurements(seed, "L");
    expect(out[0].sizes).toEqual({ S: "20", M: "21", L: "" });
    expect(out[1].sizes).toEqual({ S: "30", M: "31", L: "" });
  });

  it("trims whitespace from the size name", () => {
    const out = addSizeToMeasurements(seed, "  XL  ");
    expect("XL" in out[0].sizes).toBe(true);
  });

  it("no-ops on empty / whitespace-only input", () => {
    expect(addSizeToMeasurements(seed, "")).toBe(seed);
    expect(addSizeToMeasurements(seed, "   ")).toBe(seed);
  });

  it("preserves existing measurement values", () => {
    const out = addSizeToMeasurements(seed, "L");
    expect(out[0].sizes.S).toBe("20");
    expect(out[0].sizes.M).toBe("21");
  });
});

describe("removeSizeFromMeasurements", () => {
  it("drops the size key from every row", () => {
    const seed: Measurement[] = [
      { id: "a", pointOfMeasure: "Chest",  tolerance: "±0.5", sizes: { S: "20", M: "21", L: "22" } },
      { id: "b", pointOfMeasure: "Length", tolerance: "±0.5", sizes: { S: "30", M: "31", L: "32" } },
    ];
    const out = removeSizeFromMeasurements(seed, "M");
    expect(out[0].sizes).toEqual({ S: "20", L: "22" });
    expect(out[1].sizes).toEqual({ S: "30", L: "32" });
  });

  it("is a no-op (per-row) when size doesn't exist", () => {
    const seed: Measurement[] = [{ id: "a", pointOfMeasure: "X", tolerance: "", sizes: { S: "1" } }];
    const out = removeSizeFromMeasurements(seed, "missing");
    expect(out[0].sizes).toEqual({ S: "1" });
  });
});

// ── SpecSheet detail ────────────────────────────────────────────────────────

describe("createSpecSheetRow", () => {
  it("seeds an empty value for every size", () => {
    const r = createSpecSheetRow(["S", "M"]);
    expect(r.values).toEqual({ S: "", M: "" });
    expect(r.tolerance).toBe(DEFAULT_TOLERANCE);
  });
});

describe("addSizeToSpecSheet", () => {
  const rows: SpecSheetRow[] = [
    { id: "a", pointOfMeasure: "Chest",  tolerance: "±0.5", values: { S: "20" } },
    { id: "b", pointOfMeasure: "Length", tolerance: "±0.5", values: { S: "30" } },
  ];

  it("appends to sizes + backfills the new key in every row", () => {
    const out = addSizeToSpecSheet(rows, ["S"], "M");
    expect(out.sizes).toEqual(["S", "M"]);
    expect(out.rows[0].values).toEqual({ S: "20", M: "" });
    expect(out.rows[1].values).toEqual({ S: "30", M: "" });
  });

  it("trims whitespace and no-ops on empty input", () => {
    const out1 = addSizeToSpecSheet(rows, ["S"], "  M  ");
    expect(out1.sizes).toEqual(["S", "M"]);

    const out2 = addSizeToSpecSheet(rows, ["S"], "   ");
    expect(out2.rows).toBe(rows);
    expect(out2.sizes).toEqual(["S"]);
  });
});

describe("removeSizeFromSpecSheet", () => {
  it("removes from sizes + drops the key from every row's values", () => {
    const rows: SpecSheetRow[] = [
      { id: "a", pointOfMeasure: "Chest",  tolerance: "", values: { S: "20", M: "21", L: "22" } },
      { id: "b", pointOfMeasure: "Length", tolerance: "", values: { S: "30", M: "31", L: "32" } },
    ];
    const out = removeSizeFromSpecSheet(rows, ["S", "M", "L"], "M");
    expect(out.sizes).toEqual(["S", "L"]);
    expect(out.rows[0].values).toEqual({ S: "20", L: "22" });
    expect(out.rows[1].values).toEqual({ S: "30", L: "32" });
  });
});
