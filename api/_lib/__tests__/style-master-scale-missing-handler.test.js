// Handler guards for /api/internal/style-master/scale-missing.
// Pure — no DB. Exercises the method/config guards (the DB path is covered by
// real-DB smoke after deploy). The endpoint backs the Today "styles missing a
// size scale" drill: Style Master fetches { style_codes } and filters its grid.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import handler from "../../_handlers/internal/style-master/scale-missing.js";

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { this.ended = true; return this; },
  };
}

describe("scale-missing handler guards", () => {
  const saved = {};
  beforeEach(() => { saved.url = process.env.VITE_SUPABASE_URL; saved.key = process.env.SUPABASE_SERVICE_ROLE_KEY; });
  afterEach(() => { process.env.VITE_SUPABASE_URL = saved.url; process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key; });

  it("OPTIONS preflight returns 200 with CORS headers", async () => {
    const res = mockRes();
    await handler({ method: "OPTIONS", headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("GET");
  });

  it("rejects non-GET with 405", async () => {
    const res = mockRes();
    await handler({ method: "POST", headers: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("GET");
  });

  it("returns 500 when the service client is not configured", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = mockRes();
    await handler({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/not configured/i);
  });
});
