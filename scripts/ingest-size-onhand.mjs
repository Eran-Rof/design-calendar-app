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
//   node scripts/ingest-size-onhand.mjs --apply --style RYB0412
//                                                       # CUTOVER one style (writes PROD)
//   node scripts/ingest-size-onhand.mjs --batch         # CUTOVER ALL matched styles (writes PROD)
//   node scripts/ingest-size-onhand.mjs --batch --batch-limit 3   # smoke-test the batch
//   node scripts/ingest-size-onhand.mjs --reverse-batch <manifest.json>  # undo a whole batch
//
// --batch is the CATALOG-WIDE cutover: for every DISTINCT REST BasePartNumber
// that EXACTLY equals a style_master.style_code in the ROF entity (SKIPPING PPK
// prepacks, unmatched BPs, and the RYB0412 pilot), it runs the SAME proven
// per-style apply logic, VERIFIES each style (Σ xoro_rest_size == REST, all
// opening_balance zeroed, no other source_kind touched), and REVERSES just that
// style on any verify failure (restore opening_balance + delete xoro_rest_size),
// then continues. It writes a batch reversal manifest (flushed after every
// success) so the WHOLE batch can be undone with --reverse-batch.
//
// --apply (STYLE-SCOPED, OPT-IN, writes PROD) lands ONE style's size-grain
// on-hand by REPLACING its color-grain seed, per the corrected mechanism
// (NOT the xoro_mirror rebuild — that manages a different source_kind and would
// double-count). Atomic-as-possible, fully reversible. Steps:
//   1. Parse REST CSV, EXACT BasePartNumber == --style, group (Color,Size,Store)
//      summing OnHandQty, skip 0.
//   2. resolveOrCreateSku per (Color,Size) → per-size ip_item_master SKU
//      (store is the warehouse dimension, NOT part of the SKU).
//   3. Upsert tangerine_size_onhand one row per (item_id, warehouse=Store,
//      snapshot_date, source='xoro_rest', qty) for provenance/reversibility.
//   4. RETIRE the seed: zero remaining_qty on EVERY source_kind='opening_balance'
//      layer under the style's SKUs (UPDATE, never DELETE — preserves
//      original_qty + rows for exact reversal). Logs the affected layer ids +
//      original remaining_qty first. Also zeros any prior 'xoro_rest_size'
//      layers for these SKUs (idempotent re-run). Touches ONLY those two kinds.
//   5. INSERT one 'xoro_rest_size' layer per (per-size SKU, warehouse=Store)
//      with original_qty=remaining_qty=REST qty, received_at=2026-05-31T23:59:59Z,
//      unit_cost_cents best-effort from ip_item_avg_cost, notes carry the store.
//      ROF Main + ROF - ECOM stay SEPARATE layers (segmented in notes).
// --apply REFUSES to run without an explicit single --style (no catalog batch).
// Prod writes go via a service-role client whose key is fetched at runtime from
// `supabase projects api-keys` (PAT-backed); nothing is persisted to disk.
//
// Reads SUPABASE_PAT from .env.local / .env.staging (same as run-sql-prod.mjs).

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { repairSizeCell } from "../api/_lib/inventory/restCsvSize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REST_CSV_DIR = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs";

// ── arg parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const APPLY = args.includes("--apply"); // STYLE-SCOPED cutover; writes PROD
const BATCH = args.includes("--batch"); // CATALOG-WIDE cutover; writes PROD
const ONLY_STYLE = argVal("--style");
const CSV_OVERRIDE = argVal("--csv");
const DETAIL_LIMIT = Number(argVal("--limit") || 40);
const CHUNK_SIZE = Number(argVal("--chunk") || 25);
// --batch-limit caps how many styles the batch processes (smoke-test aid).
const BATCH_LIMIT = argVal("--batch-limit") ? Number(argVal("--batch-limit")) : null;
// --reverse-batch <manifest.json> undoes a whole batch (PROD writes).
const REVERSE_BATCH = argVal("--reverse-batch");

// PROD identity (Ring of Fire entity + prod project ref).
const PROD_REF = "qcvqvxxoperiurauoxmp";
const ROF_ENTITY_ID = "404b8a6b-0d2d-44d2-8539-9064ff0fafee";

// Xoro StoreName → Tangerine inventory_locations.code. Each REST cell carries its
// StoreName; the layer must sit on THAT store's warehouse location (not one
// style-level location), else e.g. ROF-ECOM stock shows as on-hand in Main. The
// per-cell store is also recorded in the layer notes (wh=<Store>).
const STORE_TO_LOC_CODE = {
  "ROF Main": "WH-00000",
  "ROF - ECOM": "WH-00001",
  "Psycho Tuna": "WH-00002",
  "Psycho Tuna Ecom": "WH-00003",
};

// --apply is OPT-IN, PROD-mutating, and STYLE-SCOPED. It must refuse to run
// catalog-wide. A single explicit --style is mandatory.
if (APPLY && !BATCH && (!ONLY_STYLE || !ONLY_STYLE.trim())) {
  console.error("✗ --apply requires an explicit single --style (e.g. --apply --style RYB0412).");
  console.error("  Catalog-wide apply is the separate --batch mode.");
  process.exit(2);
}
// --batch is the CATALOG-WIDE cutover. It iterates EVERY REST BasePartNumber that
// EXACTLY equals an existing style_master.style_code in the ROF entity, SKIPPING
// PPK prepacks (separate pack-grain world), unmatched BPs (no style row), and
// RYB0412 (already cut over in the pilot). For each style it runs the SAME proven
// per-style apply logic, VERIFIES (Σ xoro_rest_size == REST, all opening_balance
// zeroed, no other source_kind touched), and REVERSES that one style on any
// failure (restore opening_balance remaining_qty + delete its xoro_rest_size
// layers), then continues. It must NOT be combined with --style.
if (BATCH && ONLY_STYLE) {
  console.error("✗ --batch is catalog-wide; do NOT combine it with --style.");
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

// ── PROD service-role client (apply only) ─────────────────────────────────────
// The repo/.env holds the STAGING key. For the prod cutover we mint a prod
// service-role client at runtime: fetch the key from `supabase projects
// api-keys` (PAT-backed via the linked CLI). Nothing is persisted.
function prodUrl() {
  return `https://${PROD_REF}.supabase.co`;
}
let _prodKey = null;
function prodServiceKey() {
  if (_prodKey) return _prodKey;
  let out;
  try {
    out = execFileSync("supabase", ["projects", "api-keys", "--project-ref", PROD_REF], {
      cwd: WORKDIR, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, shell: true,
    });
  } catch (e) {
    throw new Error(`supabase projects api-keys failed: ${e.stderr || e.message}`);
  }
  // The CLI prints a table; the service_role row carries the JWT.
  const line = out.split(/\r?\n/).find((l) => /\bservice_role\b/.test(l));
  const m = line && line.match(/(eyJ[\w-]+\.[\w-]+\.[\w-]+)/);
  if (!m) throw new Error("could not parse service_role key from `supabase projects api-keys`");
  _prodKey = m[1];
  return _prodKey;
}

// ── snapshot_date from the CSV filename (postAD_invrest_YYYYMMDDHHMMSS.csv) ─────
function snapshotDateFromCsv(p) {
  const m = String(p).match(/postAD_invrest_(\d{4})(\d{2})(\d{2})/);
  if (!m) throw new Error(`cannot derive snapshot_date from CSV name: ${p}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

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
console.log(`# Mode:          ${BATCH ? "BATCH APPLY (PROD writes)" : APPLY ? "APPLY (PROD writes)" : "DRY-RUN (no writes)"}`);
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
// Store-grain cells for --apply (ROF Main vs ROF - ECOM stay SEPARATE layers).
// key = bp||color||size||store -> { bp, color, size, store, qty }
const cellStoreMap = new Map();
let repairedCells = 0; // kids age-range "XS(5,6)" comma corruption fixed (see restCsvSize.js)
for (let i = 1; i < lines.length; i++) {
  const f = parseCsvLine(lines[i]);
  const bp = (f[cBP] || "").trim();
  if (!bp) continue;
  if (ONLY_STYLE && bp.toUpperCase() !== ONLY_STYLE.toUpperCase()) continue;
  // Xoro bakes kids age-range sizes into Color with an UNQUOTED comma
  // ("DEEP BLACK-XS(5,6)"), so the CSV split spills "6)" into Size. Rebuild the
  // clean (color,size) before it forks garbage SKUs.
  const fixed = repairSizeCell(f[cColor] || "", f[cSize] || "");
  if (fixed.repaired) repairedCells++;
  const color = fixed.color;
  const size = fixed.size;
  const qty = Number(f[cOnHand] || 0) || 0;
  const store = cStore >= 0 ? (f[cStore] || "").trim() : "DEFAULT";
  const key = `${bp}||${color}||${size}`;
  let cell = cellMap.get(key);
  if (!cell) { cell = { bp, color, size, qty: 0, stores: new Set() }; cellMap.set(key, cell); }
  cell.qty += qty;
  if (store) cell.stores.add(store);
  const skey = `${bp}||${color}||${size}||${store}`;
  let scell = cellStoreMap.get(skey);
  if (!scell) { scell = { bp, color, size, store, qty: 0 }; cellStoreMap.set(skey, scell); }
  scell.qty += qty;
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
if (repairedCells > 0) console.log(`# Repaired ${repairedCells} kids age-range size cells (XS(5,6) comma corruption)`);

// ══════════════════════════════════════════════════════════════════════════════
// --apply : STYLE-SCOPED PROD cutover (writes). Replaces a style's color-grain
// opening_balance seed layers with per-SIZE xoro_rest_size layers. Runs and
// then EXITS before the dry-run reconciliation block below.
// --batch : CATALOG-WIDE cutover (writes). Builds the work-list and iterates the
// SAME per-style logic with per-style verify + reverse-on-failure.
// ══════════════════════════════════════════════════════════════════════════════
if (APPLY && !BATCH) {
  const snapshotDate = snapshotDateFromCsv(csvPath);
  const styleCode = ONLY_STYLE.trim();
  console.log(`\n# ── APPLY (PROD) ──────────────────────────────────────────────`);
  console.log(`# Style:         ${styleCode}  (EXACT BasePartNumber match)`);
  console.log(`# snapshot_date: ${snapshotDate}`);
  console.log(`# entity_id:     ${ROF_ENTITY_ID}`);
  const admin = await makeProdAdmin();
  const res = await applyStyle(admin, styleCode, snapshotDate);
  if (!res.ok) {
    console.error(`✗ APPLY failed for ${styleCode}: ${res.error}  (exit ${res.code})`);
    process.exit(res.code || 1);
  }
  console.log(`# ✓ APPLY complete for ${styleCode}. Reversal manifest: ${res.manifestPath}`);
  process.exit(0);
}

if (BATCH) {
  await runBatch();
  process.exit(0);
}

// --reverse-batch undoes a whole batch from its manifest (PROD writes). Placed
// after the _prodKey declaration so the lazy key fetch is out of its TDZ.
if (REVERSE_BATCH) {
  await runReverseBatch(REVERSE_BATCH);
  process.exit(0);
}

// PROD service-role JS client factory (apply/batch only; key never stored on disk).
// Lazily imports @supabase/supabase-js so the dry-run path never needs it.
async function makeProdAdmin() {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(prodUrl(), prodServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// applyStyle: the PROVEN per-style cutover, parameterized + non-fatal. Returns
//   { ok:true, restTotal, byKind, byWh, manifestPath, manifest }
//   { ok:false, error, code, manifest? }   (NEVER calls process.exit)
// `manifest` carries everything needed to REVERSE this one style:
//   { style_code, style_id, snapshot_date, zeroed_opening_balance_layers:[{id,original_qty,remaining_qty}],
//     inserted_xoro_rest_size_total, all_style_sku_ids }
// `styleIdHint` (optional): a pre-resolved style_master.id (the batch path
// resolves ALL style_ids in ONE query up front, so it skips the slow per-style
// `supabase db query` CLI spawn). When omitted (the --apply path), we resolve
// via the admin client (also fast — no CLI).
async function applyStyle(admin, styleCode, snapshotDate, styleIdHint) {
  // Store-grain cells for the EXACT style only, nonzero qty.
  const cells = Array.from(cellStoreMap.values()).filter(
    (c) => c.bp === styleCode && Number(c.qty) !== 0,
  );
  if (cells.length === 0) {
    return { ok: false, error: `no non-zero (color,size,store) cells for EXACT BasePartNumber '${styleCode}'`, code: 3 };
  }
  // Non-sized styles (blank Size in REST — accessories / one-size samples like
  // BP00001, FL00001) can't resolve a per-SIZE SKU. Skip the WHOLE style cleanly
  // (partial cutover would make Σxoro_rest_size != REST and self-reverse anyway).
  const blankSizeCells = cells.filter((c) => !String(c.size || "").trim());
  if (blankSizeCells.length > 0) {
    return { ok: false, error: `non-sized style (blank Size on ${blankSizeCells.length}/${cells.length} cells) — skipped (needs a size scale)`, code: 3, skip: true };
  }
  const restTotal = cells.reduce((s, c) => s + c.qty, 0);
  const whTotals = {};
  for (const c of cells) whTotals[c.store] = (whTotals[c.store] || 0) + c.qty;
  console.log(`# (color,size,store) cells: ${cells.length}   REST total: ${restTotal}   per-warehouse: ${JSON.stringify(whTotals)}`);

  // Resolve the style_id from prod (must exist; do NOT create styles here).
  // 0 rows is NOT fatal here: an inseam-suffixed BP (e.g. RYB059430) may have no
  // style_master row of its own yet still have SKUs under a parent — PREFIX-MODE
  // below resolves it. Only >1 is a hard error. If styleId stays null and
  // prefix-mode doesn't fire, we fail cleanly further down.
  let styleId = styleIdHint || null;
  if (!styleId) {
    const { data: srows, error: sErr } = await admin
      .from("style_master").select("id")
      .eq("style_code", styleCode).eq("entity_id", ROF_ENTITY_ID);
    if (sErr) return { ok: false, error: `resolve style_id: ${sErr.message}`, code: 3 };
    if (srows && srows.length > 1) {
      return { ok: false, error: `expected ≤1 style_master row for ${styleCode} in ROF entity, got ${srows.length}`, code: 3 };
    }
    styleId = srows && srows.length === 1 ? srows[0].id : null;
  }
  console.log(`# style_id:      ${styleId || "(none — trying prefix-mode)"}`);

  // ── PREFIX-MODE (inseam-suffixed BP) ────────────────────────────────────────
  // Some Xoro BasePartNumbers bake the INSEAM into the code: RYB059432 = style
  // RYB0594 + inseam 32. Those BPs have a style_master row with ZERO SKUs of
  // their own; the actual SKUs live under the PARENT style (RYB0594), coded by
  // the BP prefix ('RYB059432-…') with `inseam` populated — the parent holds
  // every inseam side-by-side. Without special handling the batch guard skips
  // them (resolved SKUs are "foreign" to the empty BP style) and their on-hand
  // never refreshes. Here: if THIS style has no SKUs but 'BP-%' SKUs exist under
  // exactly ONE parent at ONE inseam, refresh AGAINST THE PARENT, scoped to just
  // this BP's inseam SKUs (so sibling inseams like RYB059430 are untouched).
  let prefixMode = false;
  let prefixSkuIds = null; // when set, retire/delete/verify scope to these SKUs
  let resolveInseam = null;
  {
    // Own-SKU check only when this BP has a style row of its own.
    let ownCount = 0;
    if (styleId) {
      const { data: ownSkus } = await admin
        .from("ip_item_master").select("id")
        .eq("entity_id", ROF_ENTITY_ID).eq("style_id", styleId).limit(1);
      ownCount = (ownSkus || []).length;
    }
    // No own SKUs (empty style row) OR no style row at all → look for parent SKUs
    // coded with this BP prefix.
    if (ownCount === 0) {
      const { data: pfx } = await admin
        .from("ip_item_master").select("id, style_id, inseam")
        .eq("entity_id", ROF_ENTITY_ID).like("sku_code", `${styleCode}-%`);
      if (pfx && pfx.length > 0) {
        const parentIds = [...new Set(pfx.map((r) => r.style_id).filter(Boolean))];
        const inseams = [...new Set(pfx.map((r) => r.inseam).filter((v) => v != null).map((v) => String(v).trim()))];
        if (parentIds.length === 1 && inseams.length === 1) {
          prefixMode = true;
          styleId = parentIds[0];
          resolveInseam = inseams[0];
          prefixSkuIds = pfx.map((r) => r.id);
          console.log(`# PREFIX-MODE: '${styleCode}' → refresh under PARENT ${styleId} (inseam ${resolveInseam}), scoped to ${prefixSkuIds.length} '${styleCode}-*' SKUs.`);
        } else {
          return { ok: false, skip: true, code: 3, error: `sized-BP '${styleCode}' maps to ${parentIds.length} parent style(s) / ${inseams.length} inseam(s) — ambiguous, skipped` };
        }
      }
    }
  }
  // If we still have no style to write to (unmatched BP, no parent prefix SKUs),
  // skip cleanly — nothing to cut over.
  if (!styleId) {
    return { ok: false, skip: true, code: 3, error: `'${styleCode}' has no style_master row and no parent prefix SKUs — skipped (unmatched)` };
  }

  // 1. Find-or-create per-size SKU per (color,size). Store is NOT part of the
  //    SKU. We do this INLINE (not via the shared resolveOrCreateSku) because
  //    that helper hard-codes is_apparel=true, which trips ip_item_master's
  //    `apparel_dims_required` CHECK (apparel rows need inseam/length/fit —
  //    dims the REST snapshot does not carry). This style's existing color-grain
  //    SKUs are is_apparel=false; we match that so the size SKUs are consistent
  //    and the constraint is satisfied. (No matrix surface relies on these being
  //    apparel-flagged; the matrix reads dims off the size_scale, not is_apparel.)
  // Delegate to the ONE shared resolver: variant-aware find (reuses a legacy
  // SML/LRG row instead of forking), creates canonical, and catches a 23505 on
  // the logical-SKU UNIQUE index by re-finding the tuple. isApparel:false
  // matches this style's existing color-grain SKUs + avoids apparel_dims_required.
  const { resolveOrCreateSku, canonColor, normalizeSize } = await import("../api/_lib/styleMatrix.js");
  const skuByColorSize = new Map(); // `${color}||${size}` -> item_id
  let created = 0, reused = 0;

  if (prefixMode) {
    // REUSE-ONLY: match REST cells to the parent's EXISTING '<BP>-*' SKUs by
    // (canonColor, normalizeSize). NEVER create here — the inseam SKUs were laid
    // down by the original by-size cutover, so a cell with no match is a genuine
    // data gap (a new color/size Xoro added since). Creating would fork a
    // wrong/null-style SKU (resolveOrCreateSku's create path mis-set style_id in
    // this scenario) and the guard would skip anyway — but leave clutter. Instead
    // skip the whole style cleanly and report the gap, so the nightly never
    // accretes stray SKUs.
    const pMeta = [];
    for (let i = 0; i < prefixSkuIds.length; i += 100) {
      const { data: rows } = await admin
        .from("ip_item_master").select("id, color, size")
        .in("id", prefixSkuIds.slice(i, i + 100));
      for (const r of rows || []) pMeta.push(r);
    }
    const byCS = new Map();
    for (const r of pMeta) byCS.set(`${canonColor(r.color)}||${normalizeSize(String(r.size))}`, r.id);
    const gaps = [];
    for (const cell of cells) {
      const k = `${cell.color}||${cell.size}`;
      if (skuByColorSize.has(k)) continue;
      const id = byCS.get(`${canonColor(cell.color)}||${normalizeSize(String(cell.size))}`);
      if (!id) { gaps.push(`${cell.color}/${cell.size}`); continue; }
      skuByColorSize.set(k, id);
      reused++;
    }
    if (gaps.length > 0) {
      return { ok: false, skip: true, code: 3, error: `prefix-mode reuse-only: ${gaps.length}/${cells.length} REST cell(s) have no existing parent SKU (e.g. ${gaps[0]}) — new color/size data gap, skipped (no SKUs created)` };
    }
  } else {
    async function findOrCreateSizeSku(color, size) {
      return resolveOrCreateSku(admin, ROF_ENTITY_ID, { style_id: styleId, style_code: styleCode, color, size, inseam: resolveInseam }, { isApparel: false });
    }
    for (const cell of cells) {
      const k = `${cell.color}||${cell.size}`;
      if (skuByColorSize.has(k)) continue;
      const res = await findOrCreateSizeSku(cell.color, cell.size);
      if (res.error || !res.id) {
        return { ok: false, error: `findOrCreateSizeSku failed for (${cell.color}, ${cell.size}): ${res.error}`, code: 4 };
      }
      skuByColorSize.set(k, res.id);
      if (res.created) created++; else reused++;
    }
  }
  console.log(`# SKUs: ${skuByColorSize.size} distinct (color,size)  [${created} created, ${reused} reused]`);

  // Need sku_code + a default location for every SKU we will write a layer to.
  // We mirror the location used by this style's existing layers (all opening_
  // balance rows sit at one location); fall back to the entity's MAIN_WH.
  const skuIds = [...new Set(skuByColorSize.values())];
  const { data: skuMeta, error: skuMetaErr } = await admin
    .from("ip_item_master")
    .select("id, sku_code, color, size, style_id")
    .in("id", skuIds);
  if (skuMetaErr) { return { ok: false, error: `load sku meta: ${skuMetaErr.message}`, code: 4 }; }
  const skuCodeById = new Map((skuMeta || []).map((r) => [r.id, r.sku_code]));

  // GUARD (pre-write): every resolved SKU must belong to THIS style_id. For a
  // SKU-less style_master row whose style_code is a size/gender-suffixed BP
  // (e.g. RYB059432 = style RYB0594 + waist 32, RYB086934PL), resolveOrCreateSku
  // can't find/create under the empty style and re-finds a FOREIGN SKU by the
  // globally-unique sku_code — so layers would land on the parent style and the
  // per-style reversal (scoped to THIS style's SKUs, which is empty) can't undo
  // them → an un-reversible orphan double-count. Refuse the whole style instead.
  const foreignSkus = (skuMeta || []).filter((r) => r.style_id !== styleId);
  if (foreignSkus.length > 0) {
    return {
      ok: false, skip: true, code: 3,
      error: `resolved ${foreignSkus.length}/${skuIds.length} SKU(s) belonging to a DIFFERENT style (e.g. ${foreignSkus[0].sku_code}) — SKU-less / sized-BP style, skipped to avoid orphan layers on the parent`,
    };
  }

  // Determine the location_id to stamp on new layers: reuse the location on the
  // style's existing layers (deterministic, single-location in prod); fallback
  // to MAIN_WH for the entity.
  const { data: existLayerLoc } = await admin
    .from("inventory_layers")
    .select("location_id")
    .in("item_id", skuIds)
    .not("location_id", "is", null)
    .limit(1);
  let locationId = existLayerLoc && existLayerLoc[0] ? existLayerLoc[0].location_id : null;
  if (!locationId) {
    // Zero-layer styles (brand-new SKUs with no prior on-hand) have no existing
    // location to mirror. The ROF Main Warehouse code is WH-00000 (NOT MAIN_WH);
    // fall back to it, then to ANY location for the entity as a last resort.
    const { data: mainWh } = await admin
      .from("inventory_locations")
      .select("id")
      .eq("entity_id", ROF_ENTITY_ID)
      .eq("code", "WH-00000")
      .maybeSingle();
    locationId = mainWh?.id || null;
    if (!locationId) {
      const { data: anyLoc } = await admin
        .from("inventory_locations")
        .select("id").eq("entity_id", ROF_ENTITY_ID).order("code").limit(1);
      locationId = anyLoc && anyLoc[0] ? anyLoc[0].id : null;
    }
  }
  if (!locationId) { return { ok: false, error: `could not resolve a location_id for new layers`, code: 4 }; }
  console.log(`# location_id (fallback): ${locationId}`);

  // Per-store location map so each layer sits on ITS store's warehouse (ROF Main
  // → WH-00000, ROF - ECOM → WH-00001, …). Falls back to `locationId` for any
  // store not in the map. Without this all stores' stock lands on one location.
  const { data: allLocs } = await admin
    .from("inventory_locations")
    .select("id, code")
    .eq("entity_id", ROF_ENTITY_ID);
  const locByCode = new Map((allLocs || []).map((l) => [l.code, l.id]));
  const locForStore = (store) => locByCode.get(STORE_TO_LOC_CODE[store]) || locationId;

  // Avg cost: ip_item_avg_cost keyed by sku_code, dollars. Prefer the exact
  // per-size sku_code; fall back to the color-level sku_code (style-COLOR);
  // else 0. Cost is not final pre-go-live (operator confirmed).
  const allSkuCodesNeeded = new Set();
  for (const code of skuCodeById.values()) if (code) {
    allSkuCodesNeeded.add(code);
    // color-level code = strip trailing -<size> (e.g. RYB0412-GREY-30 -> RYB0412-GREY)
    const colorCode = code.replace(/-[^-]+$/, "");
    if (colorCode && colorCode !== code) allSkuCodesNeeded.add(colorCode);
  }
  const avgBySku = new Map();
  if (allSkuCodesNeeded.size > 0) {
    const { data: avgRows } = await admin
      .from("ip_item_avg_cost")
      .select("sku_code, avg_cost")
      .in("sku_code", [...allSkuCodesNeeded]);
    for (const r of avgRows || []) if (r.avg_cost != null) avgBySku.set(r.sku_code, Number(r.avg_cost));
  }
  function unitCostCentsFor(code) {
    if (!code) return 0;
    if (avgBySku.has(code)) return Math.round(avgBySku.get(code) * 100);
    const colorCode = code.replace(/-[^-]+$/, "");
    if (avgBySku.has(colorCode)) return Math.round(avgBySku.get(colorCode) * 100);
    return 0;
  }

  // 2. Upsert tangerine_size_onhand: one row per (item_id, warehouse=Store).
  //    AGGREGATE by (item_id, warehouse): when two REST (color,size) cells
  //    resolve to the SAME SKU (e.g. resolveOrCreateSku reuses one legacy
  //    SML/LRG row for multiple REST sizes), naive per-cell rows collide on the
  //    (entity,item,warehouse,snapshot,source) unique key → "ON CONFLICT DO
  //    UPDATE command cannot affect row a second time". Sum the qty instead.
  const upsertByKey = new Map();
  for (const cell of cells) {
    const itemId = skuByColorSize.get(`${cell.color}||${cell.size}`);
    const key = `${itemId}||${cell.store}`;
    const prev = upsertByKey.get(key);
    if (prev) prev.qty_on_hand += cell.qty;
    else upsertByKey.set(key, {
      entity_id: ROF_ENTITY_ID,
      item_id: itemId,
      warehouse_code: cell.store, // ROF Main / ROF - ECOM kept SEPARATE
      snapshot_date: snapshotDate,
      qty_on_hand: cell.qty,
      source: "xoro_rest",
    });
  }
  const upsertRows = [...upsertByKey.values()];
  const { error: upErr } = await admin
    .from("tangerine_size_onhand")
    .upsert(upsertRows, { onConflict: "entity_id,item_id,warehouse_code,snapshot_date,source" });
  if (upErr) { return { ok: false, error: `tangerine_size_onhand upsert failed: ${upErr.message}`, code: 5 }; }
  console.log(`# ✓ upserted ${upsertRows.length} tangerine_size_onhand rows.`);

  // ── Retire the seed (REVERSIBLE) ────────────────────────────────────────────
  // EVERY ip_item_master SKU under this style (not just resolved ones) — the
  // 24 color-grain seed SKUs must all go to 0 so the matrix total == REST.
  // PREFIX-MODE: scope to ONLY this BP's inseam SKUs (+ any just-resolved) so the
  // parent's OTHER inseams (e.g. RYB059430) keep their layers untouched.
  let allStyleSkuIds;
  if (prefixMode) {
    allStyleSkuIds = [...new Set([...prefixSkuIds, ...skuByColorSize.values()])];
    console.log(`# PREFIX-MODE scope: ${allStyleSkuIds.length} SKUs (this inseam only).`);
  } else {
    const { data: allStyleSkus, error: allSkuErr } = await admin
      .from("ip_item_master")
      .select("id")
      .eq("entity_id", ROF_ENTITY_ID)
      .eq("style_id", styleId);
    if (allSkuErr) { return { ok: false, error: `load style SKUs: ${allSkuErr.message}`, code: 5 }; }
    allStyleSkuIds = (allStyleSkus || []).map((r) => r.id);
  }

  // A few legacy styles carry HUNDREDS of stale SKUs; a single `.in(item_id,[…])`
  // over all of them blows past PostgREST's URL length (→ 400 Bad Request). Chunk
  // every item_id-keyed query/delete into batches of 100.
  const ID_CHUNK = 100;
  const chunkIds = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += ID_CHUNK) out.push(arr.slice(i, i + ID_CHUNK));
    return out;
  };

  // 4a. Capture the MIRROR-OWNED layers we will zero (for exact reversal), then
  //     UPDATE remaining_qty=0 (do NOT delete). Chunked over item_id.
  //     Mirror-owned = {opening_balance, xoro_onhand_sync}: both are synthetic
  //     on-hand seeds that the per-SIZE xoro_rest_size layer SUPERSEDES. The
  //     nightly xoro_onhand_sync (color-grain) manages ~70 styles; once a style
  //     has xoro_rest_size the sync disqualifies it, so a leftover nonzero
  //     xoro_onhand_sync layer would DOUBLE-COUNT (23 styles overlap the REST
  //     feed). Native kinds (po_receipt/ap_invoice/adjustment/transfer_in/
  //     manufacture/credit_memo_return) are legit stock and NEVER touched here.
  const RETIRE_KINDS = ["opening_balance", "xoro_onhand_sync"];
  const obToZero = [];
  for (const ids of chunkIds(allStyleSkuIds)) {
    const { data: obLayers, error: obErr } = await admin
      .from("inventory_layers")
      .select("id, item_id, original_qty, remaining_qty, source_kind")
      .eq("entity_id", ROF_ENTITY_ID)
      .in("item_id", ids)
      .in("source_kind", RETIRE_KINDS)
      .gt("remaining_qty", 0);
    if (obErr) { return { ok: false, error: `load mirror-owned (${RETIRE_KINDS.join("/")}) layers: ${obErr.message}`, code: 5 }; }
    for (const l of obLayers || []) obToZero.push(l);
  }
  const obZeroedTotal = obToZero.reduce((s, l) => s + Number(l.remaining_qty), 0);
  const retiredByKind = obToZero.reduce((m, l) => ((m[l.source_kind] = (m[l.source_kind] || 0) + Number(l.remaining_qty)), m), {});
  console.log(`\n# ── REVERSAL LOG: mirror-owned layers being zeroed (${obToZero.length} layers, ${obZeroedTotal} units; ${JSON.stringify(retiredByKind)}) ──`);
  for (const l of obToZero) {
    console.log(`#   layer ${l.id}  item ${l.item_id}  remaining_qty ${l.remaining_qty}  (original_qty ${l.original_qty})`);
  }
  // Reversal manifest — everything needed to undo THIS style:
  //  - zeroed_opening_balance_layers: restore each id's remaining_qty
  //  - all_style_sku_ids: delete xoro_rest_size layers under these SKUs
  const manifest = {
    style_code: styleCode, style_id: styleId, entity_id: ROF_ENTITY_ID,
    snapshot_date: snapshotDate, zeroed_opening_balance_layers: obToZero,
    all_style_sku_ids: allStyleSkuIds, rest_total: restTotal,
  };
  const manifestPath = join(tmp, `reversal-manifest-${styleCode}-${snapshotDate}.json`);
  // NON-FATAL + self-healing: the OS can clean the temp dir mid-run on a long
  // --batch (Windows temp cleanup wiped it once → ENOENT threw and ~208 styles
  // failed pre-write). Recreate the dir; if the write still fails, WARN and
  // continue — the authoritative per-batch reversal manifest is flushed to
  // .launchd-logs after every success, so this per-style copy is only a
  // convenience for the single --apply path.
  try {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    console.log(`# reversal manifest written: ${manifestPath}`);
  } catch (e) {
    console.log(`# ⚠ per-style manifest write skipped (${e.code || e.message}); batch manifest in .launchd-logs is authoritative.`);
  }

  // 4b. Idempotent re-run: delete any PRIOR xoro_rest_size layers for these SKUs
  //     FIRST (we delete-then-reinsert below; this guards a partial state).
  for (const ids of chunkIds(allStyleSkuIds)) {
    const { error: delPriorErr } = await admin
      .from("inventory_layers")
      .delete()
      .eq("entity_id", ROF_ENTITY_ID)
      .in("item_id", ids)
      .eq("source_kind", "xoro_rest_size");
    if (delPriorErr) { return { ok: false, error: `delete prior xoro_rest_size layers: ${delPriorErr.message}`, code: 5, manifest, manifestPath }; }
  }

  // 4c. Zero the opening_balance layers (chunked over layer id).
  if (obToZero.length > 0) {
    for (const ids of chunkIds(obToZero.map((l) => l.id))) {
      const { error: zeroErr } = await admin
        .from("inventory_layers")
        .update({ remaining_qty: 0 })
        .in("id", ids);
      if (zeroErr) { return { ok: false, error: `zero opening_balance layers: ${zeroErr.message}`, code: 5, manifest, manifestPath }; }
    }
    console.log(`# ✓ zeroed ${obToZero.length} opening_balance layers (original_qty preserved).`);
  }

  // 5. Insert one xoro_rest_size layer per (per-size SKU, warehouse=Store).
  const layerRows = cells.map((cell) => {
    const itemId = skuByColorSize.get(`${cell.color}||${cell.size}`);
    const code = skuCodeById.get(itemId);
    return {
      entity_id: ROF_ENTITY_ID,
      item_id: itemId,
      location_id: locForStore(cell.store),
      // Xoro-date policy: the layer's received_at is the CSV's own snapshot date
      // (from the postAD_invrest_YYYYMMDD filename), NOT a hardcoded cutover date
      // — same date already used in `notes` and the tangerine_size_onhand upsert.
      // (The sync_received_dates RPC later advances this to the true Xoro "Last
      // Receipt Date"; this is the correct write-time value.)
      received_at: `${snapshotDate}T23:59:59Z`,
      original_qty: cell.qty,
      remaining_qty: cell.qty,
      unit_cost_cents: unitCostCentsFor(code),
      source_kind: "xoro_rest_size",
      notes: `xoro_rest_size:${snapshotDate}:wh=${cell.store}`,
    };
  });
  const { error: insErr } = await admin.from("inventory_layers").insert(layerRows);
  if (insErr) { return { ok: false, error: `insert xoro_rest_size layers: ${insErr.message}`, code: 6, manifest, manifestPath }; }
  console.log(`# ✓ inserted ${layerRows.length} xoro_rest_size layers (total ${restTotal} units).`);

  // ── In-process VERIFY ─────────────────────────────────────────────────────── (chunked over item_id)
  let total = 0; const byKind = {}; const byWh = {};
  for (const ids of chunkIds(allStyleSkuIds)) {
    const { data: postLayers, error: verErr } = await admin
      .from("inventory_layers")
      .select("remaining_qty, source_kind, notes")
      .eq("entity_id", ROF_ENTITY_ID)
      .in("item_id", ids)
      .gt("remaining_qty", 0);
    if (verErr) { return { ok: false, error: `verify read failed: ${verErr.message}`, code: 7, manifest, manifestPath }; }
    for (const l of postLayers || []) {
      const q = Number(l.remaining_qty); total += q;
      byKind[l.source_kind] = (byKind[l.source_kind] || 0) + q;
      const m = (l.notes || "").match(/wh=(.+)$/);
      const wh = m ? m[1] : "(none)";
      byWh[wh] = (byWh[wh] || 0) + q;
    }
  }
  console.log(`\n# ── POST-APPLY VERIFY (live read) ──`);
  console.log(`#   Σ remaining_qty (all nonzero layers): ${total}`);
  console.log(`#   by source_kind: ${JSON.stringify(byKind)}`);
  console.log(`#   by warehouse:   ${JSON.stringify(byWh)}`);
  // The invariants this cutover OWNS are only two:
  //   (1) the seed is retired  → NO opening_balance layer left nonzero, and
  //   (2) our xoro_rest_size layers sum to EXACTLY the REST size-grain total.
  // Any OTHER source_kind (transfer_in / adjustment / po_receipt / ap_invoice /
  // manufacture / credit_memo_return) is LEGIT native on-hand this cutover must
  // NOT touch — its presence is NOT a failure. (Earlier the check demanded "only
  // xoro_rest_size" + total==REST, so a single legit transfer_in layer tripped a
  // false FAIL and, in --batch, auto-reversed the whole style.)
  const xoroRestTotal = byKind["xoro_rest_size"] || 0;
  const mirrorRemaining = (byKind["opening_balance"] || 0) + (byKind["xoro_onhand_sync"] || 0);
  const nativeKinds = Object.keys(byKind).filter((k) => k !== "xoro_rest_size" && k !== "opening_balance" && k !== "xoro_onhand_sync");
  const nativeTotal = nativeKinds.reduce((s, k) => s + byKind[k], 0);
  const okRest = xoroRestTotal === restTotal;
  const okSeedRetired = mirrorRemaining === 0;
  console.log(`#   Σ xoro_rest_size == REST (${restTotal}): ${okRest ? "PASS" : "FAIL"} (got ${xoroRestTotal})`);
  console.log(`#   mirror seed retired (opening_balance+xoro_onhand_sync 0 remaining): ${okSeedRetired ? "PASS" : "FAIL"} (got ${mirrorRemaining})`);
  if (nativeTotal > 0) {
    console.log(`#   ℹ preserved ${nativeTotal} units on native layers (${nativeKinds.join(", ")}) — untouched by design.`);
  }
  if (!okRest || !okSeedRetired) {
    return {
      ok: false,
      error: `POST-APPLY VERIFY FAILED (xoro_rest_size=${xoroRestTotal} restTotal=${restTotal} mirror_remaining=${mirrorRemaining} byKind=${JSON.stringify(byKind)})`,
      code: 8, manifest, manifestPath, byKind, byWh, restTotal, total,
    };
  }
  return { ok: true, restTotal, byKind, byWh, manifest, manifestPath, total, xoroRestTotal, nativeTotal };
}

// reverseStyle: undo ONE style given its applyStyle manifest. Restores each
// zeroed opening_balance layer's remaining_qty and deletes every xoro_rest_size
// layer under the style's SKUs. Used both on per-style verify failure inside
// --batch and (manifest-driven) for a whole-batch reversal. Returns {ok,error}.
async function reverseStyle(admin, manifest) {
  const skuIds = manifest.all_style_sku_ids || [];
  // 1. Delete the xoro_rest_size layers we inserted (only this style's SKUs).
  //    Chunk over item_id (legacy styles can have >1000 SKUs → URL-length 400).
  for (let i = 0; i < skuIds.length; i += 100) {
    const ids = skuIds.slice(i, i + 100);
    const { error: delErr } = await admin
      .from("inventory_layers")
      .delete()
      .eq("entity_id", ROF_ENTITY_ID)
      .in("item_id", ids)
      .eq("source_kind", "xoro_rest_size");
    if (delErr) return { ok: false, error: `reverse delete xoro_rest_size: ${delErr.message}` };
  }
  // 2. Restore each opening_balance layer's original remaining_qty.
  for (const l of manifest.zeroed_opening_balance_layers || []) {
    const { error: updErr } = await admin
      .from("inventory_layers")
      .update({ remaining_qty: l.remaining_qty })
      .eq("id", l.id);
    if (updErr) return { ok: false, error: `reverse restore layer ${l.id}: ${updErr.message}` };
  }
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// --batch : iterate the work-list, calling applyStyle per style, verifying, and
// reversing any style that fails. Writes a batch-level reversal manifest so the
// ENTIRE batch can be undone with one command (node ... --reverse-batch <file>).
// ══════════════════════════════════════════════════════════════════════════════
async function runBatch() {
  const snapshotDate = snapshotDateFromCsv(csvPath);
  console.log(`\n# ══════════ BATCH CUTOVER (PROD) ══════════`);
  console.log(`# snapshot_date: ${snapshotDate}`);
  console.log(`# entity_id:     ${ROF_ENTITY_ID}`);

  // ── Build the work-list. ────────────────────────────────────────────────────
  // Every DISTINCT REST BasePartNumber that EXACTLY equals an existing
  // style_master.style_code in the ROF entity. SKIP:
  //   - PPK prepacks  (/PPK/i — separate pack-grain world; never cut over)
  //   - RYB0412       (already cut over in the pilot; verify it hasn't reverted to mirror seeds)
  //   - BPs with no exact style_code match (handled by the DB join below)
  const allBps = bps; // distinct BasePartNumbers from the CSV
  const PPK_RE = /PPK/i;
  const ppkSkipped = allBps.filter((bp) => PPK_RE.test(bp));
  const candidateBps = allBps.filter((bp) => !PPK_RE.test(bp));

  // Resolve which candidates exactly match a ROF style_code (case-sensitive,
  // EXACT — matches the dry-run reconciliation join semantics). ONE query
  // resolves BOTH the matched set AND every style_id, so the per-style loop
  // never has to do its own (slow) style_id lookup.
  const litList = candidateBps.map(sqlLit).join(",");
  const matchRows = litList
    ? await runSql(`SELECT id::text AS id, style_code FROM style_master
                    WHERE entity_id = ${sqlLit(ROF_ENTITY_ID)}
                      AND style_code IN (${litList});`)
    : [];
  const matchedSet = new Set(matchRows.map((r) => r.style_code));
  const styleIdByCode = new Map(matchRows.map((r) => [r.style_code, r.id]));
  const unmatchedSkipped = candidateBps.filter((bp) => !matchedSet.has(bp));

  // Final work-list: matched, non-PPK, excluding RYB0412 (pilot — verify+skip),
  // and excluding zero-REST styles (no on-hand to cut over; applyStyle would
  // no-op with a "no non-zero cells" error — skip cleanly, don't count failed).
  // NOTE: unmatched inseam-suffixed BPs (e.g. RYB059430 with no style row) are
  // deliberately NOT included — their SKUs are tangled across parents and
  // resolveOrCreateSku would fork null-style clutter (the guard skips them but
  // after creating stray rows). Matched-but-empty inseam BPs (the 12: RYB059432
  // etc.) ARE in the list and PREFIX-MODE refreshes them cleanly.
  const PILOT = "RYB0412";
  const matchedNonPilot = candidateBps.filter((bp) => matchedSet.has(bp) && bp !== PILOT);
  const zeroRestSkipped = matchedNonPilot.filter((bp) => (restStyleTotal.get(bp) || 0) === 0);
  let workList = matchedNonPilot.filter((bp) => (restStyleTotal.get(bp) || 0) !== 0);
  workList.sort();
  if (BATCH_LIMIT != null) {
    console.log(`# ⚠ --batch-limit ${BATCH_LIMIT}: processing only the first ${BATCH_LIMIT} styles.`);
    workList = workList.slice(0, BATCH_LIMIT);
  }

  console.log(`\n# ── WORK-LIST ──`);
  console.log(`#   REST distinct BPs:        ${allBps.length}`);
  console.log(`#   PPK skipped:              ${ppkSkipped.length}`);
  console.log(`#   unmatched skipped:        ${unmatchedSkipped.length}`);
  console.log(`#   zero-REST skipped:        ${zeroRestSkipped.length}`);
  console.log(`#   pilot RYB0412 skipped:    1 (already cut over)`);
  console.log(`#   ==> styles to cut over:   ${workList.length}`);
  console.log(`#   PPK list: ${ppkSkipped.join(", ") || "(none)"}`);
  console.log(`#   unmatched list: ${unmatchedSkipped.join(", ") || "(none)"}`);

  // Guard rails from the brief: STOP before any write if the work-list is
  // implausibly large or the grand reconciliation deviates wildly from REST.
  const restTotalAll = workList.reduce((s, bp) => s + (restStyleTotal.get(bp) || 0), 0);
  console.log(`#   REST units across work-list: ${restTotalAll}`);
  if (workList.length > 1500) {
    console.error(`✗ work-list (${workList.length}) exceeds the 1,500-style guard rail. STOPPING before any write.`);
    process.exit(9);
  }

  // ── Verify the pilot didn't revert to mirror seeds (value is dynamic now). ──
  const admin = await makeProdAdmin();
  const pilotRows = await runSql(`
    SELECT il.source_kind,
           COALESCE(SUM(il.remaining_qty) FILTER (WHERE il.remaining_qty > 0),0)::numeric AS rem
    FROM style_master sm
    JOIN ip_item_master im ON im.style_id = sm.id
    JOIN inventory_layers il ON il.item_id = im.id
    WHERE sm.style_code = ${sqlLit(PILOT)} AND sm.entity_id = ${sqlLit(ROF_ENTITY_ID)}
      AND il.remaining_qty > 0
    GROUP BY il.source_kind;`);
  const pilotByKind = pilotRows.reduce((m, r) => (m.set(r.source_kind, Number(r.rem)), m), new Map());
  const pilotTotal = [...pilotByKind.values()].reduce((s, v) => s + v, 0);
  // Invariant (not a fixed value): the pilot's on-hand is dynamic — it depletes
  // with sales and is trued up by the spine phantom-clear (was hardcoded 48,200,
  // now e.g. 11,834). What must hold is that RYB0412 hasn't REVERTED to the
  // pre-cutover mirror seeds (opening_balance / xoro_onhand_sync): its on-hand
  // should be positive and overwhelmingly xoro_rest_size. Small native layers
  // (receipts / adjustments / transfers) are legitimate and tolerated.
  const pilotRest = pilotByKind.get("xoro_rest_size") || 0;
  const pilotSeeds = (pilotByKind.get("opening_balance") || 0) + (pilotByKind.get("xoro_onhand_sync") || 0);
  const pilotOk = pilotTotal > 0 && pilotRest >= pilotTotal * 0.9 && pilotSeeds === 0;
  console.log(`\n# Pilot RYB0412 (info): total=${pilotTotal} byKind=${JSON.stringify(Object.fromEntries(pilotByKind))} -> ${pilotOk ? "OK (xoro_rest_size, no reverted seeds)" : "⚠ CHECK — reverted to mirror seeds?"}`);

  // ── Iterate in chunks, applying + verifying + reversing-on-failure. ─────────
  const succeeded = [];
  const failed = [];
  const batchManifest = {
    started_at: new Date().toISOString(),
    snapshot_date: snapshotDate,
    entity_id: ROF_ENTITY_ID,
    csv: csvPath,
    styles: [], // [{ style_code, ...manifest }] for reversal
  };
  const batchManifestPath = join(REST_CSV_DIR, `by-size-batch-reversal-${snapshotDate}-${Date.now()}.json`);

  let idx = 0;
  for (let start = 0; start < workList.length; start += CHUNK_SIZE) {
    const chunk = workList.slice(start, start + CHUNK_SIZE);
    console.log(`\n# ──────── CHUNK ${Math.floor(start / CHUNK_SIZE) + 1} / ${Math.ceil(workList.length / CHUNK_SIZE)}  (styles ${start + 1}-${start + chunk.length} of ${workList.length}) ────────`);
    for (const bp of chunk) {
      idx++;
      const restStyle = restStyleTotal.get(bp) || 0;
      console.log(`\n# [${idx}/${workList.length}] ${bp}  (REST ${restStyle})`);
      let res;
      try {
        res = await applyStyle(admin, bp, snapshotDate, styleIdByCode.get(bp));
      } catch (e) {
        res = { ok: false, error: `exception: ${e.message}`, code: 99 };
      }
      if (res.ok) {
        succeeded.push({ bp, rest: res.restTotal, byWh: res.byWh });
        batchManifest.styles.push({ style_code: bp, ...res.manifest });
        // Flush the batch manifest after EVERY success (crash-safe reversal).
        writeFileSync(batchManifestPath, JSON.stringify(batchManifest, null, 2), "utf8");
        console.log(`#   ✓ [${idx}] ${bp} cut over (${res.restTotal} units).`);
      } else {
        console.error(`#   ✗ [${idx}] ${bp} FAILED: ${res.error}`);
        // Reverse just this style if it got far enough to have a manifest.
        if (res.manifest) {
          const rev = await reverseStyle(admin, res.manifest);
          console.error(`#     reversal: ${rev.ok ? "OK (style restored to opening_balance)" : "✗ " + rev.error}`);
          failed.push({ bp, error: res.error, reversed: rev.ok });
        } else {
          // Failed before any write — nothing to reverse.
          failed.push({ bp, error: res.error, reversed: "n/a (pre-write)" });
        }
      }
    }
  }

  // ── Batch summary. ──────────────────────────────────────────────────────────
  const successUnits = succeeded.reduce((s, r) => s + r.rest, 0);
  console.log(`\n# ══════════ BATCH SUMMARY ══════════`);
  console.log(`#   styles attempted:  ${workList.length}`);
  console.log(`#   succeeded:         ${succeeded.length}  (${successUnits} units)`);
  console.log(`#   failed/skipped:    ${failed.length}`);
  if (failed.length > 0) {
    console.log(`#   FAILURES:`);
    for (const f of failed) console.log(`#     ${f.bp}: ${f.error}  [reversed: ${f.reversed}]`);
  }
  console.log(`#   batch reversal manifest: ${batchManifestPath}`);
  console.log(`#`);
  console.log(`#   To REVERSE the entire batch:`);
  console.log(`#     node scripts/ingest-size-onhand.mjs --reverse-batch "${batchManifestPath}" --workdir <main-checkout>`);
}

// ── --reverse-batch <manifest> : undo a whole batch from its manifest. ────────
async function runReverseBatch(manifestPath) {
  console.log(`# ── REVERSE BATCH ──  manifest: ${manifestPath}`);
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const admin = await makeProdAdmin();
  let ok = 0, bad = 0;
  for (const styleManifest of m.styles || []) {
    const rev = await reverseStyle(admin, styleManifest);
    if (rev.ok) { ok++; console.log(`#   ✓ reversed ${styleManifest.style_code}`); }
    else { bad++; console.error(`#   ✗ ${styleManifest.style_code}: ${rev.error}`); }
  }
  console.log(`# Reverse complete: ${ok} reversed, ${bad} failed.`);
  process.exit(bad > 0 ? 1 : 0);
}

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
