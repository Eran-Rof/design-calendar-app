// P28-3 — companion-mode tests: screen-context sanitisation/rendering and
// the cache-key extra dimension.

import { describe, it, expect } from "vitest";
import { sanitizeScreenContext, buildScreenContextBlock } from "../../ai/utils.js";
import { buildCacheKey } from "../../ai/answer-cache.js";

describe("sanitizeScreenContext", () => {
  it("passes a well-formed context through, clamped", () => {
    const out = sanitizeScreenContext({
      panel_key: "journal_entries",
      label: "Journal Entries",
      params: { je: "JE-2026-00412", q: "macys" },
      detail: "viewing one entry",
    });
    expect(out.panel_key).toBe("journal_entries");
    expect(out.label).toBe("Journal Entries");
    expect(out.params).toEqual({ je: "JE-2026-00412", q: "macys" });
  });

  it("rejects junk / missing / non-slug panel keys", () => {
    expect(sanitizeScreenContext(null)).toBeNull();
    expect(sanitizeScreenContext({})).toBeNull();
    expect(sanitizeScreenContext({ panel_key: "x; DROP TABLE" })).toBeNull();
    expect(sanitizeScreenContext("journal_entries")).toBeNull();
  });

  it("clamps param count and value lengths", () => {
    const params = {};
    for (let i = 0; i < 20; i++) params[`k${i}`] = "v".repeat(500);
    const out = sanitizeScreenContext({ panel_key: "cases", params });
    expect(Object.keys(out.params).length).toBeLessThanOrEqual(8);
    for (const v of Object.values(out.params)) expect(v.length).toBeLessThanOrEqual(120);
  });
});

describe("buildScreenContextBlock", () => {
  it("renders the block with label + params", () => {
    const block = buildScreenContextBlock({ panel_key: "chargebacks", label: "Chargebacks", params: { q: "macys" } });
    expect(block).toContain("## Current Tangerine screen");
    expect(block).toContain("Chargebacks (chargebacks)");
    expect(block).toContain("q: macys");
  });
  it("returns empty string for absent/invalid context", () => {
    expect(buildScreenContextBlock(null)).toBe("");
    expect(buildScreenContextBlock({ panel_key: "" })).toBe("");
  });
});

describe("buildCacheKey extra dimension", () => {
  const ctx = { active_filters: {} };
  it("same question on different panels caches separately", () => {
    const a = buildCacheKey("where am i", ctx, "chargebacks");
    const b = buildCacheKey("where am i", ctx, "receiving");
    const c = buildCacheKey("where am i", ctx);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
  it("no extra stays backward-compatible", () => {
    expect(buildCacheKey("q", ctx)).toBe(buildCacheKey("q", ctx, ""));
  });
});
