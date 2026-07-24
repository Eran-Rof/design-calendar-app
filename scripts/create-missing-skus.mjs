#!/usr/bin/env node
/**
 * scripts/create-missing-skus.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Step 2 of the identity-spine coverage effort: create the genuinely-new items
 * that carry live Xoro on-hand but are missing from ip_item_master, then map
 * their UPC into upc_item_master. DRY-RUN lists exactly what it would create.
 *
 * SAFETY / dedup (avoids re-fragmenting the catalog):
 *   - Identity + sku_code = normalized REST ItemNumber (clean even when the
 *     Color field is comma/paren-corrupted). Skip if that sku_code already
 *     exists, or if canonical (style, canonColor, canonSize) already exists.
 *   - Only create when the STYLE already exists in style_master (matches the
 *     cutover's rule: never invent styles here). PPK / PL / style-absent rows
 *     are BUCKETED and skipped — they need the pack-twin architecture.
 *   - Rows whose Color field is corrupted (contains '(' or ',' or a trailing
 *     size token) are BUCKETED for review, not created, until the clean
 *     ItemNumber-parse is confirmed — no guessing color/size boundaries.
 *   - Creation (on --apply) reuses styleMatrix.resolveOrCreateSku(isApparel:
 *     false), the same path the cutover uses, so dims/CHECK are satisfied.
 *
 *   node scripts/create-missing-skus.mjs           # dry-run (list only)
 *   node scripts/create-missing-skus.mjs --apply   # create + map UPCs
 */
import { readFileSync, createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const ROF = "404b8a6b-0d2d-44d2-8539-9064ff0fafee";
const CSV = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/postAD_invrest_20260709211317.csv";
function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_ANON_KEY;

function pcsv(line) { const o = []; let c = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else { if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; } } o.push(c); return o; }
const normSku = (s) => String(s || "").toUpperCase().replace(/[()]/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const ABBR = [["LIGHT", "LT"], ["MEDIUM", "MED"], ["MED", "MD"], ["DARK", "DK"], ["DRK", "DK"], ["BLACK", "BLK"], ["BLCK", "BLK"], ["GREY", "GRY"], ["GRAY", "GRY"], ["HEATHER", "HTHR"], ["CHARCOAL", "CHAR"], ["NATURAL", "NAT"], ["WHITE", "WHT"], ["BLUE", "BLU"], ["GREEN", "GRN"], ["BROWN", "BRN"]];
const cColor = (s) => { let c = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); for (const [a, b] of ABBR) c = c.split(a).join(b); return c; };
const cSize = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const SIZE_TOKENS = /-(SML|MED|LRG|XLG|XSM|XXL|2XL|3XL|XS|S|M|L|XL)$/i;
const isColorCorrupted = (color) => /[(),]/.test(color) || SIZE_TOKENS.test(color || "");

async function fetchAll(table, select) { const out = []; for (let off = 0; ; off += 1000) { const r = await fetch(`${SB_URL}/rest/v1/${table}?select=${select}&limit=1000&offset=${off}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }); const rows = await r.json(); if (!rows.length) break; out.push(...rows); if (rows.length < 1000) break; } return out; }

const ipm = await fetchAll("ip_item_master?sku_code=not.is.null", "sku_code,style_code,color,size");
const bySku = new Set(ipm.map((x) => String(x.sku_code).toUpperCase()));
const grain = new Set(ipm.map((x) => `${(x.style_code || "").toUpperCase()}|${cColor(x.color)}|${cSize(x.size)}`));
const sm = await fetchAll("style_master?style_code=not.is.null", "style_code");
const styleSet = new Set(sm.map((x) => String(x.style_code).toUpperCase()));
// Already-mapped UPCs (in the spine) — only work the remaining unmapped tail.
const mappedUpcs = new Set((await fetchAll("upc_item_master", "upc")).map((x) => x.upc));
console.log(`# Mode: ${APPLY ? "APPLY" : "DRY-RUN"} | ipm skus=${bySku.size} styles=${styleSet.size} mapped-upcs=${mappedUpcs.size}`);

const rl = createInterface({ input: createReadStream(CSV) });
let hd = null, ix = {};
const create = new Map();     // canonicalGrain -> {style,color,size,sku,upc,units,desc}
const ppkBucket = new Map(), corruptBucket = new Map();
let seen = 0;
for await (const line of rl) {
  if (!hd) { hd = pcsv(line); for (const c of ["Color", "Size", "ItemNumber", "BasePartNumber", "ItemUpc", "OnHandQty", "ItemDescription"]) ix[c] = hd.indexOf(c); continue; }
  const cols = pcsv(line); if (cols.length !== hd.length) continue;
  const itemNum = cols[ix.ItemNumber], bp = (cols[ix.BasePartNumber] || "").toUpperCase(), color = cols[ix.Color], size = cols[ix.Size], upc = (cols[ix.ItemUpc] || "").trim(), desc = cols[ix.ItemDescription];
  const q = parseFloat(cols[ix.OnHandQty] || 0) || 0;
  if (!itemNum || q <= 0 || !/^\d{6,}$/.test(upc)) continue;
  if (mappedUpcs.has(upc)) continue;                             // already in the spine
  const sku = normSku(itemNum);
  const g = `${bp}|${cColor(color)}|${cSize(size)}`;
  seen++;
  // Resolve the style (raw or size-scale-suffix-stripped, e.g. DMB001330 ->
  // DMB0013). No style in style_master -> defer (PPK/PL need the pack-twin pass).
  const styleKey = styleSet.has(bp) ? bp : (styleSet.has(bp.replace(/(\d{2})$/, "")) ? bp.replace(/(\d{2})$/, "") : null);
  if (!styleKey) { const e = ppkBucket.get(bp) || { u: 0, desc }; e.u += q; ppkBucket.set(bp, e); continue; }
  // Clean color/size: when the Size field is empty and the Color carries a
  // trailing size token (corruption: "Falcon-LRG"), split it out.
  let realColor = color, realSize = size;
  if (!String(realSize).trim()) {
    const m = String(color).match(/^(.*)-(SML|MED|LRG|XLG|XSM|XXL|2XL|3XL|XS|S|M|L|XL)$/i);
    if (m) { realColor = m[1].trim(); realSize = m[2]; }
  }
  if (!String(realSize).trim()) { const k = `${bp} / ${color}`; const e = corruptBucket.get(k) || { u: 0 }; e.u += q; corruptBucket.set(k, e); continue; } // no size -> review
  // NOTE: no grain-skip — route grain-existing rows through resolveOrCreateSku
  // too; it REUSES the existing SKU (deterministic on spelling dups like the RYA
  // Black/Gray vs Black-Gray fragmentation) and maps the UPC.
  const e = create.get(g) || { style: styleKey, color: realColor, size: realSize, sku, upc, units: 0, desc };
  e.units += q; create.set(g, e);
}
const list = [...create.values()].sort((a, b) => b.units - a.units);
console.log(`\n# ===== STEP-2 candidates =====`);
console.log(`#   CREATE (style exists, clean color/size, genuinely-new): ${list.length} SKUs / ${Math.round(list.reduce((s, x) => s + x.units, 0)).toLocaleString()} u`);
console.log(`#   BUCKET ppk/absent-style (needs pack-twin, deferred):     ${[...ppkBucket.values()].reduce((s, x) => s + x.u, 0).toLocaleString()} u / ${ppkBucket.size} styles`);
console.log(`#   BUCKET color-corrupted (needs ItemNumber parse review):  ${Math.round([...corruptBucket.values()].reduce((s, x) => s + x.u, 0)).toLocaleString()} u / ${corruptBucket.size} lines`);
console.log(`\n# top 30 SKUs to CREATE (style / color / size / units):`);
list.slice(0, 30).forEach((x) => console.log(`  ${x.style} / ${x.color} / ${x.size}  (${Math.round(x.units).toLocaleString()}u)  sku=${x.sku}`));
console.log(`\n# ppk/absent-style bucket:`); [...ppkBucket.entries()].sort((a, b) => b[1].u - a[1].u).slice(0, 12).forEach(([k, v]) => console.log(`  ${k}  ${Math.round(v.u).toLocaleString()}u  "${v.desc}"`));

if (!APPLY) { console.log(`\n# DRY-RUN — no writes. --apply would create the ${list.length} CREATE SKUs (isApparel:false) + map their UPCs.`); process.exit(0); }

// ── APPLY ── create via the cutover's own safe helper (reuses canonically →
// never forks a duplicate) + map each UPC into upc_item_master.
const PAT = env.SUPABASE_PAT;
if (!PAT) { console.error("✗ --apply needs SUPABASE_PAT"); process.exit(1); }
const LIMIT = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : Infinity;
const keyRes = await fetch(`https://api.supabase.com/v1/projects/qcvqvxxoperiurauoxmp/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${PAT}` } });
const keys = await keyRes.json();
const serviceKey = (keys.find?.((k) => k.name === "service_role") || {}).api_key;
if (!serviceKey) { console.error("✗ could not resolve service_role key from Management API:", JSON.stringify(keys).slice(0, 200)); process.exit(1); }
const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(SB_URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { resolveOrCreateSku } = await import("../api/_lib/styleMatrix.js");
const smRows = await fetchAll("style_master?style_code=not.is.null", "id,style_code");
const smById = new Map(smRows.map((r) => [String(r.style_code).toUpperCase(), r.id]));

let created = 0, reused = 0, failed = 0, mapped = 0;
const toApply = list.slice(0, LIMIT);
console.log(`\n# APPLY: processing ${toApply.length} candidate SKU(s)…`);
for (const x of toApply) {
  const style_id = smById.get(x.style.toUpperCase());
  if (!style_id) { failed++; console.warn(`  no style_id for ${x.style}`); continue; }
  const r = await resolveOrCreateSku(admin, ROF, { style_id, style_code: x.style, color: x.color, size: x.size }, { isApparel: false , source: "create_missing_skus" });
  if (r.error || !r.id) { failed++; console.warn(`  create failed ${x.style}/${x.color}/${x.size}: ${r.error}`); continue; }
  if (r.created) created++; else reused++;
  const { error: upErr } = await admin.from("upc_item_master").upsert(
    { upc: x.upc, style_no: x.style, color: x.color, size: x.size, description: x.desc || "", sku_id: r.id, source_method: "step2_create_20260711" },
    { onConflict: "upc" });
  if (!upErr) mapped++; else console.warn(`  upc map failed ${x.upc}: ${upErr.message}`);
  console.log(`  ${r.created ? "CREATED" : "reused "} ${x.style} / ${x.color} / ${x.size} -> ${r.id.slice(0, 8)}`);
}
console.log(`\n# DONE: created=${created} reused=${reused} failed=${failed} upc_mapped=${mapped}`);
