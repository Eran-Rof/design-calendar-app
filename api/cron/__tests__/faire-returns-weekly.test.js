// Tests for /api/cron/faire-returns-weekly (P12c-4).

import { describe, it, expect, beforeEach } from "vitest";

function makeRes() {
  const headers = {};
  const res = {
    statusCode: 0, body: null,
    setHeader(k, v) { headers[k] = v; },
    headers,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    end() { return res; },
  };
  return res;
}

describe("cron/faire-returns-weekly HTTP gates", () => {
  beforeEach(() => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.FAIRE_TOKEN_ENC_KEY;
  });

  it("405s non-GET/POST methods", async () => {
    const mod = await import("../faire-returns-weekly.js");
    const handler = mod.default;
    const req = { method: "PUT", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 500 when Supabase env not configured", async () => {
    const mod = await import("../faire-returns-weekly.js");
    const handler = mod.default;
    const req = { method: "GET", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/i);
  });

  it("returns 200 skipped when FAIRE_TOKEN_ENC_KEY missing", async () => {
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const mod = await import("../faire-returns-weekly.js");
    const handler = mod.default;
    const req = { method: "GET", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.skipped).toMatch(/FAIRE_TOKEN_ENC_KEY/);
  });

  it("sets Allow header on 405", async () => {
    const mod = await import("../faire-returns-weekly.js");
    const handler = mod.default;
    const req = { method: "DELETE", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.headers.Allow).toBe("GET, POST");
  });

  it("declares maxDuration of 300", async () => {
    const mod = await import("../faire-returns-weekly.js");
    expect(mod.config).toEqual({ maxDuration: 300 });
  });
});

describe("vercel.json schedule (P12c-4)", () => {
  it("has /api/cron/faire-returns-weekly registered Mondays 05:30 UTC", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const v = JSON.parse(readFileSync(resolve(here, "../../../vercel.json"), "utf8"));
    const entry = v.crons.find((c) => c.path === "/api/cron/faire-returns-weekly");
    expect(entry).toBeDefined();
    expect(entry.schedule).toBe("30 5 * * 1");
  });
});
