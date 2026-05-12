// One-off probe for Xoro's REST inventory endpoint.
//
// Xoro support confirmed 2026-05-11 that on-hand qty is available at:
//   GET https://res.xorosoft.io/api/xerp/inventory/getinventorybyitem
//   params: product_id | item_id | base_part_number | item_number | store
//
// This script hits the endpoint with the ATS App private-app key (the
// same VITE_XORO_ITEMS_API_KEY/SECRET that already powers SO + product
// reads) and dumps the response shape so we can wire it into
// sync-on-hand without guessing at the qty field name.
//
// Usage:
//   node scripts/probe-inventory-by-item.mjs
//   node scripts/probe-inventory-by-item.mjs --bp RYA1408
//   node scripts/probe-inventory-by-item.mjs --item <ItemNumber>

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ENV_CANDIDATES = [".env.vercel.tmp", ".env.local", ".env"];

async function loadEnv() {
  const env = {};
  for (const name of ENV_CANDIDATES) {
    try {
      const raw = await readFile(resolve(process.cwd(), name), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (env[m[1]] === undefined) env[m[1]] = v;
      }
    } catch { /* file may not exist; keep going */ }
  }
  return env;
}

function parseArgs(argv) {
  const args = { bp: null, item: null, store: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bp") args.bp = argv[++i];
    else if (a === "--item") args.item = argv[++i];
    else if (a === "--store") args.store = argv[++i];
    else if (a === "--all") args.all = true;
  }
  return args;
}

async function call(authHeader, params) {
  const url = `https://res.xorosoft.io/api/xerp/inventory/getinventorybyitem?${new URLSearchParams(params)}`;
  console.log(`\n→ GET ${url}`);
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  const text = await r.text();
  console.log(`  HTTP ${r.status}`);
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 400) }; }
  return { status: r.status, body };
}

function summarise(body) {
  if (!body) return "no body";
  if (body._raw) return `non-JSON: ${body._raw}`;
  if (!Array.isArray(body.Data)) {
    return { Result: body.Result, Message: body.Message, Data: body.Data };
  }
  const slim = body.Data.map((r) => ({
    ItemNumber: r.ItemNumber,
    StoreId: r.StoreId,
    StoreName: r.StoreName,
    OnHandQty: r.OnHandQty,
    AvailableQty: r.AvailableQty,
    AllocatedQty: r.AllocatedQty,
    QtyOnSO: r.QtyOnSO,
    QtyOnPO: r.QtyOnPO,
    QtyOnASN: r.QtyOnASN,
  }));
  return {
    Result: body.Result,
    Message: body.Message,
    TotalPages: body.TotalPages,
    DataLength: body.Data.length,
    AllKeys: body.Data[0] ? Object.keys(body.Data[0]) : null,
    Rows: slim,
  };
}

async function main() {
  const env = await loadEnv();
  const key = env.VITE_XORO_ITEMS_API_KEY;
  const secret = env.VITE_XORO_ITEMS_API_SECRET;
  if (!key || !secret) {
    console.error("Missing VITE_XORO_ITEMS_API_KEY/SECRET in .env.local");
    process.exit(1);
  }
  const auth = `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
  const args = parseArgs(process.argv);

  const trials = [];
  if (args.bp) trials.push({ label: "base_part_number", params: { base_part_number: args.bp } });
  if (args.item) trials.push({ label: "item_number", params: { item_number: args.item } });
  if (args.all || (!args.bp && !args.item)) {
    trials.push({ label: "no_filter page=1", params: { page: 1 } });
    trials.push({ label: "no_filter page=1 per_page=5", params: { page: 1, per_page: 5 } });
  }
  if (args.store && trials.length) trials.forEach((t) => (t.params.store = args.store));

  for (const t of trials) {
    console.log(`\n=== Trial: ${t.label} ===`);
    const r = await call(auth, t.params);
    console.dir(summarise(r.body), { depth: 4, maxArrayLength: 4 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
