// api/cron/bank-feed-sync
//
// Tangerine P6-2 — Plaid bank feed sync cron.
//
// For each active `bank_accounts` row with feed_source='plaid' AND a
// non-null plaid_access_token_ciphertext, calls Plaid /transactions/sync
// with the stored cursor, upserts new + modified transactions into
// bank_transactions, removes rows for any transaction_ids Plaid says
// were removed, and stores the new cursor on the bank account.
//
// Schedule: every 4 hours per vercel.json. Plaid also fires webhooks
// (DEFAULT_UPDATE / TRANSACTIONS_REMOVED) — the webhook handler
// (api/webhooks/plaid.js) calls this same logic on demand.
//
// Returns a per-account summary: {synced: N, added: N, modified: N,
// removed: N, errors: [...]}.

import { createClient } from "@supabase/supabase-js";
import { syncTransactions, isPlaidConfigured, PlaidError } from "../_lib/plaid/client.js";
import { decryptToken } from "../_lib/plaid/encryption.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  if (!isPlaidConfigured()) {
    return res.status(200).json({ ok: true, skipped: "Plaid not configured (PLAID_CLIENT_ID/SECRET missing)" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let onlyBankAccountId = null;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    onlyBankAccountId = url.searchParams.get("bank_account_id");
  } catch { /* fallback to all */ }

  try {
    const out = await runBankFeedSync(admin, { onlyBankAccountId });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * @param {Object} supabase  service-role client
 * @param {Object} [opts]
 * @param {string} [opts.onlyBankAccountId]  if set, sync just this one account (used by webhook handler)
 */
export async function runBankFeedSync(supabase, opts = {}) {
  let q = supabase
    .from("bank_accounts")
    .select("id, entity_id, name, plaid_access_token_ciphertext, plaid_cursor, plaid_item_id, plaid_account_id")
    .eq("feed_source", "plaid")
    .eq("is_active", true)
    .not("plaid_access_token_ciphertext", "is", null);
  if (opts.onlyBankAccountId) q = q.eq("id", opts.onlyBankAccountId);
  const { data: accounts, error: aErr } = await q;
  if (aErr) throw new Error(`bank_accounts read failed: ${aErr.message}`);

  const summary = {
    accounts_scanned: 0,
    added_total: 0,
    modified_total: 0,
    removed_total: 0,
    errors: [],
    per_account: [],
  };

  for (const acct of accounts || []) {
    summary.accounts_scanned += 1;
    const acctSummary = {
      bank_account_id: acct.id,
      name: acct.name,
      added: 0,
      modified: 0,
      removed: 0,
      cursor_updated: false,
      error: null,
    };
    summary.per_account.push(acctSummary);

    let accessToken;
    try {
      accessToken = decryptToken(acct.plaid_access_token_ciphertext);
    } catch (e) {
      const msg = `decrypt failed: ${e instanceof Error ? e.message : String(e)}`;
      acctSummary.error = msg;
      summary.errors.push(`bank_account ${acct.id}: ${msg}`);
      continue;
    }

    // Loop until has_more=false — Plaid paginates via the cursor.
    let cursor = acct.plaid_cursor;
    let hasMore = true;
    let safetyLoops = 0;
    while (hasMore && safetyLoops < 50) {
      safetyLoops += 1;
      let resp;
      try {
        resp = await syncTransactions(accessToken, cursor);
      } catch (e) {
        const msg = e instanceof PlaidError
          ? `Plaid ${e.code || e.type || e.status}: ${e.message}`
          : (e instanceof Error ? e.message : String(e));
        acctSummary.error = msg;
        summary.errors.push(`bank_account ${acct.id}: ${msg}`);
        break;
      }

      // Plaid's /transactions/sync filters its added/modified/removed arrays
      // to the entire ITEM, but we own one bank_account per Plaid account.
      // Filter to acct.plaid_account_id before writing.
      const addedRows  = (resp.added    || []).filter((t) => t.account_id === acct.plaid_account_id);
      const modRows    = (resp.modified || []).filter((t) => t.account_id === acct.plaid_account_id);
      const removedIds = (resp.removed  || [])
        .map((r) => r.transaction_id)
        .filter(Boolean);

      // UPSERT added + modified.
      for (const raw of [...addedRows, ...modRows]) {
        const row = mapPlaidTxn(acct, raw);
        const { error: upErr } = await supabase
          .from("bank_transactions")
          .upsert(row, { onConflict: "bank_account_id,external_txn_id" });
        if (upErr) {
          summary.errors.push(
            `bank_account ${acct.id} txn ${raw.transaction_id}: upsert failed: ${upErr.message}`,
          );
          continue;
        }
      }
      acctSummary.added    += addedRows.length;
      acctSummary.modified += modRows.length;

      // Plaid's "removed" means the transaction was cancelled / refunded
      // before clearing. Mark our row status='reversed' rather than DELETE
      // so the audit trail survives.
      if (removedIds.length > 0) {
        const { error: rmErr } = await supabase
          .from("bank_transactions")
          .update({ status: "reversed" })
          .eq("bank_account_id", acct.id)
          .in("external_txn_id", removedIds);
        if (rmErr) {
          summary.errors.push(
            `bank_account ${acct.id}: removed-mark failed: ${rmErr.message}`,
          );
        }
        acctSummary.removed += removedIds.length;
      }

      cursor = resp.next_cursor || cursor;
      hasMore = !!resp.has_more;
    }

    if (safetyLoops >= 50) {
      summary.errors.push(`bank_account ${acct.id}: hit 50-page safety limit; cursor may be lagging`);
    }

    if (cursor) {
      const { error: cErr } = await supabase
        .from("bank_accounts")
        .update({
          plaid_cursor: cursor,
          last_synced_at: new Date().toISOString(),
        })
        .eq("id", acct.id);
      if (cErr) {
        summary.errors.push(`bank_account ${acct.id}: cursor update failed: ${cErr.message}`);
      } else {
        acctSummary.cursor_updated = true;
      }
    }

    summary.added_total    += acctSummary.added;
    summary.modified_total += acctSummary.modified;
    summary.removed_total  += acctSummary.removed;
  }

  return summary;
}

/**
 * Map a Plaid transaction object to a bank_transactions row shape.
 * Exported for unit testing.
 *
 * Plaid `amount` is positive for OUTFLOWS from the account (charges) and
 * negative for INFLOWS (refunds, payroll deposits). We invert to match
 * the GL convention (positive = deposit / DR-cash; negative = withdrawal
 * / CR-cash).
 */
export function mapPlaidTxn(acct, t) {
  const inferAmountCents = () => {
    if (t.amount == null) return 0;
    const cents = Math.round(Number(t.amount) * 100);
    // Plaid signs deposits negative, withdrawals positive — invert.
    return -cents;
  };
  return {
    entity_id: acct.entity_id,
    bank_account_id: acct.id,
    source: "plaid",
    external_txn_id: t.transaction_id,
    posted_date: t.date,                     // Plaid uses YYYY-MM-DD
    amount_cents: inferAmountCents(),
    description: t.original_description || t.name || null,
    merchant_name: t.merchant_name || null,
    category: t.category || (t.personal_finance_category?.primary
      ? [t.personal_finance_category.primary]
      : null),
    pending: !!t.pending,
    raw_payload: t,
  };
}
