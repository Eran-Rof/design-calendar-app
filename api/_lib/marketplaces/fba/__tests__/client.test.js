// Tests for the SP-API REST client (P12a-2).

import { describe, it, expect } from "vitest";
import { SpApiClient, SpApiError, REGIONS, _REGION_ENDPOINTS } from "../client.js";

function makeResp(status, body, hdrs = {}) {
  const headers = {
    get: (k) => hdrs[k.toLowerCase()] || null,
  };
  return { status, headers, text: async () => JSON.stringify(body) };
}

function makeClient(overrides = {}) {
  const fetchFn = overrides.fetchFn || (async () => makeResp(200, { payload: {} }));
  return new SpApiClient({
    region: overrides.region || "NA",
    accessToken: overrides.accessToken || "Atza|test",
    marketplaceId: overrides.marketplaceId || "ATVPDKIKX0DER",
    awsRoleArn: overrides.awsRoleArn || null,
    deps: {
      fetchFn,
      sleepFn: async () => {},
      randomFn: () => 0.5,
    },
  });
}

describe("SpApiClient — constructor validation", () => {
  it("throws on missing opts", () => {
    expect(() => new SpApiClient()).toThrow(/opts/);
  });

  it("throws on invalid region", () => {
    expect(() => new SpApiClient({ region: "ZZ", accessToken: "t", marketplaceId: "m" }))
      .toThrow(/region must be/);
  });

  it("throws on missing accessToken", () => {
    expect(() => new SpApiClient({ region: "NA", marketplaceId: "m" })).toThrow(/accessToken/);
  });

  it("throws on missing marketplaceId", () => {
    expect(() => new SpApiClient({ region: "NA", accessToken: "t" })).toThrow(/marketplaceId/);
  });

  it("exposes REGIONS constant for handlers", () => {
    expect(REGIONS).toEqual(expect.arrayContaining(["NA", "EU", "FE"]));
    expect(REGIONS.length).toBe(3);
  });
});

describe("SpApiClient — region routing", () => {
  it("NA → sellingpartnerapi-na endpoint", () => {
    const c = makeClient({ region: "NA" });
    expect(c.endpoint).toBe(_REGION_ENDPOINTS.NA);
    expect(c.endpoint).toContain("sellingpartnerapi-na");
  });
  it("EU → sellingpartnerapi-eu endpoint", () => {
    const c = makeClient({ region: "EU" });
    expect(c.endpoint).toContain("sellingpartnerapi-eu");
  });
  it("FE → sellingpartnerapi-fe endpoint", () => {
    const c = makeClient({ region: "FE" });
    expect(c.endpoint).toContain("sellingpartnerapi-fe");
  });
});

describe("SpApiClient — request URL + header building", () => {
  it("encodes the x-amz-access-token header", async () => {
    let capturedHeaders;
    const fetchFn = async (_url, init) => {
      capturedHeaders = init.headers;
      return makeResp(200, { payload: { Orders: [] } });
    };
    const c = makeClient({ fetchFn, accessToken: "Atza|special-tok" });
    await c.request("/orders/v0/orders", { Foo: "Bar" });
    expect(capturedHeaders["x-amz-access-token"]).toBe("Atza|special-tok");
    expect(capturedHeaders["host"]).toBe("sellingpartnerapi-na.amazon.com");
    expect(capturedHeaders["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("serializes query params (skipping null/empty)", async () => {
    let capturedUrl;
    const fetchFn = async (url) => {
      capturedUrl = url;
      return makeResp(200, { payload: {} });
    };
    const c = makeClient({ fetchFn });
    await c.request("/x", { A: "1", B: null, C: "", D: 0 });
    expect(capturedUrl).toContain("A=1");
    expect(capturedUrl).not.toContain("B=");
    expect(capturedUrl).not.toContain("C=");
    // 0 is numeric, not null/empty — should be included as "0"
    expect(capturedUrl).toContain("D=0");
  });

  it("joins array query params with comma", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: {} }); };
    const c = makeClient({ fetchFn });
    await c.request("/x", { Skus: ["a", "b", "c"] });
    expect(capturedUrl).toContain("Skus=a%2Cb%2Cc");
  });
});

describe("SpApiClient.listOrders", () => {
  it("requires createdAfter | lastUpdatedAfter | nextToken", async () => {
    const c = makeClient();
    await expect(c.listOrders({})).rejects.toThrow(/createdAfter or lastUpdatedAfter/);
  });

  it("builds the correct path + query for createdAfter", async () => {
    let capturedUrl;
    const fetchFn = async (url) => {
      capturedUrl = url;
      return makeResp(200, { payload: { Orders: [], NextToken: null } });
    };
    const c = makeClient({ fetchFn });
    await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z", maxResults: 50 });
    expect(capturedUrl).toContain("/orders/v0/orders");
    expect(capturedUrl).toContain("MarketplaceIds=ATVPDKIKX0DER");
    expect(capturedUrl).toContain("CreatedAfter=");
    expect(capturedUrl).toContain("MaxResultsPerPage=50");
  });

  it("uses LastUpdatedAfter when supplied", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: { Orders: [] } }); };
    const c = makeClient({ fetchFn });
    await c.listOrders({ lastUpdatedAfter: "2026-05-01T00:00:00Z" });
    expect(capturedUrl).toContain("LastUpdatedAfter=");
  });

  it("includes NextToken when paginating", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: { Orders: [] } }); };
    const c = makeClient({ fetchFn });
    await c.listOrders({ lastUpdatedAfter: "2026-05-01T00:00:00Z", nextToken: "abc" });
    expect(capturedUrl).toContain("NextToken=abc");
  });

  it("clamps maxResults to 1..100", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: { Orders: [] } }); };
    const c = makeClient({ fetchFn });
    await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z", maxResults: 9999 });
    expect(capturedUrl).toContain("MaxResultsPerPage=100");
    await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z", maxResults: -5 });
    expect(capturedUrl).toContain("MaxResultsPerPage=1");
  });

  it("unwraps the payload envelope", async () => {
    const fetchFn = async () => makeResp(200, { payload: { Orders: [{ AmazonOrderId: "x" }] } });
    const c = makeClient({ fetchFn });
    const r = await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z" });
    expect(r.Orders).toHaveLength(1);
  });
});

describe("SpApiClient.getOrderItems", () => {
  it("requires amazonOrderId", async () => {
    const c = makeClient();
    await expect(c.getOrderItems()).rejects.toThrow(/amazonOrderId/);
  });

  it("builds correct path", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: { OrderItems: [] } }); };
    const c = makeClient({ fetchFn });
    await c.getOrderItems("111-1234567-1234567");
    expect(capturedUrl).toContain("/orders/v0/orders/111-1234567-1234567/orderItems");
  });

  it("appends NextToken on pagination", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: { OrderItems: [] } }); };
    const c = makeClient({ fetchFn });
    await c.getOrderItems("111-1234567-1234567", "ptr");
    expect(capturedUrl).toContain("NextToken=ptr");
  });
});

describe("SpApiClient.listFinancialEventGroups", () => {
  it("builds correct path and query", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: { FinancialEventGroupList: [] } }); };
    const c = makeClient({ fetchFn });
    await c.listFinancialEventGroups({
      postedAfter: "2026-05-01T00:00:00Z",
      postedBefore: "2026-05-28T00:00:00Z",
      maxResults: 25,
    });
    expect(capturedUrl).toContain("/finances/v0/financialEventGroups");
    expect(capturedUrl).toContain("FinancialEventGroupStartedAfter=");
    expect(capturedUrl).toContain("FinancialEventGroupStartedBefore=");
    expect(capturedUrl).toContain("MaxResultsPerPage=25");
  });
});

describe("SpApiClient.getInventorySummaries", () => {
  it("builds path + default granularity=Marketplace", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: { inventorySummaries: [] } }); };
    const c = makeClient({ fetchFn });
    await c.getInventorySummaries();
    expect(capturedUrl).toContain("/fba/inventory/v1/summaries");
    expect(capturedUrl).toContain("granularityType=Marketplace");
    expect(capturedUrl).toContain("granularityId=ATVPDKIKX0DER");
    expect(capturedUrl).toContain("details=true");
  });

  it("includes sellerSkus when supplied", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: {} }); };
    const c = makeClient({ fetchFn });
    await c.getInventorySummaries({ sellerSkus: ["SKU-1", "SKU-2"] });
    expect(capturedUrl).toContain("sellerSkus=SKU-1%2CSKU-2");
  });
});

describe("SpApiClient.listReturnRequests", () => {
  it("requires createdAfter or nextToken", async () => {
    const c = makeClient();
    await expect(c.listReturnRequests({})).rejects.toThrow(/createdAfter or nextToken/);
  });

  it("builds path + query", async () => {
    let capturedUrl;
    const fetchFn = async (url) => { capturedUrl = url; return makeResp(200, { payload: { returnRequests: [] } }); };
    const c = makeClient({ fetchFn });
    await c.listReturnRequests({ createdAfter: "2026-05-01T00:00:00Z", maxResults: 10 });
    expect(capturedUrl).toContain("/fba/returns/v1/returnRequests");
    expect(capturedUrl).toContain("createdAfter=");
    expect(capturedUrl).toContain("maxResults=10");
  });
});

describe("SpApiClient — 429 / 5xx backoff", () => {
  it("retries on 429 and succeeds", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls < 3) return makeResp(429, { errors: [{ code: "QuotaExceeded" }] });
      return makeResp(200, { payload: { Orders: [] } });
    };
    const c = makeClient({ fetchFn });
    const r = await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z" });
    expect(calls).toBe(3);
    expect(r.Orders).toEqual([]);
  });

  it("retries on 503 and succeeds", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls < 2) return makeResp(503, { error: "down" });
      return makeResp(200, { payload: { Orders: [] } });
    };
    const c = makeClient({ fetchFn });
    await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z" });
    expect(calls).toBe(2);
  });

  it("gives up after 5 retries on persistent 429", async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return makeResp(429, { error: "rate" }); };
    const c = makeClient({ fetchFn });
    const err = await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z" }).catch((e) => e);
    expect(err).toBeInstanceOf(SpApiError);
    expect(err.status).toBe(429);
    expect(calls).toBe(5);
  });

  it("respects Retry-After header on 429", async () => {
    let calls = 0;
    let sleepMs = null;
    const fetchFn = async () => {
      calls++;
      if (calls === 1) return makeResp(429, { error: "rate" }, { "retry-after": "10" });
      return makeResp(200, { payload: {} });
    };
    const sleepFn = async (ms) => { sleepMs = ms; };
    const c = new SpApiClient({
      region: "NA", accessToken: "t", marketplaceId: "m",
      deps: { fetchFn, sleepFn, randomFn: () => 0.5 },
    });
    await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z" });
    expect(sleepMs).toBeGreaterThanOrEqual(10000);
  });
});

describe("SpApiClient — error throwing", () => {
  it("throws SpApiError with status/body on 400", async () => {
    const fetchFn = async () => makeResp(400, { errors: [{ code: "InvalidInput", message: "bad" }] });
    const c = makeClient({ fetchFn });
    const err = await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z" }).catch((e) => e);
    expect(err).toBeInstanceOf(SpApiError);
    expect(err.status).toBe(400);
    expect(err.body.errors[0].code).toBe("InvalidInput");
    expect(err.endpoint).toBe("/orders/v0/orders");
  });

  it("does NOT retry on 403", async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return makeResp(403, { error: "forbidden" }); };
    const c = makeClient({ fetchFn });
    await expect(c.listOrders({ createdAfter: "2026-01-01T00:00:00Z" })).rejects.toBeInstanceOf(SpApiError);
    expect(calls).toBe(1);
  });

  it("wraps fetch network errors in SpApiError after retries", async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; throw new Error("ECONNRESET"); };
    const c = makeClient({ fetchFn });
    const err = await c.listOrders({ createdAfter: "2026-01-01T00:00:00Z" }).catch((e) => e);
    expect(err).toBeInstanceOf(SpApiError);
    expect(err.status).toBe(0);
    expect(calls).toBe(5);
  });
});
