#!/usr/bin/env node
// READ-ONLY. Prove the JS colorMatchKey and the SQL po_dq_norm_color() agree on
// EVERY distinct catalog colour. They must, or v_po_data_quality groups PO
// colours differently from the importer. Run after any COLOR_ABBR edit.
import { readFileSync } from "node:fs";
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

const rows = await sql(`
  select distinct color, po_dq_norm_color(color) as sqlkey
    from ip_item_master where color is not null and btrim(color) <> ''`);
let mism = 0;
for (const r of rows) {
  const js = colorMatchKey(r.color);
  if (js !== r.sqlkey) {
    if (mism < 25) console.log(`  MISMATCH "${r.color}"  js=${js}  sql=${r.sqlkey}`);
    mism++;
  }
}
console.log(`\n${rows.length} distinct colours checked — ${mism} mismatches (must be 0)`);
process.exit(mism ? 1 : 0);
