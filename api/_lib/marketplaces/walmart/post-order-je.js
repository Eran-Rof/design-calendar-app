// api/_lib/marketplaces/walmart/post-order-je.js
//
// Tangerine P12b-3 — Walmart AR invoice JE posting service.
//
// Pure(-ish) function: given a walmart_orders.id + an admin Supabase
// client, build + post the AR invoice + per-line referral / fulfillment
// fee JE atomically, and stamp the walmart_orders row with je_id +
// ar_invoice_id.
//
// JE shape (per P12b architecture §D5 + D8):
//   DR 1200 AR                         = item_subtotal − discount + shipping
//                                        (= order_total_cents − tax_collected)
//   CR 4000 Revenue                    = item_subtotal − discount
//   CR 4500 Shipping Revenue           = shipping_cents
//   (tax_collected_cents recorded in JE description per D8 — Walmart
//    is a marketplace facilitator; they already remitted the tax to the
//    states, so Tangerine does NOT credit 2200 Sales Tax Payable.)
//
//   For each walmart_order_items row (when commission_cents or
//   wfs_fulfillment_fee_cents > 0):
//     DR 6524 Referral Fees             = commission_cents
//     DR 6523 Fulfillment Fees          = wfs_fulfillment_fee_cents
//     CR 1115 Marketplace Receivable Clearing = commission + wfs_fee
//
// Idempotency:
//   - If walmart_orders.je_id IS NOT NULL → already posted → return
//     { status: 'already_posted', je_id }.
//
// source='walmart' on the ar_invoices row per T10-1 source tagging.
//
// BigInt cents throughout per project_tangerine_progress money handling.
//
// COGS: deferred to a separate path (same call-out as P11-3); the AR JE
// posts at receipt-of-order without waiting on SKU→ip_item_master
// resolution.

const ZERO = 0n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the JE payload (no DB writes). Exported for unit tests.
 *
 * @param {Object} args
 * @param {Object} args.order         walmart_orders row (snake_case).
 * @param {Object[]} args.items       walmart_order_items rows for this order.
 * @param {Object} args.accounts      { arId, revenueId, shippingRevenueId,
 *                                      referralFeeId, fulfillmentFeeId,
 *                                      clearingId }.
 * @param {string} args.customerId    Resolved customers.id.
 * @returns {Object}                  payload for gl_post_journal_entry RPC.
 */
export function buildJournalEntryPayload({ order, items, accounts, customerId }) {
  const itemSubtotal = toBigInt(order.item_subtotal_cents);
  const tax          = toBigInt(order.tax_collected_cents);
  const shipping     = toBigInt(order.shipping_cents);
  const discount     = toBigInt(order.discount_cents);
  const orderTotal   = toBigInt(order.order_total_cents);

  // Revenue = subtotal - discount.
  const revenue = itemSubtotal - discount;
  if (revenue < ZERO) {
    throw new Error(
      `Walmart order ${order.id}: item_subtotal_cents (${itemSubtotal}) - ` +
      `discount_cents (${discount}) is negative`,
    );
  }

  // AR debit = order_total - tax (tax is memo per D8; Walmart already
  // remitted it). If order_total_cents wasn't carried on the row, derive
  // it from the components.
  const arAmount = orderTotal > ZERO
    ? (orderTotal - tax)
    : (revenue + shipping);
  if (arAmount < ZERO) {
    throw new Error(
      `Walmart order ${order.id}: AR amount derived as negative (${arAmount})`,
    );
  }

  // Per-line fees.
  let totalCommission = ZERO;
  let totalWfsFee = ZERO;
  const lineFees = [];
  const itemList = Array.isArray(items) ? items : [];
  for (const ln of itemList) {
    const commission = toBigInt(ln.commission_cents);
    const wfsFee     = toBigInt(ln.wfs_fulfillment_fee_cents);
    if (commission < ZERO || wfsFee < ZERO) {
      throw new Error(
        `Walmart order ${order.id} line ${ln.line_number}: ` +
        `negative fee amount (commission=${commission}, wfs=${wfsFee})`,
      );
    }
    if (commission === ZERO && wfsFee === ZERO) continue;
    totalCommission += commission;
    totalWfsFee += wfsFee;
    lineFees.push({
      line_number: Number(ln.line_number),
      item_sku: ln.item_sku || null,
      commission,
      wfsFee,
    });
  }
  const totalFees = totalCommission + totalWfsFee;

  // Header-JE balance check (DR AR vs CR revenue + CR shipping).
  const drHeader = arAmount;
  const crHeader = revenue + shipping;
  if (drHeader !== crHeader) {
    throw new Error(
      `Walmart order ${order.id}: unbalanced header JE — DR=${drHeader}, ` +
      `CR=${crHeader} (item_subtotal=${itemSubtotal}, discount=${discount}, ` +
      `shipping=${shipping}, tax=${tax}, order_total=${orderTotal})`,
    );
  }

  // Fee-pair balance check (DR fees == CR clearing).
  if (totalFees > ZERO) {
    if (!accounts.referralFeeId && totalCommission > ZERO) {
      throw new Error(
        `Walmart order ${order.id}: commission > 0 but 6524 Referral Fees not configured`,
      );
    }
    if (!accounts.fulfillmentFeeId && totalWfsFee > ZERO) {
      throw new Error(
        `Walmart order ${order.id}: wfs_fulfillment_fee > 0 but 6523 Fulfillment Fees not configured`,
      );
    }
    if (!accounts.clearingId) {
      throw new Error(
        `Walmart order ${order.id}: fees > 0 but 1115 Marketplace Receivable Clearing not configured`,
      );
    }
  }

  const orderLabel = order.purchase_order_id || order.customer_order_id || order.id;
  const desc = tax > ZERO
    ? `Walmart order ${orderLabel} (facilitator tax memo $${centsToDecimal(tax)} per D8)`
    : `Walmart order ${orderLabel}`;

  const lines = [];
  let lineNo = 0;

  // DR AR
  lines.push({
    line_number: ++lineNo,
    account_id: accounts.arId,
    debit: centsToDecimal(arAmount),
    credit: "0",
    memo: `AR — ${orderLabel}`,
    subledger_type: "customer",
    subledger_id: customerId,
  });

  // CR Revenue
  if (revenue > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.revenueId,
      debit: "0",
      credit: centsToDecimal(revenue),
      memo: `Revenue — ${orderLabel}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // CR Shipping Revenue
  if (shipping > ZERO) {
    if (!accounts.shippingRevenueId) {
      throw new Error(
        `Walmart order ${order.id}: shipping_cents=${shipping} but no 4500 Shipping Revenue account configured`,
      );
    }
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.shippingRevenueId,
      debit: "0",
      credit: centsToDecimal(shipping),
      memo: `Shipping — ${orderLabel}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // Per-line fees: DR 6524 + DR 6523 + CR 1115 (one CR for the sum).
  for (const lf of lineFees) {
    const lineLabel = lf.item_sku
      ? `${orderLabel} line ${lf.line_number} (${lf.item_sku})`
      : `${orderLabel} line ${lf.line_number}`;
    if (lf.commission > ZERO) {
      lines.push({
        line_number: ++lineNo,
        account_id: accounts.referralFeeId,
        debit: centsToDecimal(lf.commission),
        credit: "0",
        memo: `Referral fee — ${lineLabel}`,
        subledger_type: null,
        subledger_id: null,
      });
    }
    if (lf.wfsFee > ZERO) {
      lines.push({
        line_number: ++lineNo,
        account_id: accounts.fulfillmentFeeId,
        debit: centsToDecimal(lf.wfsFee),
        credit: "0",
        memo: `WFS fulfillment fee — ${lineLabel}`,
        subledger_type: null,
        subledger_id: null,
      });
    }
  }
  if (totalFees > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(totalFees),
      memo: `Marketplace clearing — ${orderLabel}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // Final overall balance check (defense in depth).
  let drSum = ZERO;
  let crSum = ZERO;
  for (const ln of lines) {
    drSum += decimalToBigIntCents(ln.debit);
    crSum += decimalToBigIntCents(ln.credit);
  }
  if (drSum !== crSum) {
    throw new Error(
      `Walmart order ${order.id}: unbalanced JE — debits=${drSum}, credits=${crSum}`,
    );
  }

  return {
    entity_id: order.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_invoice",
    posting_date: toDateString(order.order_date),
    source_module: "walmart",
    source_table: "walmart_orders",
    source_id: order.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Resolve GL account ids by code. Returns a map keyed by code.
 *
 * @returns {Promise<{
 *   arId:string|null, revenueId:string|null,
 *   shippingRevenueId:string|null,
 *   referralFeeId:string|null, fulfillmentFeeId:string|null,
 *   clearingId:string|null,
 * }>}
 */
export async function resolveGlAccounts(adminClient, entityId) {
  const codes = ["1200", "1201", "4000", "4500", "6523", "6524", "1115"];
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
    arId:              byCode["1200"] || byCode["1201"] || null,
    revenueId:         byCode["4000"] || null,
    shippingRevenueId: byCode["4500"] || null,
    referralFeeId:     byCode["6524"] || null,
    fulfillmentFeeId:  byCode["6523"] || null,
    clearingId:        byCode["1115"] || null,
  };
}

/**
 * Resolve (or create) the customer id for a walmart order.
 *
 * Strategy:
 *   1. If order.customer_id IS NOT NULL → return it.
 *   2. Else look at raw_payload.shippingInfo.postalAddress for a name +
 *      address to upsert with code = WALMART-<customer_order_id> (or
 *      purchase_order_id when customer_order_id missing).
 *
 * Returns the customer id.
 */
export async function resolveCustomerId(adminClient, order) {
  if (order.customer_id) return order.customer_id;

  const addr = extractShippingAddress(order.raw_payload);
  const namePart = addr?.name?.trim() || null;
  const customerKey = order.customer_order_id || order.purchase_order_id;
  if (!customerKey) {
    throw new Error(
      `Walmart order ${order.id} has no customer_id and no customer_order_id / purchase_order_id`,
    );
  }
  const code = `WALMART-${customerKey}`.slice(0, 64);

  // Look up by code first (idempotent).
  const { data: byCode, error: byCodeErr } = await adminClient
    .from("customers")
    .select("id")
    .eq("entity_id", order.entity_id)
    .eq("code", code)
    .maybeSingle();
  if (byCodeErr && byCodeErr.code !== "PGRST116") {
    throw new Error(`customers lookup by code failed: ${byCodeErr.message}`);
  }
  if (byCode?.id) return byCode.id;

  const insertRow = {
    entity_id: order.entity_id,
    code,
    name: namePart || `Walmart Buyer ${customerKey}`,
    customer_type: "ecom",
    status: "active",
  };
  // Best-effort source tag — silently retried without if column rejected.
  insertRow.source = "walmart";

  const { data: inserted, error: insErr } = await adminClient
    .from("customers")
    .insert(insertRow)
    .select("id")
    .single();
  if (insErr) {
    // Race: another concurrent call may have inserted the same code.
    const { data: retry } = await adminClient
      .from("customers")
      .select("id")
      .eq("entity_id", order.entity_id)
      .eq("code", code)
      .maybeSingle();
    if (retry?.id) return retry.id;

    // Strip the source column and retry.
    if (insertRow.source) {
      const retryRow = { ...insertRow };
      delete retryRow.source;
      const { data: retry2, error: insErr2 } = await adminClient
        .from("customers")
        .insert(retryRow)
        .select("id")
        .single();
      if (!insErr2 && retry2?.id) return retry2.id;
    }

    throw new Error(`customers upsert failed: ${insErr.message}`);
  }
  return inserted.id;
}

/**
 * Extract a usable shipping address shape from the Walmart raw payload.
 * Walmart nests under shippingInfo.postalAddress. Tolerates several
 * camelCase / snake_case variants.
 */
export function extractShippingAddress(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const shippingInfo =
    rawPayload.shippingInfo ||
    rawPayload.shipping_info ||
    rawPayload.shipping ||
    null;
  if (!shippingInfo) return null;
  const postal =
    shippingInfo.postalAddress ||
    shippingInfo.postal_address ||
    shippingInfo.address ||
    null;
  if (!postal) return null;
  return {
    name:
      postal.name ||
      shippingInfo.name ||
      shippingInfo.contactName ||
      null,
    address1: postal.address1 || postal.line1 || null,
    address2: postal.address2 || postal.line2 || null,
    city: postal.city || null,
    state: postal.state || postal.region || null,
    postalCode: postal.postalCode || postal.postal_code || postal.zip || null,
    country: postal.country || postal.countryCode || null,
  };
}

/**
 * Build the ar_invoices insert row.
 */
export function buildArInvoiceRow({ order, customerId, accounts, jeId }) {
  // AR amount = order_total − tax (tax is memo per D8).
  const orderTotal = toBigInt(order.order_total_cents);
  const tax        = toBigInt(order.tax_collected_cents);
  const arAmount = orderTotal > ZERO
    ? (orderTotal - tax)
    : (toBigInt(order.item_subtotal_cents)
       - toBigInt(order.discount_cents)
       + toBigInt(order.shipping_cents));

  return {
    entity_id: order.entity_id,
    customer_id: customerId,
    invoice_number: `WALMART-${order.purchase_order_id || order.customer_order_id || order.id}`,
    invoice_kind: "customer_invoice",
    gl_status: "sent",
    invoice_date: toDateString(order.order_date),
    posting_date: toDateString(order.order_date),
    ar_account_id: accounts.arId,
    revenue_account_id: accounts.revenueId,
    accrual_je_id: jeId,
    total_amount_cents: arAmount.toString(),
    paid_amount_cents: "0",
    description: `Walmart order ${order.purchase_order_id || order.customer_order_id || order.id}`,
    source: "walmart",
  };
}

/**
 * Main entry point — post the AR JE for a walmart_orders row.
 *
 * @param {Object} args
 * @param {string} args.walmartOrderId   UUID of walmart_orders.id.
 * @param {Object} args.adminClient      Supabase service-role client.
 * @returns {Promise<
 *   {status:'already_posted', je_id:string} |
 *   {status:'posted', je_id:string, ar_invoice_id:string}
 * >}
 */
export async function postWalmartOrderJe({ walmartOrderId, adminClient }) {
  if (!walmartOrderId || !UUID_RE.test(String(walmartOrderId))) {
    throw new Error("walmartOrderId must be a uuid");
  }
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }

  // 1. Read walmart_orders row.
  const { data: order, error: orderErr } = await adminClient
    .from("walmart_orders")
    .select("*")
    .eq("id", walmartOrderId)
    .maybeSingle();
  if (orderErr) {
    throw new Error(`walmart_orders lookup failed: ${orderErr.message}`);
  }
  if (!order) {
    const e = new Error(`walmart_orders ${walmartOrderId} not found`);
    e.code = "not_found";
    throw e;
  }

  // 2. Idempotency.
  if (order.je_id) {
    return { status: "already_posted", je_id: order.je_id };
  }

  // 3. Read walmart_order_items.
  const { data: items, error: itemsErr } = await adminClient
    .from("walmart_order_items")
    .select("*")
    .eq("walmart_order_id", walmartOrderId);
  if (itemsErr) {
    throw new Error(`walmart_order_items lookup failed: ${itemsErr.message}`);
  }
  const itemRows = Array.isArray(items) ? items : [];

  // 4. Resolve customer.
  let customerId;
  try {
    customerId = await resolveCustomerId(adminClient, order);
  } catch (e) {
    const wrapped = new Error(`customer resolution failed: ${e.message}`);
    wrapped.code = "customer_resolution_failed";
    throw wrapped;
  }

  // 5. Resolve GL accounts.
  const accounts = await resolveGlAccounts(adminClient, order.entity_id);
  const missing = [];
  if (!accounts.arId)      missing.push("1200 (or 1201) — AR");
  if (!accounts.revenueId) missing.push("4000 — Revenue");
  if (toBigInt(order.shipping_cents) > ZERO && !accounts.shippingRevenueId) {
    missing.push("4500 — Shipping Revenue");
  }
  const totalCommission = itemRows.reduce(
    (acc, ln) => acc + toBigInt(ln.commission_cents), ZERO,
  );
  const totalWfsFee = itemRows.reduce(
    (acc, ln) => acc + toBigInt(ln.wfs_fulfillment_fee_cents), ZERO,
  );
  if (totalCommission > ZERO && !accounts.referralFeeId) {
    missing.push("6524 — Referral Fees");
  }
  if (totalWfsFee > ZERO && !accounts.fulfillmentFeeId) {
    missing.push("6523 — Fulfillment Fees");
  }
  if ((totalCommission + totalWfsFee) > ZERO && !accounts.clearingId) {
    missing.push("1115 — Marketplace Receivable Clearing");
  }
  if (missing.length > 0) {
    const e = new Error(`Missing GL accounts: ${missing.join(", ")}`);
    e.code = "gl_accounts_missing";
    throw e;
  }

  // 6. Build + post JE.
  const payload = buildJournalEntryPayload({
    order, items: itemRows, accounts, customerId,
  });
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

  // 7. Create ar_invoices row.
  const arInvoiceRow = buildArInvoiceRow({ order, customerId, accounts, jeId });
  const { data: arInvoice, error: arInsErr } = await adminClient
    .from("ar_invoices")
    .insert(arInvoiceRow)
    .select("id")
    .single();
  if (arInsErr) {
    // JE posted but invoice didn't write. Stamp je_id so operator can see.
    await adminClient
      .from("walmart_orders")
      .update({ je_id: jeId })
      .eq("id", walmartOrderId);
    const e = new Error(
      `ar_invoices insert failed (JE ${jeId} posted but invoice not created): ${arInsErr.message}`,
    );
    e.code = "ar_invoice_insert_failed";
    e.je_id = jeId;
    throw e;
  }

  // 8. Stamp walmart_orders with both pointers.
  const { error: updErr } = await adminClient
    .from("walmart_orders")
    .update({
      je_id: jeId,
      ar_invoice_id: arInvoice.id,
      customer_id: customerId,
      source: "walmart",
    })
    .eq("id", walmartOrderId);
  if (updErr) {
    const e = new Error(
      `walmart_orders update failed (JE ${jeId} + invoice ${arInvoice.id} posted): ${updErr.message}`,
    );
    e.code = "walmart_orders_update_failed";
    e.je_id = jeId;
    e.ar_invoice_id = arInvoice.id;
    throw e;
  }

  return {
    status: "posted",
    je_id: jeId,
    ar_invoice_id: arInvoice.id,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (exported for unit tests).
// ────────────────────────────────────────────────────────────────────────

/**
 * Coerce a value into a BigInt cents amount.
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

/**
 * BigInt cents → "123.45" decimal string.
 */
export function centsToDecimal(cents) {
  const c = typeof cents === "bigint" ? cents : toBigInt(cents);
  const neg = c < ZERO;
  const abs = neg ? -c : c;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

/**
 * "123.45" → 12345n. Reverse of centsToDecimal — used internally for the
 * defensive balance check inside buildJournalEntryPayload.
 */
function decimalToBigIntCents(s) {
  if (typeof s !== "string") {
    throw new Error(`decimal string required, got ${typeof s}`);
  }
  const m = s.match(/^(-?)(\d+)\.(\d{2})$/);
  if (!m) {
    // tolerate "0" or "" (defensive)
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
