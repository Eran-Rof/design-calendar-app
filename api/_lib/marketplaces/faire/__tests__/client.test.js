// Tests for the Faire REST client (P12c-2).
//
// Faire uses static API keys in the X-FAIRE-OAUTH-ACCESS-TOKEN header (no
// OAuth dance). The client must:
//   - Send that header on every request.
//   - Pass page/limit/updated_at_min/paid_at_min query params correctly.
//   - Surface 4xx/5xx as FaireApiError with structured {status, body}.
//   - Retry 429s up to 3 times with backoff.
//   - Enforce a 1 req/sec rate limit gate (tested via the injected sleep
//     spy — we don't actually wait 1s in tests).
//   - Return {data, hasNextPage, page} from each list method.

import { describe, it, expect, beforeEach } from "vitest";
import { FaireClient, FaireApiError, isFaireConfigured } from "../client.js";

function mockResp(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? null)),
  };
}

function spy() {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return fn.next ? fn.next(...args) : undefined;
  };
  fn.calls = calls;
  return fn;
}

const FAKE_KEY = "faire_sk_test_abc";

function makeClient(responses, { skipRateLimit = true } = {}) {
  const fetchCalls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    const r = typeof responses === "function" ? responses(url, init, i) : responses[i];
    i += 1;
    if (!r) throw new Error(`mock fetch out of responses at index ${i - 1}`);
    return r;
  };
  const sleepCalls = [];
  const sleep = async (ms) => { sleepCalls.push(ms); };
  const client = new FaireClient({
    apiKey: FAKE_KEY,
    fetchImpl,
    sleep,
    skipRateLimit,
  });
  return { client, fetchCalls, sleepCalls };
}

describe("FaireClient — construction", () => {
  it("rejects missing apiKey", () => {
    expect(() => new FaireClient({})).toThrow(/apiKey/);
    expect(() => new FaireClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("accepts a baseUrl override (testing/dev)", () => {
    const c = new FaireClient({ apiKey: "k", baseUrl: "https://stub.test" });
    expect(c.baseUrl).toBe("https://stub.test");
  });

  it("defaults baseUrl to https://www.faire.com", () => {
    const c = new FaireClient({ apiKey: "k" });
    expect(c.baseUrl).toBe("https://www.faire.com");
  });
});

describe("FaireClient — auth header", () => {
  it("sends X-FAIRE-OAUTH-ACCESS-TOKEN on every request", async () => {
    const { client, fetchCalls } = makeClient([
      mockResp(200, { orders: [], has_next_page: false }),
    ]);
    await client.listOrders({ updatedAtMin: "2026-01-01T00:00:00Z" });
    expect(fetchCalls[0].init.headers["X-FAIRE-OAUTH-ACCESS-TOKEN"]).toBe(FAKE_KEY);
    expect(fetchCalls[0].init.method).toBe("GET");
  });
});

describe("FaireClient.listOrders", () => {
  it("hits /external-api/v2/orders with updated_at_min, limit, page", async () => {
    const { client, fetchCalls } = makeClient([
      mockResp(200, { orders: [{ id: "o1" }], has_next_page: false }),
    ]);
    await client.listOrders({ updatedAtMin: "2026-05-01T00:00:00Z", limit: 25, page: 2 });
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toBe("/external-api/v2/orders");
    expect(url.searchParams.get("updated_at_min")).toBe("2026-05-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("returns {data, hasNextPage, page} from the response", async () => {
    const { client } = makeClient([
      mockResp(200, { orders: [{ id: "o1" }, { id: "o2" }], has_next_page: true }),
    ]);
    const out = await client.listOrders({ updatedAtMin: "x", page: 3 });
    expect(out.data.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(out.hasNextPage).toBe(true);
    expect(out.page).toBe(3);
  });

  it("infers hasNextPage=false when fewer-than-page-size results returned", async () => {
    const { client } = makeClient([
      mockResp(200, { orders: [{ id: "o1" }] }),  // no has_next_page flag
    ]);
    const out = await client.listOrders({ updatedAtMin: "x", limit: 50 });
    expect(out.hasNextPage).toBe(false);
  });

  it("defaults limit=50 page=1 when omitted", async () => {
    const { client, fetchCalls } = makeClient([
      mockResp(200, { orders: [] }),
    ]);
    await client.listOrders({ updatedAtMin: "x" });
    const url = new URL(fetchCalls[0].url);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("page")).toBe("1");
  });
});

describe("FaireClient.getOrder", () => {
  it("hits /external-api/v2/orders/{id} and url-encodes the id", async () => {
    const { client, fetchCalls } = makeClient([
      mockResp(200, { id: "ord_x/y" }),
    ]);
    await client.getOrder("ord_x/y");
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toBe("/external-api/v2/orders/ord_x%2Fy");
  });

  it("throws when faireOrderId missing", async () => {
    const { client } = makeClient([]);
    await expect(client.getOrder()).rejects.toThrow(/faireOrderId/);
  });
});

describe("FaireClient.listPayouts", () => {
  it("hits /external-api/v2/payouts with paid_at_min, limit, page", async () => {
    const { client, fetchCalls } = makeClient([
      mockResp(200, { payouts: [{ id: "p1" }], has_next_page: false }),
    ]);
    await client.listPayouts({ paidAtMin: "2026-05-01T00:00:00Z", limit: 10, page: 1 });
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toBe("/external-api/v2/payouts");
    expect(url.searchParams.get("paid_at_min")).toBe("2026-05-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("unwraps {payouts: [...]} into the data array", async () => {
    const { client } = makeClient([
      mockResp(200, { payouts: [{ id: "p1" }, { id: "p2" }], has_next_page: false }),
    ]);
    const out = await client.listPayouts({ paidAtMin: "x" });
    expect(out.data).toHaveLength(2);
    expect(out.hasNextPage).toBe(false);
  });
});

describe("FaireClient.getPayoutDetails", () => {
  it("hits /external-api/v2/payouts/{id}", async () => {
    const { client, fetchCalls } = makeClient([mockResp(200, { id: "p1" })]);
    await client.getPayoutDetails("p1");
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toBe("/external-api/v2/payouts/p1");
  });
});

describe("FaireClient.listShipments", () => {
  it("hits /external-api/v2/shipments with updated_at_min, limit, page", async () => {
    const { client, fetchCalls } = makeClient([
      mockResp(200, { shipments: [{ id: "s1" }] }),
    ]);
    await client.listShipments({ updatedAtMin: "2026-05-01T00:00:00Z", limit: 5, page: 1 });
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toBe("/external-api/v2/shipments");
    expect(url.searchParams.get("updated_at_min")).toBe("2026-05-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("5");
  });
});

describe("FaireClient — error surface", () => {
  it("throws FaireApiError with structured {status, body} on 4xx", async () => {
    const { client } = makeClient([
      mockResp(403, { error: "forbidden", code: "NO_ACCESS" }),
    ]);
    try {
      await client.listOrders({ updatedAtMin: "x" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FaireApiError);
      expect(e.status).toBe(403);
      expect(e.body.error).toBe("forbidden");
      expect(e.body.code).toBe("NO_ACCESS");
    }
  });

  it("throws FaireApiError with status=0 on network error", async () => {
    const c = new FaireClient({
      apiKey: FAKE_KEY,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
      sleep: async () => {},
      skipRateLimit: true,
    });
    try {
      await c.listOrders({ updatedAtMin: "x" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FaireApiError);
      expect(e.status).toBe(0);
      expect(e.message).toMatch(/network/i);
    }
  });

  it("throws FaireApiError on 500", async () => {
    const { client } = makeClient([
      mockResp(500, "Internal Server Error"),
    ]);
    await expect(client.listOrders({ updatedAtMin: "x" })).rejects.toBeInstanceOf(FaireApiError);
  });
});

describe("FaireClient — 429 retry behavior", () => {
  it("retries on 429 with exponential backoff and eventually succeeds", async () => {
    const { client, fetchCalls, sleepCalls } = makeClient([
      mockResp(429, { error: "rate_limited" }),
      mockResp(429, { error: "rate_limited" }),
      mockResp(200, { orders: [{ id: "ok" }], has_next_page: false }),
    ]);
    const out = await client.listOrders({ updatedAtMin: "x" });
    expect(out.data[0].id).toBe("ok");
    expect(fetchCalls.length).toBe(3);
    // Two retry sleeps before the third (successful) attempt.
    expect(sleepCalls.slice(0, 2)).toEqual([1000, 2000]);
  });

  it("gives up after 3 retries and throws", async () => {
    const { client, fetchCalls } = makeClient([
      mockResp(429, { error: "rate_limited" }),
      mockResp(429, { error: "rate_limited" }),
      mockResp(429, { error: "rate_limited" }),
      mockResp(429, { error: "rate_limited" }),
    ]);
    await expect(client.listOrders({ updatedAtMin: "x" })).rejects.toBeInstanceOf(FaireApiError);
    expect(fetchCalls.length).toBe(4);  // initial + 3 retries
  });
});

describe("FaireClient — rate limit gate", () => {
  it("waits ≥1s between consecutive requests (sleep spy)", async () => {
    let nowMs = 1000;
    let sleepCalls = [];
    const sleep = async (ms) => { sleepCalls.push(ms); nowMs += ms; };
    const fetchImpl = async () => mockResp(200, { orders: [], has_next_page: false });
    const c = new FaireClient({ apiKey: FAKE_KEY, fetchImpl, sleep, skipRateLimit: false });
    // Patch Date.now via spy so we control the clock.
    const origNow = Date.now;
    Date.now = () => nowMs;
    try {
      await c.listOrders({ updatedAtMin: "x" });
      await c.listOrders({ updatedAtMin: "x" });
      // Second call should have invoked sleep(≈1000) to enforce 1 req/sec.
      const gates = sleepCalls.filter((ms) => ms > 0);
      expect(gates.length).toBeGreaterThanOrEqual(1);
      expect(gates[gates.length - 1]).toBeGreaterThan(0);
      expect(gates[gates.length - 1]).toBeLessThanOrEqual(1000);
    } finally {
      Date.now = origNow;
    }
  });
});

describe("isFaireConfigured", () => {
  it("returns false when env unset", () => {
    const orig = process.env.FAIRE_TOKEN_ENC_KEY;
    delete process.env.FAIRE_TOKEN_ENC_KEY;
    expect(isFaireConfigured()).toBe(false);
    process.env.FAIRE_TOKEN_ENC_KEY = orig;
  });
  it("returns true with valid 64-hex key", () => {
    const orig = process.env.FAIRE_TOKEN_ENC_KEY;
    process.env.FAIRE_TOKEN_ENC_KEY = "a".repeat(64);
    expect(isFaireConfigured()).toBe(true);
    process.env.FAIRE_TOKEN_ENC_KEY = orig;
  });
});
