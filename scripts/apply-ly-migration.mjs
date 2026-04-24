#!/usr/bin/env node
/**
 * Applies the ly_reference_qty migration to staging and seeds LY sales data.
 * Uses Supabase REST API (service role key) — no direct DB connection needed.
 *
 * Usage:
 *   node scripts/apply-ly-migration.mjs
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Load .env.staging ─────────────────────────────────────────────────────────
const envText = readFileSync(resolve(ROOT, ".env.staging"), "utf8");
const env = Object.fromEntries(
  envText.split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const SB_URL = env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY;

if (!SB_URL) { console.error("VITE_SUPABASE_URL not found in .env.staging"); process.exit(1); }

// Use service key if available, fall back to anon (needs suitable RLS or policies)
const AUTH_KEY = SERVICE_KEY || ANON_KEY;
const HEADERS = {
  "apikey": AUTH_KEY,
  "Authorization": `Bearer ${AUTH_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=representation",
};

console.log(`\n▶ Targeting: ${SB_URL}`);
console.log(`  Auth: ${SERVICE_KEY ? "service role key" : "anon key (no service key in env)"}\n`);

// ── REST helpers ──────────────────────────────────────────────────────────────
async function sbGet(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPost(path, body, prefer = "return=representation") {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ── Step 1: Check / apply the migration via a known-safe RPC ─────────────────
// Supabase doesn't expose DDL via PostgREST directly, but we can check the
// column and fall back to outputting the SQL for manual application.

process.stdout.write("  Checking ly_reference_qty column … ");
let colExists = false;
try {
  // Use pg_catalog via PostgREST information_schema view (read-only, safe)
  const rows = await sbGet(
    `information_schema.columns?table_schema=eq.public&table_name=eq.ip_wholesale_forecast&column_name=eq.ly_reference_qty&select=column_name`
  );
  colExists = rows.length > 0;
  console.log(colExists ? "✓ already exists" : "✗ missing — needs migration");
} catch (e) {
  console.log(`⚠ Could not check: ${e.message}`);
}

if (!colExists) {
  console.log(`
  ┌──────────────────────────────────────────────────────────────┐
  │  Run this SQL in the Supabase dashboard SQL editor:          │
  │  https://supabase.com/dashboard/project/jrcnpfpopwjanwmzwmsc/sql
  │                                                              │
  │  ALTER TABLE ip_wholesale_forecast                           │
  │    ADD COLUMN IF NOT EXISTS ly_reference_qty integer null;   │
  └──────────────────────────────────────────────────────────────┘
`);
}

// ── Step 2: Load masters to resolve IDs ──────────────────────────────────────
console.log("\n── Loading staging masters ───────────────────────────────────");

process.stdout.write("  ip_customer_master … ");
const customers = await sbGet("ip_customer_master?customer_code=like.DEMO-*&select=id,customer_code");
console.log(`${customers.length} demo customers`);

process.stdout.write("  ip_item_master … ");
const items = await sbGet("ip_item_master?sku_code=like.DEMO-*&select=id,sku_code");
console.log(`${items.length} demo items`);

process.stdout.write("  ip_category_master … ");
const categories = await sbGet("ip_category_master?category_code=like.DEMO-*&select=id,category_code");
console.log(`${categories.length} demo categories`);

if (!customers.length || !items.length || !categories.length) {
  console.error("\n✗ Demo fixtures not found. Run the phase-1 fixtures first.");
  process.exit(1);
}

const byCustomerCode = Object.fromEntries(customers.map(c => [c.customer_code, c.id]));
const bySkuCode = Object.fromEntries(items.map(i => [i.sku_code, i.id]));
const byCategoryCode = Object.fromEntries(categories.map(c => [c.category_code, c.id]));

const majorId   = byCustomerCode["DEMO-MAJOR"];
const teeMId    = bySkuCode["DEMO-TEE-BLK-M"];
const hoodMId   = bySkuCode["DEMO-HOOD-BLK-M"];
const catTopsId = byCategoryCode["DEMO-TOPS"];

if (!majorId || !teeMId || !hoodMId || !catTopsId) {
  console.error("✗ Required demo masters missing (MAJOR, TEE-BLK-M, HOOD-BLK-M, DEMO-TOPS).");
  process.exit(1);
}

// ── Step 3: Seed LY sales rows ────────────────────────────────────────────────
// Snapshot ≈ 2026-04-23. LY window = Mar/Apr/May 2025.
// Fixture already has May 2025 (demo:tee:major:2025-05).
// We add March and April 2025 for TEE-M, and April 2025 for HOOD-M.

console.log("\n── Seeding LY sales (2025-03 and 2025-04) ───────────────────");

const lyRows = [
  {
    sku_id: teeMId,
    customer_id: majorId,
    category_id: catTopsId,
    order_number:  "DEMO-SO-TEE-202503",
    invoice_number:"DEMO-INV-TEE-202503",
    txn_type: "invoice",
    txn_date: "2025-03-15",
    qty: 90,
    unit_price: 19.99,
    net_amount: 90 * 19.99,
    currency: "USD",
    source: "demo",
    source_line_key: "demo:tee:major:2025-03",
  },
  {
    sku_id: teeMId,
    customer_id: majorId,
    category_id: catTopsId,
    order_number:  "DEMO-SO-TEE-202504",
    invoice_number:"DEMO-INV-TEE-202504",
    txn_type: "invoice",
    txn_date: "2025-04-15",
    qty: 95,
    unit_price: 19.99,
    net_amount: 95 * 19.99,
    currency: "USD",
    source: "demo",
    source_line_key: "demo:tee:major:2025-04",
  },
  {
    sku_id: hoodMId,
    customer_id: majorId,
    category_id: catTopsId,
    order_number:  "DEMO-SO-HOOD-202504",
    invoice_number:"DEMO-INV-HOOD-202504",
    txn_type: "invoice",
    txn_date: "2025-04-10",
    qty: 55,
    unit_price: 49.99,
    net_amount: 55 * 49.99,
    currency: "USD",
    source: "demo",
    source_line_key: "demo:hood:major:2025-04",
  },
];

process.stdout.write(`  Upserting ${lyRows.length} LY rows … `);
const inserted = await sbPost(
  "ip_sales_history_wholesale?on_conflict=source,source_line_key",
  lyRows,
  "return=minimal,resolution=merge-duplicates"
);
console.log("✓");

// ── Step 4: Verify ────────────────────────────────────────────────────────────
console.log("\n── Verification ──────────────────────────────────────────────");

const lyCheck = await sbGet(
  `ip_sales_history_wholesale?sku_id=eq.${teeMId}&customer_id=eq.${majorId}&txn_date=gte.2025-03-01&txn_date=lt.2025-06-01&select=txn_date,qty&order=txn_date.asc`
);

console.log("\n  TEE-BLK-M × MAJOR in LY window (2025-03 to 2025-05):");
for (const r of lyCheck) {
  console.log(`    ${r.txn_date.slice(0, 7)}  →  ${r.qty} units`);
}

const total = lyCheck.reduce((s, r) => s + r.qty, 0);
const avg   = lyCheck.length ? Math.round(total / lyCheck.length) : 0;
console.log(`\n  LY sum: ${total}  →  system forecast (avg): ${avg}/mo`);

console.log(`
▶ Done.

  Column status : ${colExists ? "✓ ly_reference_qty already existed" : "⚠ column needs manual SQL (see above)"}
  LY rows added : TEE-BLK-M Mar+Apr 2025, HOOD-BLK-M Apr 2025

  To see results:
    1. Open Wholesale Planning → switch method to "Same Period LY"
    2. Click "Build forecast"
    3. Hist LY column shows ${total} for TEE-BLK-M (system ≈ ${avg}/mo)
    4. Click any row to open the drawer → "Same Period LY reference" section
`);
