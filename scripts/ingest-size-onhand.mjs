#!/usr/bin/env node
// Tangerine SIZE-GRAIN on-hand ingest + reconciliation (DRY-RUN by default).
//
// Reads the newest Xoro REST inventory CSV (postAD_invrest_*.csv), aggregates
// per (BasePartNumber, Color, Size) summing every store, resolves each
// (style,color,size) to a per-size ip_item_master SKU, and produces a
// per-style reconciliation:
//
//     REST size-grain total   (sum of all sizes for the style)
//   vs current color-grain on-hand total
//     (Σ inventory_layers.remaining_qty over the style's color-grain SKUs)
//
// DEFAULT MODE = DRY-RUN: it ONLY reads and prints. It performs NO writes —
// it does NOT create SKUs, does NOT touch tangerine_size_onhand, does NOT
// touch inventory_layers. The financially-material cutover ("--apply") is left
// for the lead to run deliberately and is NOT wired here (see the report /
// README in the migration header for the gated steps).
//
// Usage:
//   node scripts/ingest-size-onhand.mjs                 # dry-run, all styles, summary
//   node scripts/ingest-size-onhand.mjs --style RYB0412B  # focus one style, verbose
//   node scripts/ingest-size-onhand.mjs --csv <path>    # explicit CSV
//   node scripts/ingest-size-onhand.mjs --limit 25      # cap detail rows printed
//
// Reads SUPABASE_PAT from .env.local / .env.staging (same as run-sql-prod.mjs).

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REST_CSV_DIR = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs";

// ── arg parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const APPLY = args.includes("--apply"); // intentionally not implemented (gated)
const ONLY_STYLE = argVal("--style");
const CSV_OVERRIDE = argVal("--csv");
const DETAIL_LIMIT = Number(argVal("--limit") || 40);

if (APPLY) {
  console.error("✗ --apply is GATED and not implemented in this script. The");
  console.error("  per-style cutover is financially material and must be run by");
  console.error("  the lead. This script is dry-run / reconciliation only.");
  process.exit(2);
}

// ── prod read via `supabase db query --linked` (the auto-allowed, PAT-free path) ──
// `--linked` must be run from a checkout linked to the prod project; pass
// --workdir to point at the main checkout when running from a worktree.
const WORKDIR = argVal("--workdir") || ROOT;
const tmp = mkdtempSync(join(tmpdir(), "size-onhand-"));
async function runSql(sql) {
  const f = join(tmp, `q${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(f, sql, "utf8");
  let out;
  try {
    // shell:true so the npm `supabase` shim (.cmd on Windows) resolves on PATH.
    out = execFileSync("supabase", ["db", "query", "--linked", "--file", `"${f}"`], {
      cwd: WORKDIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: true,
    });
  } catch (e) {
    throw new Error(`supabase db query failed: ${e.stderr || e.message}`);
  }
  // The CLI prints a JSON object {boundary, rows, warning}. Extract `rows`.
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}
const sqlLit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── pick newest CSV ───────────────────────────────────────────────────────────
function newestCsv() {
  if (CSV_OVERRIDE) return CSV_OVERRIDE;
  const files = readdirSync(REST_CSV_DIR)
    .filter((f) => /^postAD_invrest_\d+\.csv$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no postAD_invrest_*.csv in ${REST_CSV_DIR}`);
  return join(REST_CSV_DIR, files[files.length - 1]);
}

// ── minimal CSV parser (handles quoted fields) ────────────────────────────────
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────────
const csvPath = newestCsv();
console.log(`# REST CSV:      ${csvPath}`);
console.log(`# Mode:          DRY-RUN (no writes)`);
if (ONLY_STYLE) console.log(`# Filter style:  ${ONLY_STYLE}`);
console.log("");

const raw = readFileSync(csvPath, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
const header = parseCsvLine(lines[0]);
const col = (name) => header.indexOf(name);
const cColor = col("Color"), cSize = col("Size"), cBP = col("BasePartNumber");
const cOnHand = col("OnHandQty"), cStore = col("StoreName"), cItemNum = col("ItemNumber");
if ([cColor, cSize, cBP, cOnHand].some((i) => i < 0)) {
  throw new Error("CSV missing expected columns (Color/Size/BasePartNumber/OnHandQty)");
}

// Aggregate per (BP, Color, Size) summing all stores.
// key = bp||color||size
const cellMap = new Map(); // key -> { bp, color, size, qty, stores:Set }
const bySize = new Map(); // bp -> Map(size -> qty)  (style-level size profile)
for (let i = 1; i < lines.length; i++) {
  const f = parseCsvLine(lines[i]);
  const bp = (f[cBP] || "").trim();
  if (!bp) continue;
  if (ONLY_STYLE && bp.toUpperCase() !== ONLY_STYLE.toUpperCase()) continue;
  const color = (f[cColor] || "").trim();
  const size = (f[cSize] || "").trim();
  const qty = Number(f[cOnHand] || 0) || 0;
  const store = cStore >= 0 ? (f[cStore] || "").trim() : "DEFAULT";
  const key = `${bp}||${color}||${size}`;
  let cell = cellMap.get(key);
  if (!cell) { cell = { bp, color, size, qty: 0, stores: new Set() }; cellMap.set(key, cell); }
  cell.qty += qty;
  if (store) cell.stores.add(store);
  if (!bySize.has(bp)) bySize.set(bp, new Map());
  const sm = bySize.get(bp);
  sm.set(size, (sm.get(size) || 0) + qty);
}

// REST style-level totals.
const restStyleTotal = new Map(); // bp -> total qty
for (const [bp, sm] of bySize.entries()) {
  let t = 0;
  for (const v of sm.values()) t += v;
  restStyleTotal.set(bp, t);
}

const bps = Array.from(restStyleTotal.keys());
console.log(`# REST styles in CSV (after filter): ${bps.length}`);

// ── current color-grain on-hand per style_code, from prod ─────────────────────
// Match REST BasePartNumber -> style_master.style_code (exact). Some BPs carry
// a trailing season/gender letter (e.g. RYB0412B) and exist as their own style.
const bpList = bps.map(sqlLit).join(",");
const curRows = bpList
  ? (await runSql(`
      SELECT sm.style_code,
             COALESCE(SUM(il.remaining_qty) FILTER (WHERE il.remaining_qty > 0), 0)::numeric AS color_onhand,
             COUNT(DISTINCT im.id) AS color_skus
      FROM style_master sm
      JOIN ip_item_master im ON im.style_id = sm.id
      LEFT JOIN inventory_layers il ON il.item_id = im.id
      WHERE sm.style_code IN (${bpList})
      GROUP BY sm.style_code;
    `)).reduce((m, r) => (m.set(r.style_code, r), m), new Map())
  : new Map();

// ── reconcile ─────────────────────────────────────────────────────────────────
const recon = [];
for (const bp of bps) {
  const rest = restStyleTotal.get(bp) || 0;
  const cur = curRows.get(bp);
  const color = cur ? Number(cur.color_onhand) : null;
  recon.push({
    bp,
    rest,
    color,
    matched: !!cur,
    delta: color == null ? null : rest - color,
  });
}
recon.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));

const matched = recon.filter((r) => r.matched);
const unmatched = recon.filter((r) => !r.matched);
const changed = matched.filter((r) => Math.abs(r.delta) > 0.5);
const restTotalUnits = recon.reduce((s, r) => s + r.rest, 0);
const curTotalUnits = matched.reduce((s, r) => s + (r.color || 0), 0);

// ── per-style detail (focused or top-N) ───────────────────────────────────────
function printStyle(bp) {
  const sm = bySize.get(bp);
  const sizes = Array.from(sm.entries()).filter(([, q]) => q !== 0)
    .sort((a, b) => (isNaN(+a[0]) || isNaN(+b[0]) ? String(a[0]).localeCompare(b[0]) : +a[0] - +b[0]));
  const cur = curRows.get(bp);
  console.log(`\n── ${bp} ── REST size total=${restStyleTotal.get(bp)}  ` +
    `current color on-hand=${cur ? Number(cur.color_onhand) : "(no style match)"}  ` +
    `${cur ? `[delta ${restStyleTotal.get(bp) - Number(cur.color_onhand)}]` : ""}`);
  console.log("   size : qty  (summed across stores)");
  for (const [size, q] of sizes) console.log(`   ${String(size).padStart(5)} : ${q}`);
}

if (ONLY_STYLE) {
  for (const bp of bps) printStyle(bp);
  // Also dump the per (color,size) cells for the focused style.
  console.log("\n   per (color,size) cells:");
  for (const cell of Array.from(cellMap.values()).filter((c) => c.qty !== 0)
    .sort((a, b) => a.color.localeCompare(b.color) || String(a.size).localeCompare(String(b.size)))) {
    console.log(`     ${cell.color.padEnd(28)} ${String(cell.size).padStart(5)} : ${cell.qty}  (${cell.stores.size} store(s))`);
  }
} else {
  // Always show RYB0412 + RYB0412B if present (the brief's reference styles).
  for (const ref of ["RYB0412", "RYB0412B"]) if (bySize.has(ref)) printStyle(ref);
  console.log(`\n── Top ${DETAIL_LIMIT} styles by |delta| (REST size total vs current color on-hand) ──`);
  console.log("   style_code        REST      color_onhand    delta   matched");
  for (const r of recon.slice(0, DETAIL_LIMIT)) {
    console.log(
      `   ${r.bp.padEnd(16)} ${String(r.rest).padStart(9)} ` +
      `${(r.color == null ? "—" : String(r.color)).padStart(14)} ` +
      `${(r.delta == null ? "—" : String(r.delta)).padStart(9)}   ${r.matched ? "yes" : "NO"}`,
    );
  }
}

// ── summary ────────────────────────────────────────────────────────────────────
console.log("\n──────────── DRY-RUN SUMMARY ────────────");
console.log(`REST styles (after filter):        ${recon.length}`);
console.log(`  matched to a style_master.code:  ${matched.length}`);
console.log(`  UNMATCHED (no style row):        ${unmatched.length}`);
console.log(`Styles whose total WOULD CHANGE:   ${changed.length}  (|delta| > 0.5)`);
console.log(`REST size-grain total units:       ${restTotalUnits}`);
console.log(`Current color-grain total (matched): ${curTotalUnits}`);
console.log(`Net unit delta (matched styles):   ${restTotalUnits - curTotalUnits}`);
if (unmatched.length > 0) {
  console.log(`\nUnmatched BasePartNumbers (first 20):`);
  console.log("  " + unmatched.slice(0, 20).map((r) => r.bp).join(", "));
}
console.log("\nNO WRITES PERFORMED. This was a dry-run.");
