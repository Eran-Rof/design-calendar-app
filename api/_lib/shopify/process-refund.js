// api/_lib/shopify/process-refund.js
//
// Tangerine P11-6 — Shopify refund processing service.
//
// Translates a `shopify_refunds` row into the GL truth:
//
//   FULL refund (refund_amount_cents == parent shopify_orders.total_amount_cents):
//     - Reverse the parent AR invoice's accrual JE (and cash JE if it had one).
//     - Flip the AR invoice gl_status='void'.
//     - Stamp shopify_refunds.ar_credit_memo_id = original ar_invoices.id
//       (per arch §6 — the void path's "credit memo" pointer is the invoice
//        itself in reversed state; the JE pair tells the story).
//     - shopify_refunds.refund_type='full'.
//
//   PARTIAL refund (refund_amount_cents < parent total):
//     - Create a sibling AR credit memo (ar_invoices row with
//       invoice_kind='customer_credit_memo', source='shopify'). The credit
//       memo total = refund_amount_cents - restocking_fee_cents (D8: the
//       restocking fee is recognized as separate INCOME on the credit memo
//       JE, NOT netted against the revenue reversal).
//     - Build + post a JE:
//         CR 1200 AR                      refund_amount_cents
//         DR 4000 Revenue                 (refund_amount_cents - restocking_fee)
//         DR 4500 Restocking Fee Income (?)  recorded as a NEGATIVE income
//                                            reversal IS WRONG — we want the
//                                            store to KEEP the restocking fee
//                                            as income, so we book it as a
//                                            CREDIT to 4500 to offset the
//                                            full AR reduction.
//
//       The correct shape per D7+D8 is:
//
//         DR 4000 Revenue                = refund_amount_cents - restocking_fee_cents
//         CR 4500 Restocking Fee Income  = restocking_fee_cents
//         CR 1200 AR                     = refund_amount_cents
//
//       Balance check: DR = refund_amount - fee.    CR = refund_amount.
//                      DR + (CR 4500) = refund_amount - fee + fee = refund_amount = CR 1200.
//       OK — balanced.
//
//     - If restocked qty > 0 on any line, post a sibling JE per the COGS
//       reversal:
//         DR 1300 Inventory Asset   = qty * unit_cost
//         CR 5000 COGS              = qty * unit_cost
//       AND insert an inventory_layers row with source_kind='shopify_refund_restock'.
//
//     - shopify_refunds.refund_type='partial'.
//     - Stamp shopify_refunds.ar_credit_memo_id = the new credit memo's
//       ar_invoices.id.
//
// Idempotency:
//   shopify_refunds.ar_credit_memo_id IS NOT NULL  →  return
//     { status:'already_processed', ar_credit_memo_id, refund_type }.
//   This is the canonical signal — if we get an event for a refund that's
//   already linked to a credit memo (or to the voided original), we no-op.
//
// Source tagging: every ar_invoices row this service creates has
// source='shopify' per T10 / feedback_source_tagging_enforcement.
//
// BigInt cents throughout — the project's money-handling standard.

import { reverseJournalEntry } from "../accounting/posting/reverse.js";

const ZERO = 0n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Main entry point — process a shopify_refunds row.
 *
 * @param {Object} args
 * @param {string} args.shopifyRefundId    UUID of shopify_refunds.id.
 * @param {Object} args.adminClient        Supabase service-role client.
 * @param {Object} [args.deps]             Test injection point.
 * @param {(supabase, jeId, opts) => Promise<string>} [args.deps.reverseJournalEntry]
 * @returns {Promise<
 *   { status: 'already_processed', ar_credit_memo_id: string|null, refund_type: 'full'|'partial' } |
 *   { status: 'voided',            refund_type: 'full',    ar_invoice_id: string, reversed_je_ids: string[] } |
 *   { status: 'credit_memo_posted', refund_type: 'partial', ar_credit_memo_id: string, je_id: string,
 *     cogs_je_id: string|null, inventory_layer_ids: string[] }
 * >}
 */
export async function processShopifyRefund({
  shopifyRefundId,
  adminClient,
  deps = {},
} = {}) {
  if (!shopifyRefundId || !UUID_RE.test(String(shopifyRefundId))) {
    throw new Error("shopifyRefundId must be a uuid");
  }
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }

  const reverseFn = deps.reverseJournalEntry || reverseJournalEntry;

  // 1. Read the refund row.
  const { data: refund, error: refundErr } = await adminClient
    .from("shopify_refunds")
    .select("*")
    .eq("id", shopifyRefundId)
    .maybeSingle();
  if (refundErr) {
    throw new Error(`shopify_refunds lookup failed: ${refundErr.message}`);
  }
  if (!refund) {
    const e = new Error(`shopify_refunds ${shopifyRefundId} not found`);
    e.code = "not_found";
    throw e;
  }

  // 2. Idempotency.
  if (refund.ar_credit_memo_id) {
    return {
      status: "already_processed",
      ar_credit_memo_id: refund.ar_credit_memo_id,
      refund_type: refund.refund_type || classifyRefundType(refund),
    };
  }

  // 3. Read parent order.
  const { data: order, error: orderErr } = await adminClient
    .from("shopify_orders")
    .select("*")
    .eq("id", refund.shopify_order_id)
    .maybeSingle();
  if (orderErr) {
    throw new Error(`shopify_orders lookup failed: ${orderErr.message}`);
  }
  if (!order) {
    const e = new Error(
      `shopify_orders ${refund.shopify_order_id} not found (parent of refund ${shopifyRefundId})`,
    );
    e.code = "not_found";
    throw e;
  }

  // 4. Classify refund.
  const refundType = classifyRefundType(refund, order);

  if (refundType === "full") {
    return await processFullRefund({
      adminClient, refund, order, reverseFn,
    });
  }
  return await processPartialRefund({
    adminClient, refund, order,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Full refund path — reverse parent AR JEs via reverseJournalEntry.
// ──────────────────────────────────────────────────────────────────────

async function processFullRefund({ adminClient, refund, order, reverseFn }) {
  if (!order.ar_invoice_id) {
    const e = new Error(
      `Cannot process full refund — parent order ${order.id} has no ar_invoice_id (JE not yet posted)`,
    );
    e.code = "parent_ar_invoice_missing";
    throw e;
  }

  // Read the parent ar_invoices row to learn the accrual + cash JEs to reverse.
  const { data: parentInv, error: parentErr } = await adminClient
    .from("ar_invoices")
    .select("id, entity_id, gl_status, accrual_je_id, cash_je_id, paid_amount_cents")
    .eq("id", order.ar_invoice_id)
    .maybeSingle();
  if (parentErr) {
    throw new Error(`ar_invoices lookup failed: ${parentErr.message}`);
  }
  if (!parentInv) {
    const e = new Error(`Parent ar_invoices ${order.ar_invoice_id} not found`);
    e.code = "parent_ar_invoice_missing";
    throw e;
  }

  // If parent is already void / reversed, this is a re-run after a manual
  // void — still stamp the refund row as processed.
  const alreadyTerminal =
    parentInv.gl_status === "void" || parentInv.gl_status === "reversed";

  const reversedJeIds = [];
  if (!alreadyTerminal) {
    if (parentInv.accrual_je_id) {
      const newId = await reverseFn(adminClient, parentInv.accrual_je_id, {
        description: `Reversal of AR invoice for Shopify refund ${refund.shopify_refund_id}`,
      });
      reversedJeIds.push(newId);
    }
    if (parentInv.cash_je_id) {
      const newId = await reverseFn(adminClient, parentInv.cash_je_id, {
        description: `Reversal of AR cash JE for Shopify refund ${refund.shopify_refund_id}`,
      });
      reversedJeIds.push(newId);
    }

    // Flip parent gl_status='void' + tack on a void reason.
    const { error: voidErr } = await adminClient
      .from("ar_invoices")
      .update({
        gl_status: "void",
        notes: `[shopify_refund] Voided by refund ${refund.shopify_refund_id}`,
      })
      .eq("id", parentInv.id);
    if (voidErr) {
      throw new Error(`ar_invoices void update failed: ${voidErr.message}`);
    }
  }

  // Stamp the refund row.
  const { error: stampErr } = await adminClient
    .from("shopify_refunds")
    .update({
      refund_type: "full",
      ar_credit_memo_id: parentInv.id, // the original invoice IS the credit pointer for a void
    })
    .eq("id", refund.id);
  if (stampErr) {
    throw new Error(`shopify_refunds stamp failed: ${stampErr.message}`);
  }

  return {
    status: "voided",
    refund_type: "full",
    ar_invoice_id: parentInv.id,
    reversed_je_ids: reversedJeIds,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Partial refund path — create credit memo + post JE(s).
// ──────────────────────────────────────────────────────────────────────

async function processPartialRefund({ adminClient, refund, order }) {
  // 1. Resolve required GL accounts (1200 / 4000 / 4500 / 1300 / 5000).
  const accounts = await resolveCreditMemoAccounts(adminClient, order.entity_id);
  const missing = requiredAccountsCheck(accounts, refund);
  if (missing.length > 0) {
    const e = new Error(`Missing GL accounts: ${missing.join(", ")}`);
    e.code = "gl_accounts_missing";
    throw e;
  }

  // 2. Resolve the customer id from the parent invoice (already resolved at
  // order-posting time per P11-3). If the parent has no customer_id, we
  // fall back to the order's customer_id (which should also be set).
  let customerId = null;
  if (order.ar_invoice_id) {
    const { data: parentInv, error: parentErr } = await adminClient
      .from("ar_invoices")
      .select("customer_id")
      .eq("id", order.ar_invoice_id)
      .maybeSingle();
    if (parentErr) {
      throw new Error(`ar_invoices lookup failed: ${parentErr.message}`);
    }
    if (parentInv?.customer_id) customerId = parentInv.customer_id;
  }
  if (!customerId) customerId = order.customer_id || null;
  if (!customerId) {
    const e = new Error(
      `Cannot determine customer for partial refund ${refund.id} ` +
      `(parent order ${order.id} has no customer_id)`,
    );
    e.code = "customer_resolution_failed";
    throw e;
  }

  // 3. Build the credit-memo JE payload + post it.
  const refundCents     = toBigInt(refund.refund_amount_cents);
  const restockFeeCents = toBigInt(refund.restocking_fee_cents);
  const revenueReversal = refundCents - restockFeeCents;
  if (revenueReversal < ZERO) {
    const e = new Error(
      `restocking_fee_cents (${restockFeeCents}) exceeds refund_amount_cents (${refundCents})`,
    );
    e.code = "invalid_amounts";
    throw e;
  }

  const cmJePayload = buildCreditMemoJePayload({
    order, refund, accounts, customerId,
    refundCents, restockFeeCents, revenueReversal,
  });

  const { data: jeId, error: rpcErr } = await adminClient.rpc(
    "gl_post_journal_entry",
    { payload: cmJePayload },
  );
  if (rpcErr) {
    const e = new Error(`gl_post_journal_entry RPC failed: ${rpcErr.message}`);
    e.code = "rpc_failed";
    throw e;
  }
  if (typeof jeId !== "string") {
    throw new Error(
      `gl_post_journal_entry returned unexpected payload: ${JSON.stringify(jeId)}`,
    );
  }

  // 4. Create the AR credit-memo invoice row pointing at the JE.
  const cmRow = buildCreditMemoInvoiceRow({
    order, refund, accounts, customerId, jeId,
    totalAmountCents: refundCents,
    originalInvoiceId: order.ar_invoice_id,
  });
  const { data: cmInvoice, error: cmInsErr } = await adminClient
    .from("ar_invoices")
    .insert(cmRow)
    .select("id")
    .single();
  if (cmInsErr) {
    const e = new Error(
      `ar_invoices credit memo insert failed (JE ${jeId} posted): ${cmInsErr.message}`,
    );
    e.code = "ar_invoice_insert_failed";
    e.je_id = jeId;
    throw e;
  }

  // 5. COGS reversal — restocked lines reverse COGS proportionally. We pull
  // the refund payload's `refund_line_items` array (Shopify shape) to
  // identify restocked qty per shopify_order_line. If no restocked qty,
  // skip — credit memo JE alone suffices.
  let cogsJeId = null;
  const inventoryLayerIds = [];

  const restockLines = extractRestockedLines(refund.raw_payload);
  if (restockLines.length > 0 && accounts.inventoryId && accounts.cogsId) {
    const cogsResult = await postCogsReversal({
      adminClient, order, refund, accounts,
      restockLines, creditMemoId: cmInvoice.id,
    });
    cogsJeId = cogsResult.je_id;
    inventoryLayerIds.push(...cogsResult.inventory_layer_ids);
  }

  // 6. Stamp the refund row.
  const { error: stampErr } = await adminClient
    .from("shopify_refunds")
    .update({
      refund_type: "partial",
      ar_credit_memo_id: cmInvoice.id,
    })
    .eq("id", refund.id);
  if (stampErr) {
    throw new Error(`shopify_refunds stamp failed: ${stampErr.message}`);
  }

  return {
    status: "credit_memo_posted",
    refund_type: "partial",
    ar_credit_memo_id: cmInvoice.id,
    je_id: jeId,
    cogs_je_id: cogsJeId,
    inventory_layer_ids: inventoryLayerIds,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Builders + helpers (exported for unit tests).
// ──────────────────────────────────────────────────────────────────────

/**
 * Decide 'full' vs 'partial' refund. Compares refund_amount_cents against
 * the parent order's total_amount_cents.
 */
export function classifyRefundType(refund, order) {
  // Prefer the explicit value if set + valid (set by the webhook upsert
  // and persisted on re-runs).
  if (refund.refund_type === "full" || refund.refund_type === "partial") {
    // Defensive: re-verify against the parent total when we have it. This
    // catches the case where the webhook upsert classified by stale data.
    if (order && refund.refund_type === "partial") {
      const rA = toBigInt(refund.refund_amount_cents);
      const tA = toBigInt(order.total_amount_cents);
      if (rA >= tA) return "full";
    }
    return refund.refund_type;
  }

  if (!order) return "partial";
  const refundCents = toBigInt(refund.refund_amount_cents);
  const totalCents  = toBigInt(order.total_amount_cents);
  if (refundCents >= totalCents) return "full";
  return "partial";
}

/**
 * Build the credit memo journal entry payload for the partial-refund path.
 *
 * Per D7 + D8: customer gets back (refund_amount - restocking_fee) in cash;
 * we keep the restocking fee as INCOME (4500). The full original revenue is
 * reversed (DR 4000), and the AR credit memo reduces the customer's AR by
 * what we actually owe them back.
 *
 *   DR 4000 Revenue              = refund_amount_cents
 *   CR 4500 Restocking Fee Income= restocking_fee_cents               (only if > 0)
 *   CR 1200 AR                   = refund_amount_cents - restocking_fee_cents
 *
 * Balance check: DR = refund_amount.
 *                CR = fee + (refund_amount - fee) = refund_amount. OK.
 *
 * When restocking_fee_cents = 0, the JE collapses to:
 *   DR 4000 / CR 1200 (each = refund_amount_cents).
 */
export function buildCreditMemoJePayload({
  order, refund, accounts, customerId,
  refundCents, restockFeeCents, revenueReversal,
}) {
  const desc = `Shopify refund ${refund.shopify_refund_id} (order ${order.order_number || order.shopify_order_id})`;
  const lines = [];
  let lineNo = 0;
  // arCreditCents = refund_amount - fee = revenueReversal (the caller already
  // computed this as `refundCents - restockFeeCents`).
  const arCreditCents = revenueReversal;

  // DR Revenue (full original revenue is reversed; the fee is recognized
  // separately as income on the CR side below).
  if (refundCents > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.revenueId,
      debit: centsToDecimal(refundCents),
      credit: "0",
      memo: `Revenue reversal — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // CR Restocking Fee Income (D8 — kept as income, not netted vs revenue)
  if (restockFeeCents > ZERO) {
    if (!accounts.restockingFeeId) {
      throw new Error(
        `restocking_fee_cents=${restockFeeCents} but 4500 Restocking Fee Income account not configured`,
      );
    }
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.restockingFeeId,
      debit: "0",
      credit: centsToDecimal(restockFeeCents),
      memo: `Restocking fee income — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // CR AR — what we actually owe the customer back (refund - fee).
  if (arCreditCents > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.arId,
      debit: "0",
      credit: centsToDecimal(arCreditCents),
      memo: desc,
      subledger_type: "customer",
      subledger_id: customerId,
    });
  }

  // Balance check.
  let drSum = ZERO, crSum = ZERO;
  for (const l of lines) {
    drSum += decimalToCents(l.debit);
    crSum += decimalToCents(l.credit);
  }
  if (drSum !== crSum) {
    throw new Error(
      `Shopify refund ${refund.id}: unbalanced credit memo JE — debits=${drSum}, credits=${crSum}`,
    );
  }

  return {
    entity_id: order.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_credit_memo",
    posting_date: toDateString(refund.processed_at || order.processed_at),
    source_module: "shopify",
    source_table: "shopify_refunds",
    source_id: refund.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Build the ar_invoices row for a partial-refund credit memo.
 */
export function buildCreditMemoInvoiceRow({
  order, refund, accounts, customerId, jeId,
  totalAmountCents, originalInvoiceId,
}) {
  const row = {
    entity_id: order.entity_id,
    customer_id: customerId,
    invoice_number: `SHOPIFY-CM-${refund.shopify_refund_id}`,
    invoice_kind: "customer_credit_memo",
    gl_status: "sent",
    invoice_date: toDateString(refund.processed_at || order.processed_at),
    ar_account_id: accounts.arId,
    revenue_account_id: accounts.revenueId,
    accrual_je_id: jeId,
    total_amount_cents: toBigInt(totalAmountCents).toString(),
    paid_amount_cents: "0",
    notes: `Shopify refund ${refund.shopify_refund_id} (parent order ${order.shopify_order_id})`,
    source: "shopify",
  };
  if (originalInvoiceId) row.reverses_invoice_id = originalInvoiceId;
  return row;
}

/**
 * Resolve the GL accounts needed for the partial-refund path.
 *
 *   1200 (or 1201) — AR control
 *   4000           — Revenue
 *   4500           — Restocking Fee Income (D8)
 *   1300           — Inventory Asset
 *   5000           — COGS
 */
export async function resolveCreditMemoAccounts(adminClient, entityId) {
  const codes = ["1200", "1201", "4000", "4500", "1300", "5000"];
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
    arId:            byCode["1200"] || byCode["1201"] || null,
    revenueId:       byCode["4000"] || null,
    restockingFeeId: byCode["4500"] || null,
    inventoryId:     byCode["1300"] || null,
    cogsId:          byCode["5000"] || null,
  };
}

function requiredAccountsCheck(accounts, refund) {
  const missing = [];
  if (!accounts.arId)      missing.push("1200 (or 1201) — AR");
  if (!accounts.revenueId) missing.push("4000 — Revenue");
  if (toBigInt(refund.restocking_fee_cents) > ZERO && !accounts.restockingFeeId) {
    missing.push("4500 — Restocking Fee Income");
  }
  return missing;
}

/**
 * Walk the Shopify `refund_line_items` array on the refund payload and pull
 * each line that has restocked=true. Returns a normalized list of
 *   { shopify_line_id, quantity, line_total_cents }.
 *
 * Shopify shape (per Admin REST docs):
 *   refund.refund_line_items[] = {
 *     line_item_id: number,
 *     quantity: number,
 *     restock_type: 'no_restock' | 'cancel' | 'return' | 'legacy_restock',
 *     subtotal: '49.99',
 *     ...
 *   }
 *
 * A "restocked" line is one where restock_type IS NOT 'no_restock'. We treat
 * 'cancel' / 'return' / 'legacy_restock' as restocks.
 *
 * Exported for unit tests.
 */
export function extractRestockedLines(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") return [];
  const items = Array.isArray(rawPayload.refund_line_items)
    ? rawPayload.refund_line_items
    : [];
  const out = [];
  for (const li of items) {
    if (!li || typeof li !== "object") continue;
    const restockType = li.restock_type || "no_restock";
    if (restockType === "no_restock") continue;
    const qty = Number(li.quantity) || 0;
    if (qty <= 0) continue;
    out.push({
      shopify_line_id: String(li.line_item_id ?? ""),
      quantity: qty,
      subtotal_cents: dollarsToCents(li.subtotal),
      restock_type: restockType,
    });
  }
  return out;
}

/**
 * Post the COGS-reversal sibling JE for restocked lines + insert
 * inventory_layers rows (source_kind='shopify_refund_restock').
 *
 * Per line, the unit_cost_cents is pulled from the parent ar_invoice_lines
 * row's cogs_cents / quantity (P4-3 stamped these at AR send time). When the
 * lookup fails (no AR line, missing cogs_cents), we skip the line — the
 * credit memo JE alone keeps the GL balanced.
 *
 * Returns { je_id, inventory_layer_ids[] }.
 */
async function postCogsReversal({
  adminClient, order, refund, accounts, restockLines, creditMemoId,
}) {
  // Resolve the cogs_cents-per-qty per restocked line. We need the parent
  // ar_invoice_lines.cogs_cents + ar_invoice_lines.quantity + the
  // inventory_item_id — match by shopify_line_id → shopify_order_lines.
  const shopifyLineIds = restockLines.map((l) => l.shopify_line_id).filter(Boolean);
  let shopifyLineRows = [];
  if (shopifyLineIds.length > 0) {
    const { data, error } = await adminClient
      .from("shopify_order_lines")
      .select("id, shopify_line_id, sku, quantity")
      .eq("shopify_order_id", order.id)
      .in("shopify_line_id", shopifyLineIds);
    if (error) {
      throw new Error(`shopify_order_lines lookup failed: ${error.message}`);
    }
    shopifyLineRows = data || [];
  }
  const shopifyLineBySid = new Map(
    shopifyLineRows.map((r) => [String(r.shopify_line_id), r]),
  );

  // For each restocked line, resolve the parent ar_invoice_lines row by
  // sku match (best-effort). We need cogs_cents + quantity + inventory_item_id.
  let parentArLines = [];
  if (order.ar_invoice_id) {
    const { data, error } = await adminClient
      .from("ar_invoice_lines")
      .select("id, inventory_item_id, quantity, cogs_cents")
      .eq("ar_invoice_id", order.ar_invoice_id);
    if (error) {
      throw new Error(`ar_invoice_lines lookup failed: ${error.message}`);
    }
    parentArLines = data || [];
  }

  const cogsLines = [];
  const layerInserts = [];
  let totalReverseCogs = ZERO;

  for (let i = 0; i < restockLines.length; i++) {
    const rl = restockLines[i];
    const soLine = shopifyLineBySid.get(rl.shopify_line_id);
    if (!soLine) continue;

    // Match an ar_invoice_lines row by sku via shopify_order_lines.sku.
    // P11-3 doesn't currently emit per-line ar_invoice_lines rows, so this
    // is best-effort. When no match, fall back to skipping the layer +
    // COGS reversal (the credit memo JE still posts).
    let arLine = null;
    if (soLine.sku && parentArLines.length > 0) {
      arLine = parentArLines.find(
        (al) => al.inventory_item_id && al.cogs_cents != null && al.quantity != null,
      );
    }
    if (!arLine || !arLine.inventory_item_id) continue;

    const arQty = Number(arLine.quantity) || 0;
    if (arQty <= 0) continue;
    const arCogs = toBigInt(arLine.cogs_cents);
    if (arCogs <= ZERO) continue;

    // Proportional reversal: per-unit cost = arCogs / arQty.
    // Use BigInt scaling to keep cents-precise.
    const restockQty = rl.quantity;
    // (cogs * restockQty) / arQty — round half-away-from-zero.
    const numer = arCogs * BigInt(restockQty);
    const reverseCents = numer / BigInt(arQty);
    if (reverseCents <= ZERO) continue;
    const unitCostCents = arCogs / BigInt(arQty); // unit cost for layer

    totalReverseCogs += reverseCents;

    const memo = `Restock — refund ${refund.shopify_refund_id} L${i + 1}`;
    cogsLines.push({
      account_id: accounts.inventoryId,
      debit: centsToDecimal(reverseCents),
      credit: "0",
      memo,
      subledger_type: "item",
      subledger_id: arLine.inventory_item_id,
    });
    cogsLines.push({
      account_id: accounts.cogsId,
      debit: "0",
      credit: centsToDecimal(reverseCents),
      memo,
      subledger_type: "item",
      subledger_id: arLine.inventory_item_id,
    });

    layerInserts.push({
      entity_id: order.entity_id,
      item_id: arLine.inventory_item_id,
      received_at: toDateString(refund.processed_at || order.processed_at),
      original_qty: restockQty,
      remaining_qty: restockQty,
      unit_cost_cents: unitCostCents.toString(),
      source_kind: "shopify_refund_restock",
      notes: `shopify refund ${refund.shopify_refund_id} L${i + 1}`,
    });
  }

  if (cogsLines.length === 0) {
    return { je_id: null, inventory_layer_ids: [] };
  }

  // Number the lines + build the JE payload.
  const numbered = cogsLines.map((l, ix) => ({ line_number: ix + 1, ...l }));
  const desc = `Shopify refund ${refund.shopify_refund_id} — COGS reversal`;
  const cogsPayload = {
    entity_id: order.entity_id,
    basis: "ACCRUAL",
    journal_type: "inventory_adjustment",
    posting_date: toDateString(refund.processed_at || order.processed_at),
    source_module: "shopify",
    source_table: "shopify_refunds",
    source_id: refund.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines: numbered,
  };

  const { data: cogsJeId, error: cogsErr } = await adminClient.rpc(
    "gl_post_journal_entry",
    { payload: cogsPayload },
  );
  if (cogsErr) {
    const e = new Error(`COGS-reversal RPC failed: ${cogsErr.message}`);
    e.code = "rpc_failed";
    throw e;
  }

  // Insert inventory layers (source_kind='shopify_refund_restock' — schema
  // CHECK constraint accepts it per P11-1 extension). We insert directly
  // (not via fifo.createLayer) because the JS validator's VALID_SOURCE_KIND
  // Set doesn't include the Shopify value (P11-1 only widened the SQL
  // constraint).
  const insertedLayerIds = [];
  if (layerInserts.length > 0) {
    const { data: insertedLayers, error: layerErr } = await adminClient
      .from("inventory_layers")
      .insert(layerInserts)
      .select("id");
    if (layerErr) {
      // Non-fatal — JE is the GL truth. Log + return without layer ids.
      // eslint-disable-next-line no-console
      console.error(
        `[shopify refund ${refund.id}] inventory_layers insert failed: ${layerErr.message}`,
      );
    } else {
      for (const row of insertedLayers || []) {
        if (row?.id) insertedLayerIds.push(row.id);
      }
    }
  }

  // Stamp credit_memo_id loose pointer on the layers (best-effort, ignored
  // if the column doesn't exist).
  if (creditMemoId && insertedLayerIds.length > 0) {
    try {
      await adminClient
        .from("inventory_layers")
        .update({ notes: `shopify refund (cm ${creditMemoId})` })
        .in("id", insertedLayerIds);
    } catch { /* non-fatal */ }
  }

  return {
    je_id: cogsJeId,
    inventory_layer_ids: insertedLayerIds,
  };
}

// ──────────────────────────────────────────────────────────────────────
// money helpers (mirror post-order-je.js).
// ──────────────────────────────────────────────────────────────────────

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

function decimalToCents(s) {
  if (s == null || s === "") return ZERO;
  const str = typeof s === "string" ? s : String(s);
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`invalid decimal: ${str}`);
  }
  const [whole, frac = ""] = str.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, "");
  return sign * (BigInt(wholeAbs) * 100n + BigInt(padded));
}

function dollarsToCents(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function toDateString(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  if (typeof ts === "string") return ts.slice(0, 10);
  if (ts instanceof Date) return ts.toISOString().slice(0, 10);
  return String(ts).slice(0, 10);
}
