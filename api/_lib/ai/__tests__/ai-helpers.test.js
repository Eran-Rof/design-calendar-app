// Unit tests for the AI helper surface — the bits most likely to bite
// silently in production if they regress. NO tests of Anthropic or
// Supabase integration here; pure helpers only.

import { describe, it, expect } from "vitest";
import { buildCacheKey } from "../answer-cache.js";
import { applyFilter } from "../executors.js";
import { clampDate, canonName, formatCacheAge, sanitizeHistory } from "../utils.js";

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
