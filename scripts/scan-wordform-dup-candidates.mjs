#!/usr/bin/env node
// READ-ONLY. Find LIKELY-duplicate colour pairs the abbreviation dictionary does
// NOT catch — the "Blue Bleach vs Blue Bleached" class. These cannot be folded
// automatically because the difference is a real word choice, not an abbreviation,
// so this only SURFACES candidates for a yes/no decision; it never merges.
//
// Heuristic (per style, over ACTIVE colours only): flag two spellings whose
// colorMatchKey DIFFERS but which are "near" each other by one of:
//   - one key is a prefix of the other (Bleach ⊂ Bleached; Wash ⊂ Washed)
//   - the keys differ by a single small edit (Levenshtein ≤ 2 on the compact key)
//   - identical token multiset in a different ORDER (Navy/Peach vs Peach/Navy)
// Each candidate is ranked by sales at stake so the CEO reviews the ones that move
// real numbers first.
import { readFileSync, writeFileSync } from "node:fs";
import { colorMatchKey } from "../api/_lib/xoroLineMatch.js";

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

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const tokenMultiset = (color) => colorMatchKey(color) && color.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/).sort().join(" ");

const rows = await sql(`
  select coalesce(sm.style_code, im.style_code) as style_code, im.color,
         count(*)::int as skus,
         coalesce((select count(*) from ip_sales_history_wholesale h
                    where h.sku_id in (select id from ip_item_master x
                                        where x.style_id = im.style_id and x.color = im.color)),0)::int as sales_rows
    from ip_item_master im
    left join style_master sm on sm.id = im.style_id
   where im.active = true and im.color is not null and btrim(im.color) <> ''
   group by 1, 2, im.style_id`);

const byStyle = new Map();
for (const r of rows) {
  if (!byStyle.has(r.style_code)) byStyle.set(r.style_code, []);
  byStyle.get(r.style_code).push(r);
}

// Adding one of these words makes a DIFFERENT physical product, not a spelling
// of the same one — so a prefix match that differs only by such a word is NOT a
// duplicate ("Black" vs "Black Camo" are two real colourways). Everything here
// is a pattern / finish / second-colour modifier seen in the catalog.
const DISTINCT_MODIFIER = /^(CAMO|MIX|HEATHER|WATER|GEO|PRINT|STRIPE|STRIPED|COMBO|FADE|TIEDYE|TIEDYED|WASH|WASHED|ACID|PLAID|FLORAL|DENIM|GLITTER|OMBRE|MARBLE|LEOPARD|SNAKE|DYE|DYED|SPARKLE|METALLIC|NEON|OIL|CRACKLE|SPLATTER|BLACK|WHITE|GREY|GRAY|NAVY|BLUE|RED|GREEN|PINK|CORAL|CHARCOAL|BURGUNDY|OLIVE|BROWN|PURPLE|LAVENDER|AQUA|ORANGE|YELLOW|GOLD|SILVER|CREAM|TAN|RUST)$/;
const wordsOf = (color) => color.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/);

const HIGH = [], REVIEW = [];
for (const [style, colours] of byStyle) {
  for (let i = 0; i < colours.length; i++) {
    for (let j = i + 1; j < colours.length; j++) {
      const a = colours[i], b = colours[j];
      const ka = colorMatchKey(a.color), kb = colorMatchKey(b.color);
      if (!ka || !kb || ka === kb) continue;   // same key = already merged, skip
      const rec = { style, a: a.color, b: b.color, skus: a.skus + b.skus, sales: a.sales_rows + b.sales_rows };

      // HIGH confidence: the ONLY reason the keys differ is a glued abbreviation —
      // same word set once you split the compact keys, e.g. "Blkcamo" vs "Black
      // Camo" (BLKCAMO vs BLACKCAMO). These are dictionary GAPS, safe to fold.
      if (tokenMultiset(a.color) === tokenMultiset(b.color)) { HIGH.push({ ...rec, reason: "same words, different order/spacing" }); continue; }
      const short = ka.length < kb.length ? ka : kb, long = ka.length < kb.length ? kb : ka;
      if (long.startsWith(short) && lev(short, long) <= 3 && long.length - short.length <= 3) { HIGH.push({ ...rec, reason: "glued abbreviation (compact-key prefix, ≤3 chars)" }); continue; }

      // Otherwise NEEDS HUMAN JUDGMENT. Drop the pairs that differ by a known
      // distinct-product modifier — those are almost certainly NOT duplicates.
      const wa = wordsOf(a.color), wb = wordsOf(b.color);
      const extra = wa.length > wb.length ? wa.filter((w) => !wb.includes(w)) : wb.filter((w) => !wa.includes(w));
      const prefixMatch = ka.startsWith(kb) || kb.startsWith(ka);
      if (prefixMatch && extra.every((w) => DISTINCT_MODIFIER.test(w))) continue; // different product
      if (prefixMatch) { REVIEW.push({ ...rec, reason: `adds "${extra.join(" ")}" — same or different?` }); continue; }
      if (Math.abs(ka.length - kb.length) <= 2 && lev(ka, kb) <= 2) REVIEW.push({ ...rec, reason: `${lev(ka, kb)}-char difference` });
    }
  }
}
HIGH.sort((x, y) => y.sales - x.sales || y.skus - x.skus);
REVIEW.sort((x, y) => y.sales - x.sales || y.skus - x.skus);

const fmt = (c) => `${c.style.padEnd(12)} "${c.a}"  vs  "${c.b}"   [${c.reason}; ${c.skus} SKUs, ${c.sales} sales rows]`;
const lines = [
  `COLOUR DUPLICATE CANDIDATES the dictionary can't auto-fold`,
  `⚠️ REVIEW REQUIRED — the heuristic cannot tell "Bleach/Bleached" (same) from`,
  `   "Charcoal/Charcoal Mix" or "Black/Black Oil" (different finishes). Mark the`,
  `   truly-same pairs; those become word-form folds in COLOR_ABBR.`,
  ``,
  `TIER 1 — HIGH CONFIDENCE (glued abbreviation / same words): ${HIGH.length} pairs`,
  `  Fix: add the fold to COLOR_ABBR (+ SQL twin) and re-run merge-colour-clusters.mjs.`,
  "=".repeat(90),
  ...HIGH.map(fmt),
  ``, ``,
  `TIER 2 — NEEDS YOUR JUDGMENT (could be the same colour or a real variant): ${REVIEW.length} pairs`,
  `  Modifier-only differences (X vs "X Camo/Mix/Heather") were dropped as distinct products.`,
  "=".repeat(90),
  ...REVIEW.map(fmt),
];
const OUT = "C:/Users/Eran.RINGOFFIRE/code/rof_xoro_project/.launchd-logs/colour-wordform-candidates-2026-07-24.txt";
writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`TIER 1 (high confidence): ${HIGH.length}   TIER 2 (review): ${REVIEW.length}\n`);
console.log([`--- TIER 1 (first 30) ---`, ...HIGH.slice(0, 30).map(fmt),
  ``, `--- TIER 2 (first 15) ---`, ...REVIEW.slice(0, 15).map(fmt)].join("\n"));
console.log(`\n…full list at ${OUT}`);
