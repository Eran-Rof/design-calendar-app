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
  `SELECT 'before_cache_edge (2025-01-01..2025-02-18)' AS bucket,
          COUNT(*)::int AS rows,
          ROUND(SUM(s.net_amount)::numeric, 0) AS revenue
   FROM ip_sales_history_wholesale s
   JOIN ip_channel_master c ON c.id = s.channel_id
   WHERE s.txn_date >= '2025-01-01' AND s.txn_date <= '2025-02-18' AND c.channel_code = 'ROF'
   UNION ALL
   SELECT 'in_cache_window (2025-02-19..2025-05-18)' AS bucket,
          COUNT(*)::int,
          ROUND(SUM(s.net_amount)::numeric, 0)
   FROM ip_sales_history_wholesale s
   JOIN ip_channel_master c ON c.id = s.channel_id
   WHERE s.txn_date >= '2025-02-19' AND s.txn_date <= '2025-05-18' AND c.channel_code = 'ROF';`,
  "ROF LY: split by 15-month preload cache edge"
);
