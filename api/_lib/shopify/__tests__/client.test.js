// Tests for Tangerine P11-2 Shopify Admin REST client.
//
// fetch() is mocked globally on each test. We verify URL construction,
// header injection, Link header parsing, 429 retry/backoff, and the
// structured-error throw on 4xx/5xx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ShopifyClient, parseLinkHeader } from "../client.js";

function mockResponse({ status = 200, json = {}, link = "", text } = {}) {
  const body = text !== undefined ? text : JSON.stringify(json);
  return {
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "link") return link;
        return null;
      },
    },
    text: async () => body,
  };
}

let savedFetch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  vi.restoreAllMocks();
});

const DOMAIN = "rof.myshopify.com";
const TOKEN  = "testtoken_test123";

describe("ShopifyClient constructor", () => {
  it("requires shopifyDomain", () => {
    expect(() => new ShopifyClient({ accessToken: TOKEN })).toThrow(/shopifyDomain/);
  });
  it("requires accessToken", () => {
    expect(() => new ShopifyClient({ shopifyDomain: DOMAIN })).toThrow(/accessToken/);
  });
  it("defaults apiVersion to 2025-01", () => {
    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    expect(c.apiVersion).toBe("2025-01");
  });
  it("accepts a custom apiVersion", () => {
    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN, apiVersion: "2024-10" });
    expect(c.apiVersion).toBe("2024-10");
  });
});

describe("ShopifyClient request building", () => {
  it("listOrders builds correct URL + injects access token header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { orders: [{ id: 1 }] } }));
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const { data } = await c.listOrders({ since: "2026-01-01T00:00:00Z", limit: 50 });

    expect(data).toEqual([{ id: 1 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`https://${DOMAIN}/admin/api/2025-01/orders.json`);
    expect(url).toContain("created_at_min=2026-01-01T00%3A00%3A00Z");
    expect(url).toContain("limit=50");
    expect(url).toContain("status=any");
    expect(init.headers["X-Shopify-Access-Token"]).toBe(TOKEN);
    expect(init.method).toBe("GET");
  });

  it("listOrders with page_info omits other filters (Shopify spec)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { orders: [] } }));
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    await c.listOrders({ page_info: "cursor-xyz", since: "should-be-ignored" });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("page_info=cursor-xyz");
    expect(url).not.toContain("created_at_min");
  });

  it("getOrder hits the right URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { order: { id: 42 } } }));
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const { data } = await c.getOrder(42);
    expect(data).toEqual({ id: 42 });
    expect(fetchMock.mock.calls[0][0]).toContain("/orders/42.json");
  });

  it("listRefunds hits the order's refunds endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { refunds: [{ id: 7 }] } }));
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const { data } = await c.listRefunds(99);
    expect(data).toEqual([{ id: 7 }]);
    expect(fetchMock.mock.calls[0][0]).toContain("/orders/99/refunds.json");
  });

  it("listPayouts builds the payouts URL with date_min/date_max", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { payouts: [] } }));
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    await c.listPayouts({ since: "2026-05-01", until: "2026-05-28" });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/shopify_payments/payouts.json");
    expect(url).toContain("date_min=2026-05-01");
    expect(url).toContain("date_max=2026-05-28");
  });

  it("getPayoutTransactions queries balance/transactions with payout_id filter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { transactions: [{ id: 1 }] } }));
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const { data } = await c.getPayoutTransactions("abc123");
    expect(data).toEqual([{ id: 1 }]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/shopify_payments/balance/transactions.json");
    expect(url).toContain("payout_id=abc123");
  });
});

describe("ShopifyClient Link header parsing", () => {
  it("parses page_info from a single next link", () => {
    const link = `<https://x.myshopify.com/admin/api/2025-01/orders.json?page_info=ABC&limit=250>; rel="next"`;
    expect(parseLinkHeader(link)).toBe("ABC");
  });

  it("returns null when there is no next link", () => {
    const link = `<https://x.myshopify.com/admin/api/2025-01/orders.json?page_info=PREV>; rel="previous"`;
    expect(parseLinkHeader(link)).toBe(null);
  });

  it("returns null on empty / missing header", () => {
    expect(parseLinkHeader("")).toBe(null);
    expect(parseLinkHeader(null)).toBe(null);
    expect(parseLinkHeader(undefined)).toBe(null);
  });

  it("picks next when both prev and next are present", () => {
    const link =
      `<https://x.myshopify.com/admin/api/2025-01/orders.json?page_info=PREV>; rel="previous", ` +
      `<https://x.myshopify.com/admin/api/2025-01/orders.json?page_info=NEXT>; rel="next"`;
    expect(parseLinkHeader(link)).toBe("NEXT");
  });

  it("listOrders surfaces nextPageInfo from the Link header", async () => {
    const link = `<https://x.myshopify.com/admin/api/2025-01/orders.json?page_info=CURSOR-NEXT>; rel="next"`;
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ json: { orders: [] }, link }));

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const { nextPageInfo } = await c.listOrders({});
    expect(nextPageInfo).toBe("CURSOR-NEXT");
  });
});

describe("ShopifyClient retry / error", () => {
  it("retries on 429 with backoff, then succeeds", async () => {
    // Stub setTimeout so the test doesn't actually wait 1s/2s.
    vi.useFakeTimers();

    const responses = [
      mockResponse({ status: 429, text: "rate limited" }),
      mockResponse({ status: 429, text: "rate limited" }),
      mockResponse({ status: 200, json: { orders: [{ id: 1 }] } }),
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()));
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const p = c.listOrders({});
    // Drain timers between fetches.
    await vi.runAllTimersAsync();
    const { data } = await p;
    expect(data).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("after 3 x 429 throws { status: 429, body }", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ status: 429, text: "still limited" }),
    );

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const p = c.listOrders({}).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
    expect(err.body).toContain("still limited");

    vi.useRealTimers();
  });

  it("throws structured error on 401 (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ status: 401, text: `{"errors":"unauthorized"}` }),
    );
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const err = await c.listOrders({}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.body).toContain("unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws structured error on 500 (no retry — not in retry set)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ status: 500, text: "boom" }),
    );
    globalThis.fetch = fetchMock;

    const c = new ShopifyClient({ shopifyDomain: DOMAIN, accessToken: TOKEN });
    const err = await c.listOrders({}).catch((e) => e);
    expect(err.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
