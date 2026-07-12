#!/usr/bin/env node
/**
 * scripts/dedup-privatelabel-skus.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Collapses EMPTY spelling-variant duplicate SKUs for private-label parts. Within
 * a base style, Xoro carries ONE item per customer, but Tangerine accumulated
 * dashless / punctuation twins (e.g. JK00001-JACKSSURFBOARDS beside the real
 * JK00001-JACKS-SURFBOARDS). These twins hold 0 on-hand (the spine sync trued all
 * stock onto the Xoro-matching keeper). This removes them: keeper = the member
 * with on-hand (tie -> the dashed, longer code = Xoro's spelling); losers = the
 * rest, which MUST be oh=0. FK references to a loser are repointed to the keeper
 * first, then the loser is deleted. Full pre-image manifest. NEVER merges
 * different customers — only exact normalized-code collisions within one style.
 *
 *   node scripts/dedup-privatelabel-skus.mjs           # dry-run
 *   node scripts/dedup-privatelabel-skus.mjs --apply   # write PROD
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const MANIFEST = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/dedup-privatelabel-skus-reversal-2026-07-12.json";
function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const PAT = env.SUPABASE_PAT;
if (!PAT) { console.error("✗ need SUPABASE_PAT"); process.exit(1); }
async function mgmt(sql) { const r = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) }); if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json(); }
const sqlLit = (v) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

// Collision groups: same normalized code within a private-label style.
const rows = await mgmt(`
  with pl as (
    select im.id::text id, im.sku_code, sm.style_code,
           regexp_replace(upper(im.sku_code),'[^A-Z0-9]','','g') nrm,
           coalesce((select round(sum(remaining_qty)) from inventory_layers l where l.item_id=im.id and l.remaining_qty>0),0)::int oh
    from ip_item_master im join style_master sm on sm.id=im.style_id
    where sm.description ilike '%PRIVATE LABEL%'
  ), g as (select style_code, nrm from pl group by style_code, nrm having count(*)>1)
  select pl.* from pl join g on g.style_code=pl.style_code and g.nrm=pl.nrm order by pl.style_code, pl.nrm, pl.oh desc;`);

const groups = new Map();
for (const r of rows) { const k = `${r.style_code}|${r.nrm}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }

// keeper = highest oh; tie -> has a dash right after the style code, then longest code.
const dashKeeper = (r) => new RegExp(`^${r.style_code}-`, "i").test(r.sku_code);
const pairs = []; // {keeper, losers[]}
for (const members of groups.values()) {
  const sorted = members.slice().sort((a, b) => (b.oh - a.oh) || ((dashKeeper(b) ? 1 : 0) - (dashKeeper(a) ? 1 : 0)) || (b.sku_code.length - a.sku_code.length));
  const [keeper, ...losers] = sorted;
  pairs.push({ keeper, losers });
}
const allLosers = pairs.flatMap(p => p.losers);
const badLosers = allLosers.filter(l => l.oh > 0);
if (badLosers.length) { console.error(`✗ ABORT: ${badLosers.length} loser(s) hold on-hand — refusing to delete stock:`); badLosers.forEach(l => console.error(`   ${l.sku_code} oh=${l.oh}`)); process.exit(1); }

// FK columns referencing ip_item_master.id
const fks = await mgmt(`
  select tc.table_name t, kcu.column_name c
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name
  join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name
  where tc.constraint_type='FOREIGN KEY' and ccu.table_name='ip_item_master' and ccu.column_name='id';`);

const loserIds = allLosers.map(l => l.id);
const idList = loserIds.map(sqlLit).join(",");
// reference counts per FK table
const refCounts = [];
for (const fk of fks) {
  const [{ n }] = await mgmt(`select count(*)::int n from ${fk.t} where ${fk.c} in (${idList});`);
  if (n > 0) refCounts.push({ ...fk, n });
}

console.log(`# Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`# collision groups: ${pairs.length} | empty twins to delete: ${allLosers.length}`);
console.log(`# FK tables referencing ip_item_master.id: ${fks.length} | with references to losers: ${refCounts.length}`);
refCounts.forEach(r => console.log(`   repoint ${r.n} row(s) in ${r.t}.${r.c} -> keeper`));
console.log(`\n# sample (keeper <- loser):`);
pairs.slice(0, 8).forEach(p => p.losers.forEach(l => console.log(`   ${p.keeper.sku_code}  <-  ${l.sku_code} (oh=${l.oh})`)));

if (!APPLY) { console.log(`\n# DRY-RUN — no writes. --apply deletes loser refs (empty layers + derived snapshots) then ${allLosers.length} empty twins.`); process.exit(0); }

// Losers are oh=0, so every referencing row is either an EMPTY inventory_layer
// (remaining_qty=0) or a derived snapshot (rebuilt nightly). Delete those child
// rows, then delete the loser SKUs. Capture full pre-image for reversibility.
const preimg = await mgmt(`select row_to_json(im) j from ip_item_master im where id in (${idList});`);
writeFileSync(MANIFEST, JSON.stringify({ created_at: "2026-07-12", pairs: pairs.map(p => ({ keeper: { id: p.keeper.id, sku_code: p.keeper.sku_code }, losers: p.losers })), fk_ref_counts: refCounts, sku_preimage: preimg.map(r => r.j) }, null, 2));
console.log(`\n# reversal manifest: ${MANIFEST}`);
for (const fk of refCounts) {
  const d = await mgmt(`delete from ${fk.t} where ${fk.c} in (${idList}) returning 1;`);
  console.log(`#   deleted ${d.length} loser row(s) in ${fk.t}.${fk.c}`);
}
const del = await mgmt(`delete from ip_item_master where id in (${idList}) returning id;`);
console.log(`\n# ✓ deleted ${del.length} empty twin SKUs. (reverse: re-insert sku_preimage; derived snapshots rebuild nightly)`);
