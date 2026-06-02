// api/_lib/marketplaces/walmart/sync-settlements.js
//
// Tangerine P12b-4 — Walmart Marketplace settlement reconciliation service.
//
// Pairs with the P12b-3 per-order AR JE. Per the P12b architecture doc:
//   - P12b-3 posts per-order:    DR 1200 AR + DR 6524 Referral Fee +
//                                DR 6523 Fulfillment Fee + CR 4000 Revenue +
//                                CR 4500 Shipping Revenue + CR 1115
//                                Marketplace Receivable Clearing
//   - P12b-4 posts per-settle:   DR 1100 Bank + CR 1115 Marketplace
//                                Receivable Clearing
//
// 1115 Marketplace Receivable Clearing accumulates net-after-fees credits
// from per-order posting all week long. When Walmart deposits the weekly
// settlement to the operator's bank account, this service posts the
// offsetting JE that drains the 1115 balance into 1100 Bank, and (best-
// effort) links the matching bank_transactions row so the P6 reconciler
// sees the settlement as auto-matched.
//
// JE shape (per P12b arch §D6):
//   DR 1100 Bank                              = net_amount_cents
//   CR 1115 Marketplace Receivable Clearing   = net_amount_cents
//
// Iterates active walmart_seller_accounts rows:
//   1. Decrypt client_id + client_secret (AES-256-GCM).
//   2. getWalmartAccessToken (client_credentials grant).
//   3. Build WalmartClient.
//   4. listSettlementReports({requestedFromDate: now - sinceDaysAgo}).
//   5. For each settlement: upsert into walmart_settlements by
//      (walmart_seller_account_id, settlement_id).
//   6. Skip rows that already have je_id (idempotent).
//   7. For new ones, build + post the JE via gl_post_journal_entry, then
//      stamp walmart_settlements.je_id.
//   8. Best-effort: find a matching bank_transactions row (same
//      amount_cents, posted_date within ±5 days) and link it (set
//      walmart_settlements.bank_transaction_id; flip bank_transactions
//      to status='matched' + matched_je_line_id).
//   9. Update walmart_seller_accounts.last_settlement_sync_at.
//
// Per-account try/catch — one failing account doesn't sink the rest.
// Per-settlement try/catch — one broken settlement doesn't stop the page
// walk.
//
// BigInt cents throughout per project_tangerine_progress money handling.

import { WalmartClient } from "./client.js";
import { getWalmartAccessToken } from "./auth.js";
import { decryptToken } from "./token-encryption.js";

export const DEFAULT_LOOKBACK_DAYS = 30;
const SAFETY_PAGE_CAP = 50;
// Bank-match tolerance: same amount, ±5 days from settlement period_end.
// Mirrors the FBA settlement window (P12a-4) — Walmart usually credits
// the merchant's bank within 1–3 business days of period_end, so ±5 days
// covers banking holiday gaps without over-matching.
const BANK_MATCH_DATE_WINDOW_DAYS = 5;

const ZERO = 0n;

/**
 * Resolve GL account ids for the settlement JE. Returns a map keyed by
 * named role. Required: 1100 Bank, 1115 Marketplace Receivable Clearing.
 *
 * @returns {Promise<{bankId:string|null, clearingId:string|null}>}
 */
export async function resolveSettlementAccounts(adminClient, entityId) {
  const codes = ["1100", "1115"];
  const { data, error } = await adminClient
    .from("gl_accounts")
    .select("id, code")
    .eq("entity_id", entityId)
    .in("code", codes);
  if (error) {
    throw new Error(`gl_accounts lookup failed: ${error.message}`);
  }
  const byCode = {};
  for (const row of data || []) byCode[row.code] = row.id;
  return {
    bankId:     byCode["1100"] || null,
    clearingId: byCode["1115"] || null,
  };
}

/**
 * Build the settlement JE payload (no DB writes). Exported for tests.
 *
 * @param {Object} args
 * @param {Object} args.settlement   walmart_settlements row (snake_case).
 * @param {Object} args.accounts     { bankId, clearingId }.
 * @returns {Object}                 payload for gl_post_journal_entry RPC.
 */
export function buildSettlementJePayload({ settlement, accounts }) {
  const net = toBigInt(settlement.net_amount_cents);

  if (net <= ZERO) {
    throw new Error(
      `Walmart settlement ${settlement.id}: net_amount_cents=${net} — nothing to post`,
    );
  }
  if (!accounts.bankId) {
    throw new Error(
      `Walmart settlement ${settlement.id}: missing 1100 Bank account for entity ${settlement.entity_id}`,
    );
  }
  if (!accounts.clearingId) {
    throw new Error(
      `Walmart settlement ${settlement.id}: missing 1115 Marketplace Receivable Clearing account for entity ${settlement.entity_id}`,
    );
  }

  const periodLabel = settlement.period_end
    ? `period ending ${settlement.period_end}`
    : `id ${settlement.settlement_id}`;
  const desc = `Walmart Marketplace settlement ${settlement.settlement_id} (${periodLabel})`;

  const lines = [
    {
      line_number: 1,
      account_id: accounts.bankId,
      debit: centsToDecimal(net),
      credit: "0",
      memo: `Bank deposit — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    },
    {
      line_number: 2,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(net),
      memo: `Drain marketplace clearing — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    },
  ];

  // Balance check.
  const drSum = sumLineCents(lines, "debit");
  const crSum = sumLineCents(lines, "credit");
  if (drSum !== crSum) {
    throw new Error(
      `Walmart settlement ${settlement.id}: unbalanced JE — debits=${drSum}, credits=${crSum}`,
    );
  }

  return {
    entity_id: settlement.entity_id,
    basis: "ACCRUAL",
    journal_type: "bank_deposit",
    posting_date: toDateString(settlement.period_end || settlement.period_start || new Date()),
    source_module: "walmart",
    source_table: "walmart_settlements",
    source_id: settlement.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Build the walmart_settlements row from a raw Walmart settlement
 * payload. Exported for tests.
 *
 * Walmart's listSettlementReports returns metadata for each report —
 * settlement amounts are summed from the named fields when present
 * (Walmart's payload shape varies by report-type). All cents are
 * integers.
 */
export function buildSettlementRow({ account, settlement }) {
  const id =
    settlement.settlementId ??
    settlement.settlement_id ??
    settlement.reportId ??
    settlement.report_id ??
    settlement.id;
  if (!id) {
    throw new Error("Walmart settlement payload missing settlement_id / reportId");
  }
  const gross = toCents(
    settlement.grossAmount ??
      settlement.gross_amount ??
      settlement.gross ??
      0,
  );
  const fees = toCents(
    settlement.feesAmount ??
      settlement.fees_amount ??
      settlement.fees ??
      settlement.commission ??
      0,
  );
  const refunds = toCents(
    settlement.refundsAmount ??
      settlement.refunds_amount ??
      settlement.refunds ??
      0,
  );
  const apiNet =
    settlement.netAmount ??
      settlement.net_amount ??
      settlement.net;
  const net = apiNet != null
    ? toCents(apiNet)
    : gross - fees - refunds;

  return {
    entity_id: account.entity_id,
    walmart_seller_account_id: account.id,
    settlement_id: String(id),
    period_start: dateOnly(
      settlement.periodStart ||
        settlement.period_start ||
        settlement.requestedFromDate ||
        settlement.requested_from_date ||
        null,
    ),
    period_end: dateOnly(
      settlement.periodEnd ||
        settlement.period_end ||
        settlement.requestedToDate ||
        settlement.requested_to_date ||
        null,
    ),
    gross_amount_cents: gross,
    fees_amount_cents: fees,
    refunds_amount_cents: refunds,
    net_amount_cents: net,
    currency: settlement.currency || "USD",
    raw_payload: settlement,
  };
}

/**
 * Compute the requestedFromDate cutoff for listSettlementReports.
 *
 * @param {string|null} lastSyncAt        walmart_seller_accounts.last_settlement_sync_at
 * @param {number} sinceDaysAgo           defaults to DEFAULT_LOOKBACK_DAYS
 * @param {string|null} sinceOverride     explicit ISO timestamp override
 * @param {number} [nowMs]
 * @returns {string} ISO timestamp.
 */
export function computeRequestedFromDate(lastSyncAt, sinceDaysAgo, sinceOverride, nowMs = Date.now()) {
  if (sinceOverride) return sinceOverride;
  const days = Number.isFinite(sinceDaysAgo) && sinceDaysAgo > 0
    ? sinceDaysAgo
    : DEFAULT_LOOKBACK_DAYS;
  const floor = new Date(nowMs - days * 24 * 60 * 60 * 1000);
  if (!lastSyncAt) return floor.toISOString();
  const lastMs = Date.parse(lastSyncAt);
  if (!Number.isFinite(lastMs) || lastMs < floor.getTime()) return floor.toISOString();
  return new Date(lastMs).toISOString();
}

/**
 * Main entry point — sync Walmart settlements across all active
 * walmart_seller_accounts rows.
 *
 * @param {Object} args
 * @param {Object}        args.adminClient       Supabase service-role client.
 * @param {number}        [args.sinceDaysAgo=30] Lookback window.
 * @param {string|null}   [args.onlyAccountId]   Restrict to one seller account.
 * @param {string|null}   [args.sinceOverride]   Explicit ISO since cutoff.
 * @param {Object}        [args.deps]            Injectable deps for tests.
 * @returns {Promise<Object>}                    Summary.
 */
export async function syncWalmartSettlements({
  adminClient,
  sinceDaysAgo = DEFAULT_LOOKBACK_DAYS,
  onlyAccountId = null,
  sinceOverride = null,
  deps = {},
} = {}) {
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("syncWalmartSettlements: adminClient is required");
  }
  const _deps = {
    makeClient: (cfg) => new WalmartClient(cfg),
    getAccessToken: ({ clientId, clientSecret }) =>
      getWalmartAccessToken({ clientId, clientSecret }),
    decryptToken,
    now: () => Date.now(),
    ...deps,
  };

  // 1. Load active seller accounts.
  let q = adminClient
    .from("walmart_seller_accounts")
    .select(
      "id, entity_id, partner_id, account_name, " +
        "client_id_ciphertext, client_id_iv, client_id_tag, " +
        "client_secret_ciphertext, client_secret_iv, client_secret_tag, " +
        "is_active, last_settlement_sync_at",
    )
    .eq("is_active", true)
    .not("client_id_ciphertext", "is", null);
  if (onlyAccountId) q = q.eq("id", onlyAccountId);

  const { data: accounts, error: accErr } = await q;
  if (accErr) {
    throw new Error(`walmart_seller_accounts read failed: ${accErr.message}`);
  }

  const summary = {
    accounts_scanned: 0,
    settlements_upserted_total: 0,
    settlements_posted_total: 0,
    settlements_skipped_total: 0,
    bank_matches_total: 0,
    errors: [],
    per_account: [],
  };

  for (const acct of accounts || []) {
    summary.accounts_scanned += 1;
    const acctSummary = {
      walmart_seller_account_id: acct.id,
      partner_id: acct.partner_id,
      account_name: acct.account_name,
      settlements_upserted: 0,
      settlements_posted: 0,
      settlements_skipped: 0,
      bank_matches: 0,
      pages_walked: 0,
      cursor_updated: false,
      error: null,
    };
    summary.per_account.push(acctSummary);

    try {
      await syncOneAccount(
        adminClient,
        acct,
        { sinceDaysAgo, sinceOverride },
        _deps,
        acctSummary,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      acctSummary.error = msg;
      summary.errors.push(`walmart_seller_account ${acct.id}: ${msg}`);
    }

    summary.settlements_upserted_total += acctSummary.settlements_upserted;
    summary.settlements_posted_total   += acctSummary.settlements_posted;
    summary.settlements_skipped_total  += acctSummary.settlements_skipped;
    summary.bank_matches_total         += acctSummary.bank_matches;
  }

  return summary;
}

async function syncOneAccount(adminClient, acct, opts, deps, acctSummary) {
  if (
    acct.client_id_ciphertext == null ||
    acct.client_id_iv == null ||
    acct.client_id_tag == null ||
    acct.client_secret_ciphertext == null ||
    acct.client_secret_iv == null ||
    acct.client_secret_tag == null
  ) {
    throw new Error("account missing client_id / client_secret ciphertext triple");
  }

  const clientId = deps.decryptToken(
    acct.client_id_ciphertext,
    acct.client_id_iv,
    acct.client_id_tag,
  );
  const clientSecret = deps.decryptToken(
    acct.client_secret_ciphertext,
    acct.client_secret_iv,
    acct.client_secret_tag,
  );

  const tok = await deps.getAccessToken({ clientId, clientSecret });
  const client = deps.makeClient({
    partnerId: acct.partner_id,
    accessToken: tok.access_token,
  });

  const requestedFromDate = computeRequestedFromDate(
    acct.last_settlement_sync_at,
    opts.sinceDaysAgo,
    opts.sinceOverride,
    deps.now(),
  );
  const requestedToDate = new Date(deps.now()).toISOString();

  // Resolve GL accounts once per seller account.
  const glAccounts = await resolveSettlementAccounts(adminClient, acct.entity_id);

  // Walk pages.
  let cursor = null;
  let safety = 0;
  do {
    safety += 1;
    acctSummary.pages_walked = safety;

    const { data: settlements, nextCursor } = cursor
      ? await client.listSettlementReports({ nextCursor: cursor })
      : await client.listSettlementReports({
          requestedFromDate,
          requestedToDate,
        });

    for (const raw of settlements || []) {
      try {
        await ingestOneSettlement(adminClient, acct, raw, glAccounts, acctSummary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        acctSummary.error = acctSummary.error
          ? `${acctSummary.error}; settlement ${raw?.settlementId || raw?.reportId}: ${msg}`
          : `settlement ${raw?.settlementId || raw?.reportId}: ${msg}`;
      }
    }

    cursor = nextCursor || null;
    if (safety >= SAFETY_PAGE_CAP) break;
  } while (cursor);

  // Update last_settlement_sync_at.
  const nowIso = new Date(deps.now()).toISOString();
  const { error: cErr } = await adminClient
    .from("walmart_seller_accounts")
    .update({
      last_settlement_sync_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", acct.id);
  if (cErr) {
    throw new Error(`last_settlement_sync_at update failed: ${cErr.message}`);
  }
  acctSummary.cursor_updated = true;
}

async function ingestOneSettlement(adminClient, acct, rawSettlement, glAccounts, acctSummary) {
  const row = buildSettlementRow({ account: acct, settlement: rawSettlement });

  // Upsert by (walmart_seller_account_id, settlement_id).
  const { data: upserted, error: upErr } = await adminClient
    .from("walmart_settlements")
    .upsert(row, { onConflict: "walmart_seller_account_id,settlement_id" })
    .select(
      "id, je_id, bank_transaction_id, entity_id, walmart_seller_account_id, " +
        "settlement_id, period_start, period_end, " +
        "gross_amount_cents, fees_amount_cents, refunds_amount_cents, net_amount_cents",
    )
    .single();
  if (upErr) {
    throw new Error(`walmart_settlements upsert failed: ${upErr.message}`);
  }
  acctSummary.settlements_upserted += 1;

  // Idempotent JE skip.
  if (upserted.je_id) {
    acctSummary.settlements_skipped += 1;
    return;
  }

  // Skip $0 settlements (rare — Walmart can emit zero-amount adjustments).
  const net = toBigInt(upserted.net_amount_cents);
  if (net <= ZERO) {
    acctSummary.settlements_skipped += 1;
    return;
  }

  // Build + post JE.
  const payload = buildSettlementJePayload({ settlement: upserted, accounts: glAccounts });
  const { data: jeId, error: rpcErr } = await adminClient.rpc(
    "gl_post_journal_entry",
    { payload },
  );
  if (rpcErr) {
    throw new Error(`gl_post_journal_entry RPC failed: ${rpcErr.message}`);
  }
  if (typeof jeId !== "string") {
    throw new Error(`gl_post_journal_entry returned unexpected payload: ${JSON.stringify(jeId)}`);
  }

  // Stamp je_id.
  const { error: stampErr } = await adminClient
    .from("walmart_settlements")
    .update({ je_id: jeId })
    .eq("id", upserted.id);
  if (stampErr) {
    throw new Error(`walmart_settlements je_id stamp failed (JE ${jeId} posted): ${stampErr.message}`);
  }
  acctSummary.settlements_posted += 1;

  // Best-effort bank-match. Don't let a match failure undo the JE.
  try {
    const matched = await matchBankTransaction(adminClient, acct, upserted, jeId);
    if (matched) acctSummary.bank_matches += 1;
  } catch (e) {
    // Surface as a soft error in the per-settlement message; the JE is
    // already posted and the operator can manually match in P6.
    const msg = e instanceof Error ? e.message : String(e);
    acctSummary.error = acctSummary.error
      ? `${acctSummary.error}; bank-match ${upserted.settlement_id}: ${msg}`
      : `bank-match ${upserted.settlement_id}: ${msg}`;
  }
}

/**
 * Best-effort bank-match: find an unmatched bank_transactions row with
 * the same amount_cents and a posted_date within ±BANK_MATCH_DATE_WINDOW_DAYS
 * of the settlement period_end. If exactly one candidate matches, link
 * it. Exported for unit tests.
 *
 * @returns {Promise<boolean>}  true when a single confident match was wired.
 */
export async function matchBankTransaction(adminClient, acct, settlement, jeId) {
  const net = toBigInt(settlement.net_amount_cents);
  if (net <= ZERO) return false;
  const pivotDate = settlement.period_end || settlement.period_start;
  if (!pivotDate) return false;

  const pivot = dateOnly(pivotDate);
  const start = shiftDays(pivot, -BANK_MATCH_DATE_WINDOW_DAYS);
  const end   = shiftDays(pivot, BANK_MATCH_DATE_WINDOW_DAYS);

  const { data: candidates, error } = await adminClient
    .from("bank_transactions")
    .select("id, posted_date, amount_cents, status")
    .eq("entity_id", acct.entity_id)
    .eq("amount_cents", Number(net))
    .eq("status", "unmatched")
    .gte("posted_date", start)
    .lte("posted_date", end);
  if (error) {
    throw new Error(`bank_transactions lookup failed: ${error.message}`);
  }
  const list = candidates || [];
  if (list.length !== 1) {
    // Zero candidates (settlement not yet posted to bank, or already
    // matched manually) or multiple (ambiguous — leave for operator).
    return false;
  }
  const cand = list[0];

  // Link settlement → bank_transaction.
  const { error: linkErr } = await adminClient
    .from("walmart_settlements")
    .update({ bank_transaction_id: cand.id })
    .eq("id", settlement.id);
  if (linkErr) {
    throw new Error(`walmart_settlements bank_transaction_id update failed: ${linkErr.message}`);
  }

  // Flip bank_transaction → matched.
  const { error: bErr } = await adminClient
    .from("bank_transactions")
    .update({
      status: "matched",
      matched_at: new Date().toISOString(),
      match_confidence: 100,
    })
    .eq("id", cand.id);
  if (bErr) {
    throw new Error(`bank_transactions match update failed: ${bErr.message}`);
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (exported for tests).
// ────────────────────────────────────────────────────────────────────────

/**
 * Convert a Walmart-API money value (decimal-dollar string like "12.50"
 * or float 12.50) into integer cents. Always treats numeric values as
 * dollar amounts (multiplies by 100) — never as already-cents. This
 * matches the canonical Walmart Settlement Report payload shape where
 * money is always a decimal-dollar value, never an integer-cents field.
 *
 * Pass a BigInt (or integer-cents string the schema returns) when the
 * value is already cents — those are returned verbatim.
 */
export function toCents(value) {
  if (value == null) return 0;
  if (typeof value === "bigint") return Number(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function toBigInt(v) {
  if (v == null || v === "") return ZERO;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`expected integer cents, got ${v}`);
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) {
      throw new Error(`expected integer-cents string, got ${v}`);
    }
    return BigInt(v);
  }
  throw new Error(`unsupported cents type: ${typeof v}`);
}

export function centsToDecimal(cents) {
  const c = typeof cents === "bigint" ? cents : toBigInt(cents);
  const neg = c < ZERO;
  const abs = neg ? -c : c;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

function sumLineCents(lines, key) {
  let total = ZERO;
  for (const l of lines) {
    const s = String(l[key] || "0");
    const neg = s.startsWith("-");
    const abs = neg ? s.slice(1) : s;
    const [whole, frac = "0"] = abs.split(".");
    const fracPadded = (frac + "00").slice(0, 2);
    const cents = BigInt(whole) * 100n + BigInt(fracPadded);
    total += neg ? -cents : cents;
  }
  return total;
}

function dateOnly(input) {
  if (!input) return null;
  if (typeof input === "string" && input.length >= 10) return input.slice(0, 10);
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toDateString(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  if (typeof ts === "string") return ts.slice(0, 10);
  if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}

function shiftDays(yyyymmdd, deltaDays) {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}
