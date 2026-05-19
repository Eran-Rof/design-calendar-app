#!/usr/bin/env node
/**
 * Verify channel_id backfill on ip_sales_history_wholesale.
 * Run AFTER post_invoice_detail.py --replace.
 *
 * Reuses the SUPABASE_PAT pattern from scripts/apply-migration.mjs.
 *   node scripts/query-channel-backfill.mjs
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
if (!PAT) { console.error("✗ SUPABASE_PAT missing in .env.local"); process.exit(1); }

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

// Q1: how many rows now have channel_id?
await run(
  `SELECT (channel_id IS NOT NULL) AS has_channel, COUNT(*)::int AS rows
   FROM ip_sales_history_wholesale
   GROUP BY 1
   ORDER BY 1;`,
  "Q1: rows with vs without channel_id (expect mostly TRUE)"
);

// Q2: row count + revenue per channel
await run(
  `SELECT c.channel_code,
          COUNT(s.id)::int               AS sales_rows,
          ROUND(SUM(s.net_amount)::numeric, 2) AS revenue
   FROM ip_channel_master c
   LEFT JOIN ip_sales_history_wholesale s ON s.channel_id = c.id
   WHERE c.channel_code IN ('ROF','ROF ECOM','PT','PT ECOM')
   GROUP BY c.channel_code
   ORDER BY sales_rows DESC NULLS LAST;`,
  "Q2: rows + revenue per channel"
);

// Q3: spot-check the PT split — Shopify psychotuna customer routes to PT ECOM
await run(
  `SELECT cu.name AS customer,
          c.channel_code,
          COUNT(*)::int AS rows
   FROM ip_sales_history_wholesale s
   JOIN ip_customer_master cu ON cu.id = s.customer_id
   JOIN ip_channel_master  c  ON c.id  = s.channel_id
   WHERE cu.name ILIKE 'Shopify psychotuna'
      OR c.channel_code IN ('PT','PT ECOM')
   GROUP BY cu.name, c.channel_code
   ORDER BY rows DESC
   LIMIT 10;`,
  "Q3: PT split sanity-check (Shopify psychotuna should appear under PT ECOM)"
);
