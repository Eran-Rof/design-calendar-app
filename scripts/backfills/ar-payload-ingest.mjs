#!/usr/bin/env node
/**
 * One-shot historical sweep of the CURRENT open-invoice universe: archive every
 * reachable invoice/getinvoice payload into raw_xoro_payloads(endpoint=
 * 'sales-history') so ar-sizegrain-explode.mjs can explode more AR invoices to
 * per-size lines. Same engine as the nightly cron (api/_handlers/cron/
 * ar-payload-ingest.js) — shares api/_lib/xoro-mirror/ar-payload-ingest.js.
 *
 * ⚠️ invoice/getinvoice returns ONLY open invoices (verified #1824); this
 * captures what is reachable RIGHT NOW. Closed history is a permanent residual.
 * Idempotent: skips invoices already archived, so re-running is safe and cheap.
 *
 * Requires the SALES Xoro credentials (module=sales). Locally, seed .env.local
 * with VITE_XORO_SALES_API_KEY / _SECRET (Vercel already has them wired).
 *
 * Usage:
 *   node scripts/backfills/ar-payload-ingest.mjs                 # full walk
 *   node scripts/backfills/ar-payload-ingest.mjs --page-start=1 --max-pages=60
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll, xoroCredsFromEnv } from "../../api/_lib/xoro-client.js";
import {
  sweepOpenInvoicePayloads,
  makeXoroInvoiceFetchPage,
} from "../../api/_lib/xoro-mirror/ar-payload-ingest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(
      text.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
    );
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local") };
for (const [k, v] of Object.entries(env)) if (process.env[k] == null) process.env[k] = v;

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}

const SB_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) {
  console.error("x VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)");
  process.exit(1);
}
const creds = xoroCredsFromEnv("sales");
if (!creds.ok) {
  console.error(`x Xoro SALES credentials missing: ${creds.error}. Seed VITE_XORO_SALES_API_KEY / _SECRET.`);
  process.exit(2);
}

const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
const pageStart = Math.max(1, parseInt(arg("page-start", "1"), 10) || 1);
const maxPages = Math.min(Math.max(1, parseInt(arg("max-pages", "60"), 10) || 60), 500);

console.log(`AR payload ingest — open-invoice sweep (page_start=${pageStart}, max_pages=${maxPages})`);
const fetchPage = makeXoroInvoiceFetchPage(fetchXoroAll, { perPage: 100, module: "sales" });
const summary = await sweepOpenInvoicePayloads(
  { fetchPage, admin },
  { pageStart, maxPages, batchSize: 50, log: (m) => console.log(`  ${m}`) },
);
console.log("\nRESULT:");
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.errors.length === 0 ? 0 : 1);
