// Tests for the always-visible universal search handler (/api/internal/global-search).
//
// Pure-shape tests for the query validator + term sanitizer. No Supabase call.

import { describe, it, expect, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { validate, sanitizeTerm } from "../index.js";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, v);
  return sp;
}

describe("sanitizeTerm", () => {
  it("strips PostgREST or()/ilike breakers", () => {
    expect(sanitizeTerm("a,b(c)*d%e\\f")).toBe("a b c d e f");
  });
  it("collapses whitespace and trims", () => {
    expect(sanitizeTerm("  hello   world  ")).toBe("hello world");
  });
  it("handles null/undefined", () => {
    expect(sanitizeTerm(null)).toBe("");
    expect(sanitizeTerm(undefined)).toBe("");
  });
});

describe("validate", () => {
  it("requires q", () => {
    expect(validate(P({})).error).toMatch(/required/);
  });
  it("rejects q shorter than 2 chars after sanitizing", () => {
    expect(validate(P({ q: "a" })).error).toMatch(/at least 2/);
    // punctuation-only collapses to empty → too short
    expect(validate(P({ q: "()" })).error).toMatch(/at least 2/);
  });
  it("rejects q longer than 100 chars", () => {
    expect(validate(P({ q: "x".repeat(101) })).error).toMatch(/at most 100/);
  });
  it("accepts a valid query and defaults the limit", () => {
    const v = validate(P({ q: "acme" }));
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({ q: "acme", limit: 6 });
  });
  it("clamps limit to [1,10]", () => {
    expect(validate(P({ q: "acme", limit: "99" })).data.limit).toBe(10);
    expect(validate(P({ q: "acme", limit: "0" })).data.limit).toBe(1);
    expect(validate(P({ q: "acme", limit: "3" })).data.limit).toBe(3);
  });
  it("sanitizes the returned q", () => {
    expect(validate(P({ q: "ac,me" })).data.q).toBe("ac me");
  });
});
