#!/usr/bin/env node
/**
 * scripts/retire-soldthrough.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Retire stale xoro_rest_size layers for NON-SPINE items that are CONFIRMED
 * sold-through — i.e. absent from the current Xoro-REST feed at their exact
 * (style, canonColor, canonSize) grain. Complements the spine phantom-clear /
 * on-hand sync (which handle spine-mapped items). Items that ARE in the current
 * REST feed but merely unmapped are EXCLUDED (coverage gaps, not phantom).
 *
 * SAFETY: only xoro_rest_size layers (native never touched); only REDUCES (to
 * 0); full pre-image reversal manifest before any write. An item is retired
 * ONLY if its (style, canonColor, canonSize) is NOT present anywhere in the
 * fresh REST CSV — the Xoro walk is complete, so absence = sold through.
 *
 *   node scripts/retire-soldthrough.mjs           # dry-run
 *   node scripts/retire-soldthrough.mjs --apply   # write PROD
 */
import { readFileSync, createReadStream, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
function newestCsv() {
  if (process.argv.includes("--csv")) return process.argv[process.argv.indexOf("--csv") + 1];
  const dir = process.argv.includes("--rest-dir") ? process.argv[process.argv.indexOf("--rest-dir") + 1] : "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs";
  const files = readdirSync(dir).filter((f) => /^postAD_invrest_.*\.csv$/.test(f)).sort();
  if (!files.length) throw new Error(`no postAD_invrest_*.csv in ${dir}`);
  return join(dir, files[files.length - 1]);
}
const CSV = newestCsv();
function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_ANON_KEY, PAT = env.SUPABASE_PAT;
if (!SB_URL || !ANON || !PAT) { console.error("✗ need URL + anon + SUPABASE_PAT"); process.exit(1); }
function pcsv(l) { const o = []; let c = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else { if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; } } o.push(c); return o; }
async function anonAll(t, s) { const o = []; for (let off = 0; ; off += 1000) { const r = await fetch(`${SB_URL}/rest/v1/${t}?select=${s}&limit=1000&offset=${off}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }); const rows = await r.json(); if (!rows.length) break; o.push(...rows); if (rows.length < 1000) break; } return o; }
async function mgmt(sql) { const r = await fetch(`https://api.supabase.com/v1/projects/qcvqvxxoperiurauoxmp/database/query`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) }); if (!r.ok) throw new Error(await r.text()); return r.json(); }
const sqlLit = (v) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const cS = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const ABBR = [["LIGHT", "LT"], ["MEDIUM", "MED"], ["MED", "MD"], ["DARK", "DK"], ["DRK", "DK"], ["BLACK", "BLK"], ["BLCK", "BLK"], ["GREY", "GRY"], ["GRAY", "GRY"], ["HEATHER", "HTHR"], ["CHARCOAL", "CHAR"], ["NATURAL", "NAT"], ["WHITE", "WHT"], ["BLUE", "BLU"], ["GREEN", "GRN"], ["BROWN", "BRN"]];
const cC = (s) => { let c = String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); for (const [a, b] of ABBR) c = c.split(a).join(b); return c; };

const spine = new Set((await anonAll("upc_item_master", "sku_id")).map(r => r.sku_id).filter(Boolean));
const restGrain = new Set();
{ const rl = createInterface({ input: createReadStream(CSV) }); let hd = null, ix = {}; for await (const line of rl) { if (!hd) { hd = pcsv(line); for (const c of ["BasePartNumber", "Color", "Size", "OnHandQty"]) ix[c] = hd.indexOf(c); continue; } const cols = pcsv(line); if (cols.length !== hd.length) continue; const q = parseFloat(cols[ix.OnHandQty] || 0) || 0; if (q <= 0) continue; const bp = (cols[ix.BasePartNumber] || "").toUpperCase(); restGrain.add(`${bp}|${cC(cols[ix.Color])}|${cS(cols[ix.Size])}`); } }
const ipm = new Map((await anonAll("ip_item_master?sku_code=not.is.null", "id,style_id,color,size")).map(r => [r.id, r]));
const sm = new Map((await anonAll("style_master?style_code=not.is.null", "id,style_code")).map(r => [r.id, String(r.style_code).toUpperCase()]));
// per-item xoro_rest_size on-hand
const rest = await mgmt(`select item_id::text item, round(sum(remaining_qty))::int q from inventory_layers where source_kind='xoro_rest_size' and remaining_qty>0 group by item_id;`);

const targets = [];  // items to retire (non-spine, sold-through, has rest layers)
let excludedInRest = 0, excludedInRestU = 0;
for (const { item, q } of rest) {
  if (spine.has(item)) continue;                    // spine handled elsewhere
  const im = ipm.get(item); if (!im) continue;
  const grain = `${sm.get(im.style_id) || ""}|${cC(im.color)}|${cS(im.size)}`;
  if (restGrain.has(grain)) { excludedInRest++; excludedInRestU += q; continue; } // in Xoro -> keep
  targets.push({ item, q });
}
const retireU = targets.reduce((s, t) => s + t.q, 0);
console.log(`# Mode: ${APPLY ? "APPLY" : "DRY-RUN"} | CSV: ${CSV.split(/[\\/]/).pop()}`);
console.log(`# non-spine sold-through items to RETIRE: ${targets.length} / ${retireU.toLocaleString()} u`);
console.log(`# EXCLUDED (non-spine but IN current Xoro feed — coverage gaps): ${excludedInRest} items / ${excludedInRestU.toLocaleString()} u`);
if (!APPLY) { console.log(`\n# DRY-RUN — no writes. --apply would zero ${retireU.toLocaleString()} u of confirmed sold-through xoro_rest_size layers.`); process.exit(0); }

const itemIds = targets.map(t => t.item);
const updates = [];
for (let i = 0; i < itemIds.length; i += 200) {
  const chunk = itemIds.slice(i, i + 200);
  const rows = await mgmt(`select id::text, item_id::text, remaining_qty::numeric q from inventory_layers where source_kind='xoro_rest_size' and remaining_qty>0 and item_id in (${chunk.map(sqlLit).join(",")});`);
  for (const r of rows) updates.push({ id: r.id, item: r.item_id, old: Number(r.q), new: 0 });
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const manifestPath = `C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/retire-soldthrough-reversal-${stamp}.json`;
writeFileSync(manifestPath, JSON.stringify({ created_at: new Date().toISOString(), csv: CSV, units_retired: retireU, updates }, null, 2));
console.log(`\n# reversal manifest: ${manifestPath} (${updates.length} layers). Reverse = restore each 'old'.`);
let done = 0;
for (let i = 0; i < updates.length; i += 500) {
  const chunk = updates.slice(i, i + 500);
  await mgmt(`update inventory_layers il set remaining_qty = 0 where il.id in (${chunk.map(u => sqlLit(u.id) + "::uuid").join(",")});`);
  done += chunk.length; console.log(`#   zeroed ${done}/${updates.length}`);
}
const [{ t }] = await mgmt(`select round(sum(remaining_qty))::int t from inventory_layers where remaining_qty>0;`);
console.log(`\n# ✓ DONE. retired ${retireU.toLocaleString()} u across ${updates.length} layers. inventory_layers total now ${t.toLocaleString()}.`);
