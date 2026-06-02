// api/_lib/shopify/sync-payouts.js
//
// Tangerine P11-9 — Shopify Payments payout reconciliation service.
//
// Pairs with the P11-3 per-order AR JE. Per the P11 architecture doc:
//   - P11-3 posts per-order:  DR 6510 Merchant Fees + CR 1110 Clearing
//   - P11-9 posts per-payout: DR 1100 Bank            + CR 1110 Clearing
//
// The clearing account (1110 Payment Processor Clearing) accumulates
// per-order fee debits during the day; when Shopify Payments deposits the
// net amount to the merchant's bank account, this service posts the
// offsetting JE that drains the clearing balance into the bank and
// optionally records any payout-level fee adjustments not present on
// individual orders.
//
// JE shape (per arch §4.1 D6):
//   DR 1100 Bank                          = net_amount_cents
//   CR 1110 Payment Processor Clearing    = net_amount_cents
//   (optional adjustment if Shopify reports fees on the payout summary
//   that weren't already booked on the per-order JEs:)
//   DR 6510 Merchant Fees                 = fees_amount_cents
//   CR 1110 Payment Processor Clearing    = fees_amount_cents
//
// Iterates active shopify_stores rows:
//   1. Decrypt access_token (AES-256-GCM).
//   2. Build ShopifyClient.
//   3. listPayouts({since: now - sinceDaysAgo}) → walk page_info cursor.
//   4. For each payout, upsert into shopify_payouts by
//      (shopify_store_id, shopify_payout_id).
//   5. Skip rows that already have je_id (idempotent).
//   6. For new ones, build + post the JE via gl_post_journal_entry, then
//      stamp shopify_payouts.je_id.
//   7. Update shopify_stores.updated_at as a cursor proxy (P11-1 didn't
//      add a dedicated last_payouts_sync_at column; we keep the no-
//      migration constraint and reuse updated_at).
//
// Per-store try/catch — one failing store doesn't sink the rest. Per-
// payout try/catch inside each store so a single broken payout doesn't
// stop the page walk.
//
// BigInt cents throughout per project_tangerine_progress money handling.

import { ShopifyClient } from "./client.js";
import { decryptToken } from "./token-encryption.js";

export const DEFAULT_LOOKBACK_DAYS = 30;
const PAGE_LIMIT = 250;
const SAFETY_PAGE_CAP = 100;

const ZERO = 0n;

/**
 * Resolve GL account ids for the payout JE. Returns a map keyed by code.
 * Required: 1100 Bank, 1110 Payment Processor Clearing. Optional: 6510
 * Merchant Fees (only needed when payout-level fees are reported).
 *
 * @returns {Promise<{bankId:string|null, clearingId:string|null, feeId:string|null}>}
 */
export async function resolvePayoutAccounts(adminClient, entityId) {
  const codes = ["1100", "1110", "6510"];
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
    clearingId: byCode["1110"] || null,
    feeId:      byCode["6510"] || null,
  };
}

/**
 * Build the payout JE payload (no DB writes). Exported for unit tests.
 *
 * @param {Object} args
 * @param {Object} args.payout    shopify_payouts row (snake_case columns).
 * @param {Object} args.accounts  { bankId, clearingId, feeId }.
 * @returns {Object}              payload for gl_post_journal_entry RPC.
 */
export function buildPayoutJePayload({ payout, accounts }) {
  const net  = toBigInt(payout.net_amount_cents);
  const fees = toBigInt(payout.fees_amount_cents);

  if (net <= ZERO && fees <= ZERO) {
    throw new Error(
      `Shopify payout ${payout.id}: both net_amount_cents and fees_amount_cents are zero — nothing to post`,
    );
  }
  if (!accounts.bankId) {
    throw new Error(
      `Shopify payout ${payout.id}: missing 1100 Bank account for entity ${payout.entity_id}`,
    );
  }
  if (!accounts.clearingId) {
    throw new Error(
      `Shopify payout ${payout.id}: missing 1110 Clearing account for entity ${payout.entity_id}`,
    );
  }
  if (fees > ZERO && !accounts.feeId) {
    throw new Error(
      `Shopify payout ${payout.id}: fees_amount_cents=${fees} but 6510 Merchant Fees account not configured`,
    );
  }

  const desc = `Shopify Payments payout ${payout.shopify_payout_id} on ${payout.payout_date}`;
  const lines = [];
  let lineNo = 0;

  // DR 1100 Bank = net
  if (net > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.bankId,
      debit: centsToDecimal(net),
      credit: "0",
      memo: `Bank deposit — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
    // CR 1110 Clearing = net
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(net),
      memo: `Clear processor balance — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // Optional payout-level fee adjustment (DR 6510 / CR 1110)
  if (fees > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.feeId,
      debit: centsToDecimal(fees),
      credit: "0",
      memo: `Payout-level merchant fee — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(fees),
      memo: `Clear processor fee balance — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // Balance check.
  const drSum = sumLineCents(lines, "debit");
  const crSum = sumLineCents(lines, "credit");
  if (drSum !== crSum) {
    throw new Error(
      `Shopify payout ${payout.id}: unbalanced JE — debits=${drSum}, credits=${crSum}`,
    );
  }

  return {
    entity_id: payout.entity_id,
    basis: "ACCRUAL",
    journal_type: "bank_deposit",
    posting_date: toDateString(payout.payout_date),
    source_module: "shopify",
    source_table: "shopify_payouts",
    source_id: payout.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Build the shopify_payouts row from a raw Shopify payout payload.
 * Exported for tests.
 */
export function buildPayoutRow({ store, payout }) {
  const gross = toCents(payout.amount ?? payout.gross ?? payout.gross_amount ?? 0);
  // Shopify reports a `summary` object on payouts containing the fee/total
  // breakdown. Fall back to top-level fields for older payload shapes.
  const summary = payout.summary || {};
  const fees = toCents(
    summary.charges_fee_amount ?? summary.fees_amount ?? payout.fees ?? payout.fees_amount ?? 0,
  );
  // net_amount = gross - fees if not explicitly provided
  const apiNet = payout.net ?? payout.net_amount ?? summary.net_amount;
  const net = apiNet != null ? toCents(apiNet) : (gross - fees);

  return {
    entity_id: store.entity_id,
    shopify_store_id: store.id,
    shopify_payout_id: String(payout.id || payout.payout_id),
    payout_date: dateOnly(payout.date || payout.payout_date || payout.created_at || new Date()),
    gross_amount_cents: gross,
    fees_amount_cents: fees,
    net_amount_cents: net,
    currency: payout.currency || "USD",
    raw_payload: payout,
  };
}

/**
 * Compute the since cutoff for listPayouts.
 *
 * @param {number} sinceDaysAgo
 * @param {string|null} [sinceOverride]
 * @param {number} [nowMs]
 * @returns {string} ISO timestamp.
 */
export function computeSince(sinceDaysAgo, sinceOverride, nowMs = Date.now()) {
  if (sinceOverride) return sinceOverride;
  const days = Number.isFinite(sinceDaysAgo) && sinceDaysAgo > 0
    ? sinceDaysAgo
    : DEFAULT_LOOKBACK_DAYS;
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Main entry point — sync Shopify Payments payouts across all active
 * shopify_stores rows.
 *
 * @param {Object} args
 * @param {Object} args.adminClient                 Supabase service-role client.
 * @param {number} [args.sinceDaysAgo=30]           Lookback window.
 * @param {string} [args.onlyShopifyStoreId]        Restrict to one store.
 * @param {string} [args.sinceOverride]             Explicit ISO since cutoff.
 * @param {Object} [args.deps]                      Injectable deps for tests.
 * @returns {Promise<Object>}                       Summary.
 */
export async function syncShopifyPayouts({
  adminClient,
  sinceDaysAgo = DEFAULT_LOOKBACK_DAYS,
  onlyShopifyStoreId = null,
  sinceOverride = null,
  deps = {},
} = {}) {
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("syncShopifyPayouts: adminClient is required");
  }
  const _deps = {
    makeClient: (cfg) => new ShopifyClient(cfg),
    decryptToken,
    now: () => Date.now(),
    ...deps,
  };

  // 1. Load active stores.
  let q = adminClient
    .from("shopify_stores")
    .select("id, entity_id, shopify_domain, store_name, api_version, access_token_ciphertext, access_token_iv, access_token_tag, is_active")
    .eq("is_active", true)
    .not("access_token_ciphertext", "is", null);
  if (onlyShopifyStoreId) q = q.eq("id", onlyShopifyStoreId);

  const { data: stores, error: storesErr } = await q;
  if (storesErr) {
    throw new Error(`shopify_stores read failed: ${storesErr.message}`);
  }

  const summary = {
    stores_scanned: 0,
    payouts_upserted_total: 0,
    payouts_posted_total: 0,
    payouts_skipped_total: 0,
    errors: [],
    per_store: [],
  };

  for (const store of stores || []) {
    summary.stores_scanned += 1;
    const storeSummary = {
      shopify_store_id: store.id,
      store_name: store.store_name,
      shopify_domain: store.shopify_domain,
      payouts_upserted: 0,
      payouts_posted: 0,
      payouts_skipped: 0,
      pages_walked: 0,
      cursor_updated: false,
      error: null,
    };
    summary.per_store.push(storeSummary);

    try {
      await syncOneStore(adminClient, store, {
        sinceDaysAgo,
        sinceOverride,
      }, _deps, storeSummary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      storeSummary.error = msg;
      summary.errors.push(`shopify_store ${store.id}: ${msg}`);
    }

    summary.payouts_upserted_total += storeSummary.payouts_upserted;
    summary.payouts_posted_total   += storeSummary.payouts_posted;
    summary.payouts_skipped_total  += storeSummary.payouts_skipped;
  }

  return summary;
}

async function syncOneStore(adminClient, store, opts, deps, storeSummary) {
  const accessToken = deps.decryptToken(
    store.access_token_ciphertext,
    store.access_token_iv,
    store.access_token_tag,
  );
  const client = deps.makeClient({
    shopifyDomain: store.shopify_domain,
    accessToken,
    apiVersion: store.api_version || "2025-01",
  });

  const since = computeSince(opts.sinceDaysAgo, opts.sinceOverride, deps.now());

  // Resolve GL accounts once per store.
  const accounts = await resolvePayoutAccounts(adminClient, store.entity_id);

  // Walk pages.
  let pageInfo = null;
  let safety = 0;
  while (safety < SAFETY_PAGE_CAP) {
    safety += 1;
    storeSummary.pages_walked = safety;

    const { data: payouts, nextPageInfo } = pageInfo
      ? await client.listPayouts({ page_info: pageInfo, limit: PAGE_LIMIT })
      : await client.listPayouts({ since, limit: PAGE_LIMIT });

    for (const raw of payouts || []) {
      try {
        await ingestOnePayout(adminClient, store, raw, accounts, storeSummary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        storeSummary.error = storeSummary.error
          ? `${storeSummary.error}; payout ${raw?.id}: ${msg}`
          : `payout ${raw?.id}: ${msg}`;
      }
    }

    if (!nextPageInfo) break;
    pageInfo = nextPageInfo;
  }

  // Update cursor (updated_at — no migration per P11-9 conventions).
  const nowIso = new Date(deps.now()).toISOString();
  const { error: cErr } = await adminClient
    .from("shopify_stores")
    .update({ updated_at: nowIso })
    .eq("id", store.id);
  if (cErr) {
    throw new Error(`shopify_stores cursor update failed: ${cErr.message}`);
  }
  storeSummary.cursor_updated = true;
}

async function ingestOnePayout(adminClient, store, rawPayout, accounts, storeSummary) {
  const row = buildPayoutRow({ store, payout: rawPayout });

  // Upsert by (shopify_store_id, shopify_payout_id).
  const { data: upserted, error: upErr } = await adminClient
    .from("shopify_payouts")
    .upsert(row, { onConflict: "shopify_store_id,shopify_payout_id" })
    .select("id, je_id, entity_id, shopify_payout_id, payout_date, gross_amount_cents, fees_amount_cents, net_amount_cents")
    .single();
  if (upErr) {
    throw new Error(`shopify_payouts upsert failed: ${upErr.message}`);
  }
  storeSummary.payouts_upserted += 1;

  // Idempotent JE skip.
  if (upserted.je_id) {
    storeSummary.payouts_skipped += 1;
    return;
  }

  // Skip $0 payouts (rare — Shopify can emit zero-amount adjustments).
  const net  = toBigInt(upserted.net_amount_cents);
  const fees = toBigInt(upserted.fees_amount_cents);
  if (net <= ZERO && fees <= ZERO) {
    storeSummary.payouts_skipped += 1;
    return;
  }

  // Build + post JE.
  const payload = buildPayoutJePayload({ payout: upserted, accounts });
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
    .from("shopify_payouts")
    .update({ je_id: jeId })
    .eq("id", upserted.id);
  if (stampErr) {
    throw new Error(`shopify_payouts je_id stamp failed (JE ${jeId} posted): ${stampErr.message}`);
  }
  storeSummary.payouts_posted += 1;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (exported for tests).
// ────────────────────────────────────────────────────────────────────────

export function toCents(value) {
  if (value == null) return 0;
  if (typeof value === "bigint") return Number(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  if (Math.floor(num) !== num) return Math.round(num * 100);
  return Math.round(num);
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
    // Convert decimal-string back to BigInt cents.
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
  if (!input) return new Date().toISOString().slice(0, 10);
  if (typeof input === "string" && input.length >= 10) return input.slice(0, 10);
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function toDateString(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  if (typeof ts === "string") return ts.slice(0, 10);
  if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}
