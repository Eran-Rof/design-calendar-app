#!/usr/bin/env node
// Factor Module Phase 2 — post the monthly factoring-cost JEs from
// factor_statements (Rosenthal CLIENT RECAP economics).
//
//   node scripts/post-factor-cost-jes.mjs [--dry-run] [--months=2024-10,2025-09]
//
// Per statement month M (accrual):
//   DR 6802 Factor Commissions Expense   commissions_cents
//   DR 6804 Factor Interest Expense      interest_cents + prior_month_interest_adj_cents
//   DR 6803 Factor Exp - Other           facility_fees_cents + facility_other_cents
//   CR 1051 Factor Advances - Rosenthal  (total — the factor charges costs to the loan)
//
// Why NOT fees_other_cents (the recap "(FACILITY)" total): that line is
// ACCRUED INTEREST (the PRIOR month's interest now charged to the loan) +
// FEES + OTHER — posting it whole would double-count interest. Interest is
// expensed in its ACCRUAL month (TOTAL INTEREST "*will be charged to your
// loan next month*" + the prior-month adjustment); only FEES+OTHER are new
// cost in M. Chargebacks/creditbacks are AR-side (customer deductions), NOT
// factoring cost — excluded by design.
//
// A negative component posts on the credit side of its expense account (sign
// flip, e.g. a fee refund). Explicit EXCLUDED_OTHER months are skipped from
// the 6803 line entirely (documented anomalies, not expense).
//
// JE date = statement month-end (SOURCE dates — never today). T11 audit
// reason on every post. Idempotent: one JE per month keyed by
// (source_module='factor_recap', source_id=<statement_month>).
//
// Env: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (JWT — the sb_secret_*
// key in .env.local is rejected by PostgREST; reveal the legacy JWT via the
// Management API and export it).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

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
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Documented per-month exclusions from the 6803 fees/other line.
const EXCLUDED_OTHER = {
  // Oct-24 facility OTHER is a one-off −$188,930.78 CREDIT to the loan —
  // three orders of magnitude beyond every other month's OTHER ($54–$352)
  // and clearly not a fee. Booking it as negative factoring expense would
  // misstate Oct-24 P&L. Excluded pending CEO / Rosenthal clarification
  // (memory: project_factor_phase2). The loan (1051) itself is unaffected —
  // 1051 activity posts from actual cash events, not from this JE.
  "2024-10-01": "one-off -$188,930.78 facility OTHER credit (unexplained; not a fee)",
};

const fmt = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const dollars = (c) => (Math.abs(c) / 100).toFixed(2);

function monthEndISO(statementMonth) {
  const [y, m] = statementMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

function monthLabel(statementMonth) {
  const [y, m] = statementMonth.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Expense line with sign handling: positive → debit, negative → credit. */
function expenseLine(lineNumber, accountId, cents) {
  return cents >= 0
    ? { line_number: lineNumber, account_id: accountId, debit: dollars(cents), credit: "0" }
    : { line_number: lineNumber, account_id: accountId, debit: "0", credit: dollars(cents) };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const monthsArg = (process.argv.find((a) => a.startsWith("--months=")) || "").slice(9);
  const onlyMonths = monthsArg ? new Set(monthsArg.split(",").map((m) => `${m.trim()}-01`)) : null;

  const { data: entity, error: entErr } = await sb.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (entErr || !entity) throw new Error("Default entity (ROF) not found");

  const { data: accts, error: aErr } = await sb.from("gl_accounts")
    .select("id, code, name").eq("entity_id", entity.id).in("code", ["6802", "6803", "6804", "1051"]);
  if (aErr) throw new Error(aErr.message);
  const acct = new Map((accts || []).map((a) => [a.code, a]));
  for (const code of ["6802", "6803", "6804", "1051"]) {
    if (!acct.get(code)) throw new Error(`GL account ${code} not found in the chart`);
  }

  const { data: stmts, error: sErr } = await sb.from("factor_statements")
    .select("statement_month, commissions_cents, interest_cents, prior_month_interest_adj_cents, facility_fees_cents, facility_other_cents")
    .order("statement_month", { ascending: true });
  if (sErr) throw new Error(sErr.message);

  let grand = 0;
  const results = [];
  for (const s of stmts || []) {
    if (onlyMonths && !onlyMonths.has(s.statement_month)) continue;

    const commissions = Number(s.commissions_cents || 0);
    const interest = Number(s.interest_cents || 0) + Number(s.prior_month_interest_adj_cents || 0);
    const excluded = EXCLUDED_OTHER[s.statement_month];
    const feesOther = excluded ? 0 : Number(s.facility_fees_cents || 0) + Number(s.facility_other_cents || 0);
    const total = commissions + interest + feesOther;
    if (total === 0 && commissions === 0 && interest === 0 && feesOther === 0) {
      results.push({ month: s.statement_month, status: "skipped (all zero)" });
      continue;
    }

    // Idempotency: one factoring-cost JE per statement month. NOTE: a failed
    // read must NOT fall through to a post (the uq_je_source_basis constraint
    // is the backstop, but we want the loud error here).
    const { data: existing, error: exErr } = await sb.from("journal_entries")
      .select("id")
      .eq("source_module", "factor_recap").eq("source_id", s.statement_month)
      .maybeSingle();
    if (exErr) throw new Error(`existence check ${s.statement_month}: ${exErr.message}`);
    if (existing) {
      grand += total;
      results.push({ month: s.statement_month, status: `exists (${existing.id.slice(0, 8)})`, commissions, interest, feesOther, total });
      continue;
    }

    const postingDate = monthEndISO(s.statement_month);
    const label = monthLabel(s.statement_month);
    const lines = [];
    let n = 1;
    if (commissions !== 0) lines.push(expenseLine(n++, acct.get("6802").id, commissions));
    if (interest !== 0) lines.push(expenseLine(n++, acct.get("6804").id, interest));
    if (feesOther !== 0) lines.push(expenseLine(n++, acct.get("6803").id, feesOther));
    // Offset: the factor charges every cost to the loan (Factor Advances).
    lines.push(total >= 0
      ? { line_number: n++, account_id: acct.get("1051").id, debit: "0", credit: dollars(total) }
      : { line_number: n++, account_id: acct.get("1051").id, debit: dollars(total), credit: "0" });

    const payload = {
      entity_id: entity.id,
      basis: "ACCRUAL",
      journal_type: "factor_cost",
      posting_date: postingDate,
      source_module: "factor_recap",
      source_table: "factor_statements",
      source_id: s.statement_month,
      description: `Rosenthal factoring cost — ${label}: commissions ${fmt(commissions)}, interest ${fmt(interest)}, fees/other ${fmt(feesOther)}${excluded ? ` (facility OTHER excluded: ${excluded})` : ""}`,
      audit_reason: `Monthly factoring cost per Rosenthal CLIENT RECAP ${label} (Factor Module Phase 2 backfill from factor_statements)`,
      lines,
    };

    if (dryRun) {
      grand += total;
      results.push({ month: s.statement_month, status: "DRY-RUN", commissions, interest, feesOther, total });
      continue;
    }

    const { error: postErr } = await sb.rpc("gl_post_journal_entry", { payload });
    if (postErr) {
      results.push({ month: s.statement_month, status: `ERROR: ${postErr.message}` });
      process.exitCode = 1;
      continue;
    }
    grand += total;
    results.push({ month: s.statement_month, status: "POSTED", commissions, interest, feesOther, total });
  }

  console.log("\nFactoring-cost JEs (DR 6802/6804/6803 → CR 1051):");
  for (const r of results) {
    if (r.total === undefined) { console.log(`  ${r.month}: ${r.status}`); continue; }
    console.log(`  ${r.month}: comm ${fmt(r.commissions)} + int ${fmt(r.interest)} + fees ${fmt(r.feesOther)} = ${fmt(r.total)}  [${r.status}]`);
  }
  console.log(`\n  TOTAL factoring cost: ${fmt(grand)}`);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
