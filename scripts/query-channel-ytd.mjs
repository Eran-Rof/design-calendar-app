#!/usr/bin/env node
/**
 * YTD 2026 sales per channel — used to reconcile against ATS report totals.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(
      text.split("\n")
        .filter(l => l.includes("=") && !l.startsWith("#"))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
    );
  } catch { return {}; }
}

const env = { ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
const PROD_REF = "qcvqvxxoperiurauoxmp";

async function run(sql, label) {
  console.log(`\n▶ ${label}`);
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) { console.log(`✗ ${text}`); return; }
  try { console.table(JSON.parse(text)); } catch { console.log(text); }
}

// YTD 2026 totals per channel
await run(
  `SELECT COALESCE(c.channel_code, '(NULL)') AS channel,
          COUNT(s.id)::int AS rows,
          ROUND(SUM(s.net_amount)::numeric, 0) AS revenue
   FROM ip_sales_history_wholesale s
   LEFT JOIN ip_channel_master c ON c.id = s.channel_id
   WHERE s.txn_date >= '2026-01-01' AND s.txn_date <= '2026-05-18'
   GROUP BY c.channel_code
   ORDER BY revenue DESC NULLS LAST;`,
  "YTD 2026 (Jan 1 – May 18) revenue per channel"
);

// Grand total YTD
await run(
  `SELECT COUNT(*)::int AS rows,
          ROUND(SUM(net_amount)::numeric, 0) AS total_revenue
   FROM ip_sales_history_wholesale
   WHERE txn_date >= '2026-01-01' AND txn_date <= '2026-05-18';`,
  "YTD 2026 total (all channels)"
);

// Sanity: ROF + PT only (what user expects to be ~$6.8M)
await run(
  `SELECT ROUND(SUM(s.net_amount)::numeric, 0) AS rof_plus_pt_revenue,
          COUNT(*)::int AS rows
   FROM ip_sales_history_wholesale s
   JOIN ip_channel_master c ON c.id = s.channel_id
   WHERE s.txn_date >= '2026-01-01' AND s.txn_date <= '2026-05-18'
     AND c.channel_code IN ('ROF', 'PT');`,
  "YTD 2026 — ROF + PT combined (wholesale only)"
);
