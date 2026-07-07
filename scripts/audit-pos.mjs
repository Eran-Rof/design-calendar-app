#!/usr/bin/env node
// PO GRID AUDIT (read-only). Runs every ACTIVE native PO through a fixed set of
// invariants and prints a categorized report of every failure — the standing
// "prove it's zero" check for the PO grid and its data wiring. ZERO writes.
//
//   node scripts/audit-pos.mjs
//
// Reads PROD via the Supabase Management API (SUPABASE_PAT from .env.local /
// .env.staging). Green = invariant holds across all POs; red = the flagged POs.
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(f) {
  try {
    const t = readFileSync(resolve(ROOT, f), "utf8");
    return Object.fromEntries(t.split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!PAT) { console.error("✗ SUPABASE_PAT missing"); process.exit(1); }
const PROD = "qcvqvxxoperiurauoxmp";
async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROD}/database/query`,
    { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`SQL ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

const ACTIVE = "status in ('issued','partially_received','in_transit')";
// Per-line + per-PO money model, replicating the grid (computePoLineMoney) with
// the reference-grain ANCHOR, over live data. Cost master normalized ONCE.
const LINE_CTE = `
with active as (select id, po_number, status, total_cents from purchase_orders where ${ACTIVE}),
skucost as (
  select upper(regexp_replace(sku_code,'[^A-Za-z0-9]','','g')) nsku, max(round(avg_cost*100)) std_cost_cents
  from ip_item_avg_cost where avg_cost is not null group by 1
),
lin as (
  select a.po_number, a.total_cents hdr_total, l.qty_ordered::numeric qty, l.unit_cost_cents::numeric unit,
    (l.inventory_item_id is not null) linked,
    case when im.size ~* 'PPK[0-9]+' then (regexp_match(im.size,'PPK([0-9]+)','i'))[1]::numeric else 1 end ppk,
    sc.std_cost_cents
  from active a join purchase_order_lines l on l.purchase_order_id=a.id
  left join ip_item_master im on im.id=l.inventory_item_id
  left join skucost sc on sc.nsku = upper(regexp_replace(im.sku_code,'[^A-Za-z0-9]','','g'))
  where l.qty_ordered > 0
),
money as (
  select *, unit*qty priceCents, qty*ppk eaches,
    case when std_cost_cents is null then unit/nullif(ppk,0)
         when abs(std_cost_cents - unit/nullif(ppk,0)) <= abs(std_cost_cents/nullif(ppk,0) - unit/nullif(ppk,0))
           then std_cost_cents else std_cost_cents/nullif(ppk,0) end costEach
  from lin
),
po as (
  select po_number, max(hdr_total) hdr_total, count(*) nlines, count(*) filter (where linked) nlinked,
    sum(unit*qty) sum_line_total,
    round(sum(priceCents) filter (where linked)/nullif(sum(eaches) filter (where linked),0)) avg_po_each,
    round(sum(costEach*eaches) filter (where linked)/nullif(sum(eaches) filter (where linked),0)) avg_cost_each
  from money group by po_number
)`;

const checks = [
  { key: "TOTAL_MISMATCH", desc: "Grid Total ≠ Σ(line qty×cost)",
    sql: `${LINE_CTE} select po_number, hdr_total/100.0 hdr, sum_line_total/100.0 lines_sum from po where abs(hdr_total-sum_line_total)>100 order by 1` },
  { key: "ALL_UNLINKED", desc: "Every line SKU-less → no cost/sell/matrix",
    sql: `${LINE_CTE} select po_number, nlines from po where nlinked=0 order by 1` },
  { key: "SOME_UNLINKED", desc: "Some lines SKU-less (excluded from cost/sell)",
    sql: `${LINE_CTE} select po_number, nlines, nlinked, (nlines-nlinked) unlinked from po where nlinked>0 and nlinked<nlines order by (nlines-nlinked) desc` },
  { key: "COST_GRAIN_ANOMALY", desc: "Avg cost/each vs Avg PO/each ratio off [0.5,2] (the $0.66/$324 class)",
    sql: `${LINE_CTE} select po_number, avg_po_each/100.0 po_each, avg_cost_each/100.0 cost_each from po
          where avg_po_each>0 and avg_cost_each is not null and (avg_cost_each::numeric/nullif(avg_po_each,0)<0.5 or avg_cost_each::numeric/nullif(avg_po_each,0)>2.0) order by 1` },
  { key: "IMPLAUSIBLE_PER_EACH", desc: "Avg PO price/each outside $0.50–$500",
    sql: `${LINE_CTE} select po_number, avg_po_each/100.0 po_each from po where avg_po_each is not null and (avg_po_each<50 or avg_po_each>50000) order by 2` },
  { key: "STYLE_CASE_MISMATCH", desc: "ip_item_master.style_code ≠ style_master casing → 'Style X not found'",
    sql: `select distinct a.po_number, im.style_code from purchase_orders a join purchase_order_lines l on l.purchase_order_id=a.id join ip_item_master im on im.id=l.inventory_item_id
          where a.${ACTIVE} and im.style_code is not null and not exists(select 1 from style_master sm where sm.style_code=im.style_code) and exists(select 1 from style_master sm where upper(sm.style_code)=upper(im.style_code)) order by 1` },
  { key: "MISSING_DESCRIPTION", desc: "Linked style has no description/name",
    sql: `select distinct a.po_number, im.style_code from purchase_orders a join purchase_order_lines l on l.purchase_order_id=a.id join ip_item_master im on im.id=l.inventory_item_id join style_master sm on sm.id=im.style_id
          where a.${ACTIVE} and coalesce(nullif(trim(sm.description),''),nullif(trim(sm.style_name),'')) is null order by 1` },
  { key: "PPK_NO_PREPACK_DEF", desc: "PPK style on a PO has no active prepack matrix → blank on-screen / wrong explode",
    sql: `select a.po_number, string_agg(distinct im.style_code,', ') styles from purchase_orders a join purchase_order_lines l on l.purchase_order_id=a.id join ip_item_master im on im.id=l.inventory_item_id
          where a.${ACTIVE} and im.style_code ~* 'PPK' and not exists(select 1 from prepack_matrices pm where lower(pm.ppk_style_code)=lower(im.style_code) and pm.is_active) group by a.po_number order by 1` },
  { key: "UNRECOGNIZED_SIZE", desc: "Size token not a known garment/numeric/PPK size → sorts/renders wrong",
    sql: `select distinct a.po_number, im.style_code, im.size from purchase_orders a join purchase_order_lines l on l.purchase_order_id=a.id join ip_item_master im on im.id=l.inventory_item_id
          where a.${ACTIVE} and im.size is not null
            and im.size !~* '^(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|XSMALL|SMALL|MEDIUM|LARGE|XLARGE|2XLARGE|3XLARGE|SML|MED|LRG|XLG|XXLARGE|OS|ONE SIZE)$'
            and im.size !~ '^[0-9]+(\\.[0-9]+)?$' and im.size !~* '^PPK[0-9]+$' and im.size !~* '^(XXS|XS|S|M|L|XL)\\([0-9]+-[0-9]+\\)$'
          order by 1` },
];

const active = (await q(`select count(*) n from purchase_orders where ${ACTIVE}`))[0].n;
console.log(`\n  PO GRID AUDIT — ${active} active POs (${ACTIVE})\n`);
const summary = [];
for (const c of checks) {
  let rows;
  try { rows = await q(c.sql); } catch (e) { console.log(`✗ ${c.key}: ${e.message}\n`); summary.push({ check: c.key, pos: -1 }); continue; }
  const pos = [...new Set(rows.map((r) => r.po_number))];
  summary.push({ check: c.key, pos: pos.length });
  console.log(`${pos.length ? "🔴" : "🟢"} ${c.key} — ${pos.length} PO(s)\n    ${c.desc}`);
  for (const r of rows.slice(0, 8)) console.log(`      ${r.po_number}  ${Object.entries(r).filter(([k]) => k !== "po_number").map(([k, v]) => `${k}=${v}`).join("  ")}`);
  if (rows.length > 8) console.log(`      … +${rows.length - 8} more`);
  console.log("");
}
console.log(`── SUMMARY ──────────────────────────────────────`);
for (const s of summary) console.log(`  ${s.pos === -1 ? "✗ " : s.pos ? "🔴" : "🟢"} ${String(s.pos < 0 ? "err" : s.pos).padStart(3)} POs  ${s.check}`);
const failed = summary.filter((s) => s.pos !== 0).length;
console.log(`\n  ${summary.length - failed}/${summary.length} invariants clean.`);
process.exit(failed ? 1 : 0);
