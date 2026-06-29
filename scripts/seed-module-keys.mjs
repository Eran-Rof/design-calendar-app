#!/usr/bin/env node
// Upsert the generated Tangerine module mirror into the module_keys DB table on
// PROD. role_permissions.module_key + entity_user_role_overrides.module_key both
// FK-reference module_keys(key), so every nav module must have a backing row or
// ticking its cell in the User Access panel fails. Run AFTER gen-module-keys.mjs.
//
// Run:  node scripts/seed-module-keys.mjs        (uses SUPABASE_PAT, PROD)
//       node scripts/seed-module-keys.mjs --print  (print SQL, no execute)

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { TANGERINE_MODULES } from "../api/_lib/tangerineModules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROD_REF = "qcvqvxxoperiurauoxmp";

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (a) => `ARRAY[${a.map(lit).join(",")}]::text[]`;
const values = TANGERINE_MODULES
  .map((m) => `  (${lit(m.key)}, ${lit(m.display_name)}, ${lit(m.group_name)}, ${m.sort_order}, ${arr(m.available_actions)})`)
  .join(",\n");

const sql = `INSERT INTO module_keys (key, display_name, group_name, sort_order, available_actions) VALUES
${values}
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  group_name = EXCLUDED.group_name,
  sort_order = EXCLUDED.sort_order,
  available_actions = EXCLUDED.available_actions;
SELECT COUNT(*) AS module_keys_total FROM module_keys;`;

if (process.argv.includes("--print")) { console.log(sql); process.exit(0); }

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!PAT) { console.error("✗ SUPABASE_PAT missing"); process.exit(1); }

const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
console.log(`status: ${res.status}`);
console.log(text);
process.exit(res.ok ? 0 : 1);
