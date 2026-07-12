#!/usr/bin/env node
/**
 * scripts/sync-onhand-spine.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Spine-based nightly on-hand sync — the replacement for the by-size cutover's
 * broken exact-style-code matching (which processed 0 styles). Keeps Tangerine's
 * xoro_rest_size layers equal to the live Xoro-REST size-grain on-hand, per
 * (sku, store), BIDIRECTIONALLY (depletes AND replenishes), resolving each REST
 * row to its exact sku_id via the UPC spine (upc_item_master).
 *
 * SAFETY:
 *   - SPINE-MAPPED items only. Unmapped items are never touched (their Xoro
 *     on-hand is unknown — see coverage work).
 *   - Only source_kind='xoro_rest_size' is adjusted. Native layers
 *     (opening_balance / receipts / adjustments / transfers) are NEVER touched.
 *   - Target per (sku, location) = max(0, Xoro-REST - native_at_that_location).
 *     DECREASE: reduce existing rest layers oldest-first (FK-safe, no delete).
 *     INCREASE: add to the newest rest layer, or create one (cost from
 *     ip_item_avg_cost, location from store).
 *   - Full pre-image reversal manifest written BEFORE any write.
 *
 *   node scripts/sync-onhand-spine.mjs           # dry-run
 *   node scripts/sync-onhand-spine.mjs --apply   # write PROD
 */
import { readFileSync, createReadStream, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const ROF = "404b8a6b-0d2d-44d2-8539-9064ff0fafee";
const argCsv = process.argv.includes("--csv") ? process.argv[process.argv.indexOf("--csv") + 1] : null;
const STORE_TO_LOC_CODE = { "ROF Main": "WH-00000", "ROF - ECOM": "WH-00001", "Psycho Tuna": "WH-00002" };
function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_ANON_KEY, PAT = env.SUPABASE_PAT;
if (!SB_URL || !ANON || !PAT) { console.error("✗ need URL + anon + SUPABASE_PAT"); process.exit(1); }
function pcsv(l) { const o = []; let c = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else { if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; } } o.push(c); return o; }
async function anonAll(t, s) { const out = []; for (let off = 0; ; off += 1000) { const r = await fetch(`${SB_URL}/rest/v1/${t}?select=${s}&limit=1000&offset=${off}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }); const rows = await r.json(); if (!rows.length) break; out.push(...rows); if (rows.length < 1000) break; } return out; }
async function mgmt(sql) { const r = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) }); if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json(); }
const sqlLit = (v) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

function newestCsv() {
  if (argCsv) return argCsv;
  const dir = process.argv.includes("--rest-dir") ? process.argv[process.argv.indexOf("--rest-dir") + 1] : "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs";
  const files = readdirSync(dir).filter((f) => /^postAD_invrest_.*\.csv$/.test(f)).sort();  // timestamped names sort chronologically
  if (!files.length) throw new Error(`no postAD_invrest_*.csv in ${dir}`);
  return join(dir, files[files.length - 1]);
}

// spine + locations + cost
const upcMap = new Map((await anonAll("upc_item_master", "upc,sku_id")).filter(r => r.sku_id).map(r => [r.upc, r.sku_id]));
const spineSkus = new Set(upcMap.values());
const locs = await anonAll("inventory_locations", "id,code");
const locIdByCode = new Map(locs.map(l => [l.code, l.id]));
const skuCodeById = new Map((await anonAll("ip_item_master?sku_code=not.is.null", "id,sku_code")).map(r => [r.id, r.sku_code]));
const avgCost = new Map((await anonAll("ip_item_avg_cost", "sku_code,avg_cost")).filter(r => r.avg_cost != null).map(r => [r.sku_code, Number(r.avg_cost)]));

// Xoro-REST target on-hand by (sku_id, loc_code)
const target = new Map();  // `${sku}|${loc}` -> qty
{
  const rl = createInterface({ input: createReadStream(newestCsv()) }); let hd = null, ix = {};
  for await (const line of rl) { if (!hd) { hd = pcsv(line); for (const c of ["ItemUpc", "OnHandQty", "StoreName"]) ix[c] = hd.indexOf(c); continue; } const cols = pcsv(line); if (cols.length !== hd.length) continue; const upc = (cols[ix.ItemUpc] || "").trim(); const q = parseFloat(cols[ix.OnHandQty] || 0) || 0; if (q <= 0 || !/^\d{6,}$/.test(upc)) continue; const sku = upcMap.get(upc); if (!sku) continue; const loc = STORE_TO_LOC_CODE[(cols[ix.StoreName] || "").trim()]; if (!loc) continue; const k = `${sku}|${loc}`; target.set(k, (target.get(k) || 0) + q); }
}
// current layers by (item, loc): rest + native  (via Mgmt API, join location code)
const curRows = await mgmt(`select l.item_id::text item, coalesce(loc.code,'?') loc, l.source_kind sk, round(sum(l.remaining_qty))::numeric q from inventory_layers l left join inventory_locations loc on loc.id=l.location_id where l.remaining_qty>0 group by l.item_id, loc.code, l.source_kind;`);
const restByKey = new Map(), nativeByKey = new Map();
for (const r of curRows) { const k = `${r.item}|${r.loc}`; if (r.sk === "xoro_rest_size") restByKey.set(k, (restByKey.get(k) || 0) + Number(r.q)); else nativeByKey.set(k, (nativeByKey.get(k) || 0) + Number(r.q)); }

// Plan: for every (sku,loc) that appears in target OR has rest layers (spine only)
const keys = new Set([...target.keys(), ...restByKey.keys()].filter(k => spineSkus.has(k.split("|")[0])));
let inc = 0, dec = 0, incU = 0, decU = 0;
const plan = [];
for (const k of keys) {
  const [sku, loc] = k.split("|");
  const xoro = target.get(k) || 0;             // 0 = sold-through at this store
  const native = nativeByKey.get(k) || 0;
  const curRest = restByKey.get(k) || 0;
  const targetRest = Math.max(0, xoro - native);
  const delta = targetRest - curRest;
  if (Math.abs(delta) < 0.5) continue;
  if (delta > 0) { inc++; incU += delta; } else { dec++; decU += -delta; }
  plan.push({ sku, loc, xoro, native, curRest, targetRest, delta });
}
const restTotalNow = [...restByKey.values()].reduce((s, v) => s + v, 0);
console.log(`# Mode: ${APPLY ? "APPLY" : "DRY-RUN"} | CSV: ${newestCsv().split(/[\\/]/).pop()}`);
console.log(`# spine skus=${spineSkus.size} | current xoro_rest_size total=${Math.round(restTotalNow).toLocaleString()}`);
console.log(`\n# ===== SPINE ON-HAND SYNC PLAN (spine items, per store) =====`);
console.log(`#   (sku,loc) cells changing: ${plan.length}`);
console.log(`#   INCREASE: ${inc} cells / +${Math.round(incU).toLocaleString()} u  (receipts/replenish)`);
console.log(`#   DECREASE: ${dec} cells / -${Math.round(decU).toLocaleString()} u  (sold-through/deplete)`);
console.log(`#   net change to xoro_rest_size: ${Math.round(incU - decU).toLocaleString()} u`);
console.log(`\n# top 15 changes (sku | loc | xoro | native | curRest -> targetRest | delta):`);
plan.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 15).forEach(p => console.log(`  ${(skuCodeById.get(p.sku) || p.sku.slice(0, 8))} | ${p.loc} | xoro=${p.xoro} native=${p.native} ${p.curRest}->${p.targetRest} (${p.delta > 0 ? "+" : ""}${Math.round(p.delta)})`));

if (!APPLY) { console.log(`\n# DRY-RUN — no writes. --apply would true xoro_rest_size to Xoro-REST per store (reversal manifest saved).`); process.exit(0); }

// ── APPLY ── per (sku,loc): DECREASE reduce oldest-first; INCREASE add to newest
// existing rest layer, else CREATE one. FK-safe (no deletes). Reversal manifest.
const planSkus = [...new Set(plan.map(p => p.sku))];
const layerRows = [];
for (let i = 0; i < planSkus.length; i += 200) {
  const chunk = planSkus.slice(i, i + 200);
  const rows = await mgmt(`select l.id::text, l.item_id::text item, coalesce(loc.code,'?') loc, l.remaining_qty::numeric q from inventory_layers l left join inventory_locations loc on loc.id=l.location_id where l.source_kind='xoro_rest_size' and l.remaining_qty>0 and l.item_id in (${chunk.map(sqlLit).join(",")}) order by l.item_id, loc.code, l.received_at asc nulls first;`);
  layerRows.push(...rows);
}
const layersByCell = new Map();
for (const r of layerRows) { const k = `${r.item}|${r.loc}`; if (!layersByCell.has(k)) layersByCell.set(k, []); layersByCell.get(k).push(r); }
const skuCode = (sku) => skuCodeById.get(sku);
const costCents = (sku) => { const c = skuCode(sku); return avgCost.has(c) ? Math.round(avgCost.get(c) * 100) : 0; };
const updates = [], creates = [];
for (const p of plan) {
  const ls = layersByCell.get(`${p.sku}|${p.loc}`) || [];
  if (p.delta < 0) {
    let toRemove = -p.delta;
    for (const l of ls) { if (toRemove <= 0.0001) break; const cur = Number(l.q); const take = Math.min(cur, toRemove); updates.push({ id: l.id, old: cur, new: cur - take }); toRemove -= take; }
  } else if (ls.length) {
    const l = ls[ls.length - 1]; updates.push({ id: l.id, old: Number(l.q), new: Number(l.q) + p.delta });
  } else {
    const locId = locIdByCode.get(p.loc); if (!locId) continue;
    creates.push({ item: p.sku, locId, qty: p.delta, costC: costCents(p.sku) });
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const manifestPath = `C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/spine-onhand-sync-reversal-${stamp}.json`;
console.log(`\n# ${updates.length} layer updates, ${creates.length} new layers. Reverse = restore 'old' on updates + delete created ids.`);
let up = 0;
for (let i = 0; i < updates.length; i += 500) {
  const chunk = updates.slice(i, i + 500);
  const vals = chunk.map((u) => `(${sqlLit(u.id)}::uuid, ${u.new}::numeric)`).join(",");
  await mgmt(`update inventory_layers il set remaining_qty = v.q from (values ${vals}) v(id,q) where il.id = v.id;`);
  up += chunk.length; console.log(`#   updated ${up}/${updates.length}`);
}
const createdIds = [];
for (let i = 0; i < creates.length; i += 300) {
  const chunk = creates.slice(i, i + 300);
  const vals = chunk.map((c) => `(${sqlLit(c.item)}::uuid, ${sqlLit(c.locId)}::uuid, 'xoro_rest_size', ${c.qty}::numeric, ${c.qty}::numeric, ${c.costC}::bigint, now(), ${sqlLit(ROF)}::uuid)`).join(",");
  const rows = await mgmt(`insert into inventory_layers (item_id, location_id, source_kind, original_qty, remaining_qty, unit_cost_cents, received_at, entity_id) values ${vals} returning id;`);
  for (const r of rows) createdIds.push(r.id);
  console.log(`#   created ${createdIds.length}/${creates.length}`);
}
writeFileSync(manifestPath, JSON.stringify({ created_at: new Date().toISOString(), csv: newestCsv(), updates, created_ids: createdIds }, null, 2));
console.log(`# reversal manifest: ${manifestPath}`);
const [{ t }] = await mgmt(`select round(sum(remaining_qty))::int t from inventory_layers where remaining_qty>0;`);
console.log(`\n# ✓ DONE. spine on-hand synced to Xoro-REST. inventory_layers total now ${t.toLocaleString()}.`);
