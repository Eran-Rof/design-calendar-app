// api/_lib/marketplaces/fba/sync-returns.js
//
// Tangerine P12a-6 — Amazon FBA returns sync service.
//
// Per fba_seller_accounts row:
//   1. Decrypt LWA creds, refresh access token
//   2. Call client.listReturnRequests(createdAfter = max(last_returns_sync_at,
//      now - 30 days)), paginate
//   3. For each return:
//      a. Upsert fba_returns by return_request_id
//      b. If return_status='Resellable':
//           - DR 1300 Inventory / CR 5000 COGS reversal
//           - inventory_layer insert with source_kind='fba_return_restock'
//         Else if return_status IN ('Defective','Disposed'):
//           - DR 6525 FBA Removal/Disposal Fees / CR 1300 Inventory write-off
//      c. If refund_amount_cents > 0 and parent fba_order has ar_invoice_id:
//           - Create ar_invoices row (invoice_kind='customer_credit_memo',
//             total = -refund_amount_cents → but ar_invoices.amounts_nonneg
//             check forbids negatives, so we record the absolute amount and
//             flag via reverses_invoice_id pointing at the original AR
//             invoice).
//           - Stamp fba_returns.ar_credit_memo_id.
//      d. Stamp fba_returns.je_id (the restock or writeoff JE, whichever
//         was posted).
//   4. UPDATE fba_seller_accounts.last_returns_sync_at = now
//
// Idempotency: fba_returns.je_id / ar_credit_memo_id pointers short-circuit.
// Per-return try/catch so one bad return never breaks the loop. Per-account
// try/catch in syncAllAccountsReturns so one bad account never breaks the
// rest.
//
// **Source tagging** (feedback_source_tagging_enforcement): every ar_invoices
// row written here carries source='fba'.
//
// **D8 — credit memo writes a NEGATIVE-flowing JE for the customer-facing AR
// reversal.** We DR 4000 Revenue / CR 1200 AR for the refund so the AR
// receivable shrinks and the original revenue is reversed. Per-D8 marketplace
// facilitator tax is NOT touched (Amazon handles tax on the refund side too).

import { decryptToken } from "./token-encryption.js";
import { refreshLwaAccessToken } from "./lwa.js";
import { SpApiClient } from "./client.js";

const MAX_LOOKBACK_DAYS = 30;
const MAX_PAGES_PER_ACCOUNT = 50; // 50 * 50 = 2500 returns per run cap
const ZERO = 0n;

// Map of which return_status values trigger restock vs writeoff.
// Per task spec:
//   Resellable           → restock (DR 1300 Inventory / CR 5000 COGS)
//   Defective | Disposed → writeoff (DR 6525 Removal/Disposal / CR 1300 Inventory)
// Other statuses (e.g. CarrierDamaged, Damaged, CustomerDamaged) are stored
// but not posted — operator can re-trigger after a manual disposition.
const RESTOCK_STATUSES  = new Set(["Resellable"]);
const WRITEOFF_STATUSES = new Set(["Defective", "Disposed"]);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * BigInt-safe cents coercion (mirrors post-order-je.toBigInt).
 */
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

/**
 * Compute the createdAfter window for a single account.
 * If last_returns_sync_at is older than 30 days (or null), clamp to 30d.
 */
export function computeSinceTime(lastSyncAt, now = new Date()) {
  const minTime = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (!lastSyncAt) return minTime.toISOString();
  const last = new Date(lastSyncAt);
  if (!Number.isFinite(last.getTime())) return minTime.toISOString();
  if (last < minTime) return minTime.toISOString();
  return last.toISOString();
}

/**
 * Decrypt the LWA credentials triple from a fba_seller_accounts row.
 * Mirrors ingest-orders.decryptAccountCreds.
 */
export function decryptAccountCreds(acct) {
  if (!acct.lwa_client_id_ciphertext || !acct.lwa_client_id_iv || !acct.lwa_client_id_tag) {
    throw new Error("account missing encrypted lwa_client_id triple");
  }
  if (!acct.lwa_client_secret_ciphertext || !acct.lwa_client_secret_iv || !acct.lwa_client_secret_tag) {
    throw new Error("account missing encrypted lwa_client_secret triple");
  }
  if (!acct.refresh_token_ciphertext || !acct.refresh_token_iv || !acct.refresh_token_tag) {
    throw new Error("account missing encrypted refresh_token triple");
  }
  const clientId = decryptToken(
    acct.lwa_client_id_ciphertext, acct.lwa_client_id_iv, acct.lwa_client_id_tag,
  );
  const clientSecret = decryptToken(
    acct.lwa_client_secret_ciphertext, acct.lwa_client_secret_iv, acct.lwa_client_secret_tag,
  );
  const refreshToken = decryptToken(
    acct.refresh_token_ciphertext, acct.refresh_token_iv, acct.refresh_token_tag,
  );
  return { clientId, clientSecret, refreshToken };
}

/**
 * Map an SP-API ReturnRequest payload to the fba_returns row shape.
 *
 * @param {Object} ret               raw SP-API return request
 * @param {string|null} fbaOrderId   resolved fba_orders.id (or null)
 * @returns {Object}                 fba_returns upsert payload
 */
export function mapReturnRow(ret, fbaOrderId) {
  const refund = ret.RefundAmount || ret.refundAmount || {};
  const refundCents = refund.Amount
    ? Math.round(Number(refund.Amount) * 100)
    : 0;
  return {
    fba_order_id: fbaOrderId,
    amazon_order_id: ret.AmazonOrderId || ret.amazonOrderId || null,
    return_request_id: ret.ReturnRequestId || ret.returnRequestId,
    asin: ret.ASIN || ret.asin || null,
    sku: ret.SellerSKU || ret.sellerSku || ret.SKU || null,
    quantity: Number(ret.Quantity || ret.quantity || 1) || 1,
    reason: ret.Reason || ret.reason || null,
    return_status: ret.ReturnStatus || ret.returnStatus || null,
    refund_amount_cents: refundCents,
    raw_payload: ret,
  };
}

// ──────────────────────────────────────────────────────────────────────
// GL accounts resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve GL account ids for the returns flow. We need:
 *   1300 Inventory          (restock DR, writeoff CR)
 *   5000 COGS               (restock CR)
 *   6525 FBA Removal Fees   (writeoff DR)
 *   1200 AR                 (credit memo CR — refund reduces AR)
 *   4000 Revenue            (credit memo DR — revenue reversal)
 *
 * Allows 1201 fallback on AR + 1301 fallback on inventory + 5001 on COGS
 * for entities that use the alternate codes.
 */
export async function resolveGlAccounts(adminClient, entityId) {
  const codes = ["1300", "1301", "5000", "5001", "6525", "1200", "1201", "4000"];
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
    inventoryId: byCode["1300"] || byCode["1301"] || null,
    cogsId:      byCode["5000"] || byCode["5001"] || null,
    removalId:   byCode["6525"] || null,
    arId:        byCode["1200"] || byCode["1201"] || null,
    revenueId:   byCode["4000"] || null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// JE builders
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the restock JE: DR 1300 Inventory / CR 5000 COGS.
 * Amount = unit_cost_cents * quantity (derived from inventory_layers row).
 *
 * @param {Object} args
 * @param {Object} args.ret            fba_returns row
 * @param {Object} args.parentOrder    fba_orders row (for entity_id + amazon_order_id)
 * @param {BigInt} args.amountCents    DR+CR amount in cents
 * @param {Object} args.accounts       { inventoryId, cogsId }
 * @returns {Object}                   payload for gl_post_journal_entry RPC
 */
export function buildRestockJePayload({ ret, parentOrder, amountCents, accounts }) {
  if (amountCents <= ZERO) {
    throw new Error(
      `FBA return ${ret.return_request_id}: restock amount must be positive (got ${amountCents})`,
    );
  }
  if (!accounts.inventoryId) {
    throw new Error(`FBA return ${ret.return_request_id}: missing 1300 Inventory GL account`);
  }
  if (!accounts.cogsId) {
    throw new Error(`FBA return ${ret.return_request_id}: missing 5000 COGS GL account`);
  }
  const desc = `Amazon FBA return restock — ${parentOrder?.amazon_order_id || ret.amazon_order_id || ret.return_request_id}`;
  return {
    entity_id: parentOrder.entity_id,
    basis: "ACCRUAL",
    journal_type: "adjustment",
    posting_date: toDateString(new Date()),
    source_module: "fba",
    source_table: "fba_returns",
    source_id: ret.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines: [
      {
        line_number: 1,
        account_id: accounts.inventoryId,
        debit: centsToDecimal(amountCents),
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: accounts.cogsId,
        debit: "0",
        credit: centsToDecimal(amountCents),
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
    ],
  };
}

/**
 * Build the writeoff JE: DR 6525 Removal/Disposal Fees / CR 1300 Inventory.
 */
export function buildWriteoffJePayload({ ret, parentOrder, amountCents, accounts }) {
  if (amountCents <= ZERO) {
    throw new Error(
      `FBA return ${ret.return_request_id}: writeoff amount must be positive (got ${amountCents})`,
    );
  }
  if (!accounts.removalId) {
    throw new Error(`FBA return ${ret.return_request_id}: missing 6525 Removal/Disposal Fees GL account`);
  }
  if (!accounts.inventoryId) {
    throw new Error(`FBA return ${ret.return_request_id}: missing 1300 Inventory GL account`);
  }
  const desc = `Amazon FBA return writeoff (${ret.return_status}) — ${parentOrder?.amazon_order_id || ret.amazon_order_id || ret.return_request_id}`;
  return {
    entity_id: parentOrder.entity_id,
    basis: "ACCRUAL",
    journal_type: "adjustment",
    posting_date: toDateString(new Date()),
    source_module: "fba",
    source_table: "fba_returns",
    source_id: ret.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines: [
      {
        line_number: 1,
        account_id: accounts.removalId,
        debit: centsToDecimal(amountCents),
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: accounts.inventoryId,
        debit: "0",
        credit: centsToDecimal(amountCents),
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
    ],
  };
}

/**
 * Build the credit-memo (refund) JE: DR 4000 Revenue / CR 1200 AR.
 * Reverses the receivable + revenue for the refund_amount_cents.
 */
export function buildCreditMemoJePayload({ ret, parentOrder, refundCents, accounts, customerId }) {
  if (refundCents <= ZERO) {
    throw new Error(
      `FBA return ${ret.return_request_id}: refund amount must be positive (got ${refundCents})`,
    );
  }
  if (!accounts.revenueId) {
    throw new Error(`FBA return ${ret.return_request_id}: missing 4000 Revenue GL account`);
  }
  if (!accounts.arId) {
    throw new Error(`FBA return ${ret.return_request_id}: missing 1200 AR GL account`);
  }
  const desc = `Amazon FBA refund — ${parentOrder?.amazon_order_id || ret.amazon_order_id || ret.return_request_id}`;
  return {
    entity_id: parentOrder.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_credit_memo",
    posting_date: toDateString(new Date()),
    source_module: "fba",
    source_table: "fba_returns",
    source_id: ret.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines: [
      {
        line_number: 1,
        account_id: accounts.revenueId,
        debit: centsToDecimal(refundCents),
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: accounts.arId,
        debit: "0",
        credit: centsToDecimal(refundCents),
        memo: desc,
        subledger_type: customerId ? "customer" : null,
        subledger_id: customerId || null,
      },
    ],
  };
}

/**
 * Build the ar_invoices credit-memo row.
 *
 * Note: ar_invoices.amounts_nonneg forbids negative totals, so we store the
 * absolute refund_amount in total_amount_cents and flag the memo via
 * invoice_kind='customer_credit_memo' + reverses_invoice_id pointing at the
 * original AR invoice. Downstream AR queries that net (invoice - memo) read
 * the kind/reverses pair, not a signed total.
 */
export function buildCreditMemoArRow({ ret, parentOrder, refundCents, accounts, customerId, jeId }) {
  return {
    entity_id: parentOrder.entity_id,
    customer_id: customerId,
    invoice_number: `FBA-CM-${ret.return_request_id}`.slice(0, 128),
    invoice_kind: "customer_credit_memo",
    gl_status: "sent",
    invoice_date: toDateString(new Date()),
    posting_date: toDateString(new Date()),
    ar_account_id: accounts.arId,
    revenue_account_id: accounts.revenueId,
    accrual_je_id: jeId,
    total_amount_cents: refundCents.toString(),
    paid_amount_cents: "0",
    reverses_invoice_id: parentOrder.ar_invoice_id || null,
    description: `Amazon FBA refund — return ${ret.return_request_id}`,
    source: "fba",
  };
}

// ──────────────────────────────────────────────────────────────────────
// Per-return posting orchestration
// ──────────────────────────────────────────────────────────────────────

/**
 * Look up the parent fba_orders row (if any) for the return.
 * Tries amazon_order_id within the same account first; falls back to null.
 */
export async function resolveParentOrder(adminClient, retRow, fbaSellerAccountId) {
  if (!retRow.amazon_order_id) return null;
  const { data, error } = await adminClient
    .from("fba_orders")
    .select("id, entity_id, amazon_order_id, customer_id, ar_invoice_id")
    .eq("fba_seller_account_id", fbaSellerAccountId)
    .eq("amazon_order_id", retRow.amazon_order_id)
    .maybeSingle();
  if (error && error.code !== "PGRST116") {
    throw new Error(`fba_orders lookup failed: ${error.message}`);
  }
  return data || null;
}

/**
 * Estimate the inventory unit cost in cents for restock/writeoff JE math.
 *
 * Reads the most recent inventory_layers row for the item+entity (any
 * source_kind); if none is present, falls back to ip_item_master.cost_cents.
 *
 * @returns {BigInt}  unit_cost_cents (0n if neither source available)
 */
export async function resolveUnitCostCents(adminClient, { entityId, itemId }) {
  if (!itemId) return ZERO;
  const { data: layer } = await adminClient
    .from("inventory_layers")
    .select("unit_cost_cents")
    .eq("entity_id", entityId)
    .eq("item_id", itemId)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (layer?.unit_cost_cents != null) return toBigInt(layer.unit_cost_cents);

  const { data: item } = await adminClient
    .from("ip_item_master")
    .select("cost_cents")
    .eq("id", itemId)
    .maybeSingle();
  if (item?.cost_cents != null) return toBigInt(item.cost_cents);

  return ZERO;
}

/**
 * Resolve ip_item_master_id for the return by ASIN / seller SKU.
 * Falls back to null when no match.
 */
export async function resolveItemMasterId(adminClient, { entityId, asin, sku }) {
  if (!asin && !sku) return null;
  // Try ASIN first (most specific).
  if (asin) {
    const { data } = await adminClient
      .from("ip_item_master")
      .select("id")
      .eq("entity_id", entityId)
      .eq("asin", asin)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  if (sku) {
    const { data } = await adminClient
      .from("ip_item_master")
      .select("id")
      .eq("entity_id", entityId)
      .eq("style_code", sku)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  return null;
}

/**
 * Process a single return: upsert + post JE(s) + credit memo.
 *
 * Per-step idempotency via the je_id / ar_credit_memo_id pointers on
 * fba_returns. Re-runs short-circuit cleanly.
 *
 * @returns {Object} { return_request_id, action, je_id, ar_credit_memo_id, error }
 *   action ∈ 'restock' | 'writeoff' | 'none' (status without posting rule)
 */
export async function processReturn(adminClient, { rawReturn, fbaSellerAccountId, accounts }) {
  const rowFromApi = mapReturnRow(rawReturn, null);
  if (!rowFromApi.return_request_id) {
    return { return_request_id: null, action: "skip", error: "missing return_request_id" };
  }

  // Resolve parent order (needed for entity_id + ar_invoice_id).
  const parentOrder = await resolveParentOrder(adminClient, rowFromApi, fbaSellerAccountId);
  if (!parentOrder) {
    // No parent order → can't infer entity_id reliably; still upsert with the
    // fba_returns.entity_id DEFAULT (rof_entity_id()), but skip the JE work.
    rowFromApi.fba_order_id = null;
    const { data: upserted, error: upErr } = await adminClient
      .from("fba_returns")
      .upsert(rowFromApi, { onConflict: "return_request_id" })
      .select("id, je_id, ar_credit_memo_id, return_status, refund_amount_cents")
      .maybeSingle();
    if (upErr) throw new Error(`fba_returns upsert failed for ${rowFromApi.return_request_id}: ${upErr.message}`);
    return {
      return_request_id: rowFromApi.return_request_id,
      action: "no_parent_order",
      fba_return_id: upserted?.id || null,
    };
  }

  // Resolve ip_item_master for the SKU/ASIN (best-effort).
  const ipItemMasterId = await resolveItemMasterId(adminClient, {
    entityId: parentOrder.entity_id,
    asin: rowFromApi.asin,
    sku: rowFromApi.sku,
  });

  rowFromApi.fba_order_id = parentOrder.id;
  if (ipItemMasterId) rowFromApi.ip_item_master_id = ipItemMasterId;

  // 1. Upsert fba_returns.
  const { data: upserted, error: upErr } = await adminClient
    .from("fba_returns")
    .upsert(rowFromApi, { onConflict: "return_request_id" })
    .select("id, je_id, ar_credit_memo_id, return_status, refund_amount_cents, entity_id, ip_item_master_id, fba_order_id")
    .maybeSingle();
  if (upErr) throw new Error(`fba_returns upsert failed for ${rowFromApi.return_request_id}: ${upErr.message}`);

  const retRow = upserted;
  const result = {
    return_request_id: rowFromApi.return_request_id,
    fba_return_id: retRow.id,
    action: "none",
    je_id: retRow.je_id || null,
    ar_credit_memo_id: retRow.ar_credit_memo_id || null,
  };

  const status = String(retRow.return_status || "");
  const refundCents = toBigInt(retRow.refund_amount_cents || 0);

  // 2. Post the restock or writeoff JE (idempotent — skip if je_id set).
  if (!retRow.je_id) {
    if (RESTOCK_STATUSES.has(status)) {
      const unitCost = await resolveUnitCostCents(adminClient, {
        entityId: parentOrder.entity_id,
        itemId: ipItemMasterId,
      });
      const qty = BigInt(Number(retRow.quantity || rowFromApi.quantity || 1));
      const amount = unitCost * qty;
      if (amount > ZERO) {
        const payload = buildRestockJePayload({
          ret: { ...retRow, return_request_id: rowFromApi.return_request_id },
          parentOrder,
          amountCents: amount,
          accounts,
        });
        const { data: jeId, error: rpcErr } = await adminClient.rpc(
          "gl_post_journal_entry", { payload },
        );
        if (rpcErr) {
          throw new Error(`restock JE post failed for ${rowFromApi.return_request_id}: ${rpcErr.message}`);
        }
        // Add an inventory_layer for the restock (FIFO replay).
        if (ipItemMasterId) {
          const layerRow = {
            entity_id: parentOrder.entity_id,
            item_id: ipItemMasterId,
            received_at: new Date().toISOString(),
            original_qty: Number(retRow.quantity || rowFromApi.quantity || 1),
            remaining_qty: Number(retRow.quantity || rowFromApi.quantity || 1),
            unit_cost_cents: unitCost.toString(),
            source_kind: "fba_return_restock",
            notes: `FBA return ${rowFromApi.return_request_id}`,
          };
          const { error: layerErr } = await adminClient
            .from("inventory_layers")
            .insert(layerRow);
          if (layerErr) {
            // Best-effort — log + continue. JE is the source of truth.
            // eslint-disable-next-line no-console
            console.warn(
              `[fba-returns] inventory_layers insert failed for ${rowFromApi.return_request_id}: ${layerErr.message}`,
            );
          }
        }
        result.je_id = jeId;
        result.action = "restock";
      } else {
        result.action = "restock_zero_cost";
      }
    } else if (WRITEOFF_STATUSES.has(status)) {
      const unitCost = await resolveUnitCostCents(adminClient, {
        entityId: parentOrder.entity_id,
        itemId: ipItemMasterId,
      });
      const qty = BigInt(Number(retRow.quantity || rowFromApi.quantity || 1));
      const amount = unitCost * qty;
      if (amount > ZERO) {
        const payload = buildWriteoffJePayload({
          ret: { ...retRow, return_request_id: rowFromApi.return_request_id, return_status: status },
          parentOrder,
          amountCents: amount,
          accounts,
        });
        const { data: jeId, error: rpcErr } = await adminClient.rpc(
          "gl_post_journal_entry", { payload },
        );
        if (rpcErr) {
          throw new Error(`writeoff JE post failed for ${rowFromApi.return_request_id}: ${rpcErr.message}`);
        }
        result.je_id = jeId;
        result.action = "writeoff";
      } else {
        result.action = "writeoff_zero_cost";
      }
    }
  } else {
    result.action = "je_already_posted";
  }

  // 3. Refund credit memo (independent of restock/writeoff JE).
  if (!retRow.ar_credit_memo_id && refundCents > ZERO && parentOrder.ar_invoice_id) {
    const cmPayload = buildCreditMemoJePayload({
      ret: { ...retRow, return_request_id: rowFromApi.return_request_id },
      parentOrder,
      refundCents,
      accounts,
      customerId: parentOrder.customer_id || null,
    });
    const { data: cmJeId, error: cmRpcErr } = await adminClient.rpc(
      "gl_post_journal_entry", { payload: cmPayload },
    );
    if (cmRpcErr) {
      throw new Error(`credit-memo JE post failed for ${rowFromApi.return_request_id}: ${cmRpcErr.message}`);
    }
    const arRow = buildCreditMemoArRow({
      ret: { ...retRow, return_request_id: rowFromApi.return_request_id },
      parentOrder,
      refundCents,
      accounts,
      customerId: parentOrder.customer_id,
      jeId: cmJeId,
    });
    const { data: arInv, error: arInsErr } = await adminClient
      .from("ar_invoices")
      .insert(arRow)
      .select("id")
      .single();
    if (arInsErr) {
      throw new Error(`ar_invoices (credit memo) insert failed for ${rowFromApi.return_request_id}: ${arInsErr.message}`);
    }
    result.ar_credit_memo_id = arInv.id;
    result.credit_memo_je_id = cmJeId;
  }

  // 4. Stamp pointers back to fba_returns.
  const patch = {};
  if (result.je_id && !retRow.je_id) patch.je_id = result.je_id;
  if (result.ar_credit_memo_id && !retRow.ar_credit_memo_id) patch.ar_credit_memo_id = result.ar_credit_memo_id;
  if (Object.keys(patch).length > 0) {
    const { error: updErr } = await adminClient
      .from("fba_returns")
      .update(patch)
      .eq("id", retRow.id);
    if (updErr) {
      throw new Error(`fba_returns stamp failed for ${rowFromApi.return_request_id}: ${updErr.message}`);
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Per-account orchestration
// ──────────────────────────────────────────────────────────────────────

/**
 * Sync returns for a single fba_seller_accounts row.
 */
export async function syncAccountReturns(supabase, acct, opts = {}) {
  const now = opts.now || new Date();
  const summary = {
    fba_seller_account_id: acct.id,
    returns_upserted: 0,
    je_posted: 0,
    credit_memos_posted: 0,
    pages: 0,
    since: null,
    errors: [],
  };

  const since = opts.since || computeSinceTime(acct.last_returns_sync_at, now);
  summary.since = since;

  const refreshAccessToken = opts.deps?.refreshAccessToken || refreshLwaAccessToken;
  const makeClient = opts.deps?.makeClient || ((clientArgs) => new SpApiClient(clientArgs));
  const processReturnFn = opts.deps?.processReturn || processReturn;

  // Pre-resolve GL accounts (per-entity).
  const accounts = await resolveGlAccounts(supabase, acct.entity_id);

  const creds = decryptAccountCreds(acct);
  const tokenResp = await refreshAccessToken({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken,
  });

  const client = makeClient({
    region: acct.region,
    accessToken: tokenResp.access_token,
    marketplaceId: acct.marketplace_id,
    awsRoleArn: acct.aws_role_arn || null,
  });

  let nextToken = null;
  let firstPage = true;
  for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
    const listResp = firstPage
      ? await client.listReturnRequests({ createdAfter: since, maxResults: 50 })
      : await client.listReturnRequests({ createdAfter: since, nextToken, maxResults: 50 });
    firstPage = false;
    summary.pages++;
    const returns = listResp.returnRequests || listResp.ReturnRequests || [];
    for (const ret of returns) {
      try {
        const result = await processReturnFn(supabase, {
          rawReturn: ret,
          fbaSellerAccountId: acct.id,
          accounts,
        });
        summary.returns_upserted++;
        if (result.je_id) summary.je_posted++;
        if (result.ar_credit_memo_id) summary.credit_memos_posted++;
      } catch (e) {
        summary.errors.push({
          return_request_id: ret.ReturnRequestId || ret.returnRequestId || null,
          error: e instanceof Error ? e.message : String(e),
        });
        // eslint-disable-next-line no-console
        console.warn(
          `[fba-returns] processReturn failed for ${ret.ReturnRequestId || ret.returnRequestId}: ${e?.message || e}`,
        );
      }
    }
    nextToken = (listResp.pagination && listResp.pagination.nextToken) || listResp.NextToken || null;
    if (!nextToken) break;
  }

  // Stamp last_returns_sync_at.
  const { error: updErr } = await supabase
    .from("fba_seller_accounts")
    .update({ last_returns_sync_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", acct.id);
  if (updErr) throw new Error(`last_returns_sync_at update failed: ${updErr.message}`);

  return summary;
}

/**
 * Drive syncAccountReturns across every active fba_seller_accounts row.
 * Per-account try/catch — one failing account never breaks the others.
 */
export async function syncAllAccountsReturns(supabase, opts = {}) {
  const started_at = new Date().toISOString();
  const { data: accounts, error } = await supabase
    .from("fba_seller_accounts")
    .select("*")
    .eq("is_active", true);
  if (error) throw new Error(`fba_seller_accounts read failed: ${error.message}`);

  const results = [];
  for (const acct of (accounts || [])) {
    try {
      const summary = await syncAccountReturns(supabase, acct, opts);
      results.push({ ok: true, ...summary });
    } catch (e) {
      results.push({
        ok: false,
        fba_seller_account_id: acct.id,
        returns_upserted: 0,
        je_posted: 0,
        credit_memos_posted: 0,
        pages: 0,
        since: null,
        errors: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    started_at,
    finished_at: new Date().toISOString(),
    accounts: results,
  };
}
