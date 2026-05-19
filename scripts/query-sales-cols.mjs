#!/usr/bin/env node
import { readFileSync } from "fs"; import { resolve, dirname } from "path"; import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv(f) { try { return Object.fromEntries(readFileSync(resolve(__dirname, "..", f), "utf8").split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; })); } catch { return {}; } }
const PAT = loadEnv(".env.local").SUPABASE_PAT;
async function run(sql, label) {
  console.log(`\n▶ ${label}`);
  const res = await fetch(`https://api.supabase.com/v1/projects/qcvqvxxoperiurauoxmp/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  try { console.table(JSON.parse(await res.text())); } catch (e) { console.log(e); }
}
await run(
  `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name='ip_sales_history_wholesale'
   ORDER BY ordinal_position;`,
  "ip_sales_history_wholesale columns"
);
await run(
  `SELECT COUNT(*) AS total,
          COUNT(CASE WHEN margin_amount IS NOT NULL THEN 1 END) AS has_margin_amount,
          COUNT(CASE WHEN margin_pct    IS NOT NULL THEN 1 END) AS has_margin_pct,
          COUNT(CASE WHEN cogs_amount   IS NOT NULL THEN 1 END) AS has_cogs
   FROM ip_sales_history_wholesale;`,
  "Margin/cogs population"
);
