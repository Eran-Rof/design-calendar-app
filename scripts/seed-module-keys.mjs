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

-- Attach the three seed roles' "everywhere" coverage bands to EVERY module_key
-- (idempotent). Without this, a newly-upserted module_key has a row but NO role
-- grant, so under RBAC_MODE=enforce it is forbidden to everyone — including the
-- admin (CEO) — until hand-granted. See migration 20262340000000. admin also has
-- a structural fallback in v_effective_permissions, but seeding keeps the User
-- Access grid's role-default columns truthful and covers viewer/accountant too.
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, a, true
FROM roles r CROSS JOIN module_keys mk CROSS JOIN LATERAL unnest(mk.available_actions) a
WHERE r.name = 'admin'
ON CONFLICT (role_id, module_key, action) DO NOTHING;

INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, 'read', true
FROM roles r CROSS JOIN module_keys mk
WHERE r.name = 'viewer' AND 'read' = ANY (mk.available_actions)
ON CONFLICT (role_id, module_key, action) DO NOTHING;

INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, a.action, true
FROM roles r CROSS JOIN module_keys mk
CROSS JOIN LATERAL (VALUES ('read'), ('export')) AS a(action)
WHERE r.name = 'accountant' AND a.action = ANY (mk.available_actions)
ON CONFLICT (role_id, module_key, action) DO NOTHING;

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
