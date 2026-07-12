#!/usr/bin/env node
/**
 * scripts/link-privatelabel-customers.mjs  (DRY-RUN by default; --apply writes PROD)
 *
 * Completes the base-style + customer-style model for private-label PARTS
 * (labels/patches: BP/FL/JK/ML/HS...). Each part SKU bakes the customer (surf
 * shop) into its code/color; this records that customer as a customer-style
 * within the base style via style_customer_numbers (style_id, customer_id,
 * customer_style_number = the part sku_code). Additive + idempotent: only
 * inserts (style,customer) links that don't already exist.
 *
 * The customer is resolved from the SKU's color / code-suffix by NORMALIZED
 * name match against customers, plus a small unambiguous alias set. Anything
 * that doesn't resolve confidently is REPORTED and skipped (never guessed).
 *
 *   node scripts/link-privatelabel-customers.mjs           # dry-run
 *   node scripts/link-privatelabel-customers.mjs --apply   # write PROD
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const ENTITY = "404b8a6b-0d2d-44d2-8539-9064ff0fafee"; // rof entity (from existing SCN rows)
function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_ANON_KEY, PAT = env.SUPABASE_PAT;
if (!SB_URL || !ANON || !PAT) { console.error("✗ need URL + anon + SUPABASE_PAT"); process.exit(1); }
async function anonAll(t, s) { const out = []; for (let off = 0; ; off += 1000) { const r = await fetch(`${SB_URL}/rest/v1/${t}?select=${s}&limit=1000&offset=${off}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }); const rows = await r.json(); if (!rows.length) break; out.push(...rows); if (rows.length < 1000) break; } return out; }
async function mgmt(sql) { const r = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) }); if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json(); }
const sqlLit = (v) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Unambiguous alias: normalized shop token (from color or sku suffix) -> a
// normalized customer name substring that identifies exactly one customer.
// Kept deliberately small + safe; ambiguous tokens (e.g. "HT") are omitted so
// they surface as unresolved rather than mislink.
const ALIAS = {
  ETSURFBOARD: "ETSURFBOARDS", ETSURFBOARDS: "ETSURFBOARDS",
  JACKSSURFBOARDS: "JACKSSURFBOARDS", JACKS: "JACKSSURFBOARDS",
  SURFERSUPPLY: "SURFERSUPPLIES", SURFERSUPPLIES: "SURFERSUPPLIES",
  HERITAGESURF: "HERITAGESURFSHOP", OCEANHUT: "OCEANHUTSURFSHOP",
  SOUTHCOAST: "SOUTHCOASTSURFSHOP", ELKMONTTRADING: "ELKMONTTRADINGCO",
  THALIA: "THALIASURFSHOP", SB: "SHOREBREAK", SH: "SURFHUT", OH: "OCEANHUTSURFSHOP",
  SC: "SURFCITY", HS: "HOBIESURF",
};

const styles = (await anonAll("style_master?description=not.is.null", "id,style_code,description")).filter(s => /PRIVATE LABEL/i.test(s.description || ""));
const styleIds = styles.map(s => s.id);
if (!styleIds.length) { console.error("no private-label styles"); process.exit(1); }
const skus = await anonAll(`ip_item_master?style_id=in.(${styleIds.join(",")})`, "id,sku_code,color,style_id");
const oh = new Map((await mgmt(`select item_id::text i, round(sum(remaining_qty))::int q from inventory_layers where remaining_qty>0 group by item_id;`)).map(r => [r.i, Number(r.q)]));
const customers = await anonAll("customers?name=not.is.null", "id,name");
const custByNorm = new Map(); for (const c of customers) { const k = norm(c.name); if (!custByNorm.has(k)) custByNorm.set(k, c); }
const existing = new Set((await anonAll(`style_customer_numbers?style_id=in.(${styleIds.join(",")})`, "style_id,customer_id")).map(r => `${r.style_id}|${r.customer_id}`));
const styleCode = new Map(styles.map(s => [s.id, s.style_code]));

// Resolve a SKU's customer: try color, then the sku suffix after the style code.
function resolveCustomer(sku) {
  const tokens = [];
  if (sku.color) tokens.push(norm(sku.color));
  const sc = styleCode.get(sku.style_id) || "";
  const suffix = sku.sku_code.toUpperCase().startsWith(sc.toUpperCase()) ? sku.sku_code.slice(sc.length).replace(/^[^A-Za-z0-9]+/, "") : "";
  if (suffix) tokens.push(norm(suffix));
  for (const t of tokens) {
    if (!t) continue;
    if (custByNorm.has(t)) return custByNorm.get(t);                 // exact name
    if (ALIAS[t] && custByNorm.has(ALIAS[t])) return custByNorm.get(ALIAS[t]); // alias
    // substring: token contained in exactly one customer norm-name
    const hits = [...custByNorm.entries()].filter(([k]) => k.includes(t) && t.length >= 5);
    if (hits.length === 1) return hits[0][1];
  }
  return null;
}

const toLink = new Map();  // `${style}|${cust}` -> {style_id, customer_id, csn}
const unresolved = [];
for (const sku of skus) {
  if ((oh.get(sku.id) || 0) <= 0) continue;              // only parts with on-hand
  const cust = resolveCustomer(sku);
  if (!cust) { unresolved.push(`${styleCode.get(sku.style_id)} | ${sku.sku_code} | color=${sku.color ?? ""}`); continue; }
  const key = `${sku.style_id}|${cust.id}`;
  if (existing.has(key)) continue;
  if (!toLink.has(key)) toLink.set(key, { style_id: sku.style_id, customer_id: cust.id, csn: sku.sku_code, cust: cust.name, style: styleCode.get(sku.style_id) });
}

console.log(`# Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`# private-label styles=${styles.length} | parts w/ on-hand scanned | existing links=${existing.size}`);
console.log(`# NEW links to create: ${toLink.size}`);
for (const v of toLink.values()) console.log(`  + ${v.style} -> ${v.cust}  (csn ${v.csn})`);
if (unresolved.length) { console.log(`\n# UNRESOLVED (skipped — customer not confidently matched): ${unresolved.length}`); unresolved.forEach(u => console.log(`  ? ${u}`)); }

if (!APPLY) { console.log(`\n# DRY-RUN — no writes. --apply inserts the ${toLink.size} new links.`); process.exit(0); }
if (!toLink.size) { console.log("# nothing to insert."); process.exit(0); }
const vals = [...toLink.values()].map(v => `(${sqlLit(ENTITY)}::uuid, ${sqlLit(v.style_id)}::uuid, ${sqlLit(v.customer_id)}::uuid, ${sqlLit(v.csn)})`).join(",");
const rows = await mgmt(`insert into style_customer_numbers (entity_id, style_id, customer_id, customer_style_number) values ${vals} on conflict (style_id, customer_id) do nothing returning id;`);
console.log(`\n# ✓ inserted ${rows.length} style_customer_numbers rows.`);
