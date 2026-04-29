#!/usr/bin/env node
// Local dev API server for /api/* routes. Loads .env.local then imports
// api/dispatch.js and serves it on port 3000. Bypasses `vercel dev` so we
// don't inherit Vercel cloud env vars that would override .env.local.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return;
  const txt = readFileSync(path, "utf-8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

loadEnv(".env.local");
loadEnv(".env.staging.setup");

console.log("[dev-api] VITE_SUPABASE_URL =", process.env.VITE_SUPABASE_URL);
console.log("[dev-api] SUPABASE_SERVICE_ROLE_KEY present:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);

const { default: dispatchHandler } = await import(pathToFileURL(resolve(ROOT, "api/dispatch.js")).href);

const PORT = Number(process.env.PORT || 3000);

function collectBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    // Rewrite every /api/* to /api/dispatch?__fullpath=/api/... matching vercel.json
    const urlStr = req.url || "/";
    if (!urlStr.startsWith("/api")) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "dev-api-server only handles /api/*" }));
      return;
    }
    const [pathname, search = ""] = urlStr.split("?");
    const params = new URLSearchParams(search);
    params.set("__fullpath", pathname);
    req.url = "/api/dispatch?" + params.toString();

    // Buffer + parse JSON body so handlers can read req.body
    const raw = await collectBody(req);
    if (raw.length > 0) {
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) {
        try { req.body = JSON.parse(raw.toString("utf-8")); }
        catch { req.body = raw.toString("utf-8"); }
      } else {
        req.body = raw;
      }
    }

    // Shim res.status(...).json(...) to match Vercel's API
    const origSetHeader = res.setHeader.bind(res);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => {
      origSetHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(obj));
      return res;
    };
    res.send = (body) => {
      if (typeof body === "object" && !(body instanceof Buffer)) return res.json(body);
      res.end(body);
      return res;
    };

    // Populate req.query from the rewritten URL so handlers that read it work
    req.query = Object.fromEntries(params.entries());

    await dispatchHandler(req, res);
  } catch (err) {
    console.error("[dev-api] handler error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "dev-api-server error", detail: String(err?.message || err) }));
    }
  } finally {
    const ms = Date.now() - started;
    console.log(`[dev-api] ${req.method} ${(req.url || "").split("?")[0]} -> ${res.statusCode} (${ms}ms)`);
  }
});

server.listen(PORT, () => {
  console.log(`[dev-api] listening on http://localhost:${PORT}`);
});
