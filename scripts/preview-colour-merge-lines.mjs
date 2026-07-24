#!/usr/bin/env node
// READ-ONLY. For the styles named on the command line, show the ATS colour lines
// BEFORE and AFTER the merge plan — i.e. exactly which duplicate rows collapse
// on the CEO's Inventory Snapshot, and which survive and why.
//   node scripts/preview-colour-merge-lines.mjs RYB0991 RYB0991R RBB0991
import { readFileSync } from "node:fs";
import { colorMatchKey, expandTokens } from "../api/_lib/xoroLineMatch.js";

const STYLES = process.argv.slice(2);
if (!STYLES.length) { console.error("usage: preview-colour-merge-lines.mjs STYLE [STYLE…]"); process.exit(1); }

const PAT = (() => {
  const t = readFileSync("C:/Users/Eran.RINGOFFIRE/design-calendar-app/.env.local", "utf8");
  const m = t.split("\n").find((l) => l.startsWith("SUPABASE_PAT"));
  return m.slice(m.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
})();
const sql = async (q) => {
  const r = await fetch("https://api.supabase.com/v1/projects/qcvqvxxoperiurauoxmp/database/query", {
    method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  if (!r.ok) throw new Error(await r.text());
  return JSON.parse(await r.text());
};
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])([a-z0-9]*)/g, (_, a, b) => a.toUpperCase() + b);

const rows = await sql(`
  select coalesce(sm.style_code, im.style_code) as style_code, im.color,
         count(*)::int as skus
    from ip_item_master im
    left join style_master sm on sm.id = im.style_id
   where im.active = true and im.color is not null and btrim(im.color) <> ''
     and coalesce(sm.style_code, im.style_code) in (${STYLES.map(lit).join(",")})
   group by 1, 2 order by 1, 2`);

for (const style of STYLES) {
  const mine = rows.filter((r) => r.style_code === style);
  if (!mine.length) { console.log(`\n${style}: no active colour SKUs`); continue; }
  const byKey = new Map();
  for (const r of mine) {
    const k = colorMatchKey(r.color);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const after = [...byKey.values()].map((g) =>
    titleCase(expandTokens(g.map((r) => r.color).sort((a, b) => b.length - a.length)[0])));
  console.log(`\n${style}: ${mine.length} colour lines -> ${byKey.size}  (${mine.length - byKey.size} collapse)`);
  for (const [, g] of byKey) {
    const name = titleCase(expandTokens(g.map((r) => r.color).sort((a, b) => b.length - a.length)[0]));
    if (g.length === 1 && g[0].color === name) { console.log(`    = ${name}`); continue; }
    console.log(`    ${g.length > 1 ? "+" : "~"} ${name}`);
    for (const r of g) console.log(`        was "${r.color}" (${r.skus} SKUs)`);
  }
  void after;
}
