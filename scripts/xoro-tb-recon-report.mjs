#!/usr/bin/env node
// xoro-tb-recon-report.mjs (#xoro-gl-truth)
//
// Produce the Xoro-vs-Tangerine monthly TB variance deliverable from
// v_xoro_tangerine_tb_recon (OPERATING scope — excludes closing/opening/
// distribution) + v_xoro_opening_balances + v_xoro_tb_unmapped. Writes:
//   docs/tangerine/xoro-tangerine-tb-recon.csv   — every (month, account) with
//     xoro/tangerine net-debit, variance, and SUBLEDGER-vs-GL-ONLY class.
//   docs/tangerine/xoro-tb-gl-only-backfill.csv  — the GL-ONLY backfill design:
//     per (category, month) the $ Tangerine is missing (would be posted).
//   docs/tangerine/xoro-tb-unmapped.csv          — Xoro names needing a map.
//   docs/tangerine/xoro-opening-balances.csv     — 8/31/2024 opening balances
//     (Xoro equity-touching entries) by account — the BS opening backfill source.
// Plus a console summary. Queries run through the Supabase Management API
// (SUPABASE_PAT) because the views aggregate ~700K mirror rows and exceed the
// PostgREST statement timeout.
//
// CLASSIFICATION (per (month, account) variance cell):
//   BS-OPENING              balance-sheet account (1/2/3/9xxx) — variance is the
//                           un-booked 8/31/2024 opening + subledger timing.
//   SUBLEDGER-DRIVEN        account Tangerine feeds from AR/AP (main revenue
//                           40xx, channel COGS 501x, and any expense Tangerine
//                           already posts) — variance = mapping/timing/defect,
//                           fixable in the subledger.
//   GL-ONLY:<category>      never came through a subledger — Xoro posted it in
//                           the GL and Tangerine has ~nothing. Categories:
//                           COGS-ADJ (5001-5006/5020-5023), FREIGHT (54xx),
//                           SAMPLES (52xx), DILUTION (41xx revenue contra),
//                           RETURNS-CHARGEBACKS (42xx), OTHER-INCOME (49xx),
//                           PAYROLL/BADDEBT (name), OTHER (residual Xoro-only).
//   The GL-ONLY variance IS the backfill amount — post it (source-dated) to make
//   Tangerine match Xoro. (Design only here; the CEO reviews before posting.)

import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
function loadEnv(f) {
  try {
    return Object.fromEntries(readFileSync(resolve(ROOT, f), "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local"), ...loadEnv(".env.staging") };
const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
if (!PAT) { console.error("SUPABASE_PAT missing (.env.local/.env.staging)"); process.exit(1); }
const PROD_REF = "qcvqvxxoperiurauoxmp";

async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`query failed ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

// GL-ONLY category by ROF code / name (see header).
function classify(code, name, tangNetDebit) {
  const c = String(code || "");
  const nm = String(name || "");
  if (/^[123]/.test(c) || /^9/.test(c)) return "BS-OPENING";
  if (/^(5001|5002|5003|5004|5005|5006|5020|5021|5022|5023)$/.test(c)) return "GL-ONLY:COGS-ADJ";
  if (/^54/.test(c)) return "GL-ONLY:FREIGHT";
  if (/^52/.test(c)) return "GL-ONLY:SAMPLES";
  if (/^41/.test(c)) return "GL-ONLY:DILUTION";
  if (/^42/.test(c)) return "GL-ONLY:RETURNS-CHARGEBACKS";
  if (/^49/.test(c)) return "GL-ONLY:OTHER-INCOME";
  if (/^40/.test(c)) return "SUBLEDGER:REVENUE";
  if (/^501/.test(c)) return "SUBLEDGER:COGS";
  if (/payroll|wages|salary|commission|payroll tax|bad debt/i.test(nm)) return "GL-ONLY:PAYROLL/BADDEBT";
  return Math.abs(Number(tangNetDebit || 0)) > 100 ? "SUBLEDGER-DRIVEN" : "GL-ONLY:OTHER";
}

async function main() {
  const rows = await q("select to_char(month,'YYYY-MM') as month, gl_code, gl_name, xoro_net_debit, tang_net_debit, variance, is_pl from v_xoro_tangerine_tb_recon order by abs(variance) desc");
  const unmapped = await q("select to_char(month,'YYYY-MM') as month, accounting_name, accounting_type_name, legs, net_debit from v_xoro_tb_unmapped order by abs(net_debit) desc");
  const opening = await q("select gl_code, accounting_name, accounting_type_name, round(sum(net_debit)::numeric,2) as net_debit from v_xoro_opening_balances where month <= '2024-09-01' group by 1,2,3 order by abs(sum(net_debit)) desc");

  const out = [["month", "gl_code", "gl_name", "class", "xoro_net_debit", "tangerine_net_debit", "variance"].join(",")];
  for (const r of rows) {
    const cls = classify(r.gl_code, r.gl_name, r.tang_net_debit);
    out.push([r.month, r.gl_code, esc(r.gl_name), cls, money(r.xoro_net_debit), money(r.tang_net_debit), money(r.variance)].join(","));
  }
  const p1 = resolve(ROOT, "docs/tangerine/xoro-tangerine-tb-recon.csv");
  mkdirSync(dirname(p1), { recursive: true });
  writeFileSync(p1, out.join("\n") + "\n");

  const backfill = new Map();
  const catTotal = new Map();
  for (const r of rows) {
    const cls = classify(r.gl_code, r.gl_name, r.tang_net_debit);
    if (!cls.startsWith("GL-ONLY")) continue;
    const v = Math.round(Number(r.variance) * 100);
    if (!backfill.has(cls)) backfill.set(cls, new Map());
    backfill.get(cls).set(r.month, (backfill.get(cls).get(r.month) || 0) + v);
    catTotal.set(cls, (catTotal.get(cls) || 0) + v);
  }
  const bf = [["category", "month", "backfill_net_debit"].join(",")];
  for (const [cat, mm] of [...backfill.entries()].sort((a, b) => Math.abs(catTotal.get(b[0])) - Math.abs(catTotal.get(a[0])))) {
    for (const [m, c] of [...mm.entries()].sort()) bf.push([cat, m, money(c / 100)].join(","));
  }
  const p2 = resolve(ROOT, "docs/tangerine/xoro-tb-gl-only-backfill.csv");
  writeFileSync(p2, bf.join("\n") + "\n");

  const uout = [["month", "xoro_accounting_name", "xoro_type", "legs", "net_debit"].join(",")];
  for (const u of unmapped) uout.push([u.month, esc(u.accounting_name), esc(u.accounting_type_name), u.legs, money(u.net_debit)].join(","));
  writeFileSync(resolve(ROOT, "docs/tangerine/xoro-tb-unmapped.csv"), uout.join("\n") + "\n");

  const oout = [["gl_code", "xoro_account", "xoro_type", "opening_net_debit"].join(",")];
  for (const o of opening) oout.push([o.gl_code, esc(o.accounting_name), esc(o.accounting_type_name), money(o.net_debit)].join(","));
  writeFileSync(resolve(ROOT, "docs/tangerine/xoro-opening-balances.csv"), oout.join("\n") + "\n");

  const cents = (n) => Math.round(Number(n || 0) * 100);
  const byClass = new Map();
  let plMatch = 0, plCells = 0;
  for (const r of rows) {
    const cls = classify(r.gl_code, r.gl_name, r.tang_net_debit);
    byClass.set(cls, (byClass.get(cls) || 0) + Math.abs(cents(r.variance)));
    if (r.is_pl) { plCells += 1; if (Math.abs(cents(r.variance)) <= 100) plMatch += 1; }
  }
  console.log(`recon cells: ${rows.length}; P&L cells within $1.00: ${plMatch}/${plCells}`);
  console.log("\nabs variance by class (all 24 months):");
  for (const [cls, c] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${cls.padEnd(28)} $${money(c / 100)}`);
  console.log("\nGL-ONLY backfill design — net $ Tangerine is missing, by category:");
  for (const [cat, tot] of [...catTotal.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    console.log(`  ${cat.padEnd(28)} net_debit $${money(tot / 100)} over ${backfill.get(cat).size} months`);
  }
  console.log("\ntop 15 operating P&L variances:");
  for (const r of rows.filter((r) => r.is_pl).slice(0, 15)) {
    console.log(`  ${r.month} ${r.gl_code} ${String(r.gl_name).slice(0, 26).padEnd(26)} var $${money(r.variance)} (${classify(r.gl_code, r.gl_name, r.tang_net_debit)})`);
  }
  console.log(`\nCSV -> ${p1}\nCSV -> ${p2}\nunmapped names: ${unmapped.length}; opening-balance accounts: ${opening.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
