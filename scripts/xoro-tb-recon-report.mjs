#!/usr/bin/env node
// xoro-tb-recon-report.mjs (#xoro-gl-truth)
//
// Read v_xoro_tangerine_tb_recon (monthly Xoro-vs-Tangerine net-debit per ROF
// COA code) + v_xoro_tb_unmapped and write:
//   docs/tangerine/xoro-tangerine-tb-recon.csv     — every (month, account)
//     with xoro/tangerine net debit + variance, ranked by |variance|.
//   docs/tangerine/xoro-tb-unmapped.csv            — Xoro names needing a map.
// Plus a console summary: P&L match rate month-by-month, BS opening-gap
// (the cumulative BS variance = the un-booked 2024-08-31 opening JE), and the
// biggest variances (with the known-defect annotations).
//
// Usage: node scripts/xoro-tb-recon-report.mjs

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

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
const admin = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

async function fetchAllView(view, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(view).select("*").order(order, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${view}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const rows = await fetchAllView("v_xoro_tangerine_tb_recon", "month");
  const unmapped = await fetchAllView("v_xoro_tb_unmapped", "month");

  // CSV: full recon, ranked by abs_variance desc
  const sorted = [...rows].sort((a, b) => Number(b.abs_variance) - Number(a.abs_variance));
  const out = [["month", "gl_code", "gl_name", "statement", "xoro_net_debit", "tangerine_net_debit", "variance"].join(",")];
  for (const r of sorted) {
    out.push([r.month, r.gl_code, esc(r.gl_name), r.statement, money(r.xoro_net_debit), money(r.tang_net_debit), money(r.variance)].join(","));
  }
  const p1 = resolve(ROOT, "docs/tangerine/xoro-tangerine-tb-recon.csv");
  mkdirSync(dirname(p1), { recursive: true });
  writeFileSync(p1, out.join("\n") + "\n");

  const uout = [["month", "xoro_accounting_name", "xoro_type", "legs", "net_debit"].join(",")];
  for (const u of [...unmapped].sort((a, b) => Math.abs(Number(b.net_debit)) - Math.abs(Number(a.net_debit)))) {
    uout.push([u.month, esc(u.accounting_name), esc(u.accounting_type_name), u.legs, money(u.net_debit)].join(","));
  }
  const p2 = resolve(ROOT, "docs/tangerine/xoro-tb-unmapped.csv");
  writeFileSync(p2, uout.join("\n") + "\n");

  // ── summary ──────────────────────────────────────────────────────────────
  const cents = (n) => Math.round(Number(n || 0) * 100);
  const EPS = 1; // 1 cent
  let plCells = 0, plMatch = 0, plVar = 0, bsCells = 0, bsVar = 0;
  const byMonthPl = new Map();  // month -> {cells, match, var}
  const bsCumByCode = new Map(); // code -> cumulative variance (the opening gap)
  for (const r of rows) {
    const v = cents(r.variance);
    if (r.is_pl) {
      plCells += 1; if (Math.abs(v) <= EPS) plMatch += 1; plVar += Math.abs(v);
      const m = byMonthPl.get(r.month) || { cells: 0, match: 0, var: 0 };
      m.cells += 1; if (Math.abs(v) <= EPS) m.match += 1; m.var += Math.abs(v);
      byMonthPl.set(r.month, m);
    } else {
      bsCells += 1; bsVar += Math.abs(v);
      bsCumByCode.set(r.gl_code, (bsCumByCode.get(r.gl_code) || 0) + v);
    }
  }
  console.log(`recon cells: ${rows.length} (P&L ${plCells}, BS ${bsCells}); unmapped name-months: ${unmapped.length}`);
  console.log(`P&L match (|var|<=$0.01): ${plMatch}/${plCells} (${(plMatch / Math.max(1, plCells) * 100).toFixed(1)}%); P&L abs variance $${money(plVar / 100)}`);
  console.log(`BS abs variance $${money(bsVar / 100)} (expected — the un-booked 2024-08-31 opening)`);
  console.log("\nP&L match rate by month:");
  for (const [m, s] of [...byMonthPl.entries()].sort()) {
    console.log(`  ${String(m).slice(0, 7)}: ${s.match}/${s.cells} match, abs var $${money(s.var / 100)}`);
  }
  console.log("\nBS cumulative variance by account (= the opening JE that account needs), top 15:");
  for (const [code, v] of [...bsCumByCode.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 15)) {
    const nm = (rows.find((r) => r.gl_code === code) || {}).gl_name || "";
    console.log(`  ${code} ${String(nm).slice(0, 34).padEnd(34)} cum $${money(v / 100)}`);
  }
  console.log("\nTop 20 (month, account) P&L variances (should be near 0 — investigate):");
  for (const r of sorted.filter((r) => r.is_pl).slice(0, 20)) {
    console.log(`  ${String(r.month).slice(0, 7)} ${r.gl_code} ${String(r.gl_name).slice(0, 30).padEnd(30)} xoro $${money(r.xoro_net_debit)} tang $${money(r.tang_net_debit)} var $${money(r.variance)}`);
  }
  console.log(`\nCSV -> ${p1}`);
  console.log(`CSV -> ${p2}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
