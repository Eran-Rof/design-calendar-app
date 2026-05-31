// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import {
  readBrandHeader, readChannelHeader,
  resolveBrandContext, resolveChannelContext,
  brandScopeMode, brandObserve,
  applyBrandScope, applyChannelScope,
} from "../brandContext.js";

// Minimal supabase-query stub: records .eq() calls.
function fakeQuery() {
  const calls = [];
  const q = { calls, eq(col, val) { calls.push([col, val]); return q; } };
  return q;
}

const UUID = "11111111-1111-1111-1111-111111111111";

describe("brandContext — header resolution", () => {
  it("reads X-Brand-ID (any casing) + the tangerine alias", () => {
    expect(readBrandHeader({ headers: { "x-brand-id": UUID } })).toBe(UUID);
    expect(readBrandHeader({ headers: { "X-Brand-ID": UUID } })).toBe(UUID);
    expect(readBrandHeader({ headers: { "x-tangerine-brand-id": UUID } })).toBe(UUID);
    expect(readChannelHeader({ headers: { "x-channel-id": UUID } })).toBe(UUID);
  });

  it("resolveBrandContext: valid uuid → header, else → all (safe default)", () => {
    expect(resolveBrandContext({ headers: { "x-brand-id": UUID } })).toEqual({ brand_id: UUID, source: "header" });
    expect(resolveBrandContext({ headers: { "x-brand-id": "garbage" } })).toEqual({ brand_id: null, source: "all" });
    expect(resolveBrandContext({ headers: {} })).toEqual({ brand_id: null, source: "all" });
  });

  it("resolveChannelContext mirrors brand", () => {
    expect(resolveChannelContext({ headers: { "x-channel-id": UUID } })).toEqual({ channel_id: UUID, source: "header" });
    expect(resolveChannelContext({ headers: {} })).toEqual({ channel_id: null, source: "all" });
  });
});

describe("brandScopeMode", () => {
  afterEach(() => { delete process.env.BRAND_SCOPE_MODE; });
  it("defaults to off", () => { delete process.env.BRAND_SCOPE_MODE; expect(brandScopeMode()).toBe("off"); });
  it("honours log / enforce", () => {
    process.env.BRAND_SCOPE_MODE = "log"; expect(brandScopeMode()).toBe("log");
    process.env.BRAND_SCOPE_MODE = "enforce"; expect(brandScopeMode()).toBe("enforce");
    process.env.BRAND_SCOPE_MODE = "bogus"; expect(brandScopeMode()).toBe("off");
  });
});

describe("brandObserve — silent, never throws", () => {
  afterEach(() => { delete process.env.BRAND_SCOPE_MODE; });
  it("is a no-op when mode is off (no console)", () => {
    delete process.env.BRAND_SCOPE_MODE;
    const orig = console.log; let called = 0; console.log = () => { called++; };
    try { brandObserve({ headers: { "x-brand-id": UUID } }, "/api/internal/x", "GET"); }
    finally { console.log = orig; }
    expect(called).toBe(0);
  });
  it("logs once when mode=log AND a brand/channel is selected", () => {
    process.env.BRAND_SCOPE_MODE = "log";
    const orig = console.log; let called = 0; console.log = () => { called++; };
    try {
      brandObserve({ headers: { "x-brand-id": UUID } }, "/api/internal/x", "GET");
      brandObserve({ headers: {} }, "/api/internal/y", "GET"); // all → no log
    } finally { console.log = orig; }
    expect(called).toBe(1);
  });
  it("never throws on a malformed request", () => {
    process.env.BRAND_SCOPE_MODE = "log";
    expect(() => brandObserve(null, undefined, undefined)).not.toThrow();
  });
});

describe("applyBrandScope / applyChannelScope — gated active filtering", () => {
  afterEach(() => { delete process.env.BRAND_SCOPE_MODE; });
  const reqWith = { headers: { "x-brand-id": UUID, "x-channel-id": UUID } };

  it("is a NO-OP when mode is off (default) — query untouched", () => {
    delete process.env.BRAND_SCOPE_MODE;
    const q = fakeQuery();
    expect(applyBrandScope(q, reqWith)).toBe(q);
    expect(applyChannelScope(q, reqWith)).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it("is a NO-OP in log mode (only enforce filters)", () => {
    process.env.BRAND_SCOPE_MODE = "log";
    const q = fakeQuery();
    applyBrandScope(q, reqWith);
    expect(q.calls).toEqual([]);
  });

  it("adds .eq(brand_id) / .eq(channel_id) when enforcing + selected", () => {
    process.env.BRAND_SCOPE_MODE = "enforce";
    const q = fakeQuery();
    applyBrandScope(q, reqWith);
    applyChannelScope(q, reqWith);
    expect(q.calls).toEqual([["brand_id", UUID], ["channel_id", UUID]]);
  });

  it("does NOT filter when enforcing but 'All' is selected (no header)", () => {
    process.env.BRAND_SCOPE_MODE = "enforce";
    const q = fakeQuery();
    applyBrandScope(q, { headers: {} });
    applyChannelScope(q, { headers: {} });
    expect(q.calls).toEqual([]);
  });

  it("honours a custom column name", () => {
    process.env.BRAND_SCOPE_MODE = "enforce";
    const q = fakeQuery();
    applyBrandScope(q, reqWith, "b_id");
    expect(q.calls).toEqual([["b_id", UUID]]);
  });
});
