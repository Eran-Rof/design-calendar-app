#!/usr/bin/env node
/**
 * scripts/resolve-upc-spine.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Unified, RFC-CSV-correct rebuild of the UPC identity spine (upc_item_master),
 * superseding bootstrap-upc-item-master.mjs (#1682) + canon-resolve-upc.mjs
 * (#1683): those used a naive comma split that dropped ~1,570 quoted-field REST
 * rows. This parses quoted fields correctly, then resolves each REST row's UPC
 * to an ip_item_master.sku_id by EXACT (normalized ItemNumber -> sku_code) and,
 * failing that, by CANONICALIZATION (candidates at canon-style+size, unique
 * canon-color match). Upserts on the unique upc (additive + idempotent).
 *
 * Coverage matters because the phantom-clear (Phase-3) is UNSAFE until every
 * current-REST item is mapped: an unmapped item that actually has Xoro on-hand
 * would otherwise be mistaken for sold-through and wrongly zeroed.
 *
 *   node scripts/resolve-upc-spine.mjs            # dry-run
 *   node scripts/resolve-upc-spine.mjs --apply    # write PROD
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
const SOURCE = "resolve_upc_spine_20260711";
const CSV = args.includes("--csv") ? args[args.indexOf("--csv") + 1]
  : "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/postAD_invrest_20260709211317.csv";

function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_ANON_KEY, PAT = env.SUPABASE_PAT;
if (!SB_URL || !ANON) { console.error("✗ URL/anon missing"); process.exit(1); }
if (APPLY && !PAT) { console.error("✗ --apply needs SUPABASE_PAT"); process.exit(1); }

// RFC-4180-ish line parser: handles "quoted, fields" with embedded commas + "" escapes.
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  }
  out.push(cur); return out;
}
// Parens -> dash so kids age-range ItemNumbers match ip_item_master sku_codes
// (REST "...-XS(5-6)" vs ipm "...-XS-5-6"). The ItemNumber is clean even when
// the Color field carries the comma-corrupted "XS(5,6)".
const normSku = (s) => String(s || "").toUpperCase().replace(/[()]/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const ABBR = [["LIGHT", "LT"], ["MEDIUM", "MED"], ["MED", "MD"], ["DARK", "DK"], ["DRK", "DK"], ["BLACK", "BLK"], ["BLCK", "BLK"], ["GREY", "GRY"], ["GRAY", "GRY"], ["HEATHER", "HTHR"], ["CHARCOAL", "CHAR"], ["NATURAL", "NAT"], ["WHITE", "WHT"], ["BLUE", "BLU"], ["GREEN", "GRN"], ["BROWN", "BRN"]];
const canonColor = (s) => { let c = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); for (const [a, b] of ABBR) c = c.split(a).join(b); return c; };
// Canonical size token: strip non-alnum so kids age-ranges match across the
// comma/dash formats (REST "XS(5,6)" vs ip_item_master "XS(5-6)" -> "XS56").
const canonSize = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const sqlLit = (v) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

async function loadIpm() {
  const bySku = new Map(), byStyleSize = new Map(), styleSet = new Set();
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/ip_item_master?select=id,sku_code,style_code,color,size&sku_code=not.is.null&limit=1000&offset=${off}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    const rows = await r.json(); if (!rows.length) break;
    for (const x of rows) {
      const k = String(x.sku_code).toUpperCase();
      if (!bySku.has(k)) bySku.set(k, { id: x.id, style_code: x.style_code, color: x.color, size: x.size });
      const gk = `${(x.style_code || "").toUpperCase()}|${canonSize(x.size)}`;
      if (!byStyleSize.has(gk)) byStyleSize.set(gk, []);
      byStyleSize.get(gk).push({ color: x.color, id: x.id, style_code: x.style_code, size: x.size });
      styleSet.add((x.style_code || "").toUpperCase());
    }
    if (rows.length < 1000) break;
  }
  return { bySku, byStyleSize, styleSet };
}

const { bySku, byStyleSize, styleSet } = await loadIpm();
console.log(`# Mode: ${APPLY ? "APPLY" : "DRY-RUN"} | ipm sku=${bySku.size} groups=${byStyleSize.size}`);
function candidates(bp, size) {
  const S = (bp || "").toUpperCase(), Z = canonSize(size);
  let c = byStyleSize.get(`${S}|${Z}`); if (c) return c;
  const base = S.replace(/(\d{2})$/, "");
  if (base !== S && styleSet.has(base)) { c = byStyleSize.get(`${base}|${Z}`); if (c) return c; }
  return null;
}

const rl = createInterface({ input: createReadStream(CSV) });
let header = null, idx = {};
const byUpc = new Map(); const conflict = new Set();
let rows = 0, exact = 0, canon = 0, noUpc = 0, unresolved = 0;
for await (const line of rl) {
  if (!header) { header = parseCsvLine(line); for (const c of ["Color", "Size", "ItemNumber", "BasePartNumber", "ItemUpc", "ItemDescription"]) idx[c] = header.indexOf(c); continue; }
  const cols = parseCsvLine(line); if (cols.length !== header.length) continue;
  const itemNum = cols[idx.ItemNumber], bp = cols[idx.BasePartNumber], color = cols[idx.Color], size = cols[idx.Size], upc = (cols[idx.ItemUpc] || "").trim(), desc = cols[idx.ItemDescription];
  if (!itemNum) continue;
  if (!upc || !/^\d{6,}$/.test(upc)) { noUpc++; continue; }
  rows++;
  let hit = bySku.get(normSku(itemNum)); let via = "exact";
  if (!hit) {
    const cands = candidates(bp, size);
    if (cands) { const cc = canonColor(color); const m = cands.filter((x) => canonColor(x.color) === cc); if (m.length === 1) { hit = m[0]; via = "canon"; } }
  }
  if (!hit) { unresolved++; continue; }
  if (via === "exact") exact++; else canon++;
  const prev = byUpc.get(upc);
  if (prev && prev.sku_id !== hit.id) { conflict.add(upc); continue; }
  // upc_item_master.style_no/color/size are NOT NULL — coalesce to the REST
  // value then '' for non-sized / null-attribute ip_item_master rows.
  if (!prev) byUpc.set(upc, { upc, sku_id: hit.id, style_no: hit.style_code ?? bp ?? "", color: hit.color ?? color ?? "", size: hit.size ?? size ?? "", description: desc });
}
for (const u of conflict) byUpc.delete(u);
const out = [...byUpc.values()];
console.log(`# rows=${rows} exact=${exact} canon=${canon} unresolved=${unresolved} noUpc=${noUpc} conflicts=${conflict.size} => upserts=${out.length}`);

if (!APPLY) { console.log(`# DRY-RUN — --apply to upsert ${out.length}.`); process.exit(0); }
async function mgmt(sql) { const r = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) }); if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json(); }
let w = 0;
for (let i = 0; i < out.length; i += 500) {
  const vals = out.slice(i, i + 500).map((x) => `(${sqlLit(x.upc)},${sqlLit(x.style_no)},${sqlLit(x.color)},${sqlLit(x.size)},${sqlLit(x.description)},${sqlLit(x.sku_id)}::uuid,${sqlLit(SOURCE)})`).join(",");
  await mgmt(`INSERT INTO upc_item_master (upc,style_no,color,size,description,sku_id,source_method) VALUES ${vals} ON CONFLICT (upc) DO UPDATE SET sku_id=EXCLUDED.sku_id,style_no=EXCLUDED.style_no,color=EXCLUDED.color,size=EXCLUDED.size,description=EXCLUDED.description,source_method=EXCLUDED.source_method,updated_at=now();`);
  w += Math.min(500, out.length - i); console.log(`#   upserted ${w}/${out.length}`);
}
const [{ n }] = await mgmt(`select count(*)::int n from upc_item_master;`);
console.log(`# ✓ DONE. upc_item_master now ${n} rows.`);
