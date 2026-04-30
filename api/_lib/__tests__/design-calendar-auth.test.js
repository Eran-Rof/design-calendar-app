import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  authenticateDesignCalendarCaller,
  rateLimit,
  _resetRateLimitForTests,
} from "../auth.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("authenticateDesignCalendarCaller — bearer-token gate", () => {
  let originalToken;

  beforeEach(() => {
    originalToken = process.env.DESIGN_CALENDAR_API_TOKEN;
    process.env.DESIGN_CALENDAR_API_TOKEN = TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DESIGN_CALENDAR_API_TOKEN;
    else process.env.DESIGN_CALENDAR_API_TOKEN = originalToken;
  });

  it("accepts a matching bearer token", () => {
    const r = authenticateDesignCalendarCaller({
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it("rejects a missing Authorization header with 401", () => {
    const r = authenticateDesignCalendarCaller({ headers: {} });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toMatch(/Missing bearer token/);
  });

  it("rejects an Authorization header without the Bearer scheme", () => {
    const r = authenticateDesignCalendarCaller({
      headers: { authorization: TOKEN },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it("rejects a token of the wrong length without throwing", () => {
    // crypto.timingSafeEqual throws on length mismatch — the helper must
    // length-check first so it can return 401 instead of crashing.
    const r = authenticateDesignCalendarCaller({
      headers: { authorization: "Bearer short" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it("rejects a same-length token that differs by one byte", () => {
    const wrong = "f" + TOKEN.slice(1); // same length, different byte
    expect(wrong.length).toBe(TOKEN.length);
    const r = authenticateDesignCalendarCaller({
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it("returns 500 when DESIGN_CALENDAR_API_TOKEN is unset (fail closed)", () => {
    delete process.env.DESIGN_CALENDAR_API_TOKEN;
    const r = authenticateDesignCalendarCaller({
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toMatch(/not configured/);
  });

  it("trims surrounding whitespace from a presented token", () => {
    const r = authenticateDesignCalendarCaller({
      headers: { authorization: `Bearer   ${TOKEN}   ` },
    });
    expect(r.ok).toBe(true);
  });
});

describe("rateLimit — in-memory token bucket", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
  });

  it("allows requests under the limit", () => {
    for (let i = 0; i < 5; i++) {
      const r = rateLimit("k1", { limit: 5, windowMs: 60_000 });
      expect(r.ok).toBe(true);
    }
  });

  it("returns 429 once the limit is reached", () => {
    for (let i = 0; i < 3; i++) {
      rateLimit("k2", { limit: 3, windowMs: 60_000 });
    }
    const r = rateLimit("k2", { limit: 3, windowMs: 60_000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retry_after_s).toBeGreaterThan(0);
  });

  it("partitions buckets by key — exhausting one does not affect another", () => {
    for (let i = 0; i < 3; i++) {
      rateLimit("k3", { limit: 3, windowMs: 60_000 });
    }
    const blocked = rateLimit("k3", { limit: 3, windowMs: 60_000 });
    expect(blocked.ok).toBe(false);

    const fresh = rateLimit("k4", { limit: 3, windowMs: 60_000 });
    expect(fresh.ok).toBe(true);
  });
});
