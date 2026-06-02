// Tests for Tangerine P12b-2 Walmart auth.js — client_credentials grant
// + in-process token cache.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getWalmartAccessToken,
  clearWalmartTokenCache,
  peekWalmartTokenCache,
  buildBasicAuthHeader,
} from "../auth.js";

function mockResponse({ status = 200, json = {}, text } = {}) {
  const body = text !== undefined ? text : JSON.stringify(json);
  return {
    status,
    text: async () => body,
  };
}

const CLIENT_ID = "wm-test-client";
const CLIENT_SECRET = "wm-test-secret";

let savedFetch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  clearWalmartTokenCache();
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  vi.restoreAllMocks();
  clearWalmartTokenCache();
});

describe("buildBasicAuthHeader", () => {
  it("base64-encodes clientId:clientSecret", () => {
    const v = buildBasicAuthHeader("alice", "wonderland");
    expect(v.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(v.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("alice:wonderland");
  });
  it("throws on missing args", () => {
    expect(() => buildBasicAuthHeader("", "x")).toThrow();
    expect(() => buildBasicAuthHeader("x", "")).toThrow();
  });
});

describe("getWalmartAccessToken — request shape", () => {
  it("POSTs to /v3/token with Basic auth, WM_QOS.CORRELATION_ID, WM_SVC.NAME, channel type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { access_token: "AAA", token_type: "Bearer", expires_in: 900 } }),
    );
    globalThis.fetch = fetchMock;

    const tok = await getWalmartAccessToken({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(tok.access_token).toBe("AAA");
    expect(tok.token_type).toBe("Bearer");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://marketplace.walmartapis.com/v3/token");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(init.headers.Authorization.slice(6), "base64").toString("utf8"))
      .toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);
    expect(init.headers["WM_SVC.NAME"]).toBe("Walmart Marketplace");
    expect(init.headers["WM_CONSUMER.CHANNEL.TYPE"]).toBe("MARKETPLACE");
    expect(typeof init.headers["WM_QOS.CORRELATION_ID"]).toBe("string");
    expect(init.headers["WM_QOS.CORRELATION_ID"].length).toBeGreaterThanOrEqual(36);
    expect(init.body).toBe("grant_type=client_credentials");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("honors a custom channelType", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ json: { access_token: "BBB", expires_in: 900 } }),
    );
    await getWalmartAccessToken({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      channelType: "SELLER",
    });
    expect(globalThis.fetch.mock.calls[0][1].headers["WM_CONSUMER.CHANNEL.TYPE"]).toBe("SELLER");
  });

  it("generates a fresh WM_QOS.CORRELATION_ID per call", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ json: { access_token: "AAA", expires_in: 900 } }),
    );
    await getWalmartAccessToken({ clientId: "c1", clientSecret: "s" });
    await getWalmartAccessToken({ clientId: "c2", clientSecret: "s" });
    const a = globalThis.fetch.mock.calls[0][1].headers["WM_QOS.CORRELATION_ID"];
    const b = globalThis.fetch.mock.calls[1][1].headers["WM_QOS.CORRELATION_ID"];
    expect(a).not.toBe(b);
  });
});

describe("getWalmartAccessToken — validation", () => {
  it("throws without clientId", async () => {
    await expect(getWalmartAccessToken({ clientSecret: "s" })).rejects.toThrow(/clientId/);
  });
  it("throws without clientSecret", async () => {
    await expect(getWalmartAccessToken({ clientId: "c" })).rejects.toThrow(/clientSecret/);
  });
  it("throws when token endpoint returns no access_token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ json: { token_type: "Bearer" } }));
    await expect(getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))
      .rejects.toThrow(/access_token/);
  });
});

describe("getWalmartAccessToken — cache", () => {
  it("caches by clientId within the expiry window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { access_token: "AAA", expires_in: 900 } }),
    );
    globalThis.fetch = fetchMock;

    const t1 = await getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const t2 = await getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(t1.access_token).toBe("AAA");
    expect(t2.access_token).toBe("AAA");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("force: true bypasses the cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { access_token: "AAA", expires_in: 900 } }),
    );
    globalThis.fetch = fetchMock;
    await getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("different clientIds get separate cache entries", async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(mockResponse({
        json: { access_token: `TOKEN${call}`, expires_in: 900 },
      }));
    });
    const a = await getWalmartAccessToken({ clientId: "c1", clientSecret: "s" });
    const b = await getWalmartAccessToken({ clientId: "c2", clientSecret: "s" });
    expect(a.access_token).toBe("TOKEN1");
    expect(b.access_token).toBe("TOKEN2");
    expect(peekWalmartTokenCache("c1").access_token).toBe("TOKEN1");
    expect(peekWalmartTokenCache("c2").access_token).toBe("TOKEN2");
  });

  it("refreshes when <2 minutes remain", async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(mockResponse({
        json: { access_token: `TOKEN${call}`, expires_in: 60 },
      }));
    });
    const t1 = await getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const t2 = await getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(t1.access_token).toBe("TOKEN1");
    expect(t2.access_token).toBe("TOKEN2");
  });

  it("clearWalmartTokenCache(id) removes that entry only", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ json: { access_token: "AAA", expires_in: 900 } }),
    );
    await getWalmartAccessToken({ clientId: "x", clientSecret: "s" });
    await getWalmartAccessToken({ clientId: "y", clientSecret: "s" });
    clearWalmartTokenCache("x");
    expect(peekWalmartTokenCache("x")).toBeUndefined();
    expect(peekWalmartTokenCache("y")).toBeDefined();
  });

  it("clearWalmartTokenCache() with no arg clears everything", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ json: { access_token: "AAA", expires_in: 900 } }),
    );
    await getWalmartAccessToken({ clientId: "x", clientSecret: "s" });
    await getWalmartAccessToken({ clientId: "y", clientSecret: "s" });
    clearWalmartTokenCache();
    expect(peekWalmartTokenCache("x")).toBeUndefined();
    expect(peekWalmartTokenCache("y")).toBeUndefined();
  });
});

describe("getWalmartAccessToken — retries", () => {
  it("retries 429 with backoff up to 3 attempts, then succeeds", async () => {
    let n = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      n += 1;
      if (n < 3) return Promise.resolve(mockResponse({ status: 429, text: "rate limited" }));
      return Promise.resolve(mockResponse({ json: { access_token: "OK", expires_in: 900 } }));
    });
    // Override sleeps so the test runs fast.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);

    const tok = await getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(tok.access_token).toBe("OK");
    expect(n).toBe(3);

    globalThis.setTimeout = realSetTimeout;
  });

  it("throws on 4xx (non-429) without retry", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 401, text: "unauthorized" }));
    await expect(getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))
      .rejects.toMatchObject({ status: 401, body: "unauthorized" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws after retries exhaust on persistent 5xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 503, text: "down" }));
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    await expect(getWalmartAccessToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))
      .rejects.toMatchObject({ status: 503 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    globalThis.setTimeout = realSetTimeout;
  });
});
