#!/usr/bin/env node
// One-time backfill: classify factor-churn on ALL existing factor_chargebacks
// and auto-disposition the OPEN churn rows.
//
//   node scripts/backfills/chargeback_churn_classification.mjs [--dry-run]
//
// Runs the SAME shared pass the importer uses (api/_lib/chargebackChurnSweep.js):
//   1. sets is_factor_churn / churn_kind / churn_pair_id on every row
//      (recourse_610 / offset_pair / factor_admin_code), and
//   2. auto-dispositions OPEN churn rows -> 'valid' with the standard
//      status_history append (actor 'system:churn-auto').
//
// The #1854 pre-2026 rows are already 'valid' and get FLAGS ONLY (the open-only
// guard leaves their disposition untouched). Idempotent: re-run flips 0 rows.
//
// Env: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local (PROD).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { sweepChargebackChurn } from "../../api/_lib/chargebackChurnSweep.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

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
  console.error("x VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const fmt = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main() {
  const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (dryRun) {
    // Read-only preview: classify in memory, report counts, write nothing.
    const { classifyChurn } = await import("../../api/_lib/chargebackMatch.js");
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("factor_chargebacks")
        .select("id, item_num, amount_cents, reason, reason_code, cb_date, item_type, disposition, status_history")
        .order("id", { ascending: true }).range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const cls = classifyChurn(rows);
    const counts = { recourse_610: 0, offset_pair: 0, factor_admin_code: 0 };
    let openChurn = 0, openChurnCents = 0;
    for (const r of rows) {
      const c = cls.get(r.id);
      if (!c) continue;
      counts[c.kind] += 1;
      const hasHist = Array.isArray(r.status_history) && r.status_history.some((e) => e && e.field === "disposition");
      if (r.disposition === "open" && !hasHist) { openChurn += 1; openChurnCents += Number(r.amount_cents) || 0; }
    }
    console.log(`--dry-run over ${rows.length} rows:`);
    console.log(`  offset_pair=${counts.offset_pair}  recourse_610=${counts.recourse_610}  factor_admin_code=${counts.factor_admin_code}`);
    console.log(`  would auto-disposition ${openChurn} OPEN churn row(s) (${fmt(openChurnCents)}) -> valid`);
    return;
  }

  const res = await sweepChargebackChurn(sb, { actor: "system:churn-auto", log: (m) => console.log(`  ${m}`) });
  console.log("Backfill complete:");
  console.log(`  scanned ${res.scanned} rows`);
  console.log(`  offset_pair=${res.classified.offset_pair}  recourse_610=${res.classified.recourse_610}  factor_admin_code=${res.classified.factor_admin_code}  (non-churn=${res.classified.none})`);
  console.log(`  ${res.flag_updates} annotation update(s)`);
  console.log(`  auto-dispositioned ${res.auto_dispositioned} OPEN churn row(s) (${fmt(res.auto_dispositioned_cents)}) -> valid`);
}

main().catch((e) => { console.error(`x ${e.message}`); process.exit(1); });
