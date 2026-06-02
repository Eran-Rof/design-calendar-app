// api/_lib/marketplaces/faire/post-payout-je.js
//
// Tangerine P12c-3 — Faire monthly payout JE posting service.
//
// When Faire wires the monthly net (gross - commission - refunds) to the
// operator's bank, we clear the 1115 Marketplace Receivable Clearing balance
// that has been accumulating one-per-order across the period.
//
// JE shape (per P12 arch §3.6 + D6):
//   DR 1100 Bank (or bank_accounts.gl_account_id)    = net_amount_cents
//   CR 1115 Marketplace Receivable Clearing          = net_amount_cents
//
// Idempotency:
//   - If faire_payouts.je_id IS NOT NULL → already posted → short-circuit.
//
// Bank account resolution:
//   - Look up entities.default_bank_account_id when present.
//   - Else pick the first active bank_accounts row for the entity (ordered
//     by created_at ASC so demo seeds win deterministically).
//   - Fall back to gl_accounts code='1100' when no bank_accounts row exists.
//
// Auto-match (best-effort):
//   - If a recent unmatched bank_transactions row matches amount + ±5 days,
//     stamp faire_payouts.bank_transaction_id. We do NOT touch
//     bank_transactions.matched_je_line_id here — the P6 bank-recon match
//     engine owns that side of the link (line-level FK).
//
// BigInt cents throughout per project_tangerine_progress money handling.

const ZERO = 0n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MATCH_WINDOW_DAYS = 5;

/**
 * Build the JE payload (no DB writes). Exported for unit tests.
 *
 * @param {Object} args
 * @param {Object} args.payout      faire_payouts row (snake_case columns).
 * @param {Object} args.accounts    { bankId, receivableId }.
 * @returns {Object}                payload for gl_post_journal_entry RPC.
 */
export function buildJournalEntryPayload({ payout, accounts }) {
  const net = toBigInt(payout.net_amount_cents);
  if (net <= ZERO) {
    throw new Error(
      `Faire payout ${payout.id}: net_amount_cents (${net}) must be positive`,
    );
  }

  const desc = `Faire payout ${payout.faire_payout_id}`;
  const lines = [
    // DR 1100 Bank
    {
      line_number: 1,
      account_id: accounts.bankId,
      debit: centsToDecimal(net),
      credit: "0",
      memo: `Bank deposit — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    },
    // CR 1115 Marketplace Receivable Clearing
    {
      line_number: 2,
      account_id: accounts.receivableId,
      debit: "0",
      credit: centsToDecimal(net),
      memo: `Clear receivable — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    },
  ];

  return {
    entity_id: payout.entity_id,
    basis: "ACCRUAL",
    journal_type: "bank_deposit",
    posting_date: toDateString(payout.payout_date),
    source_module: "faire",
    source_table: "faire_payouts",
    source_id: payout.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Resolve 1115 receivable id + bank account id (gl_account_id).
 *
 * Strategy for bank account:
 *   1. entities.default_bank_account_id (when column exists) → use its
 *      bank_accounts.gl_account_id.
 *   2. First active bank_accounts row for entity (oldest first).
 *   3. Fall back to gl_accounts code='1100'.
 *
 * @returns {Promise<{
 *   receivableId:string|null, bankId:string|null, bankAccountId:string|null
 * }>}
 */
export async function resolveGlAccounts(adminClient, entityId) {
  // 1115 always lives in gl_accounts.
  const { data: glData, error: glErr } = await adminClient
    .from("gl_accounts")
    .select("id, code")
    .eq("entity_id", entityId)
    .in("code", ["1115", "1100"]);
  if (glErr) {
    throw new Error(`gl_accounts lookup failed: ${glErr.message}`);
  }
  const byCode = {};
  for (const row of glData || []) byCode[row.code] = row.id;

  // Try bank_accounts first.
  let bankId = null;
  let bankAccountId = null;
  const { data: bankRows, error: bankErr } = await adminClient
    .from("bank_accounts")
    .select("id, gl_account_id, is_active, created_at")
    .eq("entity_id", entityId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (bankErr && bankErr.code !== "PGRST116" && bankErr.code !== "42P01") {
    // Don't blow up if bank_accounts table doesn't exist yet (PGRST116/42P01).
    throw new Error(`bank_accounts lookup failed: ${bankErr.message}`);
  }
  const firstBank = (bankRows || [])[0];
  if (firstBank?.gl_account_id) {
    bankId = firstBank.gl_account_id;
    bankAccountId = firstBank.id;
  } else if (byCode["1100"]) {
    bankId = byCode["1100"];
  }

  return {
    receivableId: byCode["1115"] || null,
    bankId,
    bankAccountId,
  };
}

/**
 * Best-effort auto-match: look for an unmatched bank_transactions row in the
 * same entity with amount == net_amount_cents and posted_date within
 * ±MATCH_WINDOW_DAYS of payout.payout_date. Returns the matched row id or
 * null. Exported for tests.
 */
export async function findMatchingBankTransaction(adminClient, payout) {
  if (!payout.entity_id || !payout.payout_date) return null;
  const net = toBigInt(payout.net_amount_cents);
  if (net <= ZERO) return null;

  const winStart = shiftDate(payout.payout_date, -MATCH_WINDOW_DAYS);
  const winEnd   = shiftDate(payout.payout_date, +MATCH_WINDOW_DAYS);

  const { data, error } = await adminClient
    .from("bank_transactions")
    .select("id, amount_cents, posted_date, status")
    .eq("entity_id", payout.entity_id)
    .eq("status", "unmatched")
    .eq("amount_cents", Number(net))
    .gte("posted_date", winStart)
    .lte("posted_date", winEnd)
    .order("posted_date", { ascending: true })
    .limit(1);
  if (error) {
    // Table-missing or RLS — soft-fail, log via return value.
    return null;
  }
  return (data || [])[0]?.id || null;
}

/**
 * Main entry point — post the bank deposit JE for a faire_payouts row.
 *
 * @param {Object} args
 * @param {string} args.fairePayoutId        UUID of faire_payouts.id.
 * @param {Object} args.adminClient          Supabase service-role client.
 * @returns {Promise<
 *   {status:'already_posted', je_id:string} |
 *   {status:'posted', je_id:string, bank_transaction_id:string|null}
 * >}
 */
export async function postFairePayoutJe({ fairePayoutId, adminClient }) {
  if (!fairePayoutId || !UUID_RE.test(String(fairePayoutId))) {
    throw new Error("fairePayoutId must be a uuid");
  }
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }

  // 1. Read faire_payouts row.
  const { data: payout, error: payErr } = await adminClient
    .from("faire_payouts")
    .select("*")
    .eq("id", fairePayoutId)
    .maybeSingle();
  if (payErr) {
    throw new Error(`faire_payouts lookup failed: ${payErr.message}`);
  }
  if (!payout) {
    const e = new Error(`faire_payouts ${fairePayoutId} not found`);
    e.code = "not_found";
    throw e;
  }

  // 2. Idempotency.
  if (payout.je_id) {
    return { status: "already_posted", je_id: payout.je_id };
  }

  // 3. Resolve accounts.
  const accounts = await resolveGlAccounts(adminClient, payout.entity_id);
  const missing = [];
  if (!accounts.receivableId) missing.push("1115 — Marketplace Receivable Clearing");
  if (!accounts.bankId)       missing.push("1100 — Bank (or bank_accounts.gl_account_id)");
  if (missing.length > 0) {
    const e = new Error(`Missing GL accounts: ${missing.join(", ")}`);
    e.code = "gl_accounts_missing";
    throw e;
  }

  // 4. Build + post JE.
  const payload = buildJournalEntryPayload({ payout, accounts });
  const { data: jeId, error: rpcErr } = await adminClient.rpc(
    "gl_post_journal_entry",
    { payload },
  );
  if (rpcErr) {
    const e = new Error(`gl_post_journal_entry RPC failed: ${rpcErr.message}`);
    e.code = "rpc_failed";
    e.cause = rpcErr;
    throw e;
  }
  if (typeof jeId !== "string") {
    throw new Error(
      `gl_post_journal_entry returned unexpected payload: ${JSON.stringify(jeId)}`,
    );
  }

  // 5. Best-effort auto-match against unmatched bank_transactions.
  let matchedBankTxnId = payout.bank_transaction_id || null;
  if (!matchedBankTxnId) {
    try {
      matchedBankTxnId = await findMatchingBankTransaction(adminClient, payout);
    } catch {
      matchedBankTxnId = null;
    }
  }

  // 6. Stamp faire_payouts with je_id + bank_transaction_id (when matched).
  const stamp = { je_id: jeId };
  if (matchedBankTxnId) stamp.bank_transaction_id = matchedBankTxnId;
  const { error: updErr } = await adminClient
    .from("faire_payouts")
    .update(stamp)
    .eq("id", fairePayoutId);
  if (updErr) {
    const e = new Error(
      `faire_payouts update failed (JE ${jeId} posted): ${updErr.message}`,
    );
    e.code = "faire_payouts_update_failed";
    e.je_id = jeId;
    throw e;
  }

  return {
    status: "posted",
    je_id: jeId,
    bank_transaction_id: matchedBankTxnId || null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (exported for unit tests).
// ────────────────────────────────────────────────────────────────────────

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

function toDateString(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  if (typeof ts === "string") return ts.slice(0, 10);
  if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}

export function shiftDate(dateOrIso, deltaDays) {
  const base = typeof dateOrIso === "string"
    ? new Date(`${dateOrIso.slice(0, 10)}T00:00:00Z`)
    : (dateOrIso instanceof Date ? dateOrIso : new Date());
  if (!Number.isFinite(base.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}
