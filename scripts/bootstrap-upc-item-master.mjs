#!/usr/bin/env node
/**
 * scripts/bootstrap-upc-item-master.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Bootstraps the identity spine `upc_item_master` (upc -> sku_id) from the Xoro
 * REST inventory CSV. Each REST row carries a stable UPC + an ItemNumber; we
 * normalize the ItemNumber to an ip_item_master.sku_code and, on a UNIQUE match,
 * record upc -> {sku_id + the CANONICAL ip_item_master style/color/size}.
 *
 * Once populated, the by-size cutover / ATS / reconcile can join REST rows to
 * the clean identity by UPC instead of fragile style/color strings. Rows that
 * don't uniquely match (color/style spelling variants) are SKIPPED here and are
 * the Phase-2 color-canon work.
 *
 * Reads ip_item_master via anon REST (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
 * from .env.local); writes via the Supabase Management API (SUPABASE_PAT), which
 * bypasses RLS. Upserts on the unique `upc`, so re-running is safe.
 *
 *   node scripts/bootstrap-upc-item-master.mjs                 # dry-run (report only)
 *   node scripts/bootstrap-upc-item-master.mjs --csv <path>    # override REST CSV
 *   node scripts/bootstrap-upc-item-master.mjs --apply         # write PROD
 */
import { readFileSync, createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const csvArg = args.includes("--csv") ? args[args.indexOf("--csv") + 1] : null;
const PROD_REF = "qcvqvxxoperiurauoxmp";
const SOURCE_METHOD = "rest_itemnumber_bootstrap_20260710";
const DEFAULT_CSV = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/postAD_invrest_20260709211317.csv";

function loadEnv(file) {
  try {
    return Object.fromEntries(readFileSync(resolve(ROOT, file), "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!SB_URL || !ANON) { console.error("✗ VITE_SUPABASE_URL / ANON key missing"); process.exit(1); }
if (APPLY && !PAT) { console.error("✗ --apply needs SUPABASE_PAT (Management API)"); process.exit(1); }

// REST ItemNumber -> candidate sku_code (upper; "- "/space -> "-"; collapse).
const norm = (s) => String(s || "").toUpperCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const sqlLit = (v) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

async function loadItemMaster() {
  // upper(sku_code) -> {id, style_code, color, size}; drop dup sku_codes (ambiguous).
  const bySku = new Map();
  const dup = new Set();
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/ip_item_master?select=id,sku_code,style_code,color,size&sku_code=not.is.null&limit=1000&offset=${off}`,
      { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    if (!r.ok) throw new Error(`ip_item_master read failed: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    if (!rows.length) break;
    for (const x of rows) {
      const k = String(x.sku_code).toUpperCase();
      if (bySku.has(k)) { dup.add(k); } else { bySku.set(k, { id: x.id, style_code: x.style_code, color: x.color, size: x.size }); }
    }
    if (rows.length < 1000) break;
  }
  for (const k of dup) bySku.delete(k); // ambiguous -> never map
  return { bySku, dupCount: dup.size };
}

async function readRest(csvPath) {
  const rl = createInterface({ input: createReadStream(csvPath) });
  let header = null, nCols = 0, idx = {};
  const rows = [];
  let malformed = 0;
  for await (const line of rl) {
    if (!header) {
      header = line.split(","); nCols = header.length;
      for (const c of ["Color", "Size", "ItemNumber", "BasePartNumber", "ItemDescription", "ItemUpc"]) idx[c] = header.indexOf(c);
      continue;
    }
    const cols = line.split(",");
    if (cols.length !== nCols) { malformed++; continue; } // unquoted comma in a field -> skip safely
    rows.push({
      upc: (cols[idx.ItemUpc] || "").trim(),
      itemNumber: (cols[idx.ItemNumber] || "").trim(),
      bp: (cols[idx.BasePartNumber] || "").trim(),
      color: (cols[idx.Color] || "").trim(),
      size: (cols[idx.Size] || "").trim(),
      desc: (cols[idx.ItemDescription] || "").trim(),
    });
  }
  return { rows, malformed };
}

async function runSqlMgmt(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Mgmt API ${res.status}: ${await res.text()}`);
  return res.json();
}

const csvPath = csvArg || DEFAULT_CSV;
console.log(`# REST CSV: ${csvPath}`);
console.log(`# Mode:     ${APPLY ? "APPLY (PROD writes)" : "DRY-RUN (no writes)"}`);

const { bySku, dupCount } = await loadItemMaster();
console.log(`# ip_item_master sku_codes loaded: ${bySku.size.toLocaleString()} (dropped ${dupCount} ambiguous dup sku_codes)`);

const { rows, malformed } = await readRest(csvPath);
console.log(`# REST rows: ${rows.length.toLocaleString()} (skipped ${malformed} malformed/comma-shifted)`);

// Resolve + dedup by UPC. Conflict guard: if two rows share a UPC but resolve
// to different sku_ids, drop that UPC (data ambiguity).
const byUpc = new Map();
const conflictUpc = new Set();
let noUpc = 0, unmatched = 0;
for (const r of rows) {
  if (!r.upc || !/^\d{6,}$/.test(r.upc)) { noUpc++; continue; }
  const hit = bySku.get(norm(r.itemNumber));
  if (!hit) { unmatched++; continue; }
  const prev = byUpc.get(r.upc);
  if (prev && prev.sku_id !== hit.id) { conflictUpc.add(r.upc); continue; }
  if (!prev) byUpc.set(r.upc, { upc: r.upc, sku_id: hit.id, style_no: hit.style_code, color: hit.color, size: hit.size, description: r.desc });
}
for (const u of conflictUpc) byUpc.delete(u);

const out = [...byUpc.values()].filter((x) => x.style_no && x.color != null && x.size != null);
console.log(`\n# ── RESULT ──`);
console.log(`#   no/invalid UPC:        ${noUpc.toLocaleString()}`);
console.log(`#   unmatched (color canon): ${unmatched.toLocaleString()}`);
console.log(`#   UPC conflicts dropped: ${conflictUpc.size}`);
console.log(`#   ==> upc->sku_id rows to write: ${out.length.toLocaleString()}`);
console.log(`#   sample:`);
out.slice(0, 5).forEach((x) => console.log(`     ${x.upc}  ->  ${x.style_no} / ${x.color} / ${x.size}  (sku ${x.sku_id.slice(0, 8)})`));

if (!APPLY) { console.log(`\n# DRY-RUN — pass --apply to write ${out.length} rows.`); process.exit(0); }

// Write via Management API, chunked, upsert on unique upc.
let written = 0;
for (let i = 0; i < out.length; i += 500) {
  const chunk = out.slice(i, i + 500);
  const values = chunk.map((x) =>
    `(${sqlLit(x.upc)}, ${sqlLit(x.style_no)}, ${sqlLit(x.color)}, ${sqlLit(x.size)}, ${sqlLit(x.description)}, ${sqlLit(x.sku_id)}::uuid, ${sqlLit(SOURCE_METHOD)})`).join(",\n");
  const sql = `INSERT INTO upc_item_master (upc, style_no, color, size, description, sku_id, source_method)
VALUES ${values}
ON CONFLICT (upc) DO UPDATE SET sku_id=EXCLUDED.sku_id, style_no=EXCLUDED.style_no,
  color=EXCLUDED.color, size=EXCLUDED.size, description=EXCLUDED.description,
  source_method=EXCLUDED.source_method, updated_at=now();`;
  await runSqlMgmt(sql);
  written += chunk.length;
  console.log(`#   upserted ${written.toLocaleString()} / ${out.length.toLocaleString()}`);
}
const [{ n }] = await runSqlMgmt(`select count(*)::int n from upc_item_master;`);
console.log(`\n# ✓ DONE. upc_item_master now has ${n.toLocaleString()} rows.`);
