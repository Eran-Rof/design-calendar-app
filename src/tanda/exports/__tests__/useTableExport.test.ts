import { describe, it, expect } from "vitest";
import {
  inferColumns,
  formatCell,
  buildAoA,
  toCsvRow,
  toCsv,
  todayStamp,
} from "../useTableExport";

describe("inferColumns", () => {
  it("returns [] on empty rows", () => {
    expect(inferColumns([])).toEqual([]);
  });
  it("uses keys of the first row", () => {
    const out = inferColumns([{ a: 1, b: "x" }]);
    expect(out.map((c) => c.key)).toEqual(["a", "b"]);
    expect(out.map((c) => c.header)).toEqual(["a", "b"]);
  });
});

describe("formatCell", () => {
  it("null/undefined → empty string", () => {
    expect(formatCell(null)).toBe("");
    expect(formatCell(undefined)).toBe("");
  });
  it("currency_cents divides by 100", () => {
    expect(formatCell(12345, { key: "x", format: "currency_cents" })).toBe(123.45);
    expect(formatCell(null,  { key: "x", format: "currency_cents" })).toBe("");
    expect(formatCell("abc", { key: "x", format: "currency_cents" })).toBe("");
  });
  it("number format coerces", () => {
    expect(formatCell("5",  { key: "x", format: "number" })).toBe(5);
    expect(formatCell("ab", { key: "x", format: "number" })).toBe("");
  });
  it("date with Date instance", () => {
    expect(formatCell(new Date("2026-05-28T00:00:00Z"), { key: "x", format: "date" })).toBe("2026-05-28");
  });
  it("date with string passthrough", () => {
    expect(formatCell("2026-05-28", { key: "x", format: "date" })).toBe("2026-05-28");
  });
  it("object → JSON", () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });
  it("plain primitives passthrough", () => {
    expect(formatCell("hello")).toBe("hello");
    expect(formatCell(42)).toBe(42);
    expect(formatCell(true)).toBe(true);
  });
});

describe("buildAoA", () => {
  it("emits header row then body rows in column order", () => {
    type R = { code: string; amt: number | null; ignored?: string };
    const cols: Array<import("../useTableExport").ExportColumn<R>> = [
      { key: "code", header: "Code" },
      { key: "amt",  header: "Amount", format: "currency_cents" },
    ];
    const aoa = buildAoA<R>(
      [{ code: "1100", amt: 12345, ignored: "x" }, { code: "1200", amt: null }],
      cols,
    );
    expect(aoa).toEqual([
      ["Code", "Amount"],
      ["1100", 123.45],
      ["1200", ""],
    ]);
  });
});

describe("CSV encoding", () => {
  it("toCsvRow quotes only when needed (RFC 4180)", () => {
    expect(toCsvRow(["a", "b", 1])).toBe("a,b,1");
    expect(toCsvRow(["a, b", 'has "quote"', "line\nbreak"])).toBe('"a, b","has ""quote""","line\nbreak"');
    expect(toCsvRow([null, "", "x"])).toBe(",,x");
  });
  it("toCsv joins with CRLF", () => {
    expect(toCsv([["a", "b"], [1, 2]])).toBe("a,b\r\n1,2");
  });
});

describe("todayStamp", () => {
  it("returns YYYY-MM-DD shape", () => {
    expect(todayStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
