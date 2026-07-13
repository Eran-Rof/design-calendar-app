#!/usr/bin/env node
// build-xoro-account-map.mjs (#xoro-gl-truth)
//
// Populate the xoro_account_map bridge table (Xoro GL account path -> ROF COA)
// used by v_xoro_tangerine_tb_recon. Reads every DISTINCT accounting_name from
// the xoro_gl_transactions mirror and resolves it with the SAME deterministic
// resolver the AP feed uses (api/_lib/accounting/xoroAccountMap.js) — exact
// leaf/code matching + the curated XORO_TO_ROF_CODE dictionary. Unresolved
// names are stored with gl_code = NULL (surfaced by v_xoro_tb_unmapped; never
// guessed). Idempotent upsert; re-run after each mirror walk to pick up new
// account names.
//
// Usage: node scripts/build-xoro-account-map.mjs [--report]

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { buildXoroAccountResolver } from "../api/_lib/accounting/xoroAccountMap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
function loadEnv(f) {
  try {
    return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) { console.error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });
const REPORT = process.argv.includes("--report");

async function fetchAll(table, select, mod = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select(select).range(from, from + 999);
    q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) throw new Error("ROF entity not found");
  const accts = await fetchAll("gl_accounts", "id, code, name, is_postable, is_control, status",
    (q) => q.eq("entity_id", entity.id));
  const resolve1 = buildXoroAccountResolver(accts);

  // Distinct (accounting_name -> type) from the mirror. Keyset-page over id so
  // we cover every row regardless of table size (distinct names are only a few
  // hundred, but the mirror is ~700K rows so we must scan all of them).
  const names = new Map();
  let last = 0;
  for (;;) {
    const { data, error } = await admin.from("xoro_gl_transactions")
      .select("id, accounting_name, accounting_type_name")
      .gt("id", last).order("id", { ascending: true }).limit(1000);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    for (const r of data) { if (r.accounting_name) names.set(r.accounting_name, r.accounting_type_name); last = r.id; }
    if (data.length < 1000) break;
  }

  let mapped = 0, unmapped = 0;
  const rows = [];
  for (const [name, type] of names) {
    const hit = resolve1(name);
    if (hit) { mapped += 1; rows.push({ xoro_accounting_name: name, gl_account_id: hit.account.id, gl_code: hit.account.code, gl_name: hit.account.name, via: hit.via, xoro_type_name: type, updated_at: new Date().toISOString() }); }
    else { unmapped += 1; rows.push({ xoro_accounting_name: name, gl_account_id: null, gl_code: null, gl_name: null, via: "unmapped", xoro_type_name: type, updated_at: new Date().toISOString() }); }
  }

  if (REPORT) {
    console.log(`distinct Xoro account names: ${names.size}; mapped ${mapped}, unmapped ${unmapped}`);
    console.log("unmapped names:");
    for (const r of rows.filter((r) => !r.gl_code)) console.log(`  ${r.xoro_accounting_name}  [${r.xoro_type_name}]`);
    return;
  }

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from("xoro_account_map").upsert(rows.slice(i, i + 200), { onConflict: "xoro_accounting_name" });
    if (error) throw new Error(`upsert failed: ${error.message}`);
  }
  console.log(`xoro_account_map: ${rows.length} names upserted (${mapped} mapped, ${unmapped} unmapped)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
