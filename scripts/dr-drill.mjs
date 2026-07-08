#!/usr/bin/env node
// scripts/dr-drill.mjs — repeatable disaster-recovery drill (see docs/tangerine/DR-RUNBOOK.md).
//
// Extracts the GL-critical tables from PROD via the Supabase Management API,
// restores them into an isolated drill schema on STAGING, and verifies row
// counts + the debit/credit checksum reproduce prod exactly. Proves the
// extract→load→verify path works and times it. Run at least quarterly:
//
//   node scripts/dr-drill.mjs
//
// Non-destructive: prod is read-only; staging gets a dr_drill_<date> schema
// (previous drill schema is dropped). Requires SUPABASE_PAT in .env.local.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROD = "qcvqvxxoperiurauoxmp";
const STAG = "jrcnpfpopwjanwmzwmsc";
const TABLES = ["gl_accounts", "journal_entries", "journal_entry_lines"];

function pat() {
  for (const f of [".env.local", ".env.staging"]) {
    try {
      const line = readFileSync(resolve(ROOT, f), "utf8").split("\n").find((l) => l.startsWith("SUPABASE_PAT"));
      if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    } catch { /* next */ }
  }
  console.error("✗ SUPABASE_PAT not found"); process.exit(2);
}
const PAT = pat();

async function sql(ref, query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`${ref} sql ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const t0 = Date.now();
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const schema = `dr_drill_${stamp}`;

const dumps = {};
for (const t of TABLES) dumps[t] = (await sql(PROD, `select json_agg(x) as j from (select * from ${t}) x`))[0]?.j || [];
const src = (await sql(PROD, `select count(*)::int as n, coalesce(sum(debit),0)::numeric(18,2) as dr, coalesce(sum(credit),0)::numeric(18,2) as cr from journal_entry_lines`))[0];

await sql(STAG, `drop schema if exists ${schema} cascade; create schema ${schema};`);
for (const t of TABLES) {
  await sql(STAG, `create table ${schema}.${t} (doc jsonb not null)`);
  for (let i = 0; i < dumps[t].length; i += 250) {
    const chunk = JSON.stringify(dumps[t].slice(i, i + 250)).replace(/'/g, "''");
    await sql(STAG, `insert into ${schema}.${t} (doc) select jsonb_array_elements('${chunk}'::jsonb)`);
  }
}
const v = {};
for (const t of TABLES) v[t] = (await sql(STAG, `select count(*)::int as n from ${schema}.${t}`))[0].n;
const chk = (await sql(STAG,
  `select count(*)::int as n,
          coalesce(sum((doc->>'debit')::numeric),0)::numeric(18,2) as dr,
          coalesce(sum((doc->>'credit')::numeric),0)::numeric(18,2) as cr
   from ${schema}.journal_entry_lines`))[0];

const ok = TABLES.every((t) => v[t] === dumps[t].length) && chk.dr === src.dr && chk.cr === src.cr && chk.n === src.n;
console.log("prod:", TABLES.map((t) => `${t}=${dumps[t].length}`).join(" "), "| lines", JSON.stringify(src));
console.log("staging:", JSON.stringify(v), "| lines", JSON.stringify(chk));
console.log(ok ? "DRILL PASS" : "DRILL FAIL", `— ${((Date.now() - t0) / 1000).toFixed(1)}s — schema ${schema} on staging`);
process.exit(ok ? 0 : 1);
