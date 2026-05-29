// Tests for the LWA refresh-token → access-token flow (P12a-2).

import { describe, it, expect, beforeEach } from "vitest";
import { refreshLwaAccessToken, tokenCache, _clearCacheForTest } from "../lwa.js";

function jsonResp(status, body) {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  _clearCacheForTest();
});

describe("refreshLwaAccessToken — happy path", () => {
  it("returns the access_token on 200", async () => {
    const fetchFn = async () => jsonResp(200, {
      access_token: "Atza|EXAMPLE-access-token",
      token_type: "bearer",
      expires_in: 3600,
    });
    const r = await refreshLwaAccessToken({
      clientId: "amzn1.application-oa2-client.x",
      clientSecret: "secret-x",
      refreshToken: "Atzr|refresh-x",
      deps: { fetchFn },
    });
    expect(r.access_token).toBe("Atza|EXAMPLE-access-token");
    expect(r.token_type).toBe("bearer");
    expect(r.expires_in).toBe(3600);
    expect(r.cached).toBe(false);
  });

  it("posts grant_type=refresh_token form-encoded body", async () => {
    let capturedBody = null;
    let capturedHeaders = null;
    const fetchFn = async (url, init) => {
      capturedBody = init.body;
      capturedHeaders = init.headers;
      expect(url).toBe("https://api.amazon.com/auth/o2/token");
      expect(init.method).toBe("POST");
      return jsonResp(200, { access_token: "t", token_type: "bearer", expires_in: 3600 });
    };
    await refreshLwaAccessToken({
      clientId: "cid", clientSecret: "csec", refreshToken: "rtok",
      deps: { fetchFn },
    });
    expect(capturedHeaders["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("refresh_token=rtok");
    expect(capturedBody).toContain("client_id=cid");
    expect(capturedBody).toContain("client_secret=csec");
  });
});

describe("refreshLwaAccessToken — caching", () => {
  it("returns cached token on second call within expiry", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResp(200, { access_token: "tok-1", token_type: "bearer", expires_in: 3600 });
    };
    const args = { clientId: "c", clientSecret: "s", refreshToken: "r", deps: { fetchFn } };
    const a = await refreshLwaAccessToken(args);
    const b = await refreshLwaAccessToken(args);
    expect(calls).toBe(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.access_token).toBe("tok-1");
  });

  it("refreshes when cached token is within 5min of expiry", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResp(200, {
        access_token: `tok-${calls}`,
        token_type: "bearer",
        expires_in: 3600,
      });
    };
    let now = 0;
    const nowFn = () => now;
    const args = {
      clientId: "c", clientSecret: "s", refreshToken: "r",
      deps: { fetchFn, nowFn },
    };
    await refreshLwaAccessToken(args);
    expect(calls).toBe(1);
    // Advance 56 minutes — within the 5-min safety window.
    now = 56 * 60 * 1000;
    const second = await refreshLwaAccessToken(args);
    expect(calls).toBe(2);
    expect(second.cached).toBe(false);
    expect(second.access_token).toBe("tok-2");
  });

  it("uses a separate cache slot per refresh_token", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResp(200, { access_token: `tok-${calls}`, token_type: "bearer", expires_in: 3600 });
    };
    await refreshLwaAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r1", deps: { fetchFn } });
    await refreshLwaAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r2", deps: { fetchFn } });
    expect(calls).toBe(2);
    expect(tokenCache.size).toBe(2);
  });
});

describe("refreshLwaAccessToken — retry on 429 / 5xx", () => {
  it("retries on 429 and succeeds on the second attempt", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls === 1) return jsonResp(429, { error: "rate_limited" });
      return jsonResp(200, { access_token: "tok-late", token_type: "bearer", expires_in: 3600 });
    };
    const sleepFn = async () => {};
    const r = await refreshLwaAccessToken({
      clientId: "c", clientSecret: "s", refreshToken: "r-429",
      deps: { fetchFn, sleepFn },
    });
    expect(calls).toBe(2);
    expect(r.access_token).toBe("tok-late");
  });

  it("retries on 503 and gives up after 3 attempts", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResp(503, { error: "service_unavailable" });
    };
    const sleepFn = async () => {};
    await expect(refreshLwaAccessToken({
      clientId: "c", clientSecret: "s", refreshToken: "r-503",
      deps: { fetchFn, sleepFn },
    })).rejects.toThrow(/3 attempts/);
    expect(calls).toBe(3);
  });
});

describe("refreshLwaAccessToken — 4xx terminal", () => {
  it("throws immediately on 400 (does not retry)", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResp(400, { error: "invalid_grant", error_description: "refresh token expired" });
    };
    await expect(refreshLwaAccessToken({
      clientId: "c", clientSecret: "s", refreshToken: "r-bad",
      deps: { fetchFn },
    })).rejects.toThrow(/refresh token expired/);
    expect(calls).toBe(1);
  });

  it("throws immediately on 401 (does not retry)", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResp(401, { error: "invalid_client" });
    };
    const err = await refreshLwaAccessToken({
      clientId: "c", clientSecret: "s", refreshToken: "r-401",
      deps: { fetchFn },
    }).catch((e) => e);
    expect(calls).toBe(1);
    expect(err.status).toBe(401);
  });
});

describe("refreshLwaAccessToken — argument validation", () => {
  it("throws when args is missing", async () => {
    await expect(refreshLwaAccessToken(null)).rejects.toThrow(/args object/);
  });

  it("throws when clientId missing", async () => {
    await expect(refreshLwaAccessToken({ clientSecret: "s", refreshToken: "r" })).rejects.toThrow(/clientId/);
  });

  it("throws when clientSecret missing", async () => {
    await expect(refreshLwaAccessToken({ clientId: "c", refreshToken: "r" })).rejects.toThrow(/clientSecret/);
  });

  it("throws when refreshToken missing", async () => {
    await expect(refreshLwaAccessToken({ clientId: "c", clientSecret: "s" })).rejects.toThrow(/refreshToken/);
  });
});
