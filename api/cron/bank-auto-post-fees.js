// api/cron/bank-auto-post-fees
//
// Tangerine P6-7 — Auto-post fee rules cron.
//
// Iterates over every active bank_account that has at least one rule in
// auto_post_fee_rules. For each, pulls unmatched + non-pending
// bank_transactions, runs them through findMatchingRule, and (on a match)
// calls bank_create_je_for_transaction — flipping the transaction to
// status='manual_je_created'.
//
// Idempotent: only acts on status='unmatched' rows; previously auto-posted
// rows are skipped because their status flipped on the previous run.
//
// Triggers:
//   - Scheduled daily at 16:00 UTC (vercel.json crons[]).
//   - Manual POST /api/cron/bank-auto-post-fees by an operator after a
//     bulk CSV upload (we accept both GET — Vercel cron — and POST).
//
// Query params:
//   ?bank_account_id=<uuid>  limit to one account (e.g. test-run a single account)
//   ?dry_run=true            skip the RPC call; just return what WOULD have posted
//
// Returns a per-account summary including the count of auto-posted rows,
// any errors, and (for dry_run) the matched rule index + label.

import { createClient } from "@supabase/supabase-js";
import { findMatchingRule } from "../_lib/bank-feeds/autoPostRules.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });

  let onlyBankAccountId = null;
  let dryRun = false;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    onlyBankAccountId = url.searchParams.get("bank_account_id");
    dryRun = url.searchParams.get("dry_run") === "true";
  } catch { /* fall through to all */ }

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const out = await runAutoPost(admin, { onlyBankAccountId, dryRun });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * @param {Object} supabase service-role client
 * @param {Object} [opts]
 * @param {string|null} [opts.onlyBankAccountId]
 * @param {boolean} [opts.dryRun]
 */
export async function runAutoPost(supabase, opts = {}) {
  let q = supabase
    .from("bank_accounts")
    .select("id, entity_id, name, auto_post_fee_rules")
    .eq("is_active", true);
  if (opts.onlyBankAccountId) q = q.eq("id", opts.onlyBankAccountId);
  const { data: accounts, error: aErr } = await q;
  if (aErr) throw new Error(`bank_accounts read failed: ${aErr.message}`);

  const summary = {
    dry_run: !!opts.dryRun,
    accounts_scanned: 0,
    txns_scanned: 0,
    posted_total: 0,
    errors: [],
    per_account: [],
  };

  for (const acct of accounts || []) {
    const rules = Array.isArray(acct.auto_post_fee_rules) ? acct.auto_post_fee_rules : [];
    if (rules.length === 0) continue;
    summary.accounts_scanned += 1;

    const acctSummary = {
      bank_account_id: acct.id,
      name: acct.name,
      rules_count: rules.length,
      txns_scanned: 0,
      posted: 0,
      matched_in_dry_run: [],
      errors: [],
    };
    summary.per_account.push(acctSummary);

    const { data: txns, error: tErr } = await supabase
      .from("bank_transactions")
      .select("id, description, merchant_name, amount_cents, posted_date, status, pending")
      .eq("bank_account_id", acct.id)
      .eq("status", "unmatched")
      .eq("pending", false)
      .order("posted_date", { ascending: true })
      .limit(500);
    if (tErr) {
      const msg = `bank_transactions read failed: ${tErr.message}`;
      acctSummary.errors.push(msg);
      summary.errors.push(`bank_account ${acct.id}: ${msg}`);
      continue;
    }

    for (const txn of txns || []) {
      acctSummary.txns_scanned += 1;
      summary.txns_scanned += 1;
      const m = findMatchingRule(rules, txn);
      if (!m) continue;

      if (opts.dryRun) {
        acctSummary.matched_in_dry_run.push({
          bank_transaction_id: txn.id,
          rule_index: m.index,
          rule_label: m.rule.label || null,
          target_account_id: m.rule.target_account_id,
          amount_cents: txn.amount_cents,
        });
        acctSummary.posted += 1;
        summary.posted_total += 1;
        continue;
      }

      const memo = m.rule.label
        ? `Auto-post: ${m.rule.label}`
        : "Auto-post (fee rule match)";
      const { error: rpcErr } = await supabase.rpc("bank_create_je_for_transaction", {
        p_bank_transaction_id: txn.id,
        p_target_gl_account_id: m.rule.target_account_id,
        p_actor_user_id: null,
        p_memo: memo,
      });
      if (rpcErr) {
        const msg = `txn ${txn.id} (rule ${m.index}): ${rpcErr.message}`;
        acctSummary.errors.push(msg);
        summary.errors.push(`bank_account ${acct.id}: ${msg}`);
        continue;
      }
      acctSummary.posted += 1;
      summary.posted_total += 1;
    }
  }

  return summary;
}
