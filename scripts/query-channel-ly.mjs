#!/usr/bin/env node
/** Compare 2025-01-01..2025-05-18 ROF revenue vs the report's LY total. */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(
      text.split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
    );
  } catch { return {}; }
}

const PAT = loadEnv(".env.local").SUPABASE_PAT;
const PROD_REF = "qcvqvxxoperiurauoxmp";

async function run(sql, label) {
  console.log(`\n▶ ${label}`);
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  try { console.table(JSON.parse(await res.text())); } catch (e) { console.log(e); }
}

// 1. SP LY full ROF YTD 2025
await run(
  `SELECT COALESCE(c.channel_code, '(NULL)') AS channel,
          COUNT(*)::int AS rows,
          ROUND(SUM(s.net_amount)::numeric, 0) AS revenue
   FROM ip_sales_history_wholesale s
   LEFT JOIN ip_channel_master c ON c.id = s.channel_id
   WHERE s.txn_date >= '2025-01-01' AND s.txn_date <= '2025-05-18'
     AND (c.channel_code = 'ROF' OR (c.channel_code IS NULL AND s.channel_id IS NULL))
   GROUP BY c.channel_code
   ORDER BY revenue DESC NULLS LAST;`,
  "LY (2025-01-01..2025-05-18) ROF + NULL channel"
);

// 2. ALL channel revenue for LY period (sanity check)
await run(
  `SELECT COALESCE(c.channel_code, '(NULL)') AS channel,
          COUNT(*)::int AS rows,
          ROUND(SUM(s.net_amount)::numeric, 0) AS revenue
   FROM ip_sales_history_wholesale s
   LEFT JOIN ip_channel_master c ON c.id = s.channel_id
   WHERE s.txn_date >= '2025-01-01' AND s.txn_date <= '2025-05-18'
   GROUP BY c.channel_code
   ORDER BY revenue DESC NULLS LAST;`,
  "LY (2025-01-01..2025-05-18) ALL channels"
);

// 3. Where does the data extend back to — earliest txn?
await run(
  `SELECT MIN(txn_date) AS earliest, MAX(txn_date) AS latest, COUNT(*)::int AS total_rows
   FROM ip_sales_history_wholesale;`,
  "Full data window in ip_sales_history_wholesale"
);

// 4. Full 2025 by month — see if early months are missing data
await run(
  `SELECT TO_CHAR(s.txn_date, 'YYYY-MM') AS month,
          COUNT(*)::int AS rows,
          ROUND(SUM(s.net_amount)::numeric, 0) AS revenue
   FROM ip_sales_history_wholesale s
   LEFT JOIN ip_channel_master c ON c.id = s.channel_id
   WHERE s.txn_date >= '2025-01-01' AND s.txn_date <= '2025-12-31'
     AND c.channel_code = 'ROF'
   GROUP BY 1
   ORDER BY 1;`,
  "ROF revenue by month, 2025"
);
