#!/usr/bin/env node
/**
 * One-shot backfill: scan every existing ip_sales_history_wholesale row,
 * apply the same pack-priced-as-unit detector that the sync handler
 * uses going forward, and rewrite the rows that pass all five guards
 * to point at the PPK sibling SKU with corrected qty_units / cogs /
 * margin.
 *
 * Usage:
 *   node scripts/backfill-pack-priced-as-unit.mjs            # DRY RUN
 *   node scripts/backfill-pack-priced-as-unit.mjs --apply    # update DB
 *
 * Reuses api/_lib/sales-grain.js — same five guards as the sync, no
 * duplicated logic. Operates on the production database via the same
 * SUPABASE_PAT pattern as scripts/query-channel-backfill.mjs.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectPackPricedAsUnit,
  findSiblingPpkMaster,
  SUSPICIOUS_PRICE_RATIO,
  deriveSalesGrainFields,
} from "../api/_lib/sales-grain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(
      text.split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
    );
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!PAT) { console.error("✗ SUPABASE_PAT missing in .env.local"); process.exit(1); }
const PROD_REF = "qcvqvxxoperiurauoxmp";
const SB_URL = `https://api.supabase.com/v1/projects/${PROD_REF}/database/query`;

async function sql(query) {
  const res = await fetch(SB_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL error: ${text}`);
  return JSON.parse(text);
}

// ── Step 1: Load all unit-grain master rows that have a suspicious
// sale (price ≥ 5× cost). Pull JUST these candidates — keeps the
// scan size proportional to the actual problem space.
console.log(`\n▶ Step 1: Identify suspect sales rows...`);
const suspectSales = await sql(`
  SELECT s.id          AS sales_id,
         s.sku_id,
         s.customer_id,
         s.qty,
         s.unit_price,
         s.gross_amount,
         s.net_amount,
         s.discount_amount,
         s.txn_date,
         s.invoice_number,
         m.sku_code,
         m.style_code,
         m.pack_size,
         m.unit_cost,
         cu.name AS customer_name
  FROM ip_sales_history_wholesale s
  JOIN ip_item_master m ON m.id = s.sku_id
  LEFT JOIN ip_customer_master cu ON cu.id = s.customer_id
  WHERE m.pack_size = 1
    AND m.unit_cost IS NOT NULL
    AND m.unit_cost > 0
    AND s.unit_price >= m.unit_cost * ${SUSPICIOUS_PRICE_RATIO}
  ORDER BY s.txn_date DESC, m.sku_code;
`);
console.log(`   → ${suspectSales.length} suspect rows (price >= ${SUSPICIOUS_PRICE_RATIO}× cost)`);

if (suspectSales.length === 0) {
  console.log("Nothing to do.\n");
  process.exit(0);
}

// ── Step 2: Load the PPK siblings for every distinct unit-grain master
// in the suspect set, plus all masters referenced (for the masterByCode
// map the detector uses).
const styleCodes = [...new Set(suspectSales.map(r => r.style_code))];
const skuCodes = [...new Set(suspectSales.map(r => r.sku_code))];
console.log(`\n▶ Step 2: Load ${styleCodes.length} style families + sibling PPK masters...`);

// PPK siblings live under two naming conventions in master:
//   "{style}PPK"   (e.g. RYO0658PPK)  — glued
//   "{style}-PPK"  (e.g. RBB1440N-PPK) — dash-separated
// Pull both so masterByCode covers everything findSiblingPpkMaster
// can resolve to. Also fold in any "{base}-PPK" pattern derived from
// the sku itself, which catches mis-tagged unit rows (e.g.
// 'RBB1438N-BLACK' with style_code 'RBB1438N-PPK' — the unit master
// has a bad style_code, so we re-derive the true base from the sku).
const baseFromSku = [...new Set(skuCodes.map(s => {
  const i = s.lastIndexOf("-");
  return i > 0 ? s.slice(0, i).replace(/-?PPK\d*$/i, "") : null;
}).filter(Boolean))];
const allStyleVariants = [
  ...new Set([
    ...styleCodes,
    ...styleCodes.map(s => `${s}PPK`),
    ...styleCodes.map(s => `${s}-PPK`),
    ...baseFromSku,
    ...baseFromSku.map(s => `${s}PPK`),
    ...baseFromSku.map(s => `${s}-PPK`),
  ]),
];
const masterRows = await sql(`
  SELECT id, sku_code, style_code, pack_size, unit_cost
  FROM ip_item_master
  WHERE style_code = ANY(ARRAY[${allStyleVariants.map(s => `'${s.replace(/'/g, "''")}'`).join(",")}]::text[]);
`);
const masterByCode = new Map();
const masterByCodeToId = new Map();
for (const r of masterRows) {
  masterByCode.set(r.sku_code, r);
  masterByCodeToId.set(r.sku_code, r.id);
}
console.log(`   → ${masterRows.length} master rows loaded`);

// ── Step 3: Pull historical reference prices for every (customer_id,
// sku_id) pair appearing in the suspect set. Used by
// pickReferenceUnitPrice via detectPackPricedAsUnit.
console.log(`\n▶ Step 3: Pull 24-month reference price history per (customer, sku)...`);
const pairs = [...new Set(suspectSales.map(r => `${r.sku_id}|${r.customer_id}`))];
const skuIds = [...new Set(suspectSales.map(r => r.sku_id))];
const custIds = [...new Set(suspectSales.map(r => r.customer_id).filter(Boolean))];

const refsByPair = new Map(); // `${sku_id}|${cust_id}` → number[]
const CHUNK = 100;
let totalRef = 0;
for (let i = 0; i < skuIds.length; i += CHUNK) {
  const skuChunk = skuIds.slice(i, i + CHUNK);
  for (let j = 0; j < custIds.length; j += CHUNK) {
    const custChunk = custIds.slice(j, j + CHUNK);
    const rows = await sql(`
      SELECT sku_id, customer_id, unit_price
      FROM ip_sales_history_wholesale
      WHERE sku_id  = ANY(ARRAY[${skuChunk.map(s => `'${s}'`).join(",")}]::uuid[])
        AND customer_id = ANY(ARRAY[${custChunk.map(c => `'${c}'`).join(",")}]::uuid[])
        AND unit_price IS NOT NULL
        AND txn_date >= CURRENT_DATE - INTERVAL '24 months'
      LIMIT 50000;
    `);
    for (const r of rows) {
      const key = `${r.sku_id}|${r.customer_id}`;
      if (!pairs.includes(key)) continue;
      if (!refsByPair.has(key)) refsByPair.set(key, []);
      refsByPair.get(key).push(Number(r.unit_price));
      totalRef += 1;
    }
  }
}
console.log(`   → ${totalRef} historical unit_price rows across ${refsByPair.size} pairs`);

// ── Step 4: Run the detector on each suspect.
console.log(`\n▶ Step 4: Apply detector...`);
const reclassifications = [];
const skipped = { no_sibling: 0, off_ratio: 0, no_reference: 0 };
for (const r of suspectSales) {
  const unitMaster = masterByCode.get(r.sku_code);
  if (!unitMaster) continue;
  const refPrices = refsByPair.get(`${r.sku_id}|${r.customer_id}`) || [];
  const sibling = detectPackPricedAsUnit({
    candidateUnitPrice: Number(r.unit_price),
    unitMaster,
    masterByCode,
    historicalUnitPrices: refPrices,
  });
  if (!sibling) {
    // Diagnose why it was skipped
    const siblingTest = findSiblingPpkMaster(unitMaster, masterByCode);
    if (!siblingTest) skipped.no_sibling += 1;
    else if (refPrices.length === 0) skipped.no_reference += 1;
    else skipped.off_ratio += 1;
    continue;
  }
  reclassifications.push({
    sales_id: r.sales_id,
    txn_date: r.txn_date,
    invoice_number: r.invoice_number,
    customer: r.customer_name,
    from_sku: r.sku_code,
    to_sku: sibling.sku_code,
    to_sku_id: masterByCodeToId.get(sibling.sku_code),
    qty: Number(r.qty),
    pack_size: Number(sibling.pack_size),
    new_qty_units: Number(r.qty) * Number(sibling.pack_size),
    unit_price: Number(r.unit_price),
    gross: Number(r.gross_amount),
    net: Number(r.net_amount),
    unit_cost_per_unit: Number(unitMaster.unit_cost),
  });
}
console.log(`   → ${reclassifications.length} rows match all five guards → would be reclassified`);
console.log(`   → ${skipped.no_sibling} skipped (no PPK sibling exists)`);
console.log(`   → ${skipped.no_reference} skipped (no reference unit_price history for this customer+sku)`);
console.log(`   → ${skipped.off_ratio} skipped (price doesn't match reference × pack_size ±5%)`);

// ── Step 5: Show summary table (always) + per-row detail when verbose
console.log(`\n▶ Step 5: Reclassification preview`);
if (reclassifications.length === 0) {
  console.log("   No rows passed all guards — nothing to update.");
  process.exit(0);
}

// Roll-up by (from_sku, to_sku) so the operator sees the shape at a glance
const byFlip = new Map();
for (const r of reclassifications) {
  const key = `${r.from_sku} → ${r.to_sku}`;
  if (!byFlip.has(key)) byFlip.set(key, { rows: 0, qty: 0, net: 0 });
  const acc = byFlip.get(key);
  acc.rows += 1;
  acc.qty += r.qty;
  acc.net += r.net;
}
const summary = [...byFlip.entries()].map(([flip, v]) => ({
  flip,
  rows: v.rows,
  qty_total: v.qty,
  net_total: Math.round(v.net * 100) / 100,
}));
console.table(summary);

if (VERBOSE || reclassifications.length <= 20) {
  console.log("\n   Per-row detail:");
  console.table(reclassifications.slice(0, 50));
  if (reclassifications.length > 50) {
    console.log(`   ... + ${reclassifications.length - 50} more rows (use --verbose for full list)`);
  }
}

// ── Step 6: Apply if --apply
if (!APPLY) {
  console.log("\n✓ DRY RUN — no changes made. Re-run with --apply to update the DB.\n");
  process.exit(0);
}

console.log(`\n▶ Step 6: APPLY — updating ${reclassifications.length} rows...`);

// Step 6a: pull per-PPK-sku avg cost from ip_item_avg_cost so the
// recomputed cogs/margin land at the size-granular cost (the
// authoritative source from the Xoro Item Costing Report) rather
// than at master.unit_cost. Falls back to master cost when the
// PPK sibling isn't in the avg-cost table.
const ppkSkus = [...new Set(reclassifications.map(r => r.to_sku))];
const avgCostByCode = new Map();
for (let i = 0; i < ppkSkus.length; i += 200) {
  const chunk = ppkSkus.slice(i, i + 200);
  const rows = await sql(`
    SELECT sku_code, avg_cost FROM ip_item_avg_cost
    WHERE sku_code = ANY(ARRAY[${chunk.map(s => `'${s.replace(/'/g, "''")}'`).join(",")}]::text[]);
  `);
  for (const r of rows) {
    const v = Number(r.avg_cost);
    if (Number.isFinite(v) && v > 0) avgCostByCode.set(r.sku_code, v);
  }
}
console.log(`   → avg_cost coverage: ${avgCostByCode.size}/${ppkSkus.length} PPK skus`);

// Update one row at a time using parameterised UPDATE. Each update
// rewrites sku_id (to PPK sibling), qty_units (× pack_size), and
// re-derives cogs/margin via the PPK row's unit_cost (or the
// avg_cost from ip_item_avg_cost when present).
let updated = 0;
let failed = 0;
for (const r of reclassifications) {
  const ppkMaster = masterByCode.get(r.to_sku);
  const grainFields = deriveSalesGrainFields({
    rawItemNumber: r.to_sku, // contains "PPK" → inferQtyGrain returns "pack"
    qty: r.qty,
    netAmount: r.net,
    master: { pack_size: r.pack_size, unit_cost: ppkMaster.unit_cost },
    avgCostPerRawQty: avgCostByCode.get(r.to_sku),
  });
  try {
    await sql(`
      UPDATE ip_sales_history_wholesale
      SET sku_id            = '${r.to_sku_id}',
          qty_grain         = '${grainFields.qty_grain}',
          qty_units         = ${grainFields.qty_units},
          unit_cost_at_sale = ${grainFields.unit_cost_at_sale ?? "NULL"},
          cogs_amount       = ${grainFields.cogs_amount ?? "NULL"},
          margin_amount     = ${grainFields.margin_amount ?? "NULL"},
          margin_pct        = ${grainFields.margin_pct ?? "NULL"}
      WHERE id = '${r.sales_id}';
    `);
    updated += 1;
    if (updated % 10 === 0) console.log(`   ... ${updated}/${reclassifications.length}`);
  } catch (e) {
    failed += 1;
    console.error(`   ✗ ${r.invoice_number}: ${e.message}`);
  }
}
console.log(`\n✓ Done. Updated ${updated} rows, ${failed} failed.\n`);
