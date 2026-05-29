// Tests for Tangerine P12b-2 Walmart Marketplace REST client.
//
// fetch() is mocked globally on each test. We verify URL construction,
// header injection (WM_SEC.ACCESS_TOKEN, WM_QOS.CORRELATION_ID, WM_SVC.NAME,
// WM_CONSUMER.CHANNEL.TYPE), cursor-pagination parsing, 429/5xx retry, and
// the structured-error throw on 4xx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WalmartClient, extractCursor } from "../client.js";

function mockResponse({ status = 200, json = {}, text } = {}) {
  const body = text !== undefined ? text : JSON.stringify(json);
  return {
    status,
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

const PARTNER = "10000xxxxx";
const TOKEN = "wm-access-token";

describe("WalmartClient constructor", () => {
  it("requires partnerId", () => {
    expect(() => new WalmartClient({ accessToken: TOKEN })).toThrow(/partnerId/);
  });
  it("requires accessToken", () => {
    expect(() => new WalmartClient({ partnerId: PARTNER })).toThrow(/accessToken/);
  });
  it("defaults baseUrl to https://marketplace.walmartapis.com", () => {
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    expect(c.baseUrl).toBe("https://marketplace.walmartapis.com");
  });
  it("defaults channelType to MARKETPLACE", () => {
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    expect(c.channelType).toBe("MARKETPLACE");
  });
  it("accepts a custom baseUrl + channelType", () => {
    const c = new WalmartClient({
      partnerId: PARTNER,
      accessToken: TOKEN,
      baseUrl: "https://example.test",
      channelType: "SELLER",
    });
    expect(c.baseUrl).toBe("https://example.test");
    expect(c.channelType).toBe("SELLER");
  });
});

describe("WalmartClient header injection", () => {
  it("injects WM_SEC.ACCESS_TOKEN + WM_SVC.NAME + WM_CONSUMER.CHANNEL.TYPE + WM_QOS.CORRELATION_ID + Accept on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { list: [] } }),
    );
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await c.listOrders({ createdStartDate: "2026-05-01T00:00:00Z", createdEndDate: "2026-05-02T00:00:00Z" });
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["WM_SEC.ACCESS_TOKEN"]).toBe(TOKEN);
    expect(headers["WM_SVC.NAME"]).toBe("Walmart Marketplace");
    expect(headers["WM_CONSUMER.CHANNEL.TYPE"]).toBe("MARKETPLACE");
    expect(headers["Accept"]).toBe("application/json");
    expect(typeof headers["WM_QOS.CORRELATION_ID"]).toBe("string");
    expect(headers["WM_QOS.CORRELATION_ID"].length).toBeGreaterThanOrEqual(36);
  });

  it("generates a fresh WM_QOS.CORRELATION_ID on each request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { list: [] } }));
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await c.listOrders({ createdStartDate: "2026-05-01T00:00:00Z" });
    await c.listOrders({ createdStartDate: "2026-05-02T00:00:00Z" });
    const a = fetchMock.mock.calls[0][1].headers["WM_QOS.CORRELATION_ID"];
    const b = fetchMock.mock.calls[1][1].headers["WM_QOS.CORRELATION_ID"];
    expect(a).not.toBe(b);
  });
});

describe("WalmartClient.listOrders", () => {
  it("builds correct URL with createdStartDate + createdEndDate + limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { list: [{ purchaseOrderId: "PO1" }] } }),
    );
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    const { data, nextCursor } = await c.listOrders({
      createdStartDate: "2026-05-01T00:00:00Z",
      createdEndDate: "2026-05-08T00:00:00Z",
      limit: 100,
    });
    expect(data).toEqual([{ purchaseOrderId: "PO1" }]);
    expect(nextCursor).toBeNull();
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("/v3/orders?");
    expect(url).toContain("createdStartDate=2026-05-01T00%3A00%3A00Z");
    expect(url).toContain("createdEndDate=2026-05-08T00%3A00%3A00Z");
    expect(url).toContain("limit=100");
  });

  it("listOrders defaults limit to 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { list: [] } }));
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await c.listOrders({ createdStartDate: "2026-05-01T00:00:00Z" });
    expect(fetchMock.mock.calls[0][0]).toContain("limit=200");
  });

  it("with nextCursor omits other filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { list: [] } }));
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await c.listOrders({ nextCursor: "?cursor=abc", createdStartDate: "should-be-ignored" });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("nextCursor=");
    expect(url).not.toContain("createdStartDate");
  });

  it("returns nextCursor from meta.nextCursor", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ json: { list: [{ purchaseOrderId: "PO1" }], meta: { nextCursor: "?next=abc" } } }),
    );
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    const { nextCursor } = await c.listOrders({ createdStartDate: "2026-05-01T00:00:00Z" });
    expect(nextCursor).toBe("?next=abc");
  });

  it("accepts a Date for createdStartDate (toIso conversion)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { list: [] } }));
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await c.listOrders({ createdStartDate: new Date("2026-05-01T00:00:00Z") });
    expect(fetchMock.mock.calls[0][0]).toContain("createdStartDate=2026-05-01T00%3A00%3A00.000Z");
  });
});

describe("WalmartClient.getOrder", () => {
  it("hits /v3/orders/{purchaseOrderId}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { order: { purchaseOrderId: "PO42" } } }),
    );
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    const { data } = await c.getOrder("PO42");
    expect(data).toEqual({ purchaseOrderId: "PO42" });
    expect(fetchMock.mock.calls[0][0]).toContain("/v3/orders/PO42");
  });

  it("throws without purchaseOrderId", async () => {
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await expect(c.getOrder()).rejects.toThrow(/purchaseOrderId/);
  });

  it("url-encodes the purchaseOrderId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { order: {} } }),
    );
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await c.getOrder("PO/with slash");
    expect(fetchMock.mock.calls[0][0]).toContain("/v3/orders/PO%2Fwith%20slash");
  });
});

describe("WalmartClient.getOrderItems", () => {
  it("hits /v3/orders/{id}/lines", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: { order: { orderLines: { orderLine: [{ lineNumber: 1 }, { lineNumber: 2 }] } } },
      }),
    );
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    const { data } = await c.getOrderItems("PO1");
    expect(data).toHaveLength(2);
    expect(globalThis.fetch.mock.calls[0][0]).toContain("/v3/orders/PO1/lines");
  });

  it("returns empty array when no lines present", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ json: {} }));
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    const { data } = await c.getOrderItems("PO1");
    expect(data).toEqual([]);
  });
});

describe("WalmartClient.listSettlementReports", () => {
  it("hits /v3/getReport with reportType + reportVersion=v1 + dates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { results: [{ reportId: "R1" }] } }),
    );
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    const { data } = await c.listSettlementReports({
      reportType: "SETTLEMENT",
      requestedFromDate: "2026-05-01T00:00:00Z",
      requestedToDate: "2026-05-08T00:00:00Z",
    });
    expect(data).toEqual([{ reportId: "R1" }]);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("/v3/getReport?");
    expect(url).toContain("reportType=SETTLEMENT");
    expect(url).toContain("reportVersion=v1");
    expect(url).toContain("requestedFromDate=2026-05-01T00%3A00%3A00Z");
    expect(url).toContain("requestedToDate=2026-05-08T00%3A00%3A00Z");
  });
});

describe("WalmartClient.listReturns", () => {
  it("hits /v3/returns + parses returnOrders.returnOrder", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        json: {
          returnOrders: { returnOrder: [{ returnOrderId: "RO1" }] },
          meta: { nextCursor: "?n=abc" },
        },
      }),
    );
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    const { data, nextCursor } = await c.listReturns({
      returnCreatedStartDate: "2026-05-01T00:00:00Z",
      returnCreatedEndDate: "2026-05-08T00:00:00Z",
    });
    expect(data).toEqual([{ returnOrderId: "RO1" }]);
    expect(nextCursor).toBe("?n=abc");
    expect(fetchMock.mock.calls[0][0]).toContain("/v3/returns?");
    expect(fetchMock.mock.calls[0][0]).toContain("returnCreatedStartDate=2026-05-01T00%3A00%3A00Z");
  });

  it("listReturns with nextCursor omits the date filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { returnOrders: { returnOrder: [] } } }));
    globalThis.fetch = fetchMock;
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await c.listReturns({ nextCursor: "?n=abc", returnCreatedStartDate: "ignored" });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("nextCursor=");
    expect(url).not.toContain("returnCreatedStartDate");
  });
});

describe("WalmartClient retry/error handling", () => {
  it("retries 429 with backoff up to 3 attempts, then succeeds", async () => {
    let n = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      n += 1;
      if (n < 3) return Promise.resolve(mockResponse({ status: 429, text: "rate" }));
      return Promise.resolve(mockResponse({ json: { list: [{ purchaseOrderId: "PO_OK" }] } }));
    });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    const { data } = await c.listOrders({ createdStartDate: "2026-05-01T00:00:00Z" });
    expect(data).toEqual([{ purchaseOrderId: "PO_OK" }]);
    expect(n).toBe(3);
    globalThis.setTimeout = realSetTimeout;
  });

  it("retries 503 then succeeds", async () => {
    let n = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      n += 1;
      if (n === 1) return Promise.resolve(mockResponse({ status: 503, text: "down" }));
      return Promise.resolve(mockResponse({ json: { list: [] } }));
    });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await c.listOrders({ createdStartDate: "2026-05-01T00:00:00Z" });
    expect(n).toBe(2);
    globalThis.setTimeout = realSetTimeout;
  });

  it("throws structured {status, body} on 4xx (non-retryable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 401, text: "unauthorized" }));
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await expect(c.listOrders({ createdStartDate: "2026-05-01T00:00:00Z" }))
      .rejects.toMatchObject({ status: 401, body: "unauthorized" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws after retries exhaust on persistent 429", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 429, text: "rate" }));
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    const c = new WalmartClient({ partnerId: PARTNER, accessToken: TOKEN });
    await expect(c.listOrders({ createdStartDate: "2026-05-01T00:00:00Z" }))
      .rejects.toMatchObject({ status: 429 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    globalThis.setTimeout = realSetTimeout;
  });
});

describe("extractCursor helper", () => {
  it("pulls meta.nextCursor", () => {
    expect(extractCursor({ meta: { nextCursor: "abc" } })).toBe("abc");
  });
  it("pulls list.meta.nextCursor", () => {
    expect(extractCursor({ list: { meta: { nextCursor: "xyz" } } })).toBe("xyz");
  });
  it("pulls nextCursor at root", () => {
    expect(extractCursor({ nextCursor: "top" })).toBe("top");
  });
  it("returns null for nullish / empty / non-object", () => {
    expect(extractCursor(null)).toBeNull();
    expect(extractCursor({})).toBeNull();
    expect(extractCursor("foo")).toBeNull();
  });
});
