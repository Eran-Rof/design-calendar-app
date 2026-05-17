// Tests for the spec-sheet AOA parser. The downloader/builder paths
// depend on a globally-loaded XLSX library + browser Blob/URL APIs
// that aren't worth stubbing — the parser, however, contains the
// non-trivial format-detection logic and is fully pure (no XLSX,
// no FileReader). That's what we cover here.

import { describe, it, expect } from "vitest";
import { parseSpecSheetAoa } from "../xlsx";

describe("parseSpecSheetAoa — legacy flat format", () => {
  it("picks up sizes from header row + values from following rows", () => {
    const aoa: any[][] = [
      ["Style: SS26-001"],
      [""],
      ["Point of Measure", "TOL", "S", "M", "L"],
      ["Chest width", "0.5", "20", "21", "22"],
      ["Length",      "0.25", "26", "27", "28"],
    ];
    const out = parseSpecSheetAoa(aoa);
    expect(out).not.toBeNull();
    expect(out!.sizes).toEqual(["S", "M", "L"]);
    expect(out!.rows).toHaveLength(2);
    expect(out!.rows[0].pointOfMeasure).toBe("Chest width");
    expect(out!.rows[0].tolerance).toBe("0.5");
    expect(out!.rows[0].values).toEqual({ S: "20", M: "21", L: "22" });
    expect(out!.rows[1].pointOfMeasure).toBe("Length");
  });

  it("accepts 'POM' as a synonym for 'Point of Measure' in the header", () => {
    const aoa: any[][] = [
      ["POM", "TOL", "S", "M"],
      ["Hem",  "",    "12", "13"],
    ];
    const out = parseSpecSheetAoa(aoa);
    expect(out).not.toBeNull();
    expect(out!.sizes).toEqual(["S", "M"]);
    expect(out!.rows[0].values).toEqual({ S: "12", M: "13" });
  });

  it("skips data rows with an empty POM cell", () => {
    const aoa: any[][] = [
      ["POM", "TOL", "S"],
      ["",    "",    ""],   // blank — skipped
      ["A",   "0.1", "10"],
    ];
    const out = parseSpecSheetAoa(aoa);
    expect(out!.rows).toHaveLength(1);
    expect(out!.rows[0].pointOfMeasure).toBe("A");
  });

  it("drops trailing empty size labels in the header", () => {
    const aoa: any[][] = [
      ["POM", "TOL", "S", "M", "", "L", "", ""],
      ["A",   "",    "1", "2", "", "3", "", ""],
    ];
    const out = parseSpecSheetAoa(aoa);
    // filter(Boolean) drops the empty strings between/around sizes
    expect(out!.sizes).toEqual(["S", "M", "L"]);
  });
});

describe("parseSpecSheetAoa — new (BLOCK SPECS) format", () => {
  it("reads sizes from the row above the header, every other col starting at 6", () => {
    const aoa: any[][] = [
      // ── header row above with sizes at cols 6, 8, 10 ──
      ["", "", "", "", "", "", "S", "", "M", "", "L"],
      // ── real header row ──
      ["POM", "BLOCK SPECS", "", "", "", "TOL", "S", "", "M", "", "L"],
      // ── data row: letter in col 0, desc in col 1, TOL in col 5, values at 6,8,10 ──
      ["A", "Chest width", "", "", "", "0.5", "20", "", "21", "", "22"],
      ["B", "Length",      "", "", "", "0.25","26", "", "27", "", "28"],
    ];
    const out = parseSpecSheetAoa(aoa);
    expect(out).not.toBeNull();
    expect(out!.sizes).toEqual(["S", "M", "L"]);
    expect(out!.rows).toHaveLength(2);
    expect(out!.rows[0].pointOfMeasure).toBe("Chest width");
    expect(out!.rows[0].tolerance).toBe("0.5");
    expect(out!.rows[0].values).toEqual({ S: "20", M: "21", L: "22" });
  });

  it("falls back to the letter when description is blank", () => {
    const aoa: any[][] = [
      ["", "", "", "", "", "", "S"],
      ["POM", "BLOCK SPECS", "", "", "", "TOL", "S"],
      ["A", "", "", "", "", "0.1", "10"],   // desc empty — pom is "A"
    ];
    const out = parseSpecSheetAoa(aoa);
    expect(out!.rows[0].pointOfMeasure).toBe("A");
  });

  it("skips data rows with both letter and description empty", () => {
    const aoa: any[][] = [
      ["", "", "", "", "", "", "S"],
      ["POM", "BLOCK SPECS", "", "", "", "TOL", "S"],
      ["", "", "", "", "", "", ""],   // skipped
      ["A", "Hem", "", "", "", "0.1", "10"],
    ];
    const out = parseSpecSheetAoa(aoa);
    expect(out!.rows).toHaveLength(1);
    expect(out!.rows[0].pointOfMeasure).toBe("Hem");
  });

  it("normalises missing/empty size cells to empty strings", () => {
    const aoa: any[][] = [
      ["", "", "", "", "", "", "S", "", "M"],
      ["POM", "BLOCK SPECS", "", "", "", "TOL", "S", "", "M"],
      ["A", "Hem", "", "", "", "", "10"],   // M cell absent — should be ""
    ];
    const out = parseSpecSheetAoa(aoa);
    expect(out!.rows[0].values).toEqual({ S: "10", M: "" });
  });
});

describe("parseSpecSheetAoa — error path", () => {
  it("returns null when no recognised header row is present", () => {
    const aoa: any[][] = [
      ["Style: SS26-001"],
      ["Random data here"],
      ["No POM line"],
    ];
    expect(parseSpecSheetAoa(aoa)).toBeNull();
  });

  it("returns null on an empty workbook", () => {
    expect(parseSpecSheetAoa([])).toBeNull();
  });
});
