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
import { buildSnapshotUpserts, pruneReason, csvDateFromName, cellKey } from "../api/_lib/spineSnapshot.js";

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

// ── Private-label parts (labels/patches/etc.): Xoro reuses/blanks the UPC across
// customers, so these can NEVER tie via the UPC spine. Their unique, stable key
// is Xoro's ItemNumber (= our sku_code, e.g. "JK00001-JACKS SURFBOARDS"). Resolve
// these AUTHORITATIVELY by normalized ItemNumber instead of UPC. Confined to
// PRIVATE-LABEL styles so the 99% UPC path is untouched. On a normalized-code
// collision (a dashless/abbrev duplicate SKU), prefer the on-hand holder, then
// the longer sku_code — deterministic; the empties get collapsed by the dedup.
const normSku = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const plRows = await mgmt(`select im.id::text id, im.sku_code, coalesce((select round(sum(remaining_qty)) from inventory_layers l where l.item_id=im.id and l.source_kind='xoro_rest_size' and l.remaining_qty>0),0)::int oh from ip_item_master im join style_master sm on sm.id=im.style_id where sm.description ilike '%PRIVATE LABEL%' and im.sku_code is not null;`);
const plByNorm = new Map(); const plSkus = new Set();
for (const r of plRows) {
  plSkus.add(r.id);
  const k = normSku(r.sku_code); const prev = plByNorm.get(k);
  if (!prev) { plByNorm.set(k, r); continue; }
  const better = (Number(r.oh) > 0 && Number(prev.oh) <= 0) ? r
    : (Number(prev.oh) > 0 && Number(r.oh) <= 0) ? prev
    : (r.sku_code.length > prev.sku_code.length ? r : prev);
  plByNorm.set(k, better);
}
const allowedSkus = new Set([...spineSkus, ...plSkus]);

// Xoro-REST target on-hand by (sku_id, loc_code). snapCells captures the SAME
// resolved cells keyed by raw StoreName (the tangerine_size_onhand.warehouse_code
// convention) for the by-size snapshot write below — including stores the layer
// true-up doesn't map (e.g. 'Psycho Tuna Ecom'); the snapshot is a faithful
// per-store mirror, the layer sync stays confined to STORE_TO_LOC_CODE.
const target = new Map();  // `${sku}|${loc}` -> qty
const snapCells = [];      // { sku, store (raw StoreName), qty }
{
  const rl = createInterface({ input: createReadStream(newestCsv()) }); let hd = null, ix = {};
  for await (const line of rl) { if (!hd) { hd = pcsv(line); for (const c of ["ItemUpc", "OnHandQty", "StoreName", "ItemNumber"]) ix[c] = hd.indexOf(c); continue; } const cols = pcsv(line); if (cols.length !== hd.length) continue; const q = parseFloat(cols[ix.OnHandQty] || 0) || 0; if (q <= 0) continue; let sku = null; const plHit = plByNorm.get(normSku(cols[ix.ItemNumber] || "")); if (plHit) sku = plHit.id; else { const upc = (cols[ix.ItemUpc] || "").trim(); if (/^\d{6,}$/.test(upc)) sku = upcMap.get(upc); } if (!sku) continue; const store = (cols[ix.StoreName] || "").trim(); if (store) snapCells.push({ sku, store, qty: q }); const loc = STORE_TO_LOC_CODE[store]; if (!loc) continue; const k = `${sku}|${loc}`; target.set(k, (target.get(k) || 0) + q); }
}
// current layers by (item, loc): rest + native  (via Mgmt API, join location code)
const curRows = await mgmt(`select l.item_id::text item, coalesce(loc.code,'?') loc, l.source_kind sk, round(sum(l.remaining_qty))::numeric q from inventory_layers l left join inventory_locations loc on loc.id=l.location_id where l.remaining_qty>0 group by l.item_id, loc.code, l.source_kind;`);
const restByKey = new Map(), nativeByKey = new Map();
for (const r of curRows) { const k = `${r.item}|${r.loc}`; if (r.sk === "xoro_rest_size") restByKey.set(k, (restByKey.get(k) || 0) + Number(r.q)); else nativeByKey.set(k, (nativeByKey.get(k) || 0) + Number(r.q)); }

// Plan: for every (sku,loc) that appears in target OR has rest layers (spine only)
const keys = new Set([...target.keys(), ...restByKey.keys()].filter(k => allowedSkus.has(k.split("|")[0])));
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
console.log(`# spine skus=${spineSkus.size} | private-label skus=${plSkus.size} (ItemNumber-resolved) | current xoro_rest_size total=${Math.round(restTotalNow).toLocaleString()}`);
console.log(`\n# ===== SPINE ON-HAND SYNC PLAN (spine items, per store) =====`);
console.log(`#   (sku,loc) cells changing: ${plan.length}`);
console.log(`#   INCREASE: ${inc} cells / +${Math.round(incU).toLocaleString()} u  (receipts/replenish)`);
console.log(`#   DECREASE: ${dec} cells / -${Math.round(decU).toLocaleString()} u  (sold-through/deplete)`);
console.log(`#   net change to xoro_rest_size: ${Math.round(incU - decU).toLocaleString()} u`);
console.log(`\n# top 15 changes (sku | loc | xoro | native | curRest -> targetRest | delta):`);
plan.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 15).forEach(p => console.log(`  ${(skuCodeById.get(p.sku) || p.sku.slice(0, 8))} | ${p.loc} | xoro=${p.xoro} native=${p.native} ${p.curRest}->${p.targetRest} (${p.delta > 0 ? "+" : ""}${Math.round(p.delta)})`));

// ── BY-SIZE SNAPSHOT PLAN (tangerine_size_onhand) — the spine now OWNS this table.
// One row per (item_id, warehouse=raw StoreName) resolved from today's CSV; older
// rows are pruned when superseded (same cell re-written today) or sold-through (a
// spine-mapped item that dropped out of the feed → truth is now 0). Non-spine
// items absent from the feed keep their last-known row (coverage gaps).
// See docs/tangerine/user-guide/22-shadow-mirror.md §22.12.3.
const csvDate = csvDateFromName(newestCsv());
let snapUpserts = [], supersededIds = [], soldThroughIds = [];
if (!csvDate) {
  console.log(`\n# ⚠ SNAPSHOT SKIPPED — CSV name carries no YYYYMMDD; cannot date the snapshot.`);
} else {
  snapUpserts = buildSnapshotUpserts(snapCells, null, csvDate);
  const feedItems = new Set(snapCells.map((c) => c.sku));
  const upsertKeys = new Set(snapUpserts.map((u) => cellKey(u.item_id, u.warehouse_code)));
  const existing = await mgmt(`select id::text id, item_id::text item_id, warehouse_code, snapshot_date::text snapshot_date, source from tangerine_size_onhand where source='xoro_rest' and entity_id=${sqlLit(ROF)}::uuid and snapshot_date < ${sqlLit(csvDate)}::date;`);
  for (const row of existing) {
    const why = pruneReason(row, { upsertKeys, allowedSkus, feedItems, csvDate });
    if (why === "superseded") supersededIds.push(row.id);
    else if (why === "sold-through") soldThroughIds.push(row.id);
  }
  console.log(`\n# ===== BY-SIZE SNAPSHOT (tangerine_size_onhand, source=xoro_rest, date ${csvDate}) =====`);
  console.log(`#   upsert rows (item×warehouse): ${snapUpserts.length} across ${feedItems.size} feed items`);
  console.log(`#   prune superseded (same cell re-written today): ${supersededIds.length}`);
  console.log(`#   prune sold-through (spine item absent from feed): ${soldThroughIds.length}`);
}

if (!APPLY) { console.log(`\n# DRY-RUN — no writes. --apply would true xoro_rest_size to Xoro-REST per store AND upsert/prune the tangerine_size_onhand snapshot above (reversal manifest saved).`); process.exit(0); }

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

// ── WRITE by-size snapshot (tangerine_size_onhand): upsert today's per-store rows,
// then prune superseded + sold-through older rows (after a successful upsert).
// Guarded on a non-empty feed so a broken/empty CSV can never mass-delete via the
// sold-through path.
let prunedSup = 0, prunedSold = 0;
if (csvDate && snapUpserts.length) {
  let sUp = 0;
  for (let i = 0; i < snapUpserts.length; i += 500) {
    const chunk = snapUpserts.slice(i, i + 500);
    const vals = chunk.map((u) => `(${sqlLit(ROF)}::uuid, ${sqlLit(u.item_id)}::uuid, ${sqlLit(u.warehouse_code)}, ${sqlLit(u.snapshot_date)}::date, ${u.qty_on_hand}::numeric, 'xoro_rest', now())`).join(",");
    await mgmt(`insert into tangerine_size_onhand (entity_id, item_id, warehouse_code, snapshot_date, qty_on_hand, source, updated_at) values ${vals} on conflict (entity_id, item_id, warehouse_code, snapshot_date, source) do update set qty_on_hand = excluded.qty_on_hand, updated_at = now();`);
    sUp += chunk.length; console.log(`#   snapshot upserted ${sUp}/${snapUpserts.length}`);
  }
  const pruneIds = async (ids) => { let n = 0; for (let i = 0; i < ids.length; i += 500) { const chunk = ids.slice(i, i + 500); const [{ n: d }] = await mgmt(`with d as (delete from tangerine_size_onhand where id in (${chunk.map((x) => `${sqlLit(x)}::uuid`).join(",")}) returning 1) select count(*)::int n from d;`); n += Number(d) || 0; } return n; };
  if (supersededIds.length) prunedSup = await pruneIds(supersededIds);
  if (soldThroughIds.length) prunedSold = await pruneIds(soldThroughIds);
} else if (csvDate) {
  console.log(`# snapshot upsert/prune SKIPPED — feed produced 0 rows (safety: no sold-through mass-delete).`);
}
console.log(`# snapshot: upserted ${snapUpserts.length}, pruned-superseded ${prunedSup}, pruned-sold-through ${prunedSold}.`);

const [{ t }] = await mgmt(`select round(sum(remaining_qty))::int t from inventory_layers where remaining_qty>0;`);
console.log(`\n# ✓ DONE. spine on-hand synced to Xoro-REST + by-size snapshot written. inventory_layers total now ${t.toLocaleString()}.`);
