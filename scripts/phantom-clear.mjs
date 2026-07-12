#!/usr/bin/env node
/**
 * scripts/phantom-clear.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Step 3 of the Tangerine⇄Xoro on-hand reconciliation: retire the STALE
 * xoro_rest_size layers so Tangerine on-hand ties to the live Xoro-REST feed.
 * Xoro sales don't deplete native xoro_rest_size layers, so sold-through items
 * keep phantom stock until rebuilt — this trues them up per item via the UPC
 * spine (exact identity), reversibly.
 *
 * SAFETY:
 *   - Only items PRESENT IN THE SPINE (upc_item_master) are touched. Unmapped
 *     items (we can't confirm their Xoro on-hand) are EXCLUDED — never zeroed.
 *   - Only source_kind='xoro_rest_size' layers are reduced. Native layers
 *     (opening_balance / receipts / adjustments / transfers) are NEVER touched.
 *   - Target xoro_rest_size = max(0, Xoro-REST_onhand - native_onhand). Reduce
 *     the item's rest layers to that, oldest-first. Only REDUCES (never adds).
 *   - Full pre-image (layer id + old remaining_qty) written to a reversal
 *     manifest before any write.
 *
 * Xoro-REST on-hand = the raw REST inventory CSV, summed by sku_id via the spine.
 *
 *   node scripts/phantom-clear.mjs            # dry-run
 *   node scripts/phantom-clear.mjs --apply    # write PROD (+ reversal manifest)
 */
import { readFileSync, createReadStream, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const CSV = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/postAD_invrest_20260709211317.csv";
function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_ANON_KEY, PAT = env.SUPABASE_PAT;
if (!SB_URL || !ANON || !PAT) { console.error("✗ need URL + anon + SUPABASE_PAT"); process.exit(1); }
function pcsv(l) { const o = []; let c = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else { if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; } } o.push(c); return o; }
async function anonAll(table, select) { const out = []; for (let off = 0; ; off += 1000) { const r = await fetch(`${SB_URL}/rest/v1/${table}?select=${select}&limit=1000&offset=${off}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }); const rows = await r.json(); if (!rows.length) break; out.push(...rows); if (rows.length < 1000) break; } return out; }
async function mgmt(sql) { const r = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) }); if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json(); }
const sqlLit = (v) => `'${String(v).replace(/'/g, "''")}'`;

const normSku = (s) => String(s || "").toUpperCase().replace(/[()]/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
// 1) spine: upc -> sku_id  (and the set of spine-covered sku_ids)
const upcMap = new Map((await anonAll("upc_item_master", "upc,sku_id")).filter(r => r.sku_id).map(r => [r.upc, r.sku_id]));
const spineSkus = new Set(upcMap.values());
// ip_item_master id -> upper(sku_code), to test "is this item present in the REST feed at all".
const skuCodeById = new Map((await anonAll("ip_item_master?sku_code=not.is.null", "id,sku_code")).map(r => [r.id, String(r.sku_code).toUpperCase()]));
// 2) Xoro-REST on-hand by sku_id (via spine) + the set of REST sku_codes present.
const xoroBySku = new Map();
const restSkuCodes = new Set();
{
  const rl = createInterface({ input: createReadStream(CSV) }); let hd = null, ix = {};
  for await (const line of rl) { if (!hd) { hd = pcsv(line); for (const c of ["ItemUpc", "OnHandQty", "ItemNumber"]) ix[c] = hd.indexOf(c); continue; } const cols = pcsv(line); if (cols.length !== hd.length) continue; const upc = (cols[ix.ItemUpc] || "").trim(); const q = parseFloat(cols[ix.OnHandQty] || 0) || 0; if (q <= 0 || !/^\d{6,}$/.test(upc)) continue; if (cols[ix.ItemNumber]) restSkuCodes.add(normSku(cols[ix.ItemNumber])); const sku = upcMap.get(upc); if (!sku) continue; xoroBySku.set(sku, (xoroBySku.get(sku) || 0) + q); }
}
// 3) layers by item + source_kind (Mgmt API)
const layerRows = await mgmt(`select item_id::text, source_kind, round(sum(remaining_qty))::numeric q from inventory_layers where remaining_qty>0 group by item_id, source_kind;`);
const byItem = new Map();
for (const r of layerRows) { const e = byItem.get(r.item_id) || { rest: 0, native: 0, total: 0 }; const q = Number(r.q); if (r.source_kind === "xoro_rest_size") e.rest += q; else e.native += q; e.total += q; byItem.set(r.item_id, e); }

// 4) Plan — SPINE-MAPPED ITEMS ONLY (exact Xoro on-hand via UPC). Non-spine
// items are EXCLUDED: the "sku_code not in REST feed" test is unreliable (same
// format mismatches that block mapping), so a sold-through vs unmapped-real
// call can't be made safely — never risk zeroing real stock. Those clear only
// after coverage reaches ~100% (or a live per-item Xoro check).
let items = 0, unitsRetire = 0, fullySold = 0, excludedNonSpine = 0, excludedNonSpineUnits = 0;
const plan = [];
for (const [item, e] of byItem) {
  if (!spineSkus.has(item)) { if (e.total > 0) { excludedNonSpine++; excludedNonSpineUnits += e.total; } continue; }
  const xoro = xoroBySku.get(item) || 0;                      // exact, via spine
  const targetRest = Math.max(0, xoro - e.native);
  const reduceBy = e.rest - targetRest;
  if (reduceBy <= 0) continue;
  items++; unitsRetire += reduceBy; if (xoro === 0) fullySold++;
  plan.push({ item, xoro, rest: e.rest, native: e.native, targetRest, reduceBy, cls: "trueup" });
}
plan.sort((a, b) => b.reduceBy - a.reduceBy);
const layersTotal = layerRows.reduce((s, r) => s + Number(r.q), 0);
const xoroTotal = [...xoroBySku.values()].reduce((s, v) => s + v, 0);

console.log(`# Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`# spine skus=${spineSkus.size} | layers items=${byItem.size} | Xoro-REST(spine) total=${Math.round(xoroTotal).toLocaleString()} | layers total=${Math.round(layersTotal).toLocaleString()}`);
console.log(`\n# ===== PHANTOM CLEAR PLAN =====`);
console.log(`#   spine items to true-up:         ${items}`);
console.log(`#   xoro_rest_size units to RETIRE: ${Math.round(unitsRetire).toLocaleString()}`);
console.log(`#     fully sold-through (Xoro=0):  ${fullySold} items`);
console.log(`#   EXCLUDED (non-spine, untouched — need coverage/live check): ${excludedNonSpine} items / ${Math.round(excludedNonSpineUnits).toLocaleString()} u`);
console.log(`#   projected layers total after: ${Math.round(layersTotal - unitsRetire).toLocaleString()}  (Xoro-REST spine total ${Math.round(xoroTotal).toLocaleString()})`);
console.log(`\n# top 20 items to true-up (item | class | Xoro | rest | native | -> retire):`);
plan.slice(0, 20).forEach((p) => console.log(`  ${p.item.slice(0, 8)}  ${p.cls}  xoro=${p.xoro}  rest=${p.rest}  native=${p.native}  retire=${Math.round(p.reduceBy)}`));

if (!APPLY) { console.log(`\n# DRY-RUN — no writes. --apply would retire ${Math.round(unitsRetire).toLocaleString()} u of xoro_rest_size layers (reversal manifest saved).`); process.exit(0); }

// ── APPLY ── reduce each item's xoro_rest_size layers to targetRest, oldest-first
// (matches FIFO depletion), with a full pre-image reversal manifest written FIRST.
const planItems = plan.map((p) => p.item);
const layerData = [];
for (let i = 0; i < planItems.length; i += 200) {
  const chunk = planItems.slice(i, i + 200);
  const rows = await mgmt(`select id::text, item_id::text, remaining_qty::numeric q, received_at::text from inventory_layers where source_kind='xoro_rest_size' and remaining_qty>0 and item_id in (${chunk.map(sqlLit).join(",")}) order by item_id, received_at asc nulls first;`);
  layerData.push(...rows);
}
const layersByItem = new Map();
for (const l of layerData) { if (!layersByItem.has(l.item_id)) layersByItem.set(l.item_id, []); layersByItem.get(l.item_id).push(l); }
const updates = [];  // {id, old, new}
for (const p of plan) {
  let toRemove = p.reduceBy;
  for (const l of (layersByItem.get(p.item) || [])) {
    if (toRemove <= 0.0001) break;
    const cur = Number(l.q);
    const take = Math.min(cur, toRemove);
    updates.push({ id: l.id, item: p.item, old: cur, new: cur - take });
    toRemove -= take;
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const manifestPath = `C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/phantom-clear-reversal-${stamp}.json`;
writeFileSync(manifestPath, JSON.stringify({ created_at: new Date().toISOString(), csv: CSV, units_retired: Math.round(unitsRetire), items: plan.length, updates }, null, 2));
console.log(`\n# reversal manifest: ${manifestPath} (${updates.length} layer updates)`);
console.log(`# To REVERSE: set each layer's remaining_qty back to 'old'.`);

let done = 0;
for (let i = 0; i < updates.length; i += 500) {
  const chunk = updates.slice(i, i + 500);
  const vals = chunk.map((u) => `(${sqlLit(u.id)}::uuid, ${u.new}::numeric)`).join(",");
  await mgmt(`update inventory_layers il set remaining_qty = v.q from (values ${vals}) v(id, q) where il.id = v.id;`);
  done += chunk.length; console.log(`#   updated ${done}/${updates.length} layers`);
}
const [{ t }] = await mgmt(`select round(sum(remaining_qty))::int t from inventory_layers where remaining_qty>0;`);
console.log(`\n# ✓ DONE. retired ${Math.round(unitsRetire).toLocaleString()} u across ${updates.length} layers. inventory_layers total now ${t.toLocaleString()}.`);
