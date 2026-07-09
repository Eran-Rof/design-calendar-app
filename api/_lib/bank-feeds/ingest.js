// api/_lib/bank-feeds/ingest.js
//
// Normalized bank-transaction ingestion seam.
//
// ONE shape, MANY feeds. Today the P6 bank tables are fed by:
//   • the Xoro register mirror (api/_lib/bank-mirror/mirror.js) — live
//   • Plaid /transactions/sync (api/cron/bank-feed-sync.js mapPlaidTxn +
//     api/webhooks/plaid.js) — plumbed, awaiting go-live
//   • CSV upload / manual entry (P6 operator flows)
//
// When Plaid goes live it needs NO new tables and NO schema change: the
// webhook already drives bank-feed-sync, which upserts rows in exactly the
// shape validated here. This module is the documented contract for any
// FUTURE feed (a richer Xoro payments endpoint, a second bank, an
// office-CSV drop): normalize to NormalizedBankTxn, then call
// ingestBankTransactions().
//
// ── NormalizedBankTxn ────────────────────────────────────────────────────
//   external_txn_id  string   REQUIRED — stable per (feed, account); the
//                             idempotency key (Plaid transaction_id, Xoro
//                             payment_number, CSV row hash).
//   posted_date      string   REQUIRED — YYYY-MM-DD, the SOURCE date
//                             (never the import date).
//   amount_cents     integer  REQUIRED — signed; positive = deposit /
//                             money in, negative = withdrawal / charge.
//   description      string?  merchant_name string?  category string[]?
//   pending          boolean  default false
//   raw_payload      object   default {} — the untouched source record.
//
// ── Plaid env vars (documented for go-live; DO NOT invent values) ───────
//   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|development|
//   production), PLAID_WEBHOOK_SECRET, PLAID_TOKEN_ENC_KEY (already used
//   by api/_lib/plaid/encryption.js for access-token pgcrypto). See
//   docs/tangerine/PLAID-SETUP.md.
//
// Match state is NEVER written by ingestion: upserts carry feed columns
// only, so a re-delivered transaction cannot clobber an operator's (or the
// auto-matcher's) match.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const INGEST_SOURCES = ["plaid", "csv_upload", "manual", "xoro_mirror"];

/**
 * Validate + normalize one raw feed record into the NormalizedBankTxn shape.
 * Throws with a field-specific message on bad input (fail loud at the seam,
 * not deep in PostgREST).
 */
export function normalizeExternalTxn(raw) {
  if (!raw || typeof raw !== "object") throw new Error("normalizeExternalTxn: record must be an object");
  const id = raw.external_txn_id;
  if (!id || typeof id !== "string") throw new Error("normalizeExternalTxn: external_txn_id (string) is required");
  const date = raw.posted_date;
  if (!date || typeof date !== "string" || !ISO_DATE_RE.test(date)) {
    throw new Error(`normalizeExternalTxn: posted_date must be YYYY-MM-DD (got ${JSON.stringify(date)})`);
  }
  const cents = raw.amount_cents;
  if (!Number.isInteger(cents)) throw new Error(`normalizeExternalTxn: amount_cents must be an integer (got ${JSON.stringify(cents)})`);
  return {
    external_txn_id: id,
    posted_date: date,
    amount_cents: cents,
    description: typeof raw.description === "string" ? raw.description : null,
    merchant_name: typeof raw.merchant_name === "string" ? raw.merchant_name : null,
    category: Array.isArray(raw.category) ? raw.category.map(String) : null,
    pending: !!raw.pending,
    raw_payload: raw.raw_payload && typeof raw.raw_payload === "object" ? raw.raw_payload : {},
  };
}

/**
 * Idempotently ingest normalized transactions for one bank account.
 *
 * @param {object} admin        service-role supabase client
 * @param {object} bankAccount  {id, entity_id} — a bank_accounts row
 * @param {Array}  rawTxns      raw feed records (normalized here)
 * @param {string} source       one of INGEST_SOURCES
 * @returns {Promise<{upserted:number, rejected:Array<{index:number, error:string}>}>}
 */
export async function ingestBankTransactions(admin, bankAccount, rawTxns, source) {
  if (!bankAccount?.id || !bankAccount?.entity_id) throw new Error("ingestBankTransactions: bankAccount {id, entity_id} required");
  if (!INGEST_SOURCES.includes(source)) throw new Error(`ingestBankTransactions: source must be one of ${INGEST_SOURCES.join(", ")}`);

  const rows = [];
  const rejected = [];
  (rawTxns || []).forEach((raw, index) => {
    try {
      const t = normalizeExternalTxn(raw);
      rows.push({
        entity_id: bankAccount.entity_id,
        bank_account_id: bankAccount.id,
        source,
        ...t,
      });
    } catch (e) {
      rejected.push({ index, error: e?.message || String(e) });
    }
  });

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await admin
      .from("bank_transactions")
      .upsert(batch, { onConflict: "bank_account_id,external_txn_id" });
    if (error) throw new Error(`ingestBankTransactions: upsert failed: ${error.message}`);
    upserted += batch.length;
  }
  return { upserted, rejected };
}
