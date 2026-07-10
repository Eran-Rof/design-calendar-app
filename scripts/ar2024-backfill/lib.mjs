// scripts/ar2024-backfill/lib.mjs
//
// Shared plumbing for the Sep–Dec 2024 AR historical backfill (closes the
// last sales-history gap: AR history previously started 2025-01-01).
//
// Sources (CEO's Xoro exports, staged locally — pass --dir):
//   Invoices_07092026*.csv  invoice REGISTRY (one row per invoice; header
//                           totals are the tie-out truth, to the cent)
//   detail_full.csv         verbatim Xoro InvoiceDetail item lines
//
// The pipeline reuses the EXISTING driver-v3 machinery end to end:
//   stage.mjs  → api/_handlers/sales/sync-invoices.js (local harness) writes
//                ip_sales_history_wholesale, then adds synthetic freight
//                top-up + header-only summary rows (source='ar2024_synth')
//   post.mjs   → api/_handlers/internal/ar-backfill/run.js (local harness)
//                posts ar_invoices + ar_invoice_lines + routed historical JEs,
//                then ar_xoro_payment_state + ar-receipts-reconcile receipts
//   verify.mjs → the six verification gates
//
// Env: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_PAT from the
// repo-root .env.local (or point AR2024_ENV_FILE at one).

import { readFileSync, readdirSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..", "..");

export const WINDOW_LO = "2024-09-01";
export const WINDOW_HI = "2024-12-31";
export const SYNTH_SOURCE = "ar2024_synth";
export const FREIGHT_SKU = "AR2024-FREIGHT";
export const SUMMARY_SKU = "AR2024-NODETAIL";
export const MACYS_NAME = "Macys"; // consignment-style → revenue-only summaries
export const ENTITY_CODE = "ROF";

// One ecom invoice's item lines sum 3¢ OVER the header (Xoro rounding):
// shave the difference off its first line so lines tie to the header
// exactly (gate 2). Cents, applied to the first detail row of the invoice.
export const PENNY_ADJUST_CENTS = { "ROF ECOM-I001091": -3 };

// Monthly header tie-out targets (cents) — computed from the registry
// exports and confirmed by the CEO's numbers. stage/post/verify all assert
// against these.
export const MONTHLY_TARGETS = {
  "2024-09": { count: 1270, cents: 182075410 },
  "2024-10": { count: 737, cents: 155457571 },
  "2024-11": { count: 1489, cents: 269678579 },
  "2024-12": { count: 1877, cents: 223044397 },
};

// ── env / clients ───────────────────────────────────────────────────────────

export function loadEnv() {
  const file = process.env.AR2024_ENV_FILE || resolve(ROOT, ".env.local");
  let out = {};
  try {
    const text = readFileSync(file, "utf8");
    out = Object.fromEntries(text.split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { /* fall through to process.env */ }
  for (const k of ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PAT"]) {
    if (!out[k] && process.env[k]) out[k] = process.env[k];
  }
  if (!out.VITE_SUPABASE_URL || !out.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(`VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found (looked in ${file}; set AR2024_ENV_FILE to your main checkout's .env.local)`);
  }
  // The local handler harness reads process.env exactly like Vercel does.
  process.env.VITE_SUPABASE_URL = out.VITE_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = out.SUPABASE_SERVICE_ROLE_KEY;
  if (out.SUPABASE_PAT) process.env.SUPABASE_PAT = out.SUPABASE_PAT;
  return out;
}

export function adminClient(env) {
  return createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// Aggregate SQL via the Supabase Management API (same channel as
// scripts/run-sql-prod.mjs). Reads cap at 1000 rows — aggregate, never dump.
const PROD_REF = "qcvqvxxoperiurauoxmp";
export async function runSql(env, sql) {
  const pat = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
  if (!pat) throw new Error("SUPABASE_PAT missing (needed for aggregate SQL)");
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API SQL failed (${res.status}): ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

export const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── CSV ─────────────────────────────────────────────────────────────────────

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const rows = [];
  let cur = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\n") { cur.push(field); field = ""; rows.push(cur); cur = []; }
    else if (c !== "\r") field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

export function money(v) {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function usDateToIso(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export const toCents = (n) => Math.round(n * 100);

// ── source loading ──────────────────────────────────────────────────────────

/**
 * Load + dedupe the invoice registry exports. Returns { headers, excluded }:
 * headers = Map(invoice_number → header) for 2024-09-01..2024-12-31;
 * excluded = rows outside the window (the 144 Jan-2025 re-exports).
 */
export function loadHeaders(dir) {
  const headers = new Map();
  const excluded = [];
  const seen = new Set();
  for (const f of readdirSync(dir)) {
    if (!/^Invoices_/i.test(f)) continue;
    for (const r of parseCsv(readFileSync(resolve(dir, f), "utf8"))) {
      const inv = String(r["Invoice Number"] || "").trim();
      if (!inv || seen.has(inv)) continue;
      seen.add(inv);
      const date = usDateToIso(r["Date"]);
      const h = {
        inv, date,
        customer: String(r["Customer Name"] || "").trim(),
        status: String(r["Status"] || "").trim(),
        totalCents: toCents(money(r["Total Amount"]) ?? 0),
        qty: money(r["Total Qty"]) ?? 0,
        dueCents: toCents(money(r["Amount Due"]) ?? 0),
        fullPaymentDate: usDateToIso(r["Full Payment Date"]),
      };
      if (date && date >= WINDOW_LO && date <= WINDOW_HI) headers.set(inv, h);
      else excluded.push(h);
    }
  }
  return { headers, excluded };
}

/** Detail rows restricted to the header set (never joins 2025+ lines). */
export function loadDetailRows(dir, headers) {
  const rows = parseCsv(readFileSync(resolve(dir, "detail_full.csv"), "utf8"));
  return rows.filter((r) => headers.has(String(r["Invoice Number"] || "").trim()));
}

export function assertMonthlyTargets(headers) {
  const monthly = {};
  for (const h of headers.values()) {
    const m = h.date.slice(0, 7);
    monthly[m] ??= { count: 0, cents: 0 };
    monthly[m].count++;
    monthly[m].cents += h.totalCents;
  }
  for (const [m, t] of Object.entries(MONTHLY_TARGETS)) {
    const got = monthly[m] || { count: 0, cents: 0 };
    if (got.count !== t.count || got.cents !== t.cents) {
      throw new Error(`Header tie-out FAILED for ${m}: got ${got.count} inv / ${got.cents}c, expected ${t.count} / ${t.cents}c`);
    }
  }
  const extra = Object.keys(monthly).filter((m) => !MONTHLY_TARGETS[m]);
  if (extra.length) throw new Error(`Unexpected months in header set: ${extra.join(", ")}`);
  return monthly;
}

// ── local handler harness ───────────────────────────────────────────────────
//
// The posting path MUST be the deployed code, byte for byte — so we import
// the repo's own api/_handlers modules and serve them on localhost with a
// minimal Vercel-compatible res shim (status/json) + JSON body pre-parse.
// This is how driver v3 was driven for the 2025-01→2026-06 load, minus the
// 300s gateway limit that forced weekly windows and 504-retries back then.

function vercelShim(handler, { parseJsonBody }) {
  return (req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); return res; };
    if (!parseJsonBody) {
      // Multipart handlers read the stream themselves.
      Promise.resolve(handler(req, res)).catch((e) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      });
      return;
    }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (body) { try { req.body = JSON.parse(body); } catch { req.body = body; } }
      Promise.resolve(handler(req, res)).catch((e) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      });
    });
  };
}

// POST JSON to the local harness WITHOUT undici's 300s headers timeout —
// a dense month takes the runner longer than that and global fetch would
// abort mid-post (leaving a stranded header for --repair).
export function httpPostJson(url, body) {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const payload = body != null ? JSON.stringify(body) : "";
    const req = httpRequest({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let json;
        try { json = JSON.parse(data); } catch { json = { raw: data }; }
        resolvePromise({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export async function startLocalHandler(modulePath, { parseJsonBody = true } = {}) {
  const mod = await import(pathToFileURL(modulePath).href);
  const server = createServer(vercelShim(mod.default, { parseJsonBody }));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((ok) => server.close(ok)),
  };
}
