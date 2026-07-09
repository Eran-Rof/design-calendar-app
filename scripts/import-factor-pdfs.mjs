#!/usr/bin/env node
// Factor Module Phase 1 — import the Rosenthal Capital Group monthly PDFs.
//
//   node scripts/import-factor-pdfs.mjs <dir-or-pdf> [more paths...] [--dry-run]
//
// Accepts directories (scanned for "CLIENT RECAP MM.YYYY.pdf" and
// "FACTORED- AR DETAILED MM.YYYY.pdf"; "(1)" duplicate downloads are ignored)
// and/or explicit PDF paths. Text extraction shells out to python+pypdf
// (`python -m pip install pypdf`); parsing lives in
// api/_lib/factor/parseFactorPdfText.js (unit-tested with fixtures).
//
// Idempotent:
//   • factor_statements    — upsert on statement_month
//   • factor_ar_open_items — upsert on (as_of_date, item_num)
//   • factor_customers     — insert-if-missing (never clobbers an operator's
//                            customer_id link)
//
// Each AR-detail load asserts Σ item_balance_cents == the report footer's
// Net OAR (the parser already enforces this; we re-verify from the DB after
// the upsert and print the tie-out table).
//
// Env: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local (PROD).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  parseClientRecap,
  parseArDetail,
  detectReportType,
} from "../api/_lib/factor/parseFactorPdfText.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env.local"), ...process.env };
const SB_URL = env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) {
  console.error("✗ VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)");
  process.exit(1);
}
const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

const PY_EXTRACT = `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
for p in r.pages:
    t = p.extract_text() or ""
    sys.stdout.write(t + "\\n")
`;

function extractPdfText(pdfPath) {
  return execFileSync("python", ["-c", PY_EXTRACT, pdfPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function collectPdfPaths(args) {
  const out = [];
  for (const a of args) {
    const p = resolve(a);
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        if (!/\.pdf$/i.test(name)) continue;
        if (/\(\d+\)\.pdf$/i.test(name)) continue; // "(1)" duplicate downloads
        // Filename patterns vary by vintage: "CLIENT RECAP 07.2025.pdf"
        // (MM.YYYY) vs "Client recap 10.24.pdf" (MM.YY). Case-insensitive,
        // both date shapes; the statement month is ALWAYS taken from the PDF
        // text ("FOR THE MONTH OF …"), never the filename.
        if (/^CLIENT RECAP \d{2}\.\d{2,4}\.pdf$/i.test(name) ||
            /^FACTORED-? AR DETAILED \d{2}\.\d{2,4}\.pdf$/i.test(name)) {
          out.push(join(p, name));
        }
      }
    } else {
      out.push(p);
    }
  }
  return out.sort();
}

const fmt = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");
  if (!args.length) {
    console.error("usage: node scripts/import-factor-pdfs.mjs <dir-or-pdf> [more...] [--dry-run]");
    process.exit(1);
  }

  const pdfs = collectPdfPaths(args);
  if (!pdfs.length) { console.error("✗ no matching PDFs found"); process.exit(1); }
  console.log(`Found ${pdfs.length} PDF(s):`);
  for (const p of pdfs) console.log(`  • ${basename(p)}`);

  const statements = [];
  const details = [];
  for (const p of pdfs) {
    const text = extractPdfText(p);
    const type = detectReportType(text);
    if (type === "client_recap") {
      const row = parseClientRecap(text);
      statements.push({ ...row, source_file: basename(p) });
      console.log(`✓ parsed CLIENT RECAP ${row.statement_month}: net sales ${fmt(row.net_sales_cents)}, ending net OAR ${fmt(row.ending_net_oar_cents)}`);
    } else if (type === "ar_detail") {
      const parsed = parseArDetail(text);
      details.push({ ...parsed, source_file: basename(p) });
      console.log(`✓ parsed AR DETAIL as of ${parsed.as_of_date}: ${parsed.items.length} items, Σ balance ${fmt(parsed.totals.net_oar_cents)} (ties to footer)`);
    } else {
      console.error(`✗ ${basename(p)}: unknown report type — skipped`);
      process.exitCode = 1;
    }
  }

  // ── Month-chain continuity: each month's beginning net OAR must equal the
  //    prior month's ending (only checked across consecutive months present).
  const byMonth = [...statements].sort((a, b) => a.statement_month.localeCompare(b.statement_month));
  for (let k = 1; k < byMonth.length; k++) {
    const prev = byMonth[k - 1];
    const cur = byMonth[k];
    const pd = new Date(prev.statement_month + "T00:00:00Z");
    pd.setUTCMonth(pd.getUTCMonth() + 1);
    if (pd.toISOString().slice(0, 10) !== cur.statement_month) continue; // gap — nothing to chain
    if (prev.ending_net_oar_cents !== cur.beginning_net_oar_cents) {
      console.error(`✗ chain break: ${prev.statement_month} ending ${fmt(prev.ending_net_oar_cents)} ≠ ${cur.statement_month} beginning ${fmt(cur.beginning_net_oar_cents)}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ chain ${prev.statement_month} → ${cur.statement_month}: ${fmt(cur.beginning_net_oar_cents)}`);
    }
  }

  if (dryRun) { console.log("\n--dry-run: no writes."); return; }

  // ── factor_customers: insert any new Rosenthal numbers (never clobber) ──
  const custByNo = new Map();
  for (const d of details) for (const r of d.items) custByNo.set(r.factor_customer_no, r.customer_name);
  if (custByNo.size) {
    const rows = [...custByNo.entries()].map(([factor_customer_no, name]) => ({ factor_customer_no, name }));
    const { error } = await sb.from("factor_customers")
      .upsert(rows, { onConflict: "factor_customer_no", ignoreDuplicates: true });
    if (error) throw new Error(`factor_customers upsert: ${error.message}`);
  }
  const { data: custRows, error: custErr } = await sb.from("factor_customers").select("factor_customer_no, customer_id");
  if (custErr) throw new Error(`factor_customers read: ${custErr.message}`);
  const customerIdByNo = new Map(custRows.map((r) => [r.factor_customer_no, r.customer_id]));

  // ── factor_statements ──
  for (const s of statements) {
    const { raw: _ignore, ...rest } = s;
    const row = {
      ...rest,
      imported_at: new Date().toISOString(),
      raw: { parser: "import-factor-pdfs v1", source_file: s.source_file },
    };
    const { error } = await sb.from("factor_statements").upsert(row, { onConflict: "statement_month" });
    if (error) throw new Error(`factor_statements upsert ${s.statement_month}: ${error.message}`);
    console.log(`↑ factor_statements ${s.statement_month} upserted`);
  }

  // ── factor_ar_open_items ──
  for (const d of details) {
    const rows = d.items.map((r) => ({
      as_of_date: d.as_of_date,
      factor_customer_no: r.factor_customer_no,
      customer_name: r.customer_name,
      item_num: r.item_num,
      item_type: r.item_type,
      po_num: r.po_num,
      item_date: r.item_date,
      due_date: r.due_date,
      terms: r.terms,
      gross_amt_cents: r.gross_amt_cents,
      item_balance_cents: r.item_balance_cents,
      customer_id: customerIdByNo.get(r.factor_customer_no) ?? null,
      imported_at: new Date().toISOString(),
    }));
    const { error } = await sb.from("factor_ar_open_items")
      .upsert(rows, { onConflict: "as_of_date,item_num" });
    if (error) throw new Error(`factor_ar_open_items upsert ${d.as_of_date}: ${error.message}`);
    console.log(`↑ factor_ar_open_items ${d.as_of_date}: ${rows.length} rows upserted`);
  }

  // ── Verify from the DB: Σ item_balance per as_of vs the report footer ──
  console.log("\nTie-out (DB Σ item_balance vs report footer Net OAR):");
  let bad = 0;
  for (const d of details) {
    const { data, error } = await sb.from("factor_ar_open_items")
      .select("item_balance_cents")
      .eq("as_of_date", d.as_of_date)
      .range(0, 9999);
    if (error) throw new Error(`verify read ${d.as_of_date}: ${error.message}`);
    const sum = data.reduce((a, r) => a + Number(r.item_balance_cents), 0);
    const ok = sum === d.totals.net_oar_cents;
    if (!ok) bad += 1;
    console.log(`  ${d.as_of_date}: ${data.length} rows, Σ ${fmt(sum)} vs footer ${fmt(d.totals.net_oar_cents)} ${ok ? "✓ TIES" : "✗ MISMATCH"}${d.totals.oap_cents ? ` (Total OAR ${fmt(d.totals.total_oar_cents)}, OAP ${fmt(d.totals.oap_cents)})` : ""}`);
  }
  if (bad) { console.error(`✗ ${bad} as-of date(s) do not tie`); process.exit(1); }
  console.log("\n✓ import complete");
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
