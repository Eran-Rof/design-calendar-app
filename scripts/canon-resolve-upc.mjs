#!/usr/bin/env node
/**
 * scripts/canon-resolve-upc.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Phase-2 of the identity-spine build: resolve the REST UPCs that the exact
 * bootstrap (bootstrap-upc-item-master.mjs) left unmatched, using color/style
 * CANONICALIZATION, and upsert them into upc_item_master.
 *
 * Match strategy for a still-unmatched REST row (upc, style BP, color, size):
 *   1. Find ip_item_master candidates at (canon-style, size). canon-style tries
 *      the raw BP, then the BP with a trailing size-scale suffix stripped
 *      (RYB059530 -> RYB0595) when that base exists.
 *   2. Among those candidates, keep the ones whose canon-color == canon(REST
 *      color). Accept ONLY when exactly ONE candidate matches (unambiguous) —
 *      this scoping guards against a canon rule over-collapsing two real
 *      colorways (that would yield >1 hit and be skipped).
 *
 * Safe by construction: writes only 1:1 (style,size,color)-unique resolutions,
 * tagged source_method='canon_resolve_20260711'. Upsert on the unique upc, so
 * it never disturbs the exact-bootstrap rows unless it resolves the same upc to
 * the same sku (idempotent). Reads ip_item_master via anon REST; writes via the
 * Management API (SUPABASE_PAT).
 *
 *   node scripts/canon-resolve-upc.mjs            # dry-run
 *   node scripts/canon-resolve-upc.mjs --apply    # write PROD
 */
import { readFileSync, createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const SOURCE_METHOD = "canon_resolve_20260711";
const CSV = args.includes("--csv") ? args[args.indexOf("--csv") + 1]
  : "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/postAD_invrest_20260709211317.csv";

function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_ANON_KEY, PAT = env.SUPABASE_PAT;
if (!SB_URL || !ANON) { console.error("✗ URL/anon missing"); process.exit(1); }
if (APPLY && !PAT) { console.error("✗ --apply needs SUPABASE_PAT"); process.exit(1); }

const normSku = (s) => String(s || "").toUpperCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
// Canonical color token: strip non-alnum, fold well-known apparel abbreviations
// to a single canonical form. Order matters (longest variants first).
const ABBR = [["LIGHT", "LT"], ["MEDIUM", "MED"], ["MED", "MD"], ["DARK", "DK"], ["DRK", "DK"],
  ["BLACK", "BLK"], ["BLCK", "BLK"], ["GREY", "GRY"], ["GRAY", "GRY"], ["HEATHER", "HTHR"],
  ["CHARCOAL", "CHAR"], ["NATURAL", "NAT"], ["WHITE", "WHT"], ["BLUE", "BLU"], ["GREEN", "GRN"], ["BROWN", "BRN"]];
const canonColor = (s) => { let c = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); for (const [a, b] of ABBR) c = c.split(a).join(b); return c; };
const sqlLit = (v) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

async function loadIpm() {
  const bySku = new Set(), byStyleSize = new Map();
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/ip_item_master?select=id,sku_code,style_code,color,size&sku_code=not.is.null&limit=1000&offset=${off}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    const rows = await r.json(); if (!rows.length) break;
    for (const x of rows) {
      bySku.add(String(x.sku_code).toUpperCase());
      const k = `${(x.style_code || "").toUpperCase()}|${(x.size || "").toUpperCase()}`;
      if (!byStyleSize.has(k)) byStyleSize.set(k, []);
      byStyleSize.get(k).push({ color: x.color, id: x.id, style_code: x.style_code, size: x.size });
    }
    if (rows.length < 1000) break;
  }
  return { bySku, byStyleSize };
}
const stylesPresent = (byStyleSize) => { const s = new Set(); for (const k of byStyleSize.keys()) s.add(k.split("|")[0]); return s; };

const { bySku, byStyleSize } = await loadIpm();
const styleSet = stylesPresent(byStyleSize);
console.log(`# Mode: ${APPLY ? "APPLY (PROD)" : "DRY-RUN"}  | ipm sku_codes=${bySku.size} style|size groups=${byStyleSize.size}`);

function candidatesFor(bp, size) {
  const S = (bp || "").toUpperCase(), Z = (size || "").toUpperCase();
  let c = byStyleSize.get(`${S}|${Z}`);
  if (c && c.length) return c;
  // style-suffix strip: RYB059530 -> RYB0595 (trailing size-scale digits) if base exists
  const base = S.replace(/(\d{2})$/, "");
  if (base !== S && styleSet.has(base)) { c = byStyleSize.get(`${base}|${Z}`); if (c && c.length) return c; }
  return null;
}

const rl = createInterface({ input: createReadStream(CSV) });
let header = null, n = 0, idx = {};
const byUpc = new Map(); const conflict = new Set();
let unmatched = 0, resolved = 0, ambiguous = 0, noCand = 0, noColor = 0;
for await (const line of rl) {
  if (!header) { header = line.split(","); n = header.length; for (const c of ["Color", "Size", "ItemNumber", "BasePartNumber", "ItemUpc", "ItemDescription"]) idx[c] = header.indexOf(c); continue; }
  const cols = line.split(","); if (cols.length !== n) continue;
  const itemNum = cols[idx.ItemNumber], bp = cols[idx.BasePartNumber], color = cols[idx.Color], size = cols[idx.Size], upc = (cols[idx.ItemUpc] || "").trim(), desc = cols[idx.ItemDescription];
  if (!itemNum || bySku.has(normSku(itemNum))) continue;      // matched by exact bootstrap already
  if (!upc || !/^\d{6,}$/.test(upc)) continue;
  unmatched++;
  const cands = candidatesFor(bp, size);
  if (!cands) { noCand++; continue; }
  const cc = canonColor(color);
  const hits = cands.filter((x) => canonColor(x.color) === cc);
  if (hits.length !== 1) { if (hits.length > 1) ambiguous++; else noColor++; continue; }
  const h = hits[0];
  const prev = byUpc.get(upc);
  if (prev && prev.sku_id !== h.id) { conflict.add(upc); continue; }
  if (!prev) { resolved++; byUpc.set(upc, { upc, sku_id: h.id, style_no: h.style_code, color: h.color, size: h.size, description: desc }); }
}
for (const u of conflict) byUpc.delete(u);
const out = [...byUpc.values()];
console.log(`# unmatched(after bootstrap)=${unmatched}  resolved(unique)=${out.length}  ambiguous=${ambiguous}  no-color-hit=${noColor}  no-candidates=${noCand}  upc-conflicts=${conflict.size}`);
out.slice(0, 6).forEach((x) => console.log(`  ${x.upc} -> ${x.style_no} / ${x.color} / ${x.size}`));

if (!APPLY) { console.log(`\n# DRY-RUN — --apply to upsert ${out.length} canon-resolved rows.`); process.exit(0); }
async function mgmt(sql) { const r = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) }); if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json(); }
let w = 0;
for (let i = 0; i < out.length; i += 500) {
  const vals = out.slice(i, i + 500).map((x) => `(${sqlLit(x.upc)},${sqlLit(x.style_no)},${sqlLit(x.color)},${sqlLit(x.size)},${sqlLit(x.description)},${sqlLit(x.sku_id)}::uuid,${sqlLit(SOURCE_METHOD)})`).join(",");
  await mgmt(`INSERT INTO upc_item_master (upc,style_no,color,size,description,sku_id,source_method) VALUES ${vals} ON CONFLICT (upc) DO UPDATE SET sku_id=EXCLUDED.sku_id,style_no=EXCLUDED.style_no,color=EXCLUDED.color,size=EXCLUDED.size,description=EXCLUDED.description,source_method=EXCLUDED.source_method,updated_at=now();`);
  w += Math.min(500, out.length - i); console.log(`#   upserted ${w}/${out.length}`);
}
const [{ n: total }] = await mgmt(`select count(*)::int n from upc_item_master;`);
console.log(`\n# ✓ DONE. upc_item_master now ${total} rows.`);
