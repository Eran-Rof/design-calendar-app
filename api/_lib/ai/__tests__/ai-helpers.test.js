// Unit tests for the AI helper surface — the bits most likely to bite
// silently in production if they regress. NO tests of Anthropic or
// Supabase integration here; pure helpers only.

import { describe, it, expect } from "vitest";
import { buildCacheKey } from "../answer-cache.js";
import { applyFilter } from "../executors.js";
import { defaultCardWindows, growthShare } from "../executors-cards.js";
import { computeMargin } from "../executors-margin.js";
import { clampDate, canonName, formatCacheAge, sanitizeHistory, sanitizeFollowups } from "../utils.js";

// ────────────────────────────────────────────────────────────────────────
// Cache key
// ────────────────────────────────────────────────────────────────────────

describe("buildCacheKey", () => {
  it("returns deterministic hash for same question + context", () => {
    const ctx = { active_filters: { category: ["Tops"], gender: "Mens" } };
    const a = buildCacheKey("Open AR by status", ctx);
    const b = buildCacheKey("Open AR by status", ctx);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("normalises whitespace and case", () => {
    const ctx = { active_filters: {} };
    const a = buildCacheKey("  open AR by status  ", ctx);
    const b = buildCacheKey("Open\tAR  by status", ctx);
    expect(a).toBe(b);
  });

  it("sorts multi-select filters so order doesn't matter", () => {
    const a = buildCacheKey("q", { active_filters: { category: ["A", "B"] } });
    const b = buildCacheKey("q", { active_filters: { category: ["B", "A"] } });
    expect(a).toBe(b);
  });

  it("produces different keys for different filters", () => {
    const a = buildCacheKey("q", { active_filters: { gender: "Mens" } });
    const b = buildCacheKey("q", { active_filters: { gender: "Womens" } });
    expect(a).not.toBe(b);
  });

  it("produces different keys for different questions", () => {
    const ctx = { active_filters: {} };
    expect(buildCacheKey("q1", ctx)).not.toBe(buildCacheKey("q2", ctx));
  });
});

// ────────────────────────────────────────────────────────────────────────
// applyFilter — PII / type-allowlist enforcement
// ────────────────────────────────────────────────────────────────────────

describe("applyFilter", () => {
  // Fake PostgREST builder that records calls and returns itself for chaining.
  function fakeQ() {
    const calls = [];
    const q = {
      _calls: calls,
      eq:   (c, v) => { calls.push(["eq", c, v]); return q; },
      neq:  (c, v) => { calls.push(["neq", c, v]); return q; },
      gt:   (c, v) => { calls.push(["gt", c, v]); return q; },
      gte:  (c, v) => { calls.push(["gte", c, v]); return q; },
      lt:   (c, v) => { calls.push(["lt", c, v]); return q; },
      lte:  (c, v) => { calls.push(["lte", c, v]); return q; },
      in:   (c, v) => { calls.push(["in", c, v]); return q; },
      ilike: (c, v) => { calls.push(["ilike", c, v]); return q; },
      is:    (c, v) => { calls.push(["is", c, v]); return q; },
      not:   (c, op, v) => { calls.push(["not", c, op, v]); return q; },
    };
    return q;
  }

  const table = {
    columns: {
      status:      { type: "text",    filterable: true,  groupable: true },
      total:       { type: "numeric", filterable: true,  aggregatable: true },
      due_date:    { type: "date",    filterable: true, date: true },
      secret_blob: { type: "text",    filterable: true,  pii: true },   // PII — should be stripped via publicColumns
      ignored:     { type: "text",    filterable: false },              // not filterable
    },
  };

  it("rejects columns not present in the table", () => {
    const r = applyFilter(fakeQ(), table, { col: "nope", op: "eq", value: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not readable/);
  });

  it("rejects PII-flagged columns (silently stripped from publicColumns)", () => {
    const r = applyFilter(fakeQ(), table, { col: "secret_blob", op: "eq", value: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not readable/);
  });

  it("rejects columns explicitly flagged not filterable", () => {
    const r = applyFilter(fakeQ(), table, { col: "ignored", op: "eq", value: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not filterable/);
  });

  it("rejects ops outside the allowlist for the column type", () => {
    // ilike is text-only; numeric column should reject it
    const r = applyFilter(fakeQ(), table, { col: "total", op: "ilike", value: "%x%" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not allowed/);
  });

  it("requires non-empty array for 'in'", () => {
    const r = applyFilter(fakeQ(), table, { col: "status", op: "in", value: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-empty array/);
  });

  it("caps 'in' arrays at 50 values", () => {
    const r = applyFilter(fakeQ(), table, { col: "status", op: "in", value: new Array(51).fill("x") });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/capped at 50/);
  });

  it("applies eq for valid input", () => {
    const q = fakeQ();
    const r = applyFilter(q, table, { col: "status", op: "eq", value: "approved" });
    expect(r.ok).toBe(true);
    expect(q._calls).toEqual([["eq", "status", "approved"]]);
  });

  it("applies is.null and not.is.null via supabase helpers", () => {
    const qA = fakeQ();
    expect(applyFilter(qA, table, { col: "status", op: "is_null" }).ok).toBe(true);
    expect(qA._calls).toEqual([["is", "status", null]]);

    const qB = fakeQ();
    expect(applyFilter(qB, table, { col: "status", op: "not_is_null" }).ok).toBe(true);
    expect(qB._calls).toEqual([["not", "status", "is", null]]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

describe("clampDate", () => {
  it("returns the date when valid YYYY-MM-DD", () => {
    expect(clampDate("2026-05-16")).toBe("2026-05-16");
  });
  it("rejects malformed input", () => {
    expect(clampDate("5/16/2026")).toBe(null);
    expect(clampDate("2026-5-16")).toBe(null);
    expect(clampDate("not a date")).toBe(null);
    expect(clampDate("")).toBe(null);
    expect(clampDate(null)).toBe(null);
  });
  it("rejects PostgREST-operator smuggling", () => {
    expect(clampDate("2026-05-16,xss")).toBe(null);
    expect(clampDate("2026-05-16 OR 1=1")).toBe(null);
  });
});

describe("canonName", () => {
  it("uppercases + collapses whitespace", () => {
    expect(canonName("Ross   Procurement")).toBe("ROSS PROCUREMENT");
    expect(canonName("  pac sun  ")).toBe("PAC SUN");
  });
});

describe("formatCacheAge", () => {
  it("formats seconds / minutes / hours", () => {
    expect(formatCacheAge(0)).toBe("0s");
    expect(formatCacheAge(59)).toBe("59s");
    expect(formatCacheAge(60)).toBe("1m");
    expect(formatCacheAge(3599)).toBe("59m");
    expect(formatCacheAge(3600)).toBe("1h");
    expect(formatCacheAge(7200)).toBe("2h");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Entity-card helpers (executors-cards.js)
// ────────────────────────────────────────────────────────────────────────

describe("defaultCardWindows", () => {
  it("returns YYYY-MM-DD strings for all four bounds", () => {
    const w = defaultCardWindows(new Date("2026-05-17T10:30:00Z"));
    for (const v of [w.t3Start, w.t3End, w.lyStart, w.lyEnd]) {
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("t3End is today, t3Start is exactly 3 months earlier", () => {
    const w = defaultCardWindows(new Date(2026, 4, 17));
    expect(w.t3End).toBe("2026-05-17");
    expect(w.t3Start).toBe("2026-02-17");
  });

  it("lyEnd is exactly 1 year before t3End", () => {
    const w = defaultCardWindows(new Date(2026, 4, 17));
    expect(w.lyEnd).toBe("2025-05-17");
  });

  it("lyStart is 15 months before t3End (3mo window shifted back 12mo)", () => {
    const w = defaultCardWindows(new Date(2026, 4, 17));
    expect(w.lyStart).toBe("2025-02-17");
  });

  it("handles month rollover correctly (Jan -> Oct of prior year)", () => {
    const w = defaultCardWindows(new Date(2026, 0, 15));
    expect(w.t3End).toBe("2026-01-15");
    expect(w.t3Start).toBe("2025-10-15");
    expect(w.lyEnd).toBe("2025-01-15");
    expect(w.lyStart).toBe("2024-10-15");
  });
});

describe("growthShare", () => {
  it("returns the ROF (current - prior) / current fraction", () => {
    expect(growthShare(100, 80)).toBeCloseTo(0.2, 5);
    expect(growthShare(50, 100)).toBeCloseTo(-1.0, 5);
  });

  it("returns 1 when prior is 0 (everything is incremental)", () => {
    expect(growthShare(100, 0)).toBe(1);
    expect(growthShare(1, 0)).toBe(1);
  });

  it("returns 1 when prior is negative (treat as no baseline)", () => {
    expect(growthShare(100, -5)).toBe(1);
  });

  it("returns null when current is 0 or negative (formula breaks)", () => {
    expect(growthShare(0, 50)).toBe(null);
    expect(growthShare(-5, 50)).toBe(null);
    expect(growthShare(0, 0)).toBe(null);
  });
});

describe("sanitizeHistory", () => {
  it("filters non-user/assistant entries + empty text", () => {
    const out = sanitizeHistory([
      { role: "user",      text: "q" },
      { role: "assistant", text: "" },
      { role: "system",    text: "sneak" },
      { role: "user",      text: "q2" },
      null,
      { role: "assistant", text: "a" },
    ]);
    expect(out).toEqual([
      { role: "user",      content: "q" },
      { role: "user",      content: "q2" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("caps text at 2000 chars per turn", () => {
    const long = "x".repeat(3000);
    const out = sanitizeHistory([{ role: "user", text: long }]);
    expect(out[0].content.length).toBe(2000);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeHistory(null)).toEqual([]);
    expect(sanitizeHistory("nope")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// sanitizeFollowups — drives the follow-up chip strip in AskAIPanel.
// The model is instructed to keep each ≤ 70 chars; the server enforces.
// ────────────────────────────────────────────────────────────────────────

describe("sanitizeFollowups", () => {
  it("returns the cleaned array for valid input", () => {
    const out = sanitizeFollowups([
      "Show monthly breakdown",
      "Same numbers for last year",
      "Which other customers buy this style?",
    ]);
    expect(out).toEqual([
      "Show monthly breakdown",
      "Same numbers for last year",
      "Which other customers buy this style?",
    ]);
  });

  it("trims whitespace and drops empty entries", () => {
    const out = sanitizeFollowups(["  trim me  ", "", "   ", "ok"]);
    expect(out).toEqual(["trim me", "ok"]);
  });

  it("drops entries over 70 chars", () => {
    const tooLong = "x".repeat(71);
    const out = sanitizeFollowups(["short one", tooLong, "another short"]);
    expect(out).toEqual(["short one", "another short"]);
  });

  it("keeps entries exactly 70 chars (boundary)", () => {
    const exactly70 = "y".repeat(70);
    const out = sanitizeFollowups([exactly70]);
    expect(out).toEqual([exactly70]);
  });

  it("caps at 3 even when the model emits more", () => {
    const out = sanitizeFollowups(["a", "b", "c", "d", "e"]);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("returns null when nothing survives sanitization", () => {
    expect(sanitizeFollowups([])).toBeNull();
    expect(sanitizeFollowups(["   ", ""])).toBeNull();
    expect(sanitizeFollowups([null, undefined])).toBeNull();
    // All over 70 → all dropped → null
    expect(sanitizeFollowups(["x".repeat(80), "y".repeat(90)])).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(sanitizeFollowups(null)).toBeNull();
    expect(sanitizeFollowups(undefined)).toBeNull();
    expect(sanitizeFollowups("a single string")).toBeNull();
    expect(sanitizeFollowups({ questions: ["a"] })).toBeNull();
  });

  it("coerces non-string entries via String()", () => {
    const out = sanitizeFollowups([42, "ok", true]);
    // 42 → "42", true → "true" (both ≤ 70 chars)
    expect(out).toEqual(["42", "ok", "true"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// computeMargin (executors-margin.js) — the math the AI must NEVER do
// itself. Wraps per-SKU revenue + qty + avg_cost into a single margin
// figure and honest coverage stats.
// ────────────────────────────────────────────────────────────────────────

describe("computeMargin", () => {
  it("computes margin over a full-coverage set", () => {
    const perSku = new Map([
      ["s1", { qty: 100, revenue: 1000 }],
      ["s2", { qty: 50,  revenue: 500 }],
    ]);
    const skuIdToCode = new Map([["s1", "SKU-1"], ["s2", "SKU-2"]]);
    const cost = new Map([["SKU-1", 6], ["SKU-2", 4]]);
    const pack = new Map([["s1", 1], ["s2", 1]]);
    const r = computeMargin(perSku, skuIdToCode, cost, pack);
    expect(r.revenue).toBe(1500);
    expect(r.cogs).toBe(100 * 6 + 50 * 4); // 800
    expect(r.margin_dollars).toBe(700);
    expect(r.margin_pct).toBeCloseTo(700 / 1500, 6);
    expect(r.cost_coverage_pct).toBe(1);
    expect(r.uncovered_revenue).toBe(0);
    expect(r.sku_count).toBe(2);
    expect(r.sku_count_with_cost).toBe(2);
  });

  it("reports partial coverage when some skus lack avg_cost", () => {
    const perSku = new Map([
      ["s1", { qty: 100, revenue: 1000 }],
      ["s2", { qty: 50,  revenue: 500 }],   // no cost
    ]);
    const skuIdToCode = new Map([["s1", "SKU-1"], ["s2", "SKU-2"]]);
    const cost = new Map([["SKU-1", 6]]); // SKU-2 missing
    const pack = new Map([["s1", 1], ["s2", 1]]);
    const r = computeMargin(perSku, skuIdToCode, cost, pack);
    expect(r.revenue).toBe(1500);
    expect(r.cogs).toBe(600);
    // Margin only over covered portion: 1000 - 600 = 400
    expect(r.margin_dollars).toBe(400);
    expect(r.margin_pct).toBeCloseTo(400 / 1000, 6);
    expect(r.cost_coverage_pct).toBeCloseTo(1000 / 1500, 6);
    expect(r.uncovered_revenue).toBe(500);
    expect(r.sku_count).toBe(2);
    expect(r.sku_count_with_cost).toBe(1);
    const missing = r.per_sku.find(s => s.sku_id === "s2");
    expect(missing.has_cost).toBe(false);
    expect(missing.cogs).toBeNull();
    expect(missing.margin_dollars).toBeNull();
  });

  it("returns null margin_pct when no covered revenue", () => {
    const perSku = new Map([
      ["s1", { qty: 100, revenue: 1000 }],
    ]);
    const skuIdToCode = new Map([["s1", "SKU-1"]]);
    const cost = new Map(); // nothing covered
    const pack = new Map([["s1", 1]]);
    const r = computeMargin(perSku, skuIdToCode, cost, pack);
    expect(r.margin_pct).toBeNull();
    expect(r.cost_coverage_pct).toBe(0);
    expect(r.sku_count_with_cost).toBe(0);
  });

  it("sorts per_sku descending by revenue", () => {
    const perSku = new Map([
      ["small", { qty: 1,  revenue: 10 }],
      ["big",   { qty: 10, revenue: 1000 }],
      ["mid",   { qty: 5,  revenue: 100 }],
    ]);
    const codes = new Map([["small", "A"], ["big", "B"], ["mid", "C"]]);
    const cost = new Map([["A", 1], ["B", 1], ["C", 1]]);
    const pack = new Map([["small", 1], ["big", 1], ["mid", 1]]);
    const r = computeMargin(perSku, codes, cost, pack);
    expect(r.per_sku.map(s => s.sku_id)).toEqual(["big", "mid", "small"]);
  });

  it("flags prepacks via pack_size > 1", () => {
    const perSku = new Map([["s1", { qty: 10, revenue: 100 }]]);
    const codes = new Map([["s1", "SKU-PPK"]]);
    const cost = new Map([["SKU-PPK", 5]]);
    const pack = new Map([["s1", 24]]);
    const r = computeMargin(perSku, codes, cost, pack);
    expect(r.per_sku[0].is_prepack).toBe(true);
    expect(r.per_sku[0].pack_size).toBe(24);
  });
});
