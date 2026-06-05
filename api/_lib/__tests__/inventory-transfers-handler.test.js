// Tests for P3-7 inventory-transfers handler.
//
// Focus is on the pure parseListQuery helper + the method-routing branch of
// the default handler (405 on non-GET). Live DB calls are not exercised here.

import { describe, it, expect } from "vitest";
import handler, { isUuid, parseListQuery, parseCreateBody } from "../../_handlers/internal/inventory-transfers/index.js";

const UUID = "11111111-1111-1111-1111-111111111111";

function mkRes() {
  const res = {
    _status: null,
    _json: null,
    _ended: false,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this._status = code; return this; },
    json(payload) { this._json = payload; return this; },
    end() { this._ended = true; return this; },
  };
  return res;
}

describe("inventory-transfers isUuid", () => {
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

describe("inventory-transfers parseListQuery", () => {
  it("empty params -> default limit 100, no filters", () => {
    const p = parseListQuery(new URLSearchParams());
    expect(p.error).toBeNull();
    expect(p.limit).toBe(100);
    expect(p.filters).toEqual({});
  });

  it("accepts item_id when valid uuid", () => {
    const p = parseListQuery(new URLSearchParams({ item_id: UUID }));
    expect(p.error).toBeNull();
    expect(p.filters.item_id).toBe(UUID);
  });

  it("rejects bad item_id", () => {
    const p = parseListQuery(new URLSearchParams({ item_id: "abc" }));
    expect(p.error).toMatch(/item_id/);
  });

  it("accepts from_location + to_location text filters", () => {
    const p = parseListQuery(new URLSearchParams({ from_location: "MAIN", to_location: "RETAIL" }));
    expect(p.error).toBeNull();
    expect(p.filters.from_location).toBe("MAIN");
    expect(p.filters.to_location).toBe("RETAIL");
  });

  it("trims whitespace and drops empty filters", () => {
    const p = parseListQuery(new URLSearchParams({ from_location: "   ", to_location: "" }));
    expect(p.error).toBeNull();
    expect(p.filters.from_location).toBeUndefined();
    expect(p.filters.to_location).toBeUndefined();
  });

  it("caps limit at 500", () => {
    const p = parseListQuery(new URLSearchParams({ limit: "9999" }));
    expect(p.error).toBeNull();
    expect(p.limit).toBe(500);
  });

  it("accepts an explicit smaller limit", () => {
    const p = parseListQuery(new URLSearchParams({ limit: "25" }));
    expect(p.error).toBeNull();
    expect(p.limit).toBe(25);
  });

  it("rejects non-numeric limit", () => {
    const p = parseListQuery(new URLSearchParams({ limit: "abc" }));
    expect(p.error).toMatch(/limit/);
  });

  it("rejects zero / negative limit", () => {
    expect(parseListQuery(new URLSearchParams({ limit: "0" })).error).toMatch(/limit/);
    expect(parseListQuery(new URLSearchParams({ limit: "-5" })).error).toMatch(/limit/);
  });
});

describe("inventory-transfers handler method routing", () => {
  it("OPTIONS returns 200", async () => {
    const req = { method: "OPTIONS", url: "/api/internal/inventory-transfers", headers: { host: "x" } };
    const res = mkRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._ended).toBe(true);
  });

  it("PATCH returns 405", async () => {
    const req = { method: "PATCH", url: "/api/internal/inventory-transfers", headers: { host: "x" } };
    const res = mkRes();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it("DELETE returns 405", async () => {
    const req = { method: "DELETE", url: "/api/internal/inventory-transfers", headers: { host: "x" } };
    const res = mkRes();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it("PUT returns 405", async () => {
    const req = { method: "PUT", url: "/api/internal/inventory-transfers", headers: { host: "x" } };
    const res = mkRes();
    await handler(req, res);
    expect(res._status).toBe(405);
  });
});

describe("inventory-transfers parseCreateBody", () => {
  const OK = {
    item_id: UUID,
    qty: 5,
    from_location: "MAIN",
    to_location: "RETAIL",
  };

  it("accepts a valid minimal body", () => {
    const p = parseCreateBody(OK);
    expect(p.error).toBeUndefined();
    expect(p.value.item_id).toBe(UUID);
    expect(p.value.qty).toBe(5);
    expect(p.value.from_location).toBe("MAIN");
    expect(p.value.to_location).toBe("RETAIL");
    expect(p.value.notes).toBeNull();
    expect(p.value.transfer_date).toBeNull();
    expect(p.value.created_by_user_id).toBeNull();
  });

  it("rejects missing item_id", () => {
    expect(parseCreateBody({ ...OK, item_id: "" }).error).toMatch(/item_id/);
  });

  it("rejects non-uuid item_id", () => {
    expect(parseCreateBody({ ...OK, item_id: "abc" }).error).toMatch(/uuid/);
  });

  it("rejects zero / negative / non-numeric qty", () => {
    expect(parseCreateBody({ ...OK, qty: 0 }).error).toMatch(/qty/);
    expect(parseCreateBody({ ...OK, qty: -2 }).error).toMatch(/qty/);
    expect(parseCreateBody({ ...OK, qty: "nope" }).error).toMatch(/qty/);
  });

  it("rejects missing from_location / to_location", () => {
    expect(parseCreateBody({ ...OK, from_location: "  " }).error).toMatch(/from_location/);
    expect(parseCreateBody({ ...OK, to_location: "" }).error).toMatch(/to_location/);
  });

  it("rejects identical from/to location", () => {
    expect(parseCreateBody({ ...OK, to_location: "MAIN" }).error).toMatch(/differ/);
  });

  it("trims locations and passes through optional notes + date", () => {
    const p = parseCreateBody({ ...OK, from_location: " A ", to_location: " B ", notes: " moved ", transfer_date: "2026-06-05" });
    expect(p.error).toBeUndefined();
    expect(p.value.from_location).toBe("A");
    expect(p.value.to_location).toBe("B");
    expect(p.value.notes).toBe("moved");
    expect(p.value.transfer_date).toBe("2026-06-05");
  });

  it("keeps created_by_user_id only when a valid uuid", () => {
    expect(parseCreateBody({ ...OK, created_by_user_id: UUID }).value.created_by_user_id).toBe(UUID);
    expect(parseCreateBody({ ...OK, created_by_user_id: "not-uuid" }).value.created_by_user_id).toBeNull();
  });
});
