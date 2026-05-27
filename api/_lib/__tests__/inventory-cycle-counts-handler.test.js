// Tests for P3-6 cycle-counts handler — index.js + [id].js pure helpers.

import { describe, it, expect } from "vitest";
import {
  isUuid,
  parseListQuery,
  validateStartBody,
  aggregateSystemQty,
} from "../../_handlers/internal/inventory-cycle-counts/index.js";
import { validatePatch } from "../../_handlers/internal/inventory-cycle-counts/[id].js";

const UUID = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";
const UUID_C = "33333333-3333-3333-3333-333333333333";

describe("cycle-counts isUuid", () => {
  it("accepts a valid uuid", () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
  });
  it("rejects non-string", () => {
    expect(isUuid(123)).toBe(false);
  });
});

describe("cycle-counts parseListQuery", () => {
  it("empty params -> default limit 100, no filters", () => {
    const p = parseListQuery(new URLSearchParams());
    expect(p.error).toBeNull();
    expect(p.limit).toBe(100);
    expect(p.filters).toEqual({});
  });

  it("accepts all three valid statuses", () => {
    for (const s of ["in_progress", "completed", "cancelled"]) {
      const p = parseListQuery(new URLSearchParams({ status: s }));
      expect(p.error).toBeNull();
      expect(p.filters.status).toBe(s);
    }
  });

  it("rejects invalid status", () => {
    const p = parseListQuery(new URLSearchParams({ status: "done" }));
    expect(p.error).toMatch(/status/);
  });

  it("accepts ISO from + to dates", () => {
    const p = parseListQuery(new URLSearchParams({ from: "2026-01-01", to: "2026-12-31" }));
    expect(p.error).toBeNull();
    expect(p.filters.from).toBe("2026-01-01");
    expect(p.filters.to).toBe("2026-12-31");
  });

  it("rejects non-ISO from", () => {
    const p = parseListQuery(new URLSearchParams({ from: "01/01/2026" }));
    expect(p.error).toMatch(/from/);
  });

  it("rejects non-ISO to", () => {
    const p = parseListQuery(new URLSearchParams({ to: "2026-1-1" }));
    expect(p.error).toMatch(/to/);
  });

  it("caps limit at 500", () => {
    const p = parseListQuery(new URLSearchParams({ limit: "9999" }));
    expect(p.limit).toBe(500);
  });

  it("rejects bad limit", () => {
    expect(parseListQuery(new URLSearchParams({ limit: "abc" })).error).toMatch(/limit/);
    expect(parseListQuery(new URLSearchParams({ limit: "0" })).error).toMatch(/limit/);
  });
});

describe("cycle-counts validateStartBody", () => {
  it("empty body -> defaults to location='main', no count_date", () => {
    const v = validateStartBody({});
    expect(v.error).toBeUndefined();
    expect(v.data.location).toBe("main");
    expect(v.data.count_date).toBeUndefined();
  });

  it("accepts ISO count_date", () => {
    const v = validateStartBody({ count_date: "2026-05-27" });
    expect(v.error).toBeUndefined();
    expect(v.data.count_date).toBe("2026-05-27");
  });

  it("rejects non-ISO count_date", () => {
    expect(validateStartBody({ count_date: "5/27/2026" }).error).toMatch(/count_date/);
  });

  it("trims & uses custom location", () => {
    const v = validateStartBody({ location: "  retail-store-7  " });
    expect(v.data.location).toBe("retail-store-7");
  });

  it("rejects empty-string location after trim", () => {
    const v = validateStartBody({ location: "   " });
    expect(v.data.location).toBe("main"); // empty falls back to default
  });

  it("accepts scope_filter.item_ids of valid uuids", () => {
    const v = validateStartBody({ scope_filter: { item_ids: [UUID, UUID_B] } });
    expect(v.error).toBeUndefined();
    expect(v.data.scope_filter.item_ids).toEqual([UUID, UUID_B]);
  });

  it("rejects scope_filter as array", () => {
    expect(validateStartBody({ scope_filter: [UUID] }).error).toMatch(/scope_filter/);
  });

  it("rejects scope_filter.item_ids as non-array", () => {
    expect(validateStartBody({ scope_filter: { item_ids: "abc" } }).error).toMatch(/item_ids/);
  });

  it("rejects a non-uuid inside item_ids", () => {
    expect(validateStartBody({ scope_filter: { item_ids: [UUID, "x"] } }).error).toMatch(/non-uuid/);
  });

  it("stores trimmed notes", () => {
    const v = validateStartBody({ notes: "  hello  " });
    expect(v.data.notes).toBe("hello");
  });
});

describe("cycle-counts aggregateSystemQty", () => {
  it("sums remaining_qty per item_id", () => {
    const layers = [
      { item_id: UUID,  remaining_qty: 5 },
      { item_id: UUID,  remaining_qty: 3 },
      { item_id: UUID_B, remaining_qty: 10 },
    ];
    const m = aggregateSystemQty(layers);
    expect(m.get(UUID)).toBe(8);
    expect(m.get(UUID_B)).toBe(10);
    expect(m.size).toBe(2);
  });

  it("ignores rows with zero or negative remaining_qty", () => {
    const layers = [
      { item_id: UUID, remaining_qty: 5 },
      { item_id: UUID, remaining_qty: 0 },
      { item_id: UUID_B, remaining_qty: -3 },
    ];
    const m = aggregateSystemQty(layers);
    expect(m.get(UUID)).toBe(5);
    expect(m.has(UUID_B)).toBe(false);
  });

  it("ignores rows with non-numeric qty", () => {
    const layers = [
      { item_id: UUID, remaining_qty: "abc" },
      { item_id: UUID_B, remaining_qty: null },
    ];
    expect(aggregateSystemQty(layers).size).toBe(0);
  });

  it("handles empty input", () => {
    expect(aggregateSystemQty([]).size).toBe(0);
    expect(aggregateSystemQty(null).size).toBe(0);
    expect(aggregateSystemQty(undefined).size).toBe(0);
  });

  it("coerces stringified numeric qty", () => {
    const m = aggregateSystemQty([{ item_id: UUID_C, remaining_qty: "7" }]);
    expect(m.get(UUID_C)).toBe(7);
  });
});

describe("cycle-counts [id] validatePatch", () => {
  it("requires status field", () => {
    expect(validatePatch({}).error).toMatch(/status/);
  });

  it("rejects status='completed' (use /finalize)", () => {
    expect(validatePatch({ status: "completed" }).error).toMatch(/cancelled/);
  });

  it("rejects status='in_progress'", () => {
    expect(validatePatch({ status: "in_progress" }).error).toMatch(/cancelled/);
  });

  it("accepts status='cancelled'", () => {
    const v = validatePatch({ status: "cancelled" });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("cancelled");
  });

  it("rejects extra fields", () => {
    expect(validatePatch({ status: "cancelled", location: "x" }).error).toMatch(/location/);
  });

  it("rejects header-level count_date edits", () => {
    expect(validatePatch({ status: "cancelled", count_date: "2026-01-01" }).error).toMatch(/count_date/);
  });
});
