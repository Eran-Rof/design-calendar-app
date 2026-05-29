// api/_lib/marketplaces/walmart/sync-returns.js
//
// Tangerine P12b-5 — Walmart returns sync service.
//
// Mirror of P12a-6 (FBA returns) for Walmart. Sibling differences:
//   - Walmart uses return_order_id as the UNIQUE key (vs FBA's
//     amazon_return_id).
//   - Restocking fees are EXPLICIT on Walmart returns
//     (walmart_returns.restocking_fee_cents). FBA does not surface a
//     restocking fee on most categories.
//   - Walmart does NOT auto-dispose like FBA — most returns come back to
//     the seller's warehouse (return_status='RECEIVED' / 'COMPLETED').
//     WFS returns work like FBA (Walmart decides disposition).
//
// Per walmart_seller_accounts row:
//   1. Decrypt client_id / client_secret + fetch access token.
//   2. WalmartClient.listReturns last 30 days.
//   3. For each return:
//      a. Upsert walmart_returns by return_order_id.
//      b. If walmart_returns.je_id IS NULL:
//         - Post AR credit memo JE:
//             CR 1200 AR              = refund_amount_cents
//             DR 4000 Revenue         = refund_amount_cents - restocking_fee_cents
//             CR 4500 Restocking Fee  = restocking_fee_cents  (D8 — operator
//                                       keeps this slice of the refund)
//         - Insert ar_invoices row (invoice_kind='customer_credit_memo',
//           source='walmart', total = refund - restocking_fee).
//         - If we can resolve item_sku → ip_item_master_id AND know a
//           qty + a layer cost, also post an inventory restock JE:
//             DR 1300 Inventory  = qty × unit_cost
//             CR 5000 COGS       = qty × unit_cost
//           plus one inventory_layers row with
//             source_kind = 'wfs_return_restock' when return came back to
//                           Walmart's WFS facility (return_status starts
//                           with 'WFS' or order was WFSFulfilled)
//             source_kind = 'credit_memo_return' otherwise (seller
//                           warehouse — the "normal" case for Walmart).
//      c. Stamp walmart_returns.je_id + ar_credit_memo_id.
//
// Per-account try/catch — one failing account NEVER breaks the others.
// Per-return try/catch — one failing return is captured in
// acctResult.return_errors without aborting the rest of the account.
//
// BigInt cents throughout (no float math for money).
// source='walmart' on the ar_invoices credit memo per T10-1 source
// tagging — same pattern as P12b-3.

import { createClient } from "@supabase/supabase-js";
import { decryptToken } from "./token-encryption.js";
import { getWalmartAccessToken } from "./auth.js";
import { WalmartClient } from "./client.js";

const ZERO = 0n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LOOKBACK_DAYS = 30;
const SAFETY_MAX_PAGES = 50;

// ────────────────────────────────────────────────────────────────────────
// Public entry points
// ────────────────────────────────────────────────────────────────────────

/**
 * Top-level orchestrator. Walks every active walmart_seller_accounts row
 * and ingests + posts returns for the lookback window. Per-account errors
 * are captured into out.accounts[].error without aborting the run.
 *
 * @param {Object} supabase  service-role client
 * @param {Object} [opts]
 * @param {string|null} [opts.account_id]    only this account (manual trigger)
 * @param {string|null} [opts.since]         ISO timestamp lookback override
 * @param {Object} [opts.deps]               injection point for tests
 *   - getAccessToken({clientId, clientSecret}) → {access_token,...}
 *   - ClientCtor                              → WalmartClient constructor
 *   - decrypt(ct, iv, tag)                    → plaintext
 */
export async function runWalmartReturnsSync(supabase, opts = {}) {
  const deps = {
    getAccessToken:
      opts.deps?.getAccessToken ||
      (({ clientId, clientSecret }) =>
        getWalmartAccessToken({ clientId, clientSecret })),
    ClientCtor: opts.deps?.ClientCtor || WalmartClient,
    decrypt: opts.deps?.decrypt || decryptToken,
  };

  const accounts = await loadAccounts(supabase, opts.account_id || null);
  const out = {
    started_at: new Date().toISOString(),
    accounts: [],
    total_returns_upserted: 0,
    total_credit_memos_posted: 0,
    total_credit_memos_already_posted: 0,
    total_restocks_posted: 0,
    total_return_errors: 0,
    total_errors: 0,
  };

  for (const acct of accounts) {
    const acctResult = await ingestOneAccount(supabase, acct, deps, {
      since: opts.since || null,
    });
    out.accounts.push(acctResult);
    out.total_returns_upserted += acctResult.returns_upserted || 0;
    out.total_credit_memos_posted += acctResult.credit_memos_posted || 0;
    out.total_credit_memos_already_posted +=
      acctResult.credit_memos_already_posted || 0;
    out.total_restocks_posted += acctResult.restocks_posted || 0;
    out.total_return_errors += acctResult.return_errors?.length || 0;
    if (acctResult.error) out.total_errors += 1;
  }

  out.finished_at = new Date().toISOString();
  return out;
}

async function loadAccounts(supabase, account_id) {
  let q = supabase
    .from("walmart_seller_accounts")
    .select(
      "id, entity_id, partner_id, account_name, " +
        "client_id_ciphertext, client_id_iv, client_id_tag, " +
        "client_secret_ciphertext, client_secret_iv, client_secret_tag, " +
        "wfs_location_id, is_active",
    )
    .eq("is_active", true);
  if (account_id) q = q.eq("id", account_id);
  const { data, error } = await q;
  if (error) {
    throw new Error(`load walmart_seller_accounts failed: ${error.message}`);
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Process a single seller account. Captures every throw into
 * acctResult.error rather than rethrowing.
 */
export async function ingestOneAccount(supabase, acct, deps, { since } = {}) {
  const acctResult = {
    walmart_seller_account_id: acct.id,
    partner_id: acct.partner_id,
    account_name: acct.account_name,
    returns_seen: 0,
    returns_upserted: 0,
    credit_memos_posted: 0,
    credit_memos_already_posted: 0,
    restocks_posted: 0,
    pages_walked: 0,
    return_errors: [],
    error: null,
  };

  try {
    if (
      acct.client_id_ciphertext == null ||
      acct.client_id_iv == null ||
      acct.client_id_tag == null ||
      acct.client_secret_ciphertext == null ||
      acct.client_secret_iv == null ||
      acct.client_secret_tag == null
    ) {
      throw new Error(
        "account missing client_id / client_secret ciphertext triple",
      );
    }
    const clientId = deps.decrypt(
      acct.client_id_ciphertext,
      acct.client_id_iv,
      acct.client_id_tag,
    );
    const clientSecret = deps.decrypt(
      acct.client_secret_ciphertext,
      acct.client_secret_iv,
      acct.client_secret_tag,
    );

    const tok = await deps.getAccessToken({ clientId, clientSecret });
    const client = new deps.ClientCtor({
      partnerId: acct.partner_id,
      accessToken: tok.access_token,
    });

    const returnCreatedStartDate = computeStartDate(since);
    const returnCreatedEndDate = new Date().toISOString();

    let cursor = null;
    let page = 0;
    do {
      const { data, nextCursor } = await client.listReturns({
        returnCreatedStartDate,
        returnCreatedEndDate,
        nextCursor: cursor,
      });
      page += 1;
      acctResult.pages_walked = page;
      const returns = Array.isArray(data) ? data : [];
      acctResult.returns_seen += returns.length;

      for (const ret of returns) {
        try {
          const wm_return_row = await upsertReturn(supabase, acct, ret);
          if (!wm_return_row) continue;
          acctResult.returns_upserted += 1;

          if (wm_return_row.je_id) {
            // already posted — idempotent re-sync.
            acctResult.credit_memos_already_posted += 1;
            continue;
          }

          const posting = await postReturnCreditMemo({
            supabase,
            walmartReturnId: wm_return_row.id,
            sellerAccount: acct,
          });
          if (posting.status === "posted") {
            acctResult.credit_memos_posted += 1;
            if (posting.restock_je_id) acctResult.restocks_posted += 1;
          } else if (posting.status === "already_posted") {
            acctResult.credit_memos_already_posted += 1;
          }
        } catch (retErr) {
          acctResult.return_errors.push({
            return_order_id:
              ret?.returnOrderId ||
              ret?.return_order_id ||
              ret?.purchaseOrderId ||
              null,
            code: retErr?.code || null,
            error: retErr instanceof Error ? retErr.message : String(retErr),
          });
        }
      }

      cursor = nextCursor || null;
      if (page >= SAFETY_MAX_PAGES) break;
    } while (cursor);
  } catch (e) {
    acctResult.error = e instanceof Error ? e.message : String(e);
  }

  return acctResult;
}

/**
 * Compute returnCreatedStartDate. Defaults to now − 30d; explicit since
 * overrides as long as it's older than now.
 */
export function computeStartDate(sinceIso, nowMs = Date.now()) {
  const lookbackMs = nowMs - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const lookbackIso = new Date(lookbackMs).toISOString();
  if (!sinceIso) return lookbackIso;
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return lookbackIso;
  return sinceMs < nowMs ? new Date(sinceMs).toISOString() : lookbackIso;
}

// ────────────────────────────────────────────────────────────────────────
// Upsert + posting
// ────────────────────────────────────────────────────────────────────────

/**
 * Upsert a single Walmart return into walmart_returns by return_order_id.
 *
 * Returns the upserted row (with id, je_id, ar_credit_memo_id) so the
 * caller can decide whether to post a credit memo or skip.
 */
export async function upsertReturn(supabase, acct, ret) {
  const return_order_id = String(
    ret?.returnOrderId ?? ret?.return_order_id ?? ret?.returnOrderID ?? "",
  );
  if (!return_order_id) return null;

  const customer_order_id =
    ret?.customerOrderId ?? ret?.customer_order_id ?? null;
  const item_sku = pickSku(ret);
  const quantity = pickInt(extractQuantity(ret));
  const reason = pickReason(ret);
  const return_status = pickStatus(ret);
  const refund_amount_cents = extractRefundCents(ret);
  const restocking_fee_cents = extractRestockingFeeCents(ret);

  // Resolve the parent walmart_orders row when possible. customer_order_id
  // is the cleanest join key Walmart gives us; if absent, leave NULL and
  // we'll skip the inventory restock unless ip_item_master_id can be
  // resolved from the SKU alone.
  let walmart_order_id = null;
  if (customer_order_id) {
    const { data: parent } = await supabase
      .from("walmart_orders")
      .select("id")
      .eq("walmart_seller_account_id", acct.id)
      .eq("customer_order_id", customer_order_id)
      .maybeSingle();
    if (parent?.id) walmart_order_id = parent.id;
  }

  // Resolve ip_item_master_id from SKU (best-effort — NULL when unknown,
  // which just means we skip the inventory restock leg).
  let ip_item_master_id = null;
  if (item_sku) {
    const { data: itemRow } = await supabase
      .from("ip_item_master")
      .select("id")
      .eq("sku", item_sku)
      .maybeSingle();
    if (itemRow?.id) ip_item_master_id = itemRow.id;
  }

  const row = {
    entity_id: acct.entity_id,
    walmart_order_id,
    customer_order_id,
    return_order_id,
    item_sku,
    ip_item_master_id,
    quantity,
    reason,
    return_status,
    refund_amount_cents: refund_amount_cents.toString(),
    restocking_fee_cents: restocking_fee_cents.toString(),
    raw_payload: ret,
  };

  const { data, error } = await supabase
    .from("walmart_returns")
    .upsert(row, { onConflict: "return_order_id" })
    .select(
      "id, entity_id, walmart_order_id, customer_order_id, return_order_id, " +
        "item_sku, ip_item_master_id, quantity, reason, return_status, " +
        "refund_amount_cents, restocking_fee_cents, je_id, ar_credit_memo_id",
    )
    .maybeSingle();
  if (error) {
    throw new Error(
      `walmart_returns upsert failed (${return_order_id}): ${error.message}`,
    );
  }
  return data;
}

/**
 * Post the AR credit memo + inventory restock JEs for a single
 * walmart_returns row. Idempotent: short-circuits when je_id is already
 * set.
 *
 * @param {Object} args
 * @param {Object} args.supabase
 * @param {string} args.walmartReturnId
 * @param {Object} args.sellerAccount    walmart_seller_accounts row
 *                                       (we read wfs_location_id off it).
 * @returns {Promise<
 *   {status:'already_posted', je_id:string} |
 *   {status:'posted', je_id:string, ar_credit_memo_id:string, restock_je_id:string|null}
 * >}
 */
export async function postReturnCreditMemo({
  supabase,
  walmartReturnId,
  sellerAccount,
}) {
  if (!walmartReturnId || !UUID_RE.test(String(walmartReturnId))) {
    throw new Error("walmartReturnId must be a uuid");
  }
  if (!supabase || typeof supabase.from !== "function") {
    throw new Error("supabase must be a Supabase client");
  }

  // 1. Read the walmart_returns row.
  const { data: ret, error: retErr } = await supabase
    .from("walmart_returns")
    .select("*")
    .eq("id", walmartReturnId)
    .maybeSingle();
  if (retErr) {
    throw new Error(`walmart_returns lookup failed: ${retErr.message}`);
  }
  if (!ret) {
    const e = new Error(`walmart_returns ${walmartReturnId} not found`);
    e.code = "not_found";
    throw e;
  }

  // 2. Idempotency.
  if (ret.je_id) {
    return { status: "already_posted", je_id: ret.je_id };
  }

  const refundAmount = toBigInt(ret.refund_amount_cents);
  const restockingFee = toBigInt(ret.restocking_fee_cents);
  if (refundAmount < ZERO) {
    throw new Error(
      `walmart_returns ${walmartReturnId}: refund_amount_cents negative (${refundAmount})`,
    );
  }
  if (restockingFee < ZERO) {
    throw new Error(
      `walmart_returns ${walmartReturnId}: restocking_fee_cents negative (${restockingFee})`,
    );
  }
  if (restockingFee > refundAmount) {
    throw new Error(
      `walmart_returns ${walmartReturnId}: restocking_fee_cents (${restockingFee}) > refund_amount_cents (${refundAmount})`,
    );
  }

  // 3. Resolve customer id from parent walmart_orders row (if any).
  let customerId = null;
  if (ret.walmart_order_id) {
    const { data: parent } = await supabase
      .from("walmart_orders")
      .select("customer_id, purchase_order_id, customer_order_id")
      .eq("id", ret.walmart_order_id)
      .maybeSingle();
    if (parent?.customer_id) customerId = parent.customer_id;
  }
  if (!customerId) {
    const e = new Error(
      `walmart_returns ${walmartReturnId}: could not resolve customer (no parent walmart_orders row or parent missing customer_id)`,
    );
    e.code = "customer_resolution_failed";
    throw e;
  }

  // 4. Resolve GL accounts.
  const accounts = await resolveGlAccounts(supabase, ret.entity_id);
  const missing = [];
  if (!accounts.arId) missing.push("1200 (or 1201) — AR");
  if (!accounts.revenueId) missing.push("4000 — Revenue");
  if (restockingFee > ZERO && !accounts.restockingFeeIncomeId) {
    missing.push("4500 — Restocking Fee Income");
  }
  if (missing.length > 0) {
    const e = new Error(`Missing GL accounts: ${missing.join(", ")}`);
    e.code = "gl_accounts_missing";
    throw e;
  }

  // 5. Build + post the credit memo JE.
  const cmPayload = buildCreditMemoJePayload({
    ret,
    refundAmount,
    restockingFee,
    accounts,
    customerId,
  });
  const { data: cmJeId, error: cmErr } = await supabase.rpc(
    "gl_post_journal_entry",
    { payload: cmPayload },
  );
  if (cmErr) {
    const e = new Error(`gl_post_journal_entry (credit memo) failed: ${cmErr.message}`);
    e.code = "rpc_failed";
    e.cause = cmErr;
    throw e;
  }
  if (typeof cmJeId !== "string") {
    throw new Error(
      `gl_post_journal_entry (credit memo) returned unexpected payload: ${JSON.stringify(cmJeId)}`,
    );
  }

  // 6. Create the ar_invoices credit memo row.
  const arRow = buildCreditMemoArRow({
    ret,
    refundAmount,
    restockingFee,
    accounts,
    customerId,
    jeId: cmJeId,
  });
  const { data: arRowOut, error: arErr } = await supabase
    .from("ar_invoices")
    .insert(arRow)
    .select("id")
    .single();
  if (arErr) {
    // JE posted but invoice didn't write. Stamp je_id so operator can see.
    await supabase
      .from("walmart_returns")
      .update({ je_id: cmJeId })
      .eq("id", walmartReturnId);
    const e = new Error(
      `ar_invoices insert failed (credit memo JE ${cmJeId} posted but invoice not created): ${arErr.message}`,
    );
    e.code = "ar_invoice_insert_failed";
    e.je_id = cmJeId;
    throw e;
  }

  // 7. Optional inventory restock JE.
  let restockJeId = null;
  const qty = Number(ret.quantity);
  const canRestock =
    ret.ip_item_master_id &&
    Number.isFinite(qty) &&
    qty > 0 &&
    accounts.inventoryAssetId &&
    accounts.cogsId;
  if (canRestock) {
    try {
      const unitCostCents = await resolveLatestLayerUnitCost(
        supabase,
        ret.entity_id,
        ret.ip_item_master_id,
      );
      if (unitCostCents != null && unitCostCents > ZERO) {
        const sourceKind = pickRestockSourceKind({
          returnStatus: ret.return_status,
          rawPayload: ret.raw_payload,
        });
        const restockResult = await postRestockJe({
          supabase,
          ret,
          qty,
          unitCostCents,
          accounts,
          sourceKind,
        });
        restockJeId = restockResult.je_id;
      }
    } catch (restockErr) {
      // Best-effort restock — credit memo is committed; surface the
      // restock failure on the return row's notes via update.
      await supabase
        .from("walmart_returns")
        .update({
          raw_payload: {
            ...(ret.raw_payload || {}),
            _restock_error:
              restockErr instanceof Error
                ? restockErr.message
                : String(restockErr),
          },
        })
        .eq("id", walmartReturnId);
    }
  }

  // 8. Stamp walmart_returns with the credit memo pointers.
  const { error: updErr } = await supabase
    .from("walmart_returns")
    .update({
      je_id: cmJeId,
      ar_credit_memo_id: arRowOut.id,
    })
    .eq("id", walmartReturnId);
  if (updErr) {
    const e = new Error(
      `walmart_returns update failed (JE ${cmJeId} + credit memo ${arRowOut.id} posted): ${updErr.message}`,
    );
    e.code = "walmart_returns_update_failed";
    e.je_id = cmJeId;
    e.ar_credit_memo_id = arRowOut.id;
    throw e;
  }

  return {
    status: "posted",
    je_id: cmJeId,
    ar_credit_memo_id: arRowOut.id,
    restock_je_id: restockJeId,
  };
}

/**
 * Build the gl_post_journal_entry payload for the credit memo.
 *
 *   DR 4000 Revenue                = refund_amount_cents (FULL reversal)
 *   CR 1200 AR                     = refund_amount_cents - restocking_fee_cents
 *                                    (customer's AR reduces only by the net
 *                                    refund — we keep the restocking slice)
 *   CR 4500 Restocking Fee Income  = restocking_fee_cents
 *                                    (reclassifies the kept slice from 4000
 *                                    Revenue → 4500 Restocking Fee Income
 *                                    per D8 — operator P&L still sees the
 *                                    same gross, but the line item is
 *                                    visible as restocking income)
 *
 * When restocking_fee_cents == 0 the AR + Revenue pair both = refund.
 */
export function buildCreditMemoJePayload({
  ret,
  refundAmount,
  restockingFee,
  accounts,
  customerId,
}) {
  const netRefund = refundAmount - restockingFee;
  if (netRefund < ZERO) {
    throw new Error(
      `Walmart return ${ret.id}: net refund derived negative (${netRefund})`,
    );
  }

  const label = ret.return_order_id || ret.customer_order_id || ret.id;
  const desc =
    restockingFee > ZERO
      ? `Walmart return ${label} (restocking fee $${centsToDecimal(restockingFee)} to 4500)`
      : `Walmart return ${label}`;

  const lines = [];
  let n = 0;

  // DR 4000 Revenue = FULL refund (reverses the original revenue
  // recognition + reclassifies the restocking slice).
  if (refundAmount > ZERO) {
    lines.push({
      line_number: ++n,
      account_id: accounts.revenueId,
      debit: centsToDecimal(refundAmount),
      credit: "0",
      memo: `Revenue reversal — ${label}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // CR 1200 AR = net refund (customer's AR reduces only by what we'll
  // actually lose from the marketplace clearing — restocking is kept).
  if (netRefund > ZERO) {
    lines.push({
      line_number: ++n,
      account_id: accounts.arId,
      debit: "0",
      credit: centsToDecimal(netRefund),
      memo: `AR reversal — ${label}`,
      subledger_type: "customer",
      subledger_id: customerId,
    });
  }

  // CR 4500 Restocking Fee Income (only when fee > 0).
  if (restockingFee > ZERO) {
    lines.push({
      line_number: ++n,
      account_id: accounts.restockingFeeIncomeId,
      debit: "0",
      credit: centsToDecimal(restockingFee),
      memo: `Restocking fee — ${label}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // Defensive balance check.
  let dr = ZERO;
  let cr = ZERO;
  for (const ln of lines) {
    dr += decimalToBigIntCents(ln.debit);
    cr += decimalToBigIntCents(ln.credit);
  }
  if (dr !== cr) {
    throw new Error(
      `Walmart return ${ret.id}: unbalanced credit memo JE — debits=${dr}, credits=${cr} (refund=${refundAmount}, restockingFee=${restockingFee})`,
    );
  }

  return {
    entity_id: ret.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_credit_memo",
    posting_date: toDateString(ret.created_at || new Date()),
    source_module: "walmart",
    source_table: "walmart_returns",
    source_id: ret.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Build the ar_invoices insert row for the credit memo.
 */
export function buildCreditMemoArRow({
  ret,
  refundAmount,
  restockingFee,
  accounts,
  customerId,
  jeId,
}) {
  const netRefund = refundAmount - restockingFee;
  const label = ret.return_order_id || ret.customer_order_id || ret.id;
  return {
    entity_id: ret.entity_id,
    customer_id: customerId,
    invoice_number: `WALMART-CM-${label}`.slice(0, 64),
    invoice_kind: "customer_credit_memo",
    gl_status: "sent",
    invoice_date: toDateString(ret.created_at || new Date()),
    posting_date: toDateString(ret.created_at || new Date()),
    ar_account_id: accounts.arId,
    revenue_account_id: accounts.revenueId,
    accrual_je_id: jeId,
    total_amount_cents: netRefund.toString(),
    paid_amount_cents: "0",
    description: `Walmart return ${label}`,
    source: "walmart",
  };
}

/**
 * Post the inventory restock JE + insert the inventory_layers row.
 *
 *   DR 1300 Inventory  = qty × unit_cost
 *   CR 5000 COGS       = qty × unit_cost
 */
export async function postRestockJe({
  supabase,
  ret,
  qty,
  unitCostCents,
  accounts,
  sourceKind,
}) {
  if (!(qty > 0)) throw new Error("postRestockJe: qty must be > 0");
  if (unitCostCents <= ZERO) {
    throw new Error("postRestockJe: unitCostCents must be > 0");
  }
  // qty × unit_cost — qty is small numeric (rarely > 100); avoid float
  // truncation by scaling.
  const qtyScaled = BigInt(Math.trunc(qty * 10000));
  const restockCents = (qtyScaled * unitCostCents) / 10000n;
  if (restockCents <= ZERO) {
    throw new Error(
      `postRestockJe: restock amount derived as zero (qty=${qty}, unit_cost=${unitCostCents})`,
    );
  }

  const label = ret.return_order_id || ret.id;
  const desc = `Walmart return restock ${label} (${sourceKind})`;
  const lines = [
    {
      line_number: 1,
      account_id: accounts.inventoryAssetId,
      debit: centsToDecimal(restockCents),
      credit: "0",
      memo: desc,
      subledger_type: "item",
      subledger_id: ret.ip_item_master_id,
    },
    {
      line_number: 2,
      account_id: accounts.cogsId,
      debit: "0",
      credit: centsToDecimal(restockCents),
      memo: desc,
      subledger_type: "item",
      subledger_id: ret.ip_item_master_id,
    },
  ];

  const payload = {
    entity_id: ret.entity_id,
    basis: "ACCRUAL",
    journal_type: "inventory_return_restock",
    posting_date: toDateString(ret.created_at || new Date()),
    source_module: "walmart",
    source_table: "walmart_returns",
    source_id: ret.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };

  const { data: jeId, error: rpcErr } = await supabase.rpc(
    "gl_post_journal_entry",
    { payload },
  );
  if (rpcErr) {
    throw new Error(`gl_post_journal_entry (restock) failed: ${rpcErr.message}`);
  }
  if (typeof jeId !== "string") {
    throw new Error(
      `gl_post_journal_entry (restock) returned unexpected payload: ${JSON.stringify(jeId)}`,
    );
  }

  // Insert the inventory_layers row directly (createLayer rejects
  // wfs_return_restock / fba_return_restock — those source kinds live
  // in the P12-0 extended CHECK constraint only).
  const layerRow = {
    entity_id: ret.entity_id,
    item_id: ret.ip_item_master_id,
    received_at: new Date().toISOString(),
    original_qty: qty,
    remaining_qty: qty,
    unit_cost_cents: unitCostCents.toString(),
    source_kind: sourceKind,
    source_invoice_id: null,
    source_adjustment_id: null,
    notes: `Walmart return ${label}`,
  };
  const { error: layerErr } = await supabase
    .from("inventory_layers")
    .insert(layerRow);
  if (layerErr) {
    throw new Error(`inventory_layers insert failed: ${layerErr.message}`);
  }

  return { je_id: jeId };
}

/**
 * Resolve the unit_cost_cents off the latest open layer for an item
 * (received_at DESC). Returns null when no layer exists.
 */
export async function resolveLatestLayerUnitCost(supabase, entityId, itemId) {
  const { data, error } = await supabase
    .from("inventory_layers")
    .select("unit_cost_cents")
    .eq("entity_id", entityId)
    .eq("item_id", itemId)
    .gt("remaining_qty", 0)
    .order("received_at", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`inventory_layers latest-cost lookup failed: ${error.message}`);
  }
  if (!Array.isArray(data) || data.length === 0) {
    // Fall back to any layer (open or not) — return cost basis still has
    // signal even when the most recent layer is fully drawn.
    const { data: any, error: anyErr } = await supabase
      .from("inventory_layers")
      .select("unit_cost_cents")
      .eq("entity_id", entityId)
      .eq("item_id", itemId)
      .order("received_at", { ascending: false })
      .limit(1);
    if (anyErr) {
      throw new Error(`inventory_layers fallback-cost lookup failed: ${anyErr.message}`);
    }
    if (!Array.isArray(any) || any.length === 0) return null;
    return toBigInt(any[0].unit_cost_cents);
  }
  return toBigInt(data[0].unit_cost_cents);
}

/**
 * Choose the inventory_layers.source_kind based on where the return
 * physically lands. WFS-fulfilled returns go back to Walmart's
 * fulfillment center (source_kind='wfs_return_restock'); seller-fulfilled
 * returns come back to the operator's warehouse
 * (source_kind='credit_memo_return' — the existing customer-return value).
 */
export function pickRestockSourceKind({ returnStatus, rawPayload }) {
  const status = String(returnStatus || "").toUpperCase();
  if (status.startsWith("WFS")) return "wfs_return_restock";
  const shipNode = String(
    rawPayload?.shipNode?.type ||
      rawPayload?.shipNodeType ||
      rawPayload?.ship_node_type ||
      "",
  ).toUpperCase();
  if (shipNode === "WFSFULFILLED" || shipNode.includes("WFS")) {
    return "wfs_return_restock";
  }
  return "credit_memo_return";
}

// ────────────────────────────────────────────────────────────────────────
// GL account resolution
// ────────────────────────────────────────────────────────────────────────

export async function resolveGlAccounts(supabase, entityId) {
  const codes = ["1200", "1201", "4000", "4500", "1300", "5000"];
  const { data, error } = await supabase
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
    arId: byCode["1200"] || byCode["1201"] || null,
    revenueId: byCode["4000"] || null,
    // 4500 doubles as Restocking Fee Income on the Tangerine chart (D8).
    // Same GL code as shipping revenue — the chart of accounts treats them
    // as a single "Other Revenue" bucket per the P12b architecture spec.
    restockingFeeIncomeId: byCode["4500"] || null,
    inventoryAssetId: byCode["1300"] || null,
    cogsId: byCode["5000"] || null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Payload extraction helpers — Walmart shape is messy
// ────────────────────────────────────────────────────────────────────────

function pickSku(ret) {
  return (
    ret?.returnOrderLines?.returnOrderLine?.[0]?.item?.sku ??
    ret?.returnOrderLines?.[0]?.item?.sku ??
    ret?.item?.sku ??
    ret?.sku ??
    ret?.item_sku ??
    null
  );
}

function extractQuantity(ret) {
  return (
    ret?.returnOrderLines?.returnOrderLine?.[0]?.returnQuantity?.amount ??
    ret?.returnOrderLines?.[0]?.returnQuantity?.amount ??
    ret?.returnQuantity?.amount ??
    ret?.returnQuantity ??
    ret?.quantity ??
    null
  );
}

function pickReason(ret) {
  return (
    ret?.returnOrderLines?.returnOrderLine?.[0]?.returnReason ??
    ret?.returnOrderLines?.[0]?.returnReason ??
    ret?.returnReason ??
    ret?.reason ??
    null
  );
}

function pickStatus(ret) {
  return (
    ret?.returnLifecycleStatus ??
    ret?.returnOrderLines?.returnOrderLine?.[0]?.returnOrderLineStatus ??
    ret?.return_status ??
    ret?.status ??
    null
  );
}

/**
 * Extract refund amount in cents. Walmart nests refund charges under
 * returnOrderLines[].refund.refundCharges[].refundAmount.amount.
 */
export function extractRefundCents(ret) {
  let total = 0n;
  const lines = collectReturnLines(ret);
  for (const ln of lines) {
    const refund = ln?.refund;
    if (!refund) continue;
    const charges = refund.refundCharges || refund.refundChargeList || [];
    const chargeList = Array.isArray(charges) ? charges : [charges];
    for (const ch of chargeList) {
      const amount = ch?.refundAmount?.amount ?? ch?.amount ?? null;
      const cents = decimalAmountToCents(amount);
      if (cents != null) total += cents;
    }
  }
  // Fallbacks for flatter payload shapes.
  if (total === 0n) {
    const flat =
      ret?.refundAmount?.amount ??
      ret?.refund_amount ??
      ret?.refund_amount_cents ??
      null;
    if (typeof flat === "number" || typeof flat === "string") {
      const cents = decimalAmountToCents(flat);
      if (cents != null) total = cents;
    }
  }
  return total;
}

/**
 * Extract restocking fee. Walmart surfaces it as a charge with
 * chargeType='RESTOCKING_FEE' (or chargeCategory='RESTOCK').
 */
export function extractRestockingFeeCents(ret) {
  let total = 0n;
  const lines = collectReturnLines(ret);
  for (const ln of lines) {
    const refund = ln?.refund;
    if (!refund) continue;
    const charges = refund.refundCharges || refund.refundChargeList || [];
    const chargeList = Array.isArray(charges) ? charges : [charges];
    for (const ch of chargeList) {
      const cat = String(
        ch?.chargeType ||
          ch?.chargeCategory ||
          ch?.charge_type ||
          "",
      ).toUpperCase();
      if (cat.includes("RESTOCK")) {
        const amount = ch?.refundAmount?.amount ?? ch?.amount ?? null;
        const cents = decimalAmountToCents(amount);
        if (cents != null) total += abs(cents);
      }
    }
  }
  if (total === 0n) {
    const flat =
      ret?.restockingFee?.amount ??
      ret?.restocking_fee ??
      ret?.restocking_fee_cents ??
      null;
    if (typeof flat === "number" || typeof flat === "string") {
      const cents = decimalAmountToCents(flat);
      if (cents != null) total = abs(cents);
    }
  }
  return total;
}

function collectReturnLines(ret) {
  const a =
    ret?.returnOrderLines?.returnOrderLine ||
    ret?.returnOrderLines ||
    ret?.return_order_lines ||
    null;
  if (!a) return [];
  return Array.isArray(a) ? a : [a];
}

// ────────────────────────────────────────────────────────────────────────
// Number helpers
// ────────────────────────────────────────────────────────────────────────

function pickInt(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function decimalAmountToCents(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.round(n * 100));
}

function abs(b) {
  return b < ZERO ? -b : b;
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
  const a = neg ? -c : c;
  const whole = a / 100n;
  const frac = a % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

function decimalToBigIntCents(s) {
  if (typeof s !== "string") {
    throw new Error(`decimal string required, got ${typeof s}`);
  }
  const m = s.match(/^(-?)(\d+)\.(\d{2})$/);
  if (!m) {
    if (s === "0" || s === "") return ZERO;
    throw new Error(`malformed decimal: ${s}`);
  }
  const sign = m[1] === "-" ? -1n : 1n;
  return sign * (BigInt(m[2]) * 100n + BigInt(m[3]));
}

function toDateString(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  if (typeof ts === "string") return ts.slice(0, 10);
  if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────
// Cron handler (default export) — exported separately so the cron file
// and the manual handler can both bring in the orchestrator.
// ────────────────────────────────────────────────────────────────────────

/**
 * Default Vercel handler — used by /api/cron/walmart-returns-daily.
 */
export async function defaultCronHandler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
  try {
    const out = await runWalmartReturnsSync(admin);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e instanceof Error ? e.message : String(e) });
  }
}
