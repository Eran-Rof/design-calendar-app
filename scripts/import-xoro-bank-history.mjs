#!/usr/bin/env node
// Xoro bank-history mirror backfill (bank reconciliation mirror, 2026-07).
//
// Mirrors Xoro's RECONCILED bank activity (reconciled in Xoro through
// 2026-05-31) into the P6 bank tables — bank_accounts, bank_transactions,
// bank_recon_runs — then auto-matches against the GL and prints an honest
// gap report. See api/_lib/bank-mirror/mirror.js for the full design notes.
//
// WHY THE REGISTER AND NOT THE XORO API (probed 2026-07-08): Xoro's REST
// API exposes NO bank-account / bank-transaction / deposit / payment /
// reconciliation endpoint under any private-app credential we hold. ~30
// path variants probed across all four key pairs; everything outside
// purchaseorder/*, bill/getbill, bill/getitemreceipt returns Xoro's
// out-of-scope signature (HTTP 500 {"Message":"An error has occurred."}).
// bill/getbill carries only header-level AmountPaid — no payment date /
// account grain. The Payments-register export staged in ap_payment_import
// (#1668) IS Xoro's cleared-bank-payment ledger, with stable
// payment_numbers, SOURCE dates, and the Xoro payment account already
// resolved to GL — so the mirror derives from it. When Xoro support opens
// a payments endpoint, or Plaid goes live, the same tables ingest those
// feeds without schema change (see api/_lib/bank-feeds/ingest.js).
//
// Usage:
//   node scripts/import-xoro-bank-history.mjs            full run
//   node scripts/import-xoro-bank-history.mjs --report   report only (no writes)
//
// Idempotent: txn upsert keys on (bank_account_id, payment_number); match
// updates only ever touch status='unmatched' rows; recon runs upsert on
// (bank_account_id, period_id) and never touch operator-owned source='manual'
// rows. Mirror + report only — this script posts NO journal entries.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import {
  runFullMirrorSync,
  ensureMirrorBankAccounts,
  RECONCILED_THROUGH,
} from "../api/_lib/bank-mirror/mirror.js";

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
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) { console.error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

const REPORT_ONLY = process.argv.includes("--report");
const usd = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

async function report() {
  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  const accounts = await ensureMirrorBankAccounts(admin, entity.id);
  console.log("\n═══ Mirror state (read-only) ═══");
  for (const { spec, bank } of accounts.values()) {
    const { count } = await admin.from("bank_transactions")
      .select("id", { count: "exact", head: true })
      .eq("bank_account_id", bank.id);
    console.log(`  ${spec.code}  ${bank.name}: ${count} txns`);
  }
}

async function main() {
  if (REPORT_ONLY) { await report(); return; }

  console.log(`Xoro bank mirror backfill — reconciled through ${RECONCILED_THROUGH}\n`);
  const out = await runFullMirrorSync(admin, {});

  console.log("═══ Accounts ═══");
  for (const a of out.accounts) console.log(`  ${a.code}  ${a.name}`);

  console.log("\n═══ Transaction sync ═══");
  console.log(`  register rows: ${out.sync.staging_rows}, upserted: ${out.sync.upserted}, zero-amount skipped: ${out.sync.skipped_zero}`);
  if (out.sync.excluded.length) {
    console.log(`  EXCLUDED (non-bank GL mapping): ${out.sync.excluded.length}`);
    for (const e of out.sync.excluded.slice(0, 10)) console.log(`    ${e.payment_number} ${e.payment_account} ${usd(e.paid_cents)}`);
  }

  console.log("\n═══ Match ═══");
  console.log(`  pass1 (register JE linkage): ${out.match.pass1}`);
  console.log(`  pass2 (amount+date ±3d):     ${out.match.pass2}`);
  console.log(`  previously matched:          ${out.match.already_matched}`);
  console.log(`  UNMATCHED:                   ${out.match.unmatched}`);
  if (out.match.amount_mismatches.length) {
    console.log(`  amount mismatches (txn vs JE line):`);
    for (const m of out.match.amount_mismatches.slice(0, 10)) console.log(`    ${m.account} ${m.payment}: txn ${usd(m.txn_cents)} vs line ${usd(m.je_line_cents)}`);
  }
  for (const [code, g] of Object.entries(out.match.gl_only)) {
    console.log(`  GL-only lines on ${code}: ${g.n} totaling ${usd(g.net_debit_cents)} (books know, register doesn't)`);
    for (const s of g.sample) console.log(`    ${s.date} ${usd(s.cents)} src=${s.src || "manual"} je=${s.je}`);
  }

  console.log("\n═══ Recon runs (per account × month) ═══");
  console.log(`  upserted ${out.recon.upserted}: ${out.recon.reconciled} reconciled, ${out.recon.flagged} flagged, ${out.recon.in_progress} in progress${out.recon.skipped_manual ? `, ${out.recon.skipped_manual} manual (untouched)` : ""}`);
  const flagged = out.recon_rows.filter((r) => r.status === "flagged");
  if (flagged.length) {
    console.log("  FLAGGED months (GL disagrees with Xoro-reconciled register):");
    for (const r of flagged) console.log(`    ${r.code} ${r.month_end}: GL ${usd(r.gl_cents)} vs register ${usd(r.stmt_cents)} (uncleared ${usd(r.uncleared_cents)}) → diff ${usd(r.diff_cents)}`);
  }
  // Month-end snapshot at the reconciled boundary, per account.
  console.log(`\n═══ Balances as of ${RECONCILED_THROUGH} (register vs GL) ═══`);
  for (const r of out.recon_rows.filter((x) => x.month_end === RECONCILED_THROUGH)) {
    console.log(`  ${r.code}: register ${usd(r.stmt_cents)}  GL ${usd(r.gl_cents)}  diff ${usd(r.diff_cents)}  [${r.status}]`);
  }
  console.log("\nDone. Mirror + report only — no JEs were posted.");
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
