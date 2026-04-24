#!/usr/bin/env node
/**
 * Seeds qty_committed (On SO) on demo inventory snapshots.
 * Patches existing snapshot rows — does not insert new ones.
 *
 * Usage:
 *   node scripts/seed-so-data.mjs
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const envText = readFileSync(resolve(ROOT, ".env.staging"), "utf8");
const env = Object.fromEntries(
  envText.split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const SB_URL = env.VITE_SUPABASE_URL;
const AUTH_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

if (!SB_URL) { console.error("VITE_SUPABASE_URL not found in .env.staging"); process.exit(1); }

const HEADERS = {
  "apikey": AUTH_KEY,
  "Authorization": `Bearer ${AUTH_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=representation",
};

console.log(`\n▶ Targeting: ${SB_URL}\n`);

async function sbGet(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(path, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPost(path, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
}

// ── Load demo items ──────────────────────────────────────────────────────────
process.stdout.write("  Loading demo item IDs … ");
const items = await sbGet("ip_item_master?sku_code=like.DEMO-*&select=id,sku_code");
const byCode = Object.fromEntries(items.map(i => [i.sku_code, i.id]));

const teeMId   = byCode["DEMO-TEE-BLK-M"];
const hoodMId  = byCode["DEMO-HOOD-BLK-M"];

if (!teeMId || !hoodMId) {
  console.error("\n✗ Demo items not found. Run phase-1 fixtures first.");
  process.exit(1);
}
console.log(`TEE=${teeMId.slice(0,8)}… HOOD=${hoodMId.slice(0,8)}…`);

// ── Check existing snapshots ─────────────────────────────────────────────────
console.log("\n── Checking existing inventory snapshots ────────────────────");

const snapshots = await sbGet(
  `ip_inventory_snapshot?sku_id=in.(${teeMId},${hoodMId})&select=id,sku_id,warehouse_code,snapshot_date,qty_on_hand,qty_committed&order=snapshot_date.desc`
);

console.log(`  Found ${snapshots.length} existing snapshot row(s)`);
for (const s of snapshots) {
  const code = items.find(i => i.id === s.sku_id)?.sku_code ?? s.sku_id.slice(0,8);
  console.log(`    ${code}  wh=${s.warehouse_code}  date=${s.snapshot_date}  on_hand=${s.qty_on_hand}  committed=${s.qty_committed ?? "null"}`);
}

// ── Demo SO quantities ───────────────────────────────────────────────────────
// TEE-BLK-M: 30 units committed (20 shipping this month, 10 shipping next month)
// HOOD-BLK-M: 45 units committed (30 this month, 15 next month)
// This intentionally mixes current-month and future-month SOs to demonstrate
// the Phase 2 gap (all deducted from month 1 ATS regardless of ship date).
const soBySkuId = {
  [teeMId]:  30,
  [hoodMId]: 45,
};

if (snapshots.length === 0) {
  // No snapshots exist — insert minimal demo ones so On SO is visible
  console.log("\n── No snapshots found — inserting demo snapshots ────────────");
  const today = new Date().toISOString().slice(0, 10);
  const rows = [
    {
      sku_id: teeMId,
      warehouse_code: "DEMO-WH",
      snapshot_date: today,
      qty_on_hand: 120,
      qty_available: 90,
      qty_committed: 30,
      qty_on_order: 0,
      qty_in_transit: 0,
      source: "demo",
    },
    {
      sku_id: hoodMId,
      warehouse_code: "DEMO-WH",
      snapshot_date: today,
      qty_on_hand: 200,
      qty_available: 155,
      qty_committed: 45,
      qty_on_order: 0,
      qty_in_transit: 0,
      source: "demo",
    },
  ];
  process.stdout.write(`  Inserting ${rows.length} demo snapshots … `);
  await sbPost(
    "ip_inventory_snapshot?on_conflict=sku_id,warehouse_code,snapshot_date",
    rows
  );
  console.log("✓");
} else {
  // Patch qty_committed on each existing snapshot row
  console.log("\n── Patching qty_committed on existing snapshots ─────────────");
  for (const s of snapshots) {
    const committed = soBySkuId[s.sku_id];
    if (committed == null) continue;
    const code = items.find(i => i.id === s.sku_id)?.sku_code ?? s.sku_id.slice(0,8);
    process.stdout.write(`  PATCH ${code} (${s.warehouse_code} ${s.snapshot_date}) → qty_committed=${committed} … `);
    await sbPatch(`ip_inventory_snapshot?id=eq.${s.id}`, { qty_committed: committed });
    console.log("✓");
  }
}

// ── Verify ───────────────────────────────────────────────────────────────────
console.log("\n── Verification ──────────────────────────────────────────────");
const verify = await sbGet(
  `ip_inventory_snapshot?sku_id=in.(${teeMId},${hoodMId})&select=sku_id,warehouse_code,snapshot_date,qty_on_hand,qty_committed&order=snapshot_date.desc`
);
for (const s of verify) {
  const code = items.find(i => i.id === s.sku_id)?.sku_code ?? s.sku_id.slice(0,8);
  const ats = (s.qty_on_hand ?? 0) - (s.qty_committed ?? 0);
  console.log(`  ${code}  on_hand=${s.qty_on_hand}  committed=${s.qty_committed}  → ATS≈${ats}`);
}

console.log(`
▶ Done.

  On SO (qty_committed) now set:
    TEE-BLK-M  → 30 units  (20 ship this month, 10 ship next month — demo of Phase 2 gap)
    HOOD-BLK-M → 45 units  (30 ship this month, 15 ship next month)

  Rebuild the forecast to see On SO appear in the Wholesale Planning grid.
  Note: all 30 / 45 units are deducted from month 1 ATS regardless of ship date
  (the Phase 2 gap — fix tracked in memory).
`);
