#!/usr/bin/env node
// READ-ONLY. After the cluster merge, count active colours whose STORED spelling
// still differs from the canonical (expanded, title-cased) name — but which are
// the ONLY spelling of their colour on their style, so the merge (duplicates
// only) never touched them. These are display-name normalizations, no merge.
import { readFileSync } from "node:fs";
import { colorMatchKey, expandTokens } from "../api/_lib/xoroLineMatch.js";

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
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])([a-z0-9]*)/g, (_, a, b) => a.toUpperCase() + b);

const rows = await sql(`
  select coalesce(sm.style_code, im.style_code) as style_code, im.color, count(*)::int as skus
    from ip_item_master im
    left join style_master sm on sm.id = im.style_id
   where im.active = true and im.color is not null and btrim(im.color) <> ''
   group by 1, 2`);

let n = 0, skus = 0;
const examples = [];
for (const r of rows) {
  const canonical = titleCase(expandTokens(r.color));
  if (canonical !== r.color && !/\bWith\b/i.test(canonical)) {   // skip W→WITH noise for the count
    n++; skus += r.skus;
    if (examples.length < 30) examples.push(`${r.color}  ->  ${canonical}  (${r.style_code}, ${r.skus} SKUs)`);
  }
}
console.log(`${n} single-spelling colours still differ from canonical (${skus} SKUs) — pure renames, no merge.\n`);
console.log(examples.join("\n"));
