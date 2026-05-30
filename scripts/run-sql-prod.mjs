#!/usr/bin/env node
// One-shot: read a .sql file, run it on PROD only via Supabase Management
// API, print the response JSON so we see SELECT result counts.
// Used 2026-05-30 for legacy apparel_dims_required cleanup.
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n")
      .filter(l => l.includes("=") && !l.startsWith("#"))
      .map(l => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!PAT) { console.error("✗ SUPABASE_PAT missing"); process.exit(1); }

const PROD_REF = "qcvqvxxoperiurauoxmp";
const file = process.argv[2];
if (!file) { console.error("usage: node scripts/run-sql-prod.mjs <path.sql>"); process.exit(1); }
const sql = readFileSync(resolve(file), "utf8");

const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
console.log(`status: ${res.status}`);
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
catch { console.log(text); }
process.exit(res.ok ? 0 : 1);
