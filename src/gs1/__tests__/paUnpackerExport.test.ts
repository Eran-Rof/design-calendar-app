import { describe, it, expect, vi } from "vitest";
import * as XLSX from "xlsx-js-style";

import {
  buildPAWorkbook,
  downloadPAWorkbook,
  paUsesPaSize,
} from "../services/paUnpackerExport";
import type { PARecord } from "../services/paUnpackerService";

// Mock the writeFile side-effect so downloadPAWorkbook doesn't hit the FS.
// xlsx-js-style is a CJS module; the SUT uses `import * as X from "xlsx-js-style"`
// and reaches into X.utils / X.writeFile. We must preserve every named export
// (`utils`, `read`, etc.) AND also re-expose the actual module as `default`,
// because Vite's ESM-from-CJS interop also surfaces a `default` alias.
vi.mock("xlsx-js-style", async (importOriginal) => {
  const actual = await importOriginal<typeof XLSX & { default?: typeof XLSX }>();
  const base = (actual.default ?? actual) as typeof XLSX;
  const writeFile = vi.fn();
  return {
    ...base,
    default: { ...base, writeFile },
    writeFile,
  };
});

// ── Fixture ──────────────────────────────────────────────────────────────────
// 8 records: 2 styles × 2 colors × 2 channels × 2 delivery dates × 3 sizes
// crafted so totals are easy to predict.

const FIXTURE: PARecord[] = [
  // style 100A, RED, MDC, 02/01/27 — sizes 5, 10
  { file: "a.xls", sheet: "s1", style: "100A", style_desc: "ALPHA",  gender: "GIRLS", color: "RED",  channel: "MDC", size: "5",  units: 10, indc_date: "02/01/27" },
  { file: "a.xls", sheet: "s1", style: "100A", style_desc: "ALPHA",  gender: "GIRLS", color: "RED",  channel: "MDC", size: "10", units: 20, indc_date: "02/01/27" },
  // style 100A, RED, MDS, 11/30/26 — size 12
  { file: "a.xls", sheet: "s1", style: "100A", style_desc: "ALPHA",  gender: "GIRLS", color: "RED",  channel: "MDS", size: "12", units:  5, indc_date: "11/30/26" },
  // style 100A, BLUE, MDC, 02/01/27 — size 5
  { file: "a.xls", sheet: "s1", style: "100A", style_desc: "ALPHA",  gender: "GIRLS", color: "BLUE", channel: "MDC", size: "5",  units:  7, indc_date: "02/01/27" },
  // style 100B, RED, MDS, 02/01/27 — sizes 10, 12
  { file: "b.xls", sheet: "s2", style: "100B", style_desc: "BRAVO",  gender: "BOYS",  color: "RED",  channel: "MDS", size: "10", units: 15, indc_date: "02/01/27" },
  { file: "b.xls", sheet: "s2", style: "100B", style_desc: "BRAVO",  gender: "BOYS",  color: "RED",  channel: "MDS", size: "12", units: 25, indc_date: "02/01/27" },
  // style 100B, BLUE, MDC, 11/30/26 — sizes 5, 10
  { file: "b.xls", sheet: "s2", style: "100B", style_desc: "BRAVO",  gender: "BOYS",  color: "BLUE", channel: "MDC", size: "5",  units:  3, indc_date: "11/30/26" },
  { file: "b.xls", sheet: "s2", style: "100B", style_desc: "BRAVO",  gender: "BOYS",  color: "BLUE", channel: "MDC", size: "10", units: 15, indc_date: "11/30/26" },
];

const FIXTURE_TOTAL_UNITS = FIXTURE.reduce((sum, r) => sum + r.units, 0); // = 100

const FILE_NAMES = ["a.xls", "b.xls"];

// Pull cell.v out of a sheet's AoA representation.
function sheetToAoA(ws: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
}

describe("buildPAWorkbook", () => {
  it("returns a workbook with exactly the 6 documented sheets in order", () => {
    const wb = buildPAWorkbook(FIXTURE, FILE_NAMES);
    expect(wb.SheetNames).toEqual([
      "Pivot by Style-Color-Size",
      "Pivot by Channel",
      "Flat Table",
      "Style Totals",
      "Size Matrix",
      "Notes",
    ]);
  });

  it("Flat Table has 1 header row + N data rows for N records, with expected headers", () => {
    const wb = buildPAWorkbook(FIXTURE, FILE_NAMES);
    const aoa = sheetToAoA(wb.Sheets["Flat Table"]);
    expect(aoa.length).toBe(1 + FIXTURE.length);
    const header = aoa[0] as string[];
    expect(header).toEqual([
      "Source File", "Sheet", "Gender", "Style", "Style Desc",
      "Color", "IN DC Date", "Channel", "Size", "Units",
    ]);
  });

  it("Pivot by Style-Color-Size grand-total cell equals total units in the fixture", () => {
    const wb = buildPAWorkbook(FIXTURE, FILE_NAMES);
    const aoa = sheetToAoA(wb.Sheets["Pivot by Style-Color-Size"]);
    const lastRow = aoa[aoa.length - 1] as unknown[];
    const lastCell = lastRow[lastRow.length - 1];
    expect(lastCell).toBe(FIXTURE_TOTAL_UNITS);
  });

  it("Style Totals row count = distinct (gender, style) pairs + 1 header; per-style total matches", () => {
    const wb = buildPAWorkbook(FIXTURE, FILE_NAMES);
    const aoa = sheetToAoA(wb.Sheets["Style Totals"]);

    const distinctPairs = new Set(FIXTURE.map(r => `${r.gender}|${r.style}`));
    expect(aoa.length).toBe(1 + distinctPairs.size);

    // Spot check: style 100A's total = 10 + 20 + 5 + 7 = 42
    const alphaRow = aoa.find(r => (r as unknown[])[1] === "100A") as unknown[] | undefined;
    expect(alphaRow).toBeDefined();
    expect(alphaRow![alphaRow!.length - 1]).toBe(42);

    // Spot check: style 100B's total = 15 + 25 + 3 + 15 = 58
    const bravoRow = aoa.find(r => (r as unknown[])[1] === "100B") as unknown[] | undefined;
    expect(bravoRow).toBeDefined();
    expect(bravoRow![bravoRow!.length - 1]).toBe(58);
  });

  it("Notes sheet contains each source filename verbatim", () => {
    const wb = buildPAWorkbook(FIXTURE, FILE_NAMES);
    const aoa = sheetToAoA(wb.Sheets["Notes"]);
    const flat = aoa.flat().map(v => String(v ?? "")).join("\n");
    for (const f of FILE_NAMES) {
      expect(flat).toContain(f);
    }
  });

  it("Size Matrix contains the Style x Color x Delivery subtotal banner row", () => {
    const wb = buildPAWorkbook(FIXTURE, FILE_NAMES);
    const aoa = sheetToAoA(wb.Sheets["Size Matrix"]);
    const banner = "── Subtotals: Style × Color × Delivery (all channels combined) ──";
    const found = aoa.some(row => (row as unknown[]).some(cell => cell === banner));
    expect(found).toBe(true);
  });
});

describe("downloadPAWorkbook", () => {
  it("returns the expected filename and calls writeFile exactly once", () => {
    const writeFileMock = vi.mocked(XLSX.writeFile);
    writeFileMock.mockClear();

    // new Date(2026, 4, 20) → month index 4 = May → 2026-05-20
    const filename = downloadPAWorkbook(FIXTURE, FILE_NAMES, new Date(2026, 4, 20));

    expect(filename).toBe("EPIC_PA_Units_2026-05-20.xlsx");
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [wb, calledFilename] = writeFileMock.mock.calls[0];
    expect(calledFilename).toBe("EPIC_PA_Units_2026-05-20.xlsx");
    expect((wb as XLSX.WorkBook).SheetNames.length).toBe(6);
  });
});

describe("paUsesPaSize", () => {
  it("returns true for known PA sizes", () => {
    expect(paUsesPaSize("5")).toBe(true);
    expect(paUsesPaSize("12")).toBe(true);
    expect(paUsesPaSize("12M")).toBe(true);
    expect(paUsesPaSize("M 10-12")).toBe(true);
  });

  it("returns false for unknown sizes", () => {
    expect(paUsesPaSize("XXL")).toBe(false);
    expect(paUsesPaSize("garbage")).toBe(false);
    expect(paUsesPaSize("")).toBe(false);
  });
});
