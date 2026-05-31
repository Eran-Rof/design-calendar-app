// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import {
  readBrandHeader, readChannelHeader,
  resolveBrandContext, resolveChannelContext,
  brandScopeMode, brandObserve,
} from "../brandContext.js";

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
