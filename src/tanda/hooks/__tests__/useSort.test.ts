import { describe, it, expect } from "vitest";
import { sortRows, baseCompare } from "../useSort";

type Row = { code?: string | null; n?: number | null; active?: boolean };

const get = (key: string, row: Row): unknown => (row as Record<string, unknown>)[key];

describe("baseCompare", () => {
  it("compares numbers numerically (not lexically)", () => {
    expect(baseCompare(2, 10)).toBeLessThan(0);
    expect(baseCompare(10, 2)).toBeGreaterThan(0);
    expect(baseCompare(5, 5)).toBe(0);
  });

  it("compares strings with numeric awareness", () => {
    expect(baseCompare("Item 2", "Item 10")).toBeLessThan(0);
    expect(baseCompare("abc", "abd")).toBeLessThan(0);
  });

  it("compares booleans false < true", () => {
    expect(baseCompare(false, true)).toBeLessThan(0);
    expect(baseCompare(true, false)).toBeGreaterThan(0);
  });

  it("compares dates by timestamp", () => {
    expect(baseCompare(new Date("2020-01-01"), new Date("2021-01-01"))).toBeLessThan(0);
  });
});

describe("sortRows", () => {
  const rows: Row[] = [
    { code: "B", n: 3 },
    { code: "a", n: 1 },
    { code: "C", n: 2 },
  ];

  it("returns input unchanged when no sort key", () => {
    expect(sortRows(rows, null, "asc", get)).toBe(rows);
  });

  it("sorts ascending by string (case-insensitive)", () => {
    const out = sortRows(rows, "code", "asc", get).map((r) => r.code);
    expect(out).toEqual(["a", "B", "C"]);
  });

  it("sorts descending by string", () => {
    const out = sortRows(rows, "code", "desc", get).map((r) => r.code);
    expect(out).toEqual(["C", "B", "a"]);
  });

  it("sorts ascending by number", () => {
    const out = sortRows(rows, "n", "asc", get).map((r) => r.n);
    expect(out).toEqual([1, 2, 3]);
  });

  it("sorts descending by number", () => {
    const out = sortRows(rows, "n", "desc", get).map((r) => r.n);
    expect(out).toEqual([3, 2, 1]);
  });

  it("sorts null / undefined / empty values LAST in ascending", () => {
    const withGaps: Row[] = [
      { code: "B" },
      { code: null },
      { code: "A" },
      { code: "" },
      { code: undefined },
    ];
    const out = sortRows(withGaps, "code", "asc", get).map((r) => r.code);
    expect(out.slice(0, 2)).toEqual(["A", "B"]);
    expect(out.slice(2)).toEqual([null, "", undefined]);
  });

  it("sorts empty values LAST in descending too", () => {
    const withGaps: Row[] = [
      { code: "B" },
      { code: null },
      { code: "A" },
    ];
    const out = sortRows(withGaps, "code", "desc", get).map((r) => r.code);
    expect(out[0]).toBe("B");
    expect(out[1]).toBe("A");
    expect(out[2]).toBe(null); // empty still last
  });

  it("is stable for equal keys (preserves original order)", () => {
    const dupes = [
      { code: "X", id: 1 },
      { code: "X", id: 2 },
      { code: "X", id: 3 },
    ];
    const out = sortRows(dupes, "code", "asc", (k, r) => (r as Record<string, unknown>)[k]).map(
      (r) => (r as { id: number }).id,
    );
    expect(out).toEqual([1, 2, 3]);
  });

  it("does not mutate the input array", () => {
    const copy = [...rows];
    sortRows(rows, "code", "asc", get);
    expect(rows).toEqual(copy);
  });
});
