// api/_lib/marketplaces/fba/sync-settlements.js
//
// Tangerine P12a-4 — Amazon FBA settlement reconciliation service.
//
// Pairs with the P12a-3 per-order AR JE. Per the P12 architecture (D4/D7):
//   - P12a-3 posts per-order:    DR 6523/6524 Fees + CR 1115 Marketplace Clearing
//                                + DR 1200 AR     + CR 4000 Revenue
//   - P12a-4 posts per-settlement (this file):
//       DR 1100 Bank                          = net_amount_cents
//       CR 1115 Marketplace Receivable Clearing = net_amount_cents
//
//     Plus any settlement-level fees that don't reach per-order JEs
//     (storage fees → 6522, sponsored ads → 6521). When the raw payload
//     reports those amounts the JE picks up an extra debit + clearing
//     credit per category. Group payloads that don't carry the
//     breakdown produce the simple 2-line bank-deposit JE.
//
// The 1115 Marketplace Receivable Clearing account accumulates per-order
// fee debits between settlement events; when Amazon's biweekly settlement
// posts its net deposit to the merchant's bank account, this service
// posts the offsetting JE that drains the clearing balance into the bank.
//
// Iterates active fba_seller_accounts rows:
//   1. Decrypt LWA creds (client_id / client_secret / refresh_token).
//   2. refreshLwaAccessToken() → access_token.
//   3. SpApiClient.listFinancialEventGroups({postedAfter}) → walk NextToken.
//   4. For each group: upsert into fba_settlements by
//      (fba_seller_account_id, financial_event_group_id).
//   5. Skip rows that already have je_id (idempotent).
//   6. For new ones, build + post the JE via gl_post_journal_entry, then
//      stamp fba_settlements.je_id.
//   7. Best-effort match to a bank_transactions row (entity_id +
//      status='unmatched' + amount_cents = net_amount_cents + posted_date
//      within ±5 days of posted_before). Stamp
//      fba_settlements.bank_transaction_id on match.
//   8. Update fba_seller_accounts.last_settlement_sync_at.
//
// Per-account try/catch — one failing account doesn't sink the rest.
// Per-settlement try/catch inside each account so a single broken group
// doesn't stop the page walk.
//
// BigInt cents throughout per project_tangerine_progress money handling.

import { SpApiClient } from "./client.js";
import { refreshLwaAccessToken } from "./lwa.js";
import { decryptToken } from "./token-encryption.js";

export const DEFAULT_LOOKBACK_DAYS = 60;
const PAGE_LIMIT = 100;
const SAFETY_PAGE_CAP = 50;
const BANK_MATCH_WINDOW_DAYS = 5;

const ZERO = 0n;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve GL account ids for the settlement JE. Returns a map keyed by
 * role. Required: 1100 Bank, 1115 Marketplace Receivable Clearing.
 * Optional: 6521 Sponsored Ads, 6522 Storage Fees, 6520 Marketplace Fees
 * (catch-all for fees not categorized by Amazon).
 *
 * @returns {Promise<{
 *   bankId:string|null, clearingId:string|null,
 *   sponsoredAdsId:string|null, storageFeesId:string|null,
 *   marketplaceFeesId:string|null
 * }>}
 */
export async function resolveSettlementAccounts(adminClient, entityId) {
  const codes = ["1100", "1115", "6520", "6521", "6522"];
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
    bankId:            byCode["1100"] || null,
    clearingId:        byCode["1115"] || null,
    marketplaceFeesId: byCode["6520"] || null,
    sponsoredAdsId:    byCode["6521"] || null,
    storageFeesId:     byCode["6522"] || null,
  };
}

/**
 * Extract settlement-level fee breakdown from the raw SP-API
 * FinancialEventGroup payload. Returns BigInt cents per category.
 *
 * Amazon's group payload does NOT carry the per-event-type roll-up by
 * default — that lives in listFinancialEvents. Operators sometimes pre-
 * aggregate the breakdown into the group payload (e.g. nightly mirror
 * script) under top-level keys we recognize. When the breakdown is not
 * present we return zeros and the JE collapses to the 2-line bank
 * deposit.
 *
 * Recognized keys (any present, all optional):
 *   raw.sponsored_ads_cents, raw.SponsoredAdsCents, raw.AdvertisingFee.Amount
 *   raw.storage_fees_cents,  raw.StorageFeesCents,  raw.StorageFee.Amount
 *   raw.other_fees_cents,    raw.OtherFeesCents,    raw.OtherFee.Amount
 *
 * Exported for tests.
 */
export function extractSettlementFees(raw) {
  if (!raw || typeof raw !== "object") {
    return { sponsoredAds: ZERO, storageFees: ZERO, otherFees: ZERO };
  }
  return {
    sponsoredAds: pickFeeCents(raw, ["sponsored_ads_cents", "SponsoredAdsCents"], raw.AdvertisingFee),
    storageFees:  pickFeeCents(raw, ["storage_fees_cents", "StorageFeesCents"], raw.StorageFee),
    otherFees:    pickFeeCents(raw, ["other_fees_cents", "OtherFeesCents"], raw.OtherFee),
  };
}

function pickFeeCents(raw, intKeys, nested) {
  for (const k of intKeys) {
    if (raw[k] != null) {
      const c = toBigInt(raw[k]);
      if (c > ZERO) return c;
    }
  }
  if (nested && nested.Amount != null) {
    // Amount comes as a decimal string (e.g. "12.34"). Convert to cents.
    const n = Number(nested.Amount);
    if (Number.isFinite(n) && n > 0) {
      return BigInt(Math.round(n * 100));
    }
  }
  return ZERO;
}

/**
 * Build the settlement JE payload (no DB writes). Exported for unit tests.
 *
 * @param {Object} args
 * @param {Object} args.settlement  fba_settlements row.
 * @param {Object} args.accounts    { bankId, clearingId, sponsoredAdsId, storageFeesId, marketplaceFeesId }.
 * @returns {Object}                payload for gl_post_journal_entry RPC.
 */
export function buildSettlementJePayload({ settlement, accounts }) {
  const net = toBigInt(settlement.net_amount_cents);
  if (net <= ZERO) {
    throw new Error(
      `FBA settlement ${settlement.id}: net_amount_cents=${net} — nothing to post`,
    );
  }
  if (!accounts.bankId) {
    throw new Error(
      `FBA settlement ${settlement.id}: missing 1100 Bank account for entity ${settlement.entity_id}`,
    );
  }
  if (!accounts.clearingId) {
    throw new Error(
      `FBA settlement ${settlement.id}: missing 1115 Marketplace Receivable Clearing account for entity ${settlement.entity_id}`,
    );
  }

  const fees = extractSettlementFees(settlement.raw_payload || {});
  if (fees.sponsoredAds > ZERO && !accounts.sponsoredAdsId) {
    throw new Error(
      `FBA settlement ${settlement.id}: sponsored_ads=${fees.sponsoredAds} but 6521 Sponsored Ads account not configured`,
    );
  }
  if (fees.storageFees > ZERO && !accounts.storageFeesId) {
    throw new Error(
      `FBA settlement ${settlement.id}: storage_fees=${fees.storageFees} but 6522 Storage Fees account not configured`,
    );
  }
  if (fees.otherFees > ZERO && !accounts.marketplaceFeesId) {
    throw new Error(
      `FBA settlement ${settlement.id}: other_fees=${fees.otherFees} but 6520 Marketplace Fees account not configured`,
    );
  }

  const desc = `Amazon FBA settlement ${settlement.financial_event_group_id}`;
  const lines = [];
  let lineNo = 0;

  // DR 1100 Bank = net
  lines.push({
    line_number: ++lineNo,
    account_id: accounts.bankId,
    debit: centsToDecimal(net),
    credit: "0",
    memo: `Bank deposit — ${desc}`,
    subledger_type: null,
    subledger_id: null,
  });

  // CR 1115 Clearing = net (drains the per-order fee + AR clearing balance)
  lines.push({
    line_number: ++lineNo,
    account_id: accounts.clearingId,
    debit: "0",
    credit: centsToDecimal(net),
    memo: `Clear marketplace receivable — ${desc}`,
    subledger_type: null,
    subledger_id: null,
  });

  // Settlement-level fee adjustments. Each category emits a paired
  // DR <fee account> / CR 1115 line so the clearing balance reflects the
  // actual deposit math (net deposit + fees withheld).
  if (fees.sponsoredAds > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.sponsoredAdsId,
      debit: centsToDecimal(fees.sponsoredAds),
      credit: "0",
      memo: `Sponsored ads — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(fees.sponsoredAds),
      memo: `Clear sponsored ads — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }
  if (fees.storageFees > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.storageFeesId,
      debit: centsToDecimal(fees.storageFees),
      credit: "0",
      memo: `Storage fees — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(fees.storageFees),
      memo: `Clear storage fees — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }
  if (fees.otherFees > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.marketplaceFeesId,
      debit: centsToDecimal(fees.otherFees),
      credit: "0",
      memo: `Other marketplace fees — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(fees.otherFees),
      memo: `Clear other marketplace fees — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // Balance check (BigInt cents).
  const drSum = sumLineCents(lines, "debit");
  const crSum = sumLineCents(lines, "credit");
  if (drSum !== crSum) {
    throw new Error(
      `FBA settlement ${settlement.id}: unbalanced JE — debits=${drSum}, credits=${crSum}`,
    );
  }

  return {
    entity_id: settlement.entity_id,
    basis: "ACCRUAL",
    journal_type: "bank_deposit",
    posting_date: toDateString(settlement.posted_before),
    source_module: "fba",
    source_table: "fba_settlements",
    source_id: settlement.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Build the fba_settlements row from a raw SP-API FinancialEventGroup
 * payload. Exported for tests.
 */
export function buildSettlementRow({ account, group }) {
  const gross   = parseAmount(group.OriginalTotal);
  const fees    = parseAmount(group.ProcessingStatus === "Closed" ? group.ConvertedTotal : null);
  const refunds = 0;
  // Amazon reports the net deposit under multiple names depending on the
  // group lifecycle. Prefer ConvertedTotal (final deposited amount once
  // the group closes); fall back to OriginalTotal (gross). Refunds are
  // not broken out at the group level — they show up via per-order JEs.
  const net = parseAmount(group.ConvertedTotal) || gross;
  return {
    fba_seller_account_id: account.id,
    financial_event_group_id: String(
      group.FinancialEventGroupId || group.financial_event_group_id || group.id,
    ),
    posted_after:  toIsoTimestamp(group.FinancialEventGroupStart || group.posted_after),
    posted_before: toIsoTimestamp(
      group.FinancialEventGroupEnd
      || group.posted_before
      || group.FinancialEventGroupStart,
    ),
    gross_amount_cents: gross,
    fees_amount_cents: Math.max(0, gross - net),
    refunds_amount_cents: refunds,
    net_amount_cents: net,
    currency:
      (group.OriginalTotal && group.OriginalTotal.CurrencyCode)
      || (group.ConvertedTotal && group.ConvertedTotal.CurrencyCode)
      || "USD",
    processing_status:
      group.ProcessingStatus === "Closed" ? "Closed" : "Open",
    raw_payload: group,
  };
}

/**
 * Compute the postedAfter cutoff for listFinancialEventGroups.
 *
 * @param {string|null} lastSyncAt   ISO timestamp from
 *                                   fba_seller_accounts.last_settlement_sync_at.
 * @param {number}      sinceDaysAgo
 * @param {string|null} [sinceOverride]
 * @param {number}      [nowMs]
 * @returns {string}                 ISO timestamp.
 */
export function computeSettlementSince(lastSyncAt, sinceDaysAgo, sinceOverride, nowMs = Date.now()) {
  if (sinceOverride) return sinceOverride;
  const days = Number.isFinite(sinceDaysAgo) && sinceDaysAgo > 0
    ? sinceDaysAgo
    : DEFAULT_LOOKBACK_DAYS;
  const floor = new Date(nowMs - days * MS_PER_DAY);
  if (!lastSyncAt) return floor.toISOString();
  const last = new Date(lastSyncAt);
  if (!Number.isFinite(last.getTime())) return floor.toISOString();
  // Use the more recent of (last sync, floor) so we don't miss anything,
  // but also don't re-walk decades of history.
  if (last < floor) return floor.toISOString();
  return last.toISOString();
}

/**
 * Best-effort match a settlement to an existing bank_transactions row.
 * Returns the bank_transactions.id on hit, null on miss. Exported for
 * tests.
 *
 * Match heuristic:
 *   - entity_id = settlement.entity_id
 *   - status = 'unmatched'
 *   - amount_cents = settlement.net_amount_cents (positive deposit)
 *   - posted_date within ±BANK_MATCH_WINDOW_DAYS of settlement.posted_before
 *
 * When more than one candidate matches we return null and let the
 * operator reconcile manually — there's no safe way to pick between
 * identical-amount deposits without human judgment.
 */
export async function matchBankTransaction(adminClient, settlement) {
  const net = toBigInt(settlement.net_amount_cents);
  if (net <= ZERO) return null;

  const periodEnd = new Date(settlement.posted_before);
  if (!Number.isFinite(periodEnd.getTime())) return null;

  const winStart = new Date(periodEnd.getTime() - BANK_MATCH_WINDOW_DAYS * MS_PER_DAY)
    .toISOString().slice(0, 10);
  const winEnd = new Date(periodEnd.getTime() + BANK_MATCH_WINDOW_DAYS * MS_PER_DAY)
    .toISOString().slice(0, 10);

  const { data, error } = await adminClient
    .from("bank_transactions")
    .select("id, posted_date, amount_cents, status")
    .eq("entity_id", settlement.entity_id)
    .eq("status", "unmatched")
    .eq("amount_cents", net.toString())
    .gte("posted_date", winStart)
    .lte("posted_date", winEnd);
  if (error) {
    // Don't sink the JE post on a bank lookup failure — log + null.
    // eslint-disable-next-line no-console
    console.warn(
      `[fba-settlement] bank_transactions lookup failed for settlement ${settlement.id}: ${error.message}`,
    );
    return null;
  }
  if (!data || data.length !== 1) return null;
  return data[0].id;
}

/**
 * Decrypt the LWA credentials triple from a fba_seller_accounts row.
 * Mirrors the helper in ingest-orders.js — duplicated to keep this
 * module independent.
 */
export function decryptAccountCreds(acct, decryptFn = decryptToken) {
  if (!acct.lwa_client_id_ciphertext || !acct.lwa_client_id_iv || !acct.lwa_client_id_tag) {
    throw new Error("account missing encrypted lwa_client_id triple");
  }
  if (!acct.lwa_client_secret_ciphertext || !acct.lwa_client_secret_iv || !acct.lwa_client_secret_tag) {
    throw new Error("account missing encrypted lwa_client_secret triple");
  }
  if (!acct.refresh_token_ciphertext || !acct.refresh_token_iv || !acct.refresh_token_tag) {
    throw new Error("account missing encrypted refresh_token triple");
  }
  return {
    clientId: decryptFn(
      acct.lwa_client_id_ciphertext, acct.lwa_client_id_iv, acct.lwa_client_id_tag,
    ),
    clientSecret: decryptFn(
      acct.lwa_client_secret_ciphertext, acct.lwa_client_secret_iv, acct.lwa_client_secret_tag,
    ),
    refreshToken: decryptFn(
      acct.refresh_token_ciphertext, acct.refresh_token_iv, acct.refresh_token_tag,
    ),
  };
}

/**
 * Main entry point — sync FBA settlements across all active
 * fba_seller_accounts rows.
 *
 * @param {Object} args
 * @param {Object} args.adminClient                  Supabase service-role client.
 * @param {number} [args.sinceDaysAgo=60]            Lookback window.
 * @param {string} [args.onlyFbaSellerAccountId]     Restrict to one account.
 * @param {string} [args.sinceOverride]              Explicit ISO since cutoff.
 * @param {Object} [args.deps]                       Injectable deps for tests.
 * @returns {Promise<Object>}                        Summary.
 */
export async function syncFbaSettlements({
  adminClient,
  sinceDaysAgo = DEFAULT_LOOKBACK_DAYS,
  onlyFbaSellerAccountId = null,
  sinceOverride = null,
  deps = {},
} = {}) {
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("syncFbaSettlements: adminClient is required");
  }
  const _deps = {
    makeClient: (cfg) => new SpApiClient(cfg),
    refreshAccessToken: refreshLwaAccessToken,
    decryptToken,
    now: () => Date.now(),
    ...deps,
  };

  let q = adminClient
    .from("fba_seller_accounts")
    .select(
      "id, entity_id, seller_id, marketplace_id, account_name, region, " +
      "lwa_client_id_ciphertext, lwa_client_id_iv, lwa_client_id_tag, " +
      "lwa_client_secret_ciphertext, lwa_client_secret_iv, lwa_client_secret_tag, " +
      "refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, " +
      "aws_role_arn, is_active, last_settlement_sync_at",
    )
    .eq("is_active", true);
  if (onlyFbaSellerAccountId) q = q.eq("id", onlyFbaSellerAccountId);

  const { data: accounts, error: accErr } = await q;
  if (accErr) {
    throw new Error(`fba_seller_accounts read failed: ${accErr.message}`);
  }

  const summary = {
    accounts_scanned: 0,
    settlements_upserted_total: 0,
    settlements_posted_total: 0,
    settlements_skipped_total: 0,
    bank_matches_total: 0,
    variance_warnings: [],
    errors: [],
    per_account: [],
  };

  for (const acct of accounts || []) {
    summary.accounts_scanned += 1;
    const acctSummary = {
      fba_seller_account_id: acct.id,
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
      await syncOneAccount(adminClient, acct, {
        sinceDaysAgo,
        sinceOverride,
      }, _deps, acctSummary, summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      acctSummary.error = msg;
      summary.errors.push(`fba_seller_account ${acct.id}: ${msg}`);
    }

    summary.settlements_upserted_total += acctSummary.settlements_upserted;
    summary.settlements_posted_total   += acctSummary.settlements_posted;
    summary.settlements_skipped_total  += acctSummary.settlements_skipped;
    summary.bank_matches_total         += acctSummary.bank_matches;
  }

  return summary;
}

async function syncOneAccount(adminClient, acct, opts, deps, acctSummary, runSummary) {
  const creds = decryptAccountCreds(acct, deps.decryptToken);
  const tokenResp = await deps.refreshAccessToken({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken,
  });

  const client = deps.makeClient({
    region: acct.region,
    accessToken: tokenResp.access_token,
    marketplaceId: acct.marketplace_id,
    awsRoleArn: acct.aws_role_arn || null,
  });

  const since = computeSettlementSince(
    acct.last_settlement_sync_at,
    opts.sinceDaysAgo,
    opts.sinceOverride,
    deps.now(),
  );

  // Resolve GL accounts once per account.
  const accounts = await resolveSettlementAccounts(adminClient, acct.entity_id);

  let nextToken = null;
  let safety = 0;
  while (safety < SAFETY_PAGE_CAP) {
    safety += 1;
    acctSummary.pages_walked = safety;

    const listResp = nextToken
      ? await client.listFinancialEventGroups({ nextToken, maxResults: PAGE_LIMIT })
      : await client.listFinancialEventGroups({ postedAfter: since, maxResults: PAGE_LIMIT });

    const groups = listResp.FinancialEventGroupList || [];
    for (const group of groups) {
      try {
        await ingestOneSettlement(
          adminClient, acct, group, accounts, acctSummary, runSummary,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const gid = group?.FinancialEventGroupId || "(unknown)";
        acctSummary.error = acctSummary.error
          ? `${acctSummary.error}; group ${gid}: ${msg}`
          : `group ${gid}: ${msg}`;
        runSummary.errors.push(
          `fba_seller_account ${acct.id} group ${gid}: ${msg}`,
        );
      }
    }
    nextToken = listResp.NextToken || null;
    if (!nextToken) break;
  }

  // Update cursor — start-of-run timestamp so any group updated mid-run
  // is picked up next time.
  const nowIso = new Date(deps.now()).toISOString();
  const { error: cErr } = await adminClient
    .from("fba_seller_accounts")
    .update({ last_settlement_sync_at: nowIso, updated_at: nowIso })
    .eq("id", acct.id);
  if (cErr) {
    throw new Error(`last_settlement_sync_at update failed: ${cErr.message}`);
  }
  acctSummary.cursor_updated = true;
}

async function ingestOneSettlement(adminClient, acct, group, accounts, acctSummary, runSummary) {
  const row = buildSettlementRow({ account: acct, group });
  if (!row.financial_event_group_id || row.financial_event_group_id === "undefined") {
    throw new Error("group missing FinancialEventGroupId");
  }

  // Upsert by (fba_seller_account_id, financial_event_group_id).
  const { data: upserted, error: upErr } = await adminClient
    .from("fba_settlements")
    .upsert(row, { onConflict: "fba_seller_account_id,financial_event_group_id" })
    .select(
      "id, je_id, entity_id, fba_seller_account_id, financial_event_group_id, " +
      "posted_after, posted_before, gross_amount_cents, fees_amount_cents, " +
      "refunds_amount_cents, net_amount_cents, processing_status, " +
      "bank_transaction_id, raw_payload",
    )
    .single();
  if (upErr) {
    throw new Error(`fba_settlements upsert failed: ${upErr.message}`);
  }
  acctSummary.settlements_upserted += 1;

  // Idempotent JE skip.
  if (upserted.je_id) {
    acctSummary.settlements_skipped += 1;
    return;
  }

  // Skip Open groups — Amazon still adjusts the totals until the group
  // is Closed and the deposit posts to the bank account. Posting the
  // JE prematurely risks misreporting the final amount.
  if (upserted.processing_status !== "Closed") {
    acctSummary.settlements_skipped += 1;
    return;
  }

  // Skip zero-net settlements.
  const net = toBigInt(upserted.net_amount_cents);
  if (net <= ZERO) {
    acctSummary.settlements_skipped += 1;
    return;
  }

  // Variance check: per-order AR clearing booked during the window should
  // approximately equal the settlement's net deposit. We log a warning if
  // the delta exceeds 1% of the gross deposit. This is informational only;
  // we still post the JE — the operator decides whether to investigate.
  const variance = await computeClearingVariance(
    adminClient, acct, upserted,
  );
  if (variance && variance.diff_cents !== 0n) {
    const grossAbs = variance.gross_cents < ZERO ? -variance.gross_cents : variance.gross_cents;
    const threshold = grossAbs / 100n;          // 1%
    const diffAbs = variance.diff_cents < ZERO ? -variance.diff_cents : variance.diff_cents;
    if (diffAbs > threshold) {
      runSummary.variance_warnings.push({
        fba_settlement_id: upserted.id,
        fba_seller_account_id: acct.id,
        financial_event_group_id: upserted.financial_event_group_id,
        ar_clearing_cents: variance.ar_clearing_cents.toString(),
        net_amount_cents: upserted.net_amount_cents.toString(),
        diff_cents: variance.diff_cents.toString(),
      });
    }
  }

  // Build + post JE.
  const payload = buildSettlementJePayload({ settlement: upserted, accounts });
  const { data: jeId, error: rpcErr } = await adminClient.rpc(
    "gl_post_journal_entry",
    { payload },
  );
  if (rpcErr) {
    throw new Error(`gl_post_journal_entry RPC failed: ${rpcErr.message}`);
  }
  if (typeof jeId !== "string") {
    throw new Error(
      `gl_post_journal_entry returned unexpected payload: ${JSON.stringify(jeId)}`,
    );
  }

  // Best-effort bank-transaction match.
  let bankTxnId = null;
  try {
    bankTxnId = await matchBankTransaction(adminClient, upserted);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[fba-settlement] bank match failed for ${upserted.id}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Stamp je_id + bank_transaction_id.
  const patch = { je_id: jeId };
  if (bankTxnId) {
    patch.bank_transaction_id = bankTxnId;
    acctSummary.bank_matches += 1;
  }
  const { error: stampErr } = await adminClient
    .from("fba_settlements")
    .update(patch)
    .eq("id", upserted.id);
  if (stampErr) {
    throw new Error(
      `fba_settlements stamp failed (JE ${jeId} posted): ${stampErr.message}`,
    );
  }

  // If we matched a bank_transactions row, flip its status to 'matched'.
  // Failure here is non-fatal — the operator can re-run the bank-recon
  // engine to fix it.
  if (bankTxnId) {
    const { error: btErr } = await adminClient
      .from("bank_transactions")
      .update({ status: "matched", je_id: jeId })
      .eq("id", bankTxnId);
    if (btErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fba-settlement] bank_transactions status update failed for ${bankTxnId}: ${btErr.message}`,
      );
    }
  }

  acctSummary.settlements_posted += 1;
}

/**
 * Sum the AR clearing (1115) debits booked by per-order JEs during the
 * settlement window. Returns the comparison vs the settlement net. Used
 * to log variance warnings.
 *
 * Returns null if we can't compute (e.g. no fba_orders rows in the
 * window). Exported for tests.
 */
export async function computeClearingVariance(adminClient, acct, settlement) {
  const since = settlement.posted_after;
  const until = settlement.posted_before;
  if (!since || !until) return null;

  const { data: orders, error } = await adminClient
    .from("fba_orders")
    .select("id, item_subtotal_cents, promotion_discount_cents, shipping_cents")
    .eq("fba_seller_account_id", acct.id)
    .gte("purchase_date", since)
    .lte("purchase_date", until);
  if (error) return null;

  // Per-order clearing math: each posted order debited 1115 by
  // (fulfillment_fee + referral_fee) summed across items. We mirror that
  // via fba_order_items here so the variance check stays self-contained.
  if (!orders || orders.length === 0) {
    return {
      ar_clearing_cents: ZERO,
      net_amount_cents: toBigInt(settlement.net_amount_cents),
      gross_cents: toBigInt(settlement.gross_amount_cents),
      diff_cents: -toBigInt(settlement.net_amount_cents),
    };
  }
  const orderIds = orders.map((o) => o.id);
  const { data: items } = await adminClient
    .from("fba_order_items")
    .select("fulfillment_fee_cents, referral_fee_cents")
    .in("fba_order_id", orderIds);

  let clearing = ZERO;
  for (const it of items || []) {
    clearing += toBigInt(it.fulfillment_fee_cents);
    clearing += toBigInt(it.referral_fee_cents);
  }

  const net = toBigInt(settlement.net_amount_cents);
  const gross = toBigInt(settlement.gross_amount_cents);
  // Expectation: AR clearing booked (per-order fees DR 1115) +
  // settlement net deposit (DR 1100, CR 1115) ≈ 0. The "drift" is the
  // delta we surface.
  const diff = clearing - net;
  return {
    ar_clearing_cents: clearing,
    net_amount_cents: net,
    gross_cents: gross,
    diff_cents: diff,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (exported for tests).
// ────────────────────────────────────────────────────────────────────────

/**
 * Parse an SP-API money struct ({Amount: "12.34", CurrencyCode: "USD"})
 * into integer cents. Returns 0 on missing / bad input.
 */
export function parseAmount(money) {
  if (!money || typeof money !== "object") return 0;
  if (money.Amount == null) return 0;
  const n = Number(money.Amount);
  if (!Number.isFinite(n)) return 0;
  if (Math.floor(n) !== n) return Math.round(n * 100);
  // Integer (already in dollars? Amazon always returns decimal strings,
  // but be defensive — Math.round handles either case.)
  return Math.round(n * 100);
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

function toDateString(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  if (typeof ts === "string") return ts.slice(0, 10);
  if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}

function toIsoTimestamp(ts) {
  if (!ts) return new Date().toISOString();
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
  }
  if (ts instanceof Date) return ts.toISOString();
  return new Date(String(ts)).toISOString();
}
