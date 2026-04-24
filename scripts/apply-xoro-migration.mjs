#!/usr/bin/env node
/**
 * Applies 20260427000000_xoro_sync.sql to staging and production.
 * Uses direct PostgreSQL connection (pg package).
 *
 * Usage:
 *   node scripts/apply-xoro-migration.mjs
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

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

const SQL = readFileSync(resolve(ROOT, "supabase/migrations/20260427000000_xoro_sync.sql"), "utf8");

const stagingEnv = loadEnv(".env.staging");
const prodEnv    = loadEnv(".env.local");

const targets = [
  {
    name: "Staging",
    url: stagingEnv.DATABASE_URL ||
      `postgresql://postgres:${stagingEnv.SUPABASE_DB_PASSWORD}@db.${stagingEnv.SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`,
  },
  {
    name: "Production",
    // Derive from project ref in VITE_SUPABASE_URL
    url: (() => {
      const supaUrl = prodEnv.VITE_SUPABASE_URL || "";
      const ref = supaUrl.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1] ?? "qcvqvxxoperiurauoxmp";
      const pass = prodEnv.SUPABASE_DB_PASSWORD || process.env.PROD_DB_PASSWORD || "";
      return `postgresql://postgres:${pass}@db.${ref}.supabase.co:5432/postgres`;
    })(),
  },
];

for (const { name, url } of targets) {
  process.stdout.write(`\n▶ ${name}: connecting … `);
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log("connected");
    await client.query(SQL);
    console.log(`  ✓ migration applied`);
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

console.log("\nDone.");
