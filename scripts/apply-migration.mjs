#!/usr/bin/env node
/**
 * Applies a migration SQL file to staging and production via Supabase Management API.
 *
 * Usage:
 *   node scripts/apply-migration.mjs supabase/migrations/20260428000000_label_templates.sql
 *   node scripts/apply-migration.mjs  (applies all unapplied migrations in order)
 */

import { readFileSync, readdirSync } from "fs";
import { resolve, dirname, basename } from "path";
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

if (!PAT) {
  console.error("✗ SUPABASE_PAT not found in .env.local");
  process.exit(1);
}

const PROJECTS = [
  { name: "Production", ref: "qcvqvxxoperiurauoxmp" },
  { name: "Staging",    ref: "jrcnpfpopwjanwmzwmsc" },
];

async function applySQL(sql, label) {
  const results = [];
  for (const { name, ref } of PROJECTS) {
    process.stdout.write(`  ${name} (${ref}) … `);
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      const text = await res.text();
      if (!res.ok) { console.log(`✗ ${text}`); results.push(false); }
      else { console.log("✓"); results.push(true); }
    } catch (e) {
      console.log(`✗ ${e.message}`);
      results.push(false);
    }
  }
  return results.every(Boolean);
}

const files = process.argv.slice(2);

if (files.length === 0) {
  // Apply all migrations in order
  const migDir = resolve(ROOT, "supabase/migrations");
  const all = readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
  for (const f of all) {
    const sql = readFileSync(resolve(migDir, f), "utf8");
    console.log(`\n▶ ${f}`);
    await applySQL(sql, f);
  }
} else {
  for (const file of files) {
    const path = resolve(ROOT, file);
    const sql = readFileSync(path, "utf8");
    console.log(`\n▶ ${basename(file)}`);
    await applySQL(sql, basename(file));
  }
}

console.log("\nDone.");
