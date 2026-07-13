#!/usr/bin/env node
// mirror-xoro-payroll.mjs (#xoro-gl-truth — payroll slice, 2026-07-12)
//
// CEO directive: "Tangerine GL = Xoro GL." Tangerine was built bottom-up from
// the AR/AP subledgers, so it never captured Xoro's GL-only entries (Paycor
// payroll, bad-debt provisions) and overstates net income ~$210K/mo. The fix
// is NOT a plug: it is to mirror Xoro's actual posted transactions — BOTH legs
// of every payroll Journal Entry — since each Xoro txn already balances to $0.
// This is the FIRST slice (payroll/bad-debt) of the broader mirror.
//
// SCOPE — a "payroll transaction" is a Xoro GL row-set (xoro_gl_transactions)
// where:
//   • txn_type_name = 'Journal Entry'  (Bills / Bill Payments / Transfers are
//     already in Tangerine's AP subledger or are bank funding — excluded to
//     avoid double-count), AND
//   • the txn has >=1 leg that is a payroll/bad-debt EXPENSE account
//     (accounting_type_name='OperatingExpenses' and name matches Payroll* or
//     'Bad Debt Expense'), AND
//   • it is NOT a closing/opening omnibus entry. Real payroll runs cap at ~22
//     legs; Xoro's fiscal-year-closing + 8/31/24 opening entries have 158-188
//     legs and merely touch payroll expense as one line among the whole
//     ledger. Guard: n_legs <= 40 AND memo NOT ILIKE '%closing entry%'.
// Each such txn is mirrored WHOLE (all legs) so the JE balances by
// construction. amount_home is SIGNED: positive => DEBIT, negative => CREDIT.
//
// ACCOUNT MAP — the 20260801 ROF chart already mirrors Xoro's payroll chart
// 1:1 by leaf name (6115 Payroll Expense - Hourly, 6119 Salaries, 6125 Tax,
// 2401 Payroll Payable, 1408 Payroll Asset, 6305 Bad Debt, …), so the
// deterministic exact-name resolver (api/_lib/accounting/xoroAccountMap.js)
// resolves nearly every leg. Two exceptions handled here:
//   • Xoro's bank leaf names say "Bank Leumi …"; ROF's cash accounts are the
//     same accounts renamed "Valley Bank …" (#1671). Explicit BANK_ALIAS maps
//     them to 1001/1002/1003.
//   • Xoro leaf "Payroll Expense - Executive Salary" had no ROF account — this
//     script CREATES 6135 (migration 20260981 codifies it) and logs it.
//
// SAFETY GUARDS (a txn that trips any of these is SKIPPED + reported, never
// force-posted):
//   • a leg resolves to a CONTROL account or to AP/AR control codes
//     (2000/1105/1107/1108) — payroll must never touch the subledger controls;
//   • a leg's Xoro account cannot be resolved to any ROF account;
//   • the txn's legs do not net to $0.00 in amount_home.
//
// IDEMPOTENCY — one Tangerine JE per Xoro txn_id: journal_type
// 'xoro_gl_mirror', source_module 'payroll', source_table 'xoro_gl_mirror',
// source_id = txn_id. Existing source_ids are skipped, so a re-run posts 0 and
// the future full-ledger mirror dedupes naturally by TxnId. NON-NEG:
// posting_date = the Xoro TxnDate, never today. T11 audit_reason on every post.
//
// Usage: node scripts/mirror-xoro-payroll.mjs <report|post|verify> [--dry-run] [--limit=N]

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { buildXoroAccountResolver } from "../api/_lib/accounting/xoroAccountMap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
function loadEnv(file) {
  try {
    return Object.fromEntries(readFileSync(resolve(ROOT, file), "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) { console.error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

const PHASE = process.argv[2];
const DRY = process.argv.includes("--dry-run") || PHASE === "report"; // `report` never posts
const LIMIT = (() => { const a = process.argv.find((x) => x.startsWith("--limit=")); return a ? parseInt(a.split("=")[1], 10) : 0; })();

const MAX_LEGS = 40;
const PAYROLL_EXP_RE = /^\*?Payroll[ :\-]/i;   // OperatingExpenses trigger
const BADDEBT_RE = /Bad Debt Expense/i;
const CLOSING_RE = /closing entry/i;
const FORBIDDEN_CODES = new Set(["2000", "1105", "1107", "1108"]); // AP + AR controls
// Xoro bank leaf names -> ROF cash-account code (same accounts, renamed #1671).
const BANK_ALIAS = {
  "bank leumi 7801 main": "1001",
  "bank leumi 1300 payroll account": "1002",
  "bank leumi 1500 web account": "1003",
};

const money = (cents) => `${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const signed = (cents) => `${cents < 0 ? "-" : ""}${money(cents)}`;
const centsOf = (v) => Math.round(Number(v) * 100);
const bankKey = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();

async function fetchAll(table, select, mod = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await mod(admin.from(table).select(select).range(from, from + 999));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadContext() {
  const { data: entity, error: eErr } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (eErr || !entity) throw new Error("ROF entity not found");
  let accts = await fetchAll("gl_accounts", "id, code, name, account_type, is_postable, is_control, status",
    (q) => q.eq("entity_id", entity.id));
  const byCode = () => new Map(accts.map((a) => [String(a.code), a]));

  // Ensure 6135 Payroll Expense - Executive Salary exists (migration 20260981
  // codifies it; created here too so a fresh run can post before merge).
  let created = [];
  if (!byCode().has("6135")) {
    if (DRY) {
      created.push("6135 Payroll Expense - Executive Salary (would create)");
    } else {
      const parent = accts.find((a) => String(a.code) === "6100");
      const { data: ins, error } = await admin.from("gl_accounts").insert({
        entity_id: entity.id, code: "6135", name: "Payroll Expense - Executive Salary",
        account_type: "expense", normal_balance: "DEBIT", is_postable: true, is_control: false,
        status: "active", parent_account_id: parent ? parent.id : null,
      }).select("id, code, name, account_type, is_postable, is_control, status").single();
      if (error) throw new Error(`create 6135 failed: ${error.message}`);
      accts.push(ins);
      created.push(`6135 Payroll Expense - Executive Salary (${ins.id})`);
    }
  }

  const resolveXoro = buildXoroAccountResolver(accts);
  const codeMap = byCode();
  // resolver wrapper: bank-alias first, then deterministic exact-name resolver.
  const resolveLeg = (name) => {
    const bk = BANK_ALIAS[bankKey(name)];
    if (bk && codeMap.get(bk)) return { account: codeMap.get(bk), via: "bank-alias" };
    return resolveXoro(name);
  };
  return { entity_id: entity.id, accts, codeMap, resolveLeg, created };
}

// Pull every leg of every in-scope payroll Journal Entry, grouped by txn_id.
async function loadPayrollTxns() {
  // 1. candidate txn_ids: JE with >=1 payroll/bad-debt EXPENSE leg. Fetch all
  //    Journal-Entry OperatingExpenses rows and filter names in JS (same regex
  //    as isPayrollExpLeg) — PostgREST .or()/.ilike DSL mangles '*'/'%'.
  const rows = await fetchAll("xoro_gl_transactions", "txn_id, accounting_name",
    (q) => q.eq("txn_type_name", "Journal Entry").eq("accounting_type_name", "OperatingExpenses"));
  const txnIds = [...new Set(rows
    .filter((r) => PAYROLL_EXP_RE.test(r.accounting_name) || BADDEBT_RE.test(r.accounting_name))
    .map((r) => r.txn_id))];
  // 2. all legs for those txns. Paginate per chunk — the server caps every
  //    read at 1000 rows regardless of .range(), and closing txns alone carry
  //    500+ legs, so an unpaginated .in() silently truncates.
  const legs = [];
  const SEL = "txn_id, txn_number, txn_date, ref_number, memo, row_seq, accounting_name, accounting_type_name, amount_home";
  for (let i = 0; i < txnIds.length; i += 30) {
    const chunk = txnIds.slice(i, i + 30);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("xoro_gl_transactions").select(SEL)
        .in("txn_id", chunk).order("txn_id").order("row_seq").range(from, from + 999);
      if (error) throw new Error(`legs: ${error.message}`);
      legs.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
  }
  const byTxn = new Map();
  for (const l of legs) {
    if (!byTxn.has(l.txn_id)) byTxn.set(l.txn_id, []);
    byTxn.get(l.txn_id).push(l);
  }
  return byTxn;
}

// Classify a txn: returns { status:'ok'|'skip', reason, lines, expCents, ym, meta }
function classifyTxn(ctx, txnId, legs) {
  const meta = {
    txn_number: legs[0].txn_number, txn_date: legs[0].txn_date,
    ref_number: legs[0].ref_number, memo: (legs.find((l) => l.memo)?.memo) || "",
  };
  const anyClosing = legs.some((l) => l.memo && CLOSING_RE.test(l.memo));
  if (legs.length > MAX_LEGS || anyClosing) {
    return { status: "skip", reason: `closing/opening omnibus (${legs.length} legs${anyClosing ? ", closing memo" : ""})`, meta };
  }
  const lines = [];
  let expCents = 0, netCents = 0, ln = 0;
  for (const l of legs.sort((a, b) => a.row_seq - b.row_seq)) {
    const c = centsOf(l.amount_home);
    if (c === 0) continue; // zero legs contribute nothing; drop to keep debit-XOR-credit
    const hit = ctx.resolveLeg(l.accounting_name);
    if (!hit) return { status: "skip", reason: `unresolved account "${l.accounting_name}"`, meta };
    if (hit.account.is_control || FORBIDDEN_CODES.has(String(hit.account.code))) {
      return { status: "skip", reason: `leg hits control/forbidden account ${hit.account.code} "${hit.account.name}" (${l.accounting_name})`, meta };
    }
    netCents += c;
    // NI impact = net debit to expense-type accounts (the P&L legs of the run:
    // payroll wages/tax/etc. + any expense-account deductions like pre-tax
    // medical credited back to insurance expense). Same universe verify counts
    // on the posted side, so posted==source to the cent.
    if (hit.account.account_type === "expense") expCents += c;
    lines.push({
      line_number: ++ln,
      account_id: hit.account.id,
      debit: c > 0 ? money(c) : "0",
      credit: c < 0 ? money(-c) : "0",
      memo: `${l.accounting_name}${l.memo ? " — " + l.memo : ""}`.slice(0, 240),
    });
  }
  if (lines.length === 0) return { status: "skip", reason: "no non-zero legs", meta };
  if (netCents !== 0) return { status: "skip", reason: `legs do not net to 0 (off by ${signed(netCents)})`, meta };
  return { status: "ok", lines, expCents, ym: String(meta.txn_date).slice(0, 7), meta };
}

async function existingSourceIds() {
  const rows = await fetchAll("journal_entries", "source_id",
    (q) => q.eq("source_table", "xoro_gl_mirror").eq("journal_type", "xoro_gl_mirror"));
  return new Set(rows.map((r) => r.source_id));
}

async function phaseRun() {
  const ctx = await loadContext();
  const byTxn = await loadPayrollTxns();
  const already = await existingSourceIds();
  const skips = new Map();          // reason-bucket -> [txn]
  const monthExp = new Map();       // ym -> cents (posted expense)
  let posted = 0, healed = 0, errors = 0, skipExisting = 0, done = 0;
  let totalDebitCents = 0;

  const ordered = [...byTxn.entries()].sort((a, b) =>
    (a[1][0].txn_date < b[1][0].txn_date ? -1 : a[1][0].txn_date > b[1][0].txn_date ? 1 : 0));

  for (const [txnId, legs] of ordered) {
    const cls = classifyTxn(ctx, txnId, legs);
    if (cls.status === "skip") {
      const bucket = cls.reason.replace(/\(.*\)/, "").replace(/".*?"/g, "…").trim();
      if (!skips.has(bucket)) skips.set(bucket, []);
      skips.get(bucket).push({ txnId, ...cls.meta, reason: cls.reason });
      continue;
    }
    if (already.has(txnId)) { skipExisting += 1; continue; }
    if (LIMIT && done >= LIMIT) break;
    done += 1;

    monthExp.set(cls.ym, (monthExp.get(cls.ym) || 0) + cls.expCents);
    const jeDebit = cls.lines.reduce((s, l) => s + centsOf(l.debit), 0);
    totalDebitCents += jeDebit;

    if (DRY) { posted += 1; continue; }
    const m = cls.meta;
    const payload = {
      entity_id: ctx.entity_id,
      basis: "ACCRUAL",
      journal_type: "xoro_gl_mirror",
      posting_date: m.txn_date,                    // NON-NEG: Xoro TxnDate
      source_module: "payroll",
      source_table: "xoro_gl_mirror",
      source_id: txnId,
      description: `Xoro payroll mirror — ${m.txn_type_name || "Journal Entry"} ${m.ref_number || m.txn_number} (${m.txn_date})${m.memo ? " — " + m.memo : ""}`.slice(0, 400),
      audit_reason: `Faithful double-entry mirror of Xoro GL payroll transaction TxnNumber ${m.txn_number} / Ref ${m.ref_number || "—"} dated ${m.txn_date} (memo: ${m.memo || "—"}). Both legs posted from xoro_gl_transactions (amount_home signed, +=DR/-=CR); each leg mapped to its ROF gl_accounts equivalent by exact leaf name. CEO "Tangerine GL = Xoro GL" strategy, payroll slice. No plug/clearing.`.slice(0, 600),
      lines: cls.lines,
    };
    const { data: jeId, error } = await admin.rpc("gl_post_journal_entry", { payload });
    if (error) {
      if (/duplicate key|uq_je_source/i.test(error.message || "")) { healed += 1; posted += 1; continue; }
      errors += 1; console.error(`  ${txnId} (${m.txn_date} ${m.ref_number}): ${error.message}`);
      continue;
    }
    posted += 1;
    if (posted % 20 === 0) console.log(`  … ${posted} JEs posted`);
  }

  console.log(`\n${DRY ? "[DRY-RUN] " : ""}Xoro payroll mirror`);
  if (ctx.created.length) console.log(`COA created: ${ctx.created.join("; ")}`);
  console.log(`kept txns posted: ${posted}${healed ? ` (${healed} healed)` : ""}; already-present skipped: ${skipExisting}; errors: ${errors}`);
  console.log(`total debits posted: $${signed(totalDebitCents)}`);
  console.log("payroll+baddebt EXPENSE posted by month (NI impact):");
  let expSum = 0;
  for (const [ym, c] of [...monthExp.entries()].sort()) { console.log(`  ${ym}: $${signed(c)}`); expSum += c; }
  console.log(`  TOTAL expense: $${signed(expSum)}`);
  console.log("\nskipped txns by reason:");
  for (const [bucket, arr] of skips) {
    console.log(`  [${arr.length}] ${bucket}`);
    for (const t of arr.slice(0, 6)) console.log(`      ${t.txn_date} ${t.ref_number || t.txn_number} — ${t.reason}`);
  }
  if (errors) process.exit(1);
}

async function phaseVerify() {
  const ctx = await loadContext();
  // 1. global TB imbalance + 2000
  const tb = await fetchAll("v_trial_balance", "code, name, debit_cents, credit_cents",
    (q) => q.eq("entity_id", ctx.entity_id).eq("basis", "ACCRUAL"));
  let imbalance = 0;
  for (const r of tb) imbalance += Math.round(Number(r.debit_cents || 0)) - Math.round(Number(r.credit_cents || 0));
  const r2000 = tb.find((r) => r.code === "2000");
  const net2000 = r2000 ? Math.round(Number(r2000.debit_cents || 0)) - Math.round(Number(r2000.credit_cents || 0)) : 0;
  console.log(`trial-balance imbalance: $${signed(imbalance)} (must be 0.00)`);
  console.log(`GL 2000 net CR: $${signed(-net2000)} (invariant $10,061,433.54)`);

  // 2. no mirror line touches 2000
  const { count: n2000 } = await admin.from("journal_entry_lines")
    .select("id, journal_entries!inner(journal_type)", { count: "exact", head: true })
    .eq("account_id", (ctx.codeMap.get("2000") || {}).id)
    .eq("journal_entries.journal_type", "xoro_gl_mirror");
  console.log(`xoro_gl_mirror lines on 2000: ${n2000 ?? 0} (must be 0)`);

  // 3. per-JE balance for all mirror JEs
  const jes = await fetchAll("journal_entries", "id, posting_date",
    (q) => q.eq("journal_type", "xoro_gl_mirror").eq("status", "posted"));
  const ids = jes.map((j) => j.id);
  let unbalanced = 0, checked = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin.from("journal_entry_lines")
      .select("journal_entry_id, debit, credit").in("journal_entry_id", ids.slice(i, i + 100)).range(0, 99999);
    if (error) throw new Error(error.message);
    const per = new Map();
    for (const l of data || []) per.set(l.journal_entry_id, (per.get(l.journal_entry_id) || 0) + centsOf(l.debit) - centsOf(l.credit));
    for (const [, c] of per) { checked += 1; if (c !== 0) unbalanced += 1; }
  }
  console.log(`mirror JEs: ${jes.length}; balanced ${checked - unbalanced}/${checked} (unbalanced ${unbalanced})`);

  // 4. monthly reconciliation: posted expense vs Xoro source expense
  const byTxn = await loadPayrollTxns();
  const srcMonth = new Map();
  for (const [txnId, legs] of byTxn) {
    const cls = classifyTxn(ctx, txnId, legs);
    if (cls.status !== "ok") continue;
    srcMonth.set(cls.ym, (srcMonth.get(cls.ym) || 0) + cls.expCents);
  }
  // posted expense by month: mirror lines on expense accounts
  const expIds = new Set(ctx.accts.filter((a) => a.account_type === "expense").map((a) => a.id));
  const postMonth = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const { data } = await admin.from("journal_entry_lines")
      .select("account_id, debit, credit, journal_entries!inner(posting_date)")
      .in("journal_entry_id", slice).range(0, 99999);
    for (const l of data || []) {
      if (!expIds.has(l.account_id)) continue;
      const ym = String(l.journal_entries.posting_date).slice(0, 7);
      postMonth.set(ym, (postMonth.get(ym) || 0) + centsOf(l.debit) - centsOf(l.credit));
    }
  }
  console.log("\nmonthly payroll+baddebt EXPENSE — Xoro source vs Tangerine posted:");
  const months = [...new Set([...srcMonth.keys(), ...postMonth.keys()])].sort();
  let sSum = 0, pSum = 0, diffs = 0;
  for (const ym of months) {
    const s = srcMonth.get(ym) || 0, p = postMonth.get(ym) || 0; sSum += s; pSum += p;
    const tie = s === p ? "✓" : `✗ Δ$${signed(p - s)}`;
    if (s !== p) diffs += 1;
    console.log(`  ${ym}  src $${signed(s)}  posted $${signed(p)}  ${tie}`);
  }
  console.log(`  TOTAL  src $${signed(sSum)}  posted $${signed(pSum)}  ${sSum === pSum ? "✓ tie to the cent" : `✗ Δ$${signed(pSum - sSum)}`}`);
  console.log(`months out of tie: ${diffs}`);
}

const RUN = { report: () => phaseRun(), post: () => phaseRun(), verify: () => phaseVerify() };
if (!RUN[PHASE]) { console.error("usage: node scripts/mirror-xoro-payroll.mjs <report|post|verify> [--dry-run] [--limit=N]"); process.exit(1); }
RUN[PHASE]().catch((e) => { console.error(e); process.exit(1); });
