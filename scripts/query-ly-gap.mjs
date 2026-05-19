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

// 1. SKUs in LY ROF sales: how many are orphans (sku_id not in ip_item_master)?
await run(
  `SELECT 'in_master' AS bucket,
          COUNT(DISTINCT s.sku_id)::int AS distinct_skus,
          COUNT(*)::int AS sales_rows,
          ROUND(SUM(s.net_amount)::numeric, 0) AS revenue
   FROM ip_sales_history_wholesale s
   JOIN ip_channel_master c ON c.id = s.channel_id
   JOIN ip_item_master m ON m.id = s.sku_id
   WHERE s.txn_date >= '2025-01-01' AND s.txn_date <= '2025-05-18' AND c.channel_code = 'ROF'
   UNION ALL
   SELECT 'orphan' AS bucket,
          COUNT(DISTINCT s.sku_id)::int,
          COUNT(*)::int,
          ROUND(SUM(s.net_amount)::numeric, 0)
   FROM ip_sales_history_wholesale s
   JOIN ip_channel_master c ON c.id = s.channel_id
   LEFT JOIN ip_item_master m ON m.id = s.sku_id
   WHERE s.txn_date >= '2025-01-01' AND s.txn_date <= '2025-05-18' AND c.channel_code = 'ROF'
     AND m.id IS NULL;`,
  "LY ROF: master-resolved vs orphan SKUs"
);

// 2. Same for TY ROF — sanity check that orphans aren't a TY problem too
await run(
  `SELECT 'in_master' AS bucket,
          COUNT(DISTINCT s.sku_id)::int AS distinct_skus,
          COUNT(*)::int AS sales_rows,
          ROUND(SUM(s.net_amount)::numeric, 0) AS revenue
   FROM ip_sales_history_wholesale s
   JOIN ip_channel_master c ON c.id = s.channel_id
   JOIN ip_item_master m ON m.id = s.sku_id
   WHERE s.txn_date >= '2026-01-01' AND s.txn_date <= '2026-05-18' AND c.channel_code = 'ROF'
   UNION ALL
   SELECT 'orphan' AS bucket,
          COUNT(DISTINCT s.sku_id)::int,
          COUNT(*)::int,
          ROUND(SUM(s.net_amount)::numeric, 0)
   FROM ip_sales_history_wholesale s
   JOIN ip_channel_master c ON c.id = s.channel_id
   LEFT JOIN ip_item_master m ON m.id = s.sku_id
   WHERE s.txn_date >= '2026-01-01' AND s.txn_date <= '2026-05-18' AND c.channel_code = 'ROF'
     AND m.id IS NULL;`,
  "TY ROF: master-resolved vs orphan SKUs"
);
