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
import { parseXoroAccountName } from "../api/_lib/accounting/xoroAccountMap.js";

// Curated Xoro-name -> ROF code map for the TB RECON. Unlike the AP classifier
// (which resolves only postable, non-control expense accounts), the recon must
// bridge STRUCTURAL / control / balance-sheet accounts too. Keys are lowercased
// (leaf or full). Only high-confidence structural correspondences — everything
// else falls to exact name/code auto-match or is reported unmapped.
const RECON_MAP = {
  // Banks: Xoro's "Bank Leumi" register names post to the VALLEY GL accounts (#1671).
  "bank leumi  7801 main": "1001",
  "bank leumi 7801 main": "1001",
  "bank leumi 1300 payroll account": "1002",
  "bank leumi 1500 web account": "1003",
  // COGS: Xoro's bare/boys COGS -> ROF main / kids COGS.
  "cogs": "5001",
  "cost of goods sold boys": "5011",
  // Inventory asset (also in the AP classifier map).
  "inventory": "1201",
  // Revenue: Xoro channels -> ROF revenue routing (business correspondence;
  // recon variance will flag any mis-map for CEO review — marked via 'recon-map').
  "revenue": "4005",
  "sales": "4005",
  "sales revenue - website": "4011",
  "sales revenue - boys": "4006",
};

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
  // Broadened recon resolver: match across ALL active accounts (INCLUDING
  // control / balance-sheet, unlike the AP classifier), so AR (1105/07/08),
  // AP (2000) and other structural accounts bridge by exact name/code.
  const active = accts.filter((a) => a && a.status === "active");
  const byCode = new Map();
  for (const a of active) if (!byCode.has(String(a.code))) byCode.set(String(a.code), a);
  const AMB = Symbol("amb");
  const byName = new Map();
  for (const a of active) {
    const k = String(a.name || "").trim().toLowerCase();
    if (k) byName.set(k, byName.has(k) ? AMB : a);
  }
  const resolve1 = (raw) => {
    const p = parseXoroAccountName(raw);
    if (!p) return null;
    const leafKey = p.leaf.toLowerCase();
    const nameKey = p.name.toLowerCase();
    // 1. curated recon map (leaf or full)
    const code = RECON_MAP[leafKey] ?? RECON_MAP[nameKey] ?? RECON_MAP[String(raw).trim().toLowerCase()];
    if (code && byCode.get(String(code))) return { account: byCode.get(String(code)), via: "recon-map" };
    // 2. code + name agree
    if (p.code) { const a = byCode.get(p.code); if (a && String(a.name).trim().toLowerCase() === nameKey) return { account: a, via: "code+name" }; }
    // 3. unique exact name (code prefix stripped)
    const n = byName.get(nameKey); if (n && n !== AMB) return { account: n, via: "name" };
    // 4. unique exact whole-leaf
    const l = byName.get(leafKey); if (l && l !== AMB) return { account: l, via: "leaf" };
    return null;
  };

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
