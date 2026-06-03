#!/usr/bin/env node
// scripts/dedup-item-master.mjs
//
// Plan + (later) merge the duplicate SKUs in ip_item_master. The catalog has
// ~7,047 redundant rows: successive ingestion pipelines (Excel uploader,
// Xoro/planning syncs, the REST size-onhand cutover) each created a row for the
// SAME logical SKU with a DIFFERENT sku_code, and uniqueness is only on sku_code
// (nothing on the (style,color,size,inseam) tuple) — so they accumulated. See
// memory project_ip_item_master_dup_skus.
//
// Logical SKU key = (style_id, color, normalizeSize(size), inseam). Each group's
// SURVIVOR is the row downstream data already points at (has on-hand layers) →
// else has unit_cost → else oldest. All other rows are LOSERS to be merged into
// the survivor (FK refs repointed, on-hand/cost folded in) and removed.
//
// DEFAULT = DRY RUN: reads only, writes NOTHING. Prints the merge plan + a full
// reconciliation (on-hand before==after, FK refs that must move, cost backfills)
// so the operator can eyeball it before any --apply is built.
//
//   node scripts/dedup-item-master.mjs              # dry run, summary
//   node scripts/dedup-item-master.mjs --samples 25 # + show N example groups
//   node scripts/dedup-item-master.mjs --style RYB1672  # focus one style
//
// --apply is intentionally NOT implemented yet (the merge is financially
// material: it repoints FKs + consolidates inventory_layers/on-hand). It lands
// only after this dry-run is reviewed and signed off.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(f) {
  try {
    return Object.fromEntries(
      readFileSync(resolve(__dirname, "..", f), "utf8")
        .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
    );
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const URL = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_KEY;
if (!URL || !KEY) { console.error("Missing VITE_SUPABASE_URL / anon key in .env(.local)"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const args = process.argv.slice(2);
const SAMPLES = (() => { const i = args.indexOf("--samples"); return i >= 0 ? Number(args[i + 1]) || 10 : 0; })();
const ONLY_STYLE = (() => { const i = args.indexOf("--style"); return i >= 0 ? String(args[i + 1] || "").toUpperCase() : null; })();
if (args.includes("--apply")) { console.error("--apply is not implemented yet — review the dry run first."); process.exit(2); }

// Canonical letter-size map (mirrors api/_lib/styleMatrix.js normalizeSize).
const LETTER_SIZE_CANON = {
  XS: "XSMALL", XSM: "XSMALL", "X-SMALL": "XSMALL", XSMALL: "XSMALL",
  S: "SMALL", SM: "SMALL", SML: "SMALL", SMALL: "SMALL",
  M: "MEDIUM", MD: "MEDIUM", MED: "MEDIUM", MEDIUM: "MEDIUM",
  L: "LARGE", LG: "LARGE", LRG: "LARGE", LARGE: "LARGE",
  XL: "XLARGE", XLG: "XLARGE", "X-LARGE": "XLARGE", XLARGE: "XLARGE",
  XXL: "2XLARGE", "2X": "2XLARGE", "2XL": "2XLARGE", XXLARGE: "2XLARGE", "2XLARGE": "2XLARGE",
  XXXL: "3XLARGE", "3X": "3XLARGE", "3XL": "3XLARGE", "3XLARGE": "3XLARGE",
};
const normalizeSize = (raw) => (raw == null ? raw : (LETTER_SIZE_CANON[String(raw).trim().toUpperCase()] || raw));
const norm = (s) => (s == null ? "" : String(s).trim());

async function getPaged(pathBase) {
  const out = []; let from = 0; const PAGE = 1000;
  for (;;) {
    const r = await fetch(`${URL}/rest/v1/${pathBase}`, { headers: { ...H, Range: `${from}-${from + PAGE - 1}` } });
    const j = await r.json().catch(() => null);
    if (!Array.isArray(j)) { if (from === 0) console.error("query error:", JSON.stringify(j)); break; }
    out.push(...j);
    if (j.length < PAGE) break;
    from += PAGE;
    if (from > 200000) break;
  }
  return out;
}

console.log("Loading ip_item_master + reference tables …");
const styleFilter = ONLY_STYLE ? `&style_code=eq.${encodeURIComponent(ONLY_STYLE)}` : "";
const rows = await getPaged(`ip_item_master?select=id,sku_code,style_id,style_code,color,size,inseam,unit_cost,created_at,active${styleFilter}`);

// Reference maps (item_id → qty / count). These are the FK surfaces that must
// move when a loser is merged away.
const ohByItem = new Map();      // tangerine_size_onhand: item_id → Σ qty_on_hand
for (const r of await getPaged("tangerine_size_onhand?select=item_id,qty_on_hand")) ohByItem.set(r.item_id, (ohByItem.get(r.item_id) || 0) + (Number(r.qty_on_hand) || 0));
const layerByItem = new Map();   // inventory_layers: item_id → { layers, remaining }
for (const r of await getPaged("inventory_layers?select=item_id,remaining_qty")) { const m = layerByItem.get(r.item_id) || { layers: 0, remaining: 0 }; m.layers++; m.remaining += Number(r.remaining_qty) || 0; layerByItem.set(r.item_id, m); }
const solByItem = new Map();     // sales_order_lines: inventory_item_id → count
for (const r of await getPaged("sales_order_lines?select=inventory_item_id")) if (r.inventory_item_id) solByItem.set(r.inventory_item_id, (solByItem.get(r.inventory_item_id) || 0) + 1);
const polByItem = new Map();     // purchase_order_lines (native): inventory_item_id → count
for (const r of await getPaged("purchase_order_lines?select=inventory_item_id")) if (r.inventory_item_id) polByItem.set(r.inventory_item_id, (polByItem.get(r.inventory_item_id) || 0) + 1);

// ── Group by canonical logical SKU ───────────────────────────────────────────
const groups = new Map(); // key → rows[]
for (const r of rows) {
  if (!r.style_id) continue; // can't key without a style; report separately
  const key = `${r.style_id}||${norm(r.color)}||${normalizeSize(norm(r.size))}||${norm(r.inseam)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const noStyleId = rows.filter((r) => !r.style_id).length;

function stockOf(r) { return (ohByItem.get(r.id) || 0) + (layerByItem.get(r.id)?.remaining || 0); }
function survivorOf(g) {
  // Most on-hand+layers (least to move) > has unit_cost > oldest (stable by id).
  // The survivor is the row downstream inventory already points at; cost (which
  // tends to live on a different, older row) is backfilled from a loser.
  return [...g].sort((a, b) =>
    stockOf(b) - stockOf(a)
    || (b.unit_cost != null) - (a.unit_cost != null)
    || String(a.created_at).localeCompare(String(b.created_at))
    || String(a.id).localeCompare(String(b.id)),
  )[0];
}

// ── Build the plan ───────────────────────────────────────────────────────────
let dupGroups = 0, redundant = 0, variantGroups = 0;
let losersWithOnHand = 0, onHandUnitsToMove = 0, losersWithLayers = 0, layersToMove = 0, losersWithSO = 0, losersWithPO = 0;
let survivorsNeedingCostBackfill = 0;
const survivorReason = { onhand: 0, cost: 0, oldest: 0 };
let onHandTotalAll = 0;
const sampleGroups = [];

for (const [key, g] of groups) {
  for (const r of g) onHandTotalAll += ohByItem.get(r.id) || 0;
  if (g.length < 2) continue;
  dupGroups++;
  redundant += g.length - 1;
  const rawSizes = new Set(g.map((r) => norm(r.size)));
  if (rawSizes.size > 1) variantGroups++; // e.g. L + LRG collapsed by normalizeSize
  const win = survivorOf(g);
  const winHasStock = (layerByItem.get(win.id)?.remaining || 0) > 0 || (ohByItem.get(win.id) || 0) > 0;
  survivorReason[winHasStock ? "onhand" : win.unit_cost != null ? "cost" : "oldest"]++;
  if (win.unit_cost == null && g.some((r) => r.unit_cost != null)) survivorsNeedingCostBackfill++;
  for (const r of g) {
    if (r.id === win.id) continue;
    const oh = ohByItem.get(r.id) || 0;
    const lay = layerByItem.get(r.id);
    if (oh > 0) { losersWithOnHand++; onHandUnitsToMove += oh; }
    if (lay && lay.layers > 0) { losersWithLayers++; layersToMove += lay.layers; }
    if (solByItem.get(r.id)) losersWithSO++;
    if (polByItem.get(r.id)) losersWithPO++;
  }
  if (sampleGroups.length < SAMPLES) sampleGroups.push({ key, g, win });
}

const rowsAfter = rows.length - redundant;
const fmt = (n) => Number(n).toLocaleString();

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  ip_item_master DUP-SKU DEDUP — DRY RUN (no writes)" + (ONLY_STYLE ? `  [style ${ONLY_STYLE}]` : ""));
console.log("══════════════════════════════════════════════════════════════════");
console.log(`Rows scanned ............... ${fmt(rows.length)}  (size=NULL: ${fmt(rows.filter((r) => !r.size).length)}, no style_id: ${fmt(noStyleId)})`);
console.log(`Logical-SKU groups ......... ${fmt(groups.size)}`);
console.log(`  dup groups (>1 row) ...... ${fmt(dupGroups)}   of which size-variant (e.g. L+LRG): ${fmt(variantGroups)}`);
console.log(`Redundant rows to remove ... ${fmt(redundant)}   (${(redundant / rows.length * 100).toFixed(1)}% of catalog)`);
console.log(`Rows AFTER merge ........... ${fmt(rowsAfter)}`);
console.log("\n── What moves (must be repointed/folded into survivors) ──");
console.log(`Losers carrying ON-HAND .... ${fmt(losersWithOnHand)} rows  →  ${fmt(onHandUnitsToMove)} units to fold into survivors`);
console.log(`Losers carrying LAYERS ..... ${fmt(losersWithLayers)} rows  →  ${fmt(layersToMove)} inventory_layers to repoint`);
console.log(`Losers referenced by SO lines  ${fmt(losersWithSO)}`);
console.log(`Losers referenced by PO lines  ${fmt(losersWithPO)}`);
console.log(`Survivors needing cost backfill ${fmt(survivorsNeedingCostBackfill)}  (survivor has no unit_cost but a loser does)`);
console.log("\n── Survivor selection ──");
console.log(`  by on-hand/layers ........ ${fmt(survivorReason.onhand)}`);
console.log(`  by unit_cost ............. ${fmt(survivorReason.cost)}`);
console.log(`  by oldest (no signal) .... ${fmt(survivorReason.oldest)}`);
console.log("\n── On-hand reconciliation (tangerine_size_onhand) ──");
console.log(`  total on-hand BEFORE ..... ${fmt(onHandTotalAll)}`);
console.log(`  (a real merge only re-attributes on-hand loser→survivor; AFTER must equal BEFORE)`);

if (sampleGroups.length) {
  console.log("\n── Sample groups (survivor ►, losers ·) ──");
  for (const { g, win } of sampleGroups) {
    const r0 = win;
    console.log(`\n  ${r0.style_code} / ${norm(r0.color)} / ${normalizeSize(norm(r0.size))}${norm(r0.inseam) ? " / " + norm(r0.inseam) : ""}`);
    for (const r of g) {
      const tag = r.id === win.id ? "►" : "·";
      const oh = ohByItem.get(r.id) || 0;
      const lay = layerByItem.get(r.id)?.layers || 0;
      const refs = [oh ? `oh=${oh}` : "", lay ? `layers=${lay}` : "", solByItem.get(r.id) ? "SO" : "", polByItem.get(r.id) ? "PO" : ""].filter(Boolean).join(" ");
      console.log(`    ${tag} ${String(r.sku_code).padEnd(32)} size=${String(r.size).padEnd(6)} cost=${r.unit_cost ?? "-"} ${String(r.created_at).slice(0, 10)}  ${refs}`);
    }
  }
}
console.log("\n(DRY RUN — nothing was written.)");
