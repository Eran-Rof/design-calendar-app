// api/_lib/marketplaces/fba/post-order-je.js
//
// Tangerine P12a-3 — Amazon FBA AR invoice JE posting service.
//
// Pure(-ish) function: given a fba_orders.id + an admin Supabase client,
// build + post the AR invoice JE atomically, then stamp the fba_orders
// row with je_id + ar_invoice_id.
//
// JE shape (P12 §4.1 / D4 / D8):
//   DR 1200 AR                            = item_subtotal - promo_discount + shipping
//                                          (the customer-side receivable, ex-tax —
//                                           marketplace facilitator tax is memo-only)
//   CR 4000 Revenue                       = item_subtotal_cents - promotion_discount_cents
//   CR 4500 Shipping Revenue              = shipping_cents
//   ... (memo line documenting tax_collected_cents — DR 0 / CR 0)
//   Per line item (i in fba_order_items):
//     DR 6523 Fulfillment Fees            = item.fulfillment_fee_cents
//     DR 6524 Referral Fees               = item.referral_fee_cents
//     CR 1115 Marketplace Receivable Clearing = fulfillment + referral
//
// The 1115 Marketplace Receivable Clearing is the bridge between the AR
// row (booked here at order time) and the Amazon settlement deposit
// (P12a-4). When the settlement hits, P12a-4 will DR 1100 Bank +
// CR 1115 for the net (gross - fees - refunds).
//
// **D8 — marketplace facilitator tax is MEMO ONLY.** Amazon collects +
// remits sales tax on the seller's behalf, so we DO NOT credit 2200
// Sales Tax Payable. We document the tax_collected_cents amount via a
// dedicated memo line (debit=0, credit=0) on the JE so auditors can see
// what Amazon collected without polluting the seller's tax liability
// balance.
//
// Idempotency:
//   - If fba_orders.je_id IS NOT NULL → already posted → return
//     { status: 'already_posted', je_id }.
//
// source='fba' is stamped on the ar_invoices row per
// feedback_source_tagging_enforcement.
//
// BigInt cents throughout per project_tangerine_progress money handling.

const ZERO = 0n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coerce a value into a BigInt cents amount. Accepts bigint / number
 * (must be safe integer) / string. Null/undefined → 0n.
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
 * BigInt cents → "123.45" decimal string (matches the RPC payload format).
 */
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
 * Build the JE payload (no DB writes). Exported for unit tests.
 *
 * @param {Object} args
 * @param {Object} args.order       fba_orders row (snake_case columns).
 * @param {Array}  args.items       fba_order_items rows (per line).
 * @param {Object} args.accounts    { arId, revenueId, shippingRevenueId, fulfillmentFeeId, referralFeeId, clearingId }
 * @param {string} args.customerId  Resolved customers.id.
 * @returns {Object}                payload for gl_post_journal_entry RPC.
 */
export function buildJournalEntryPayload({ order, items, accounts, customerId }) {
  const itemSubtotal = toBigInt(order.item_subtotal_cents);
  const taxCollected = toBigInt(order.tax_collected_cents);
  const shipping     = toBigInt(order.shipping_cents);
  const promoDiscount = toBigInt(order.promotion_discount_cents);

  // Revenue = item_subtotal - promotion_discount (contra-revenue).
  const revenue = itemSubtotal - promoDiscount;
  if (revenue < ZERO) {
    throw new Error(
      `FBA order ${order.id}: item_subtotal_cents (${itemSubtotal}) - ` +
      `promotion_discount_cents (${promoDiscount}) is negative`,
    );
  }

  // AR = revenue + shipping (tax is memo-only per D8 — NOT credited to 2200,
  // so it doesn't enter the AR receivable).
  const arAmount = revenue + shipping;

  // Aggregate per-line fees.
  let totalFulfillmentFee = ZERO;
  let totalReferralFee    = ZERO;
  for (const it of items || []) {
    totalFulfillmentFee += toBigInt(it.fulfillment_fee_cents);
    totalReferralFee    += toBigInt(it.referral_fee_cents);
  }
  const totalFees = totalFulfillmentFee + totalReferralFee;

  // Balance check (BigInt cents).
  //   DR = AR + totalFees      CR = revenue + shipping + totalFees
  //   AR = revenue + shipping  → DR == CR. Tax is memo-only (0/0).
  const drSum = arAmount + totalFees;
  const crSum = revenue + shipping + totalFees;
  if (drSum !== crSum) {
    throw new Error(
      `FBA order ${order.id}: unbalanced JE — debits=${drSum}, credits=${crSum} ` +
      `(ar=${arAmount}, revenue=${revenue}, shipping=${shipping}, fees=${totalFees})`,
    );
  }

  const desc = `Amazon FBA order ${order.amazon_order_id}`;
  const lines = [];
  let lineNo = 0;

  // DR AR (always emitted; even 0 to anchor the JE to the subledger).
  lines.push({
    line_number: ++lineNo,
    account_id: accounts.arId,
    debit: centsToDecimal(arAmount),
    credit: "0",
    memo: desc,
    subledger_type: "customer",
    subledger_id: customerId,
  });

  // CR Revenue (omit when 0).
  if (revenue > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.revenueId,
      debit: "0",
      credit: centsToDecimal(revenue),
      memo: desc,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // CR Shipping Revenue (omit when 0).
  if (shipping > ZERO) {
    if (!accounts.shippingRevenueId) {
      throw new Error(
        `FBA order ${order.id}: shipping_cents=${shipping} but no 4500 account configured`,
      );
    }
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.shippingRevenueId,
      debit: "0",
      credit: centsToDecimal(shipping),
      memo: `Shipping revenue — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // Tax memo (D8 — marketplace facilitator tax: Amazon collected + remitted,
  // so we DOCUMENT it as debit=0 / credit=0 against the AR account.
  // This keeps the JE balanced AND surfaces the tax amount in the JE memo
  // for auditors. We do NOT credit 2200 Sales Tax Payable.
  if (taxCollected > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.arId, // any account works for a 0/0 memo
      debit: "0",
      credit: "0",
      memo: `Marketplace facilitator tax (memo only — Amazon remits) — ${centsToDecimal(taxCollected)} — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // Per-line fees: one DR 6523 + one DR 6524 + one CR 1115 per item that
  // carries any fee. We emit aggregated lines per item to keep the JE
  // line count manageable while still preserving SKU traceability via
  // the memo.
  for (const it of items || []) {
    const ff = toBigInt(it.fulfillment_fee_cents);
    const rf = toBigInt(it.referral_fee_cents);
    const lineFees = ff + rf;
    if (lineFees === ZERO) continue;

    if (!accounts.clearingId) {
      throw new Error(
        `FBA order ${order.id}: line fees > 0 but no 1115 account configured`,
      );
    }

    const itemMemo = `${desc} — line ${it.order_item_id || it.id || "?"}` +
      (it.sku ? ` SKU ${it.sku}` : "") +
      (it.asin ? ` ASIN ${it.asin}` : "");

    if (ff > ZERO) {
      if (!accounts.fulfillmentFeeId) {
        throw new Error(
          `FBA order ${order.id}: fulfillment_fee_cents > 0 but no 6523 account configured`,
        );
      }
      lines.push({
        line_number: ++lineNo,
        account_id: accounts.fulfillmentFeeId,
        debit: centsToDecimal(ff),
        credit: "0",
        memo: `Fulfillment fee — ${itemMemo}`,
        subledger_type: null,
        subledger_id: null,
      });
    }
    if (rf > ZERO) {
      if (!accounts.referralFeeId) {
        throw new Error(
          `FBA order ${order.id}: referral_fee_cents > 0 but no 6524 account configured`,
        );
      }
      lines.push({
        line_number: ++lineNo,
        account_id: accounts.referralFeeId,
        debit: centsToDecimal(rf),
        credit: "0",
        memo: `Referral fee — ${itemMemo}`,
        subledger_type: null,
        subledger_id: null,
      });
    }
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(lineFees),
      memo: `Marketplace clearing (fees) — ${itemMemo}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  return {
    entity_id: order.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_invoice",
    posting_date: toDateString(order.purchase_date),
    source_module: "fba",
    source_table: "fba_orders",
    source_id: order.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Resolve GL account ids by code. Returns a map keyed by role string.
 * Required: 1200 (AR), 4000 (Revenue). Optional: 4500 (Shipping),
 * 6523 (Fulfillment Fees), 6524 (Referral Fees), 1115 (Marketplace Clearing).
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
    arId:                byCode["1200"] || byCode["1201"] || null,
    revenueId:           byCode["4000"] || null,
    shippingRevenueId:   byCode["4500"] || null,
    fulfillmentFeeId:    byCode["6523"] || null,
    referralFeeId:       byCode["6524"] || null,
    clearingId:          byCode["1115"] || null,
  };
}

/**
 * Resolve (or create) the customer id for an FBA order.
 *
 * Strategy:
 *   1. If order.customer_id IS NOT NULL → return it.
 *   2. Else, try to extract a buyer email from raw_payload.BuyerInfo.BuyerEmail.
 *   3. Look up by code = `FBA-${email}` (idempotent re-runs).
 *   4. Else upsert a new customer with code, source='fba'.
 *   5. When no email is available, fall back to an opaque per-order code
 *      `FBA-ANON-${amazon_order_id}` so the AR row still has a customer.
 *
 * Returns the customer id.
 */
export async function resolveCustomerId(adminClient, order) {
  if (order.customer_id) return order.customer_id;

  const buyerInfo = (order.raw_payload && order.raw_payload.BuyerInfo) || {};
  const rawEmail = buyerInfo.BuyerEmail || buyerInfo.buyer_email || null;
  const email = (rawEmail || "").trim().toLowerCase();

  // Compute the upsert code. Email branch when present; ANON branch otherwise.
  let code;
  let namePart;
  if (email) {
    code = `FBA-${email}`.slice(0, 64);
    namePart = email.split("@")[0] || email;
  } else {
    code = `FBA-ANON-${order.amazon_order_id || order.id}`.slice(0, 64);
    namePart = code;
  }

  // Try to find by code first (idempotent — repeated calls won't dup).
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
    name: namePart,
    customer_type: "ecom",
    status: "active",
    source: "fba",
  };

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

    // Retry without `source` in case the column hasn't reached customers yet.
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
 * Build the ar_invoices insert row from an fba_orders row + a freshly
 * posted JE id. Exported for tests.
 */
export function buildArInvoiceRow({ order, customerId, accounts, jeId }) {
  const revenue = toBigInt(order.item_subtotal_cents) - toBigInt(order.promotion_discount_cents);
  const shipping = toBigInt(order.shipping_cents);
  const arTotal = revenue + shipping;
  return {
    entity_id: order.entity_id,
    customer_id: customerId,
    invoice_number: `FBA-${order.amazon_order_id}`,
    invoice_kind: "customer_invoice",
    gl_status: "sent",
    invoice_date: toDateString(order.purchase_date),
    posting_date: toDateString(order.purchase_date),
    ar_account_id: accounts.arId,
    revenue_account_id: accounts.revenueId,
    accrual_je_id: jeId,
    total_amount_cents: arTotal.toString(),
    paid_amount_cents: "0",
    description: `Amazon FBA order ${order.amazon_order_id}`,
    source: "fba",
  };
}

/**
 * Main entry point — post the AR JE for a fba_orders row.
 *
 * @param {Object} args
 * @param {string} args.fbaOrderId         UUID of fba_orders.id.
 * @param {Object} args.adminClient        Supabase service-role client.
 * @returns {Promise<
 *   {status:'already_posted', je_id:string} |
 *   {status:'posted', je_id:string, ar_invoice_id:string}
 * >}
 */
export async function postFbaOrderJe({ fbaOrderId, adminClient }) {
  if (!fbaOrderId || !UUID_RE.test(String(fbaOrderId))) {
    throw new Error("fbaOrderId must be a uuid");
  }
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }

  // 1. Read fba_orders row.
  const { data: order, error: orderErr } = await adminClient
    .from("fba_orders")
    .select("*")
    .eq("id", fbaOrderId)
    .maybeSingle();
  if (orderErr) {
    throw new Error(`fba_orders lookup failed: ${orderErr.message}`);
  }
  if (!order) {
    const e = new Error(`fba_orders ${fbaOrderId} not found`);
    e.code = "not_found";
    throw e;
  }

  // 2. Idempotency.
  if (order.je_id) {
    return { status: "already_posted", je_id: order.je_id };
  }

  // 3. Read fba_order_items children.
  const { data: items, error: itemsErr } = await adminClient
    .from("fba_order_items")
    .select("*")
    .eq("fba_order_id", fbaOrderId);
  if (itemsErr) {
    throw new Error(`fba_order_items lookup failed: ${itemsErr.message}`);
  }

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
  // Per-line fees → need 6523 / 6524 / 1115 ONLY when any item carries them.
  let anyFulfillment = ZERO;
  let anyReferral    = ZERO;
  for (const it of items || []) {
    anyFulfillment += toBigInt(it.fulfillment_fee_cents);
    anyReferral    += toBigInt(it.referral_fee_cents);
  }
  if (anyFulfillment > ZERO && !accounts.fulfillmentFeeId) {
    missing.push("6523 — Fulfillment Fees");
  }
  if (anyReferral > ZERO && !accounts.referralFeeId) {
    missing.push("6524 — Referral Fees");
  }
  if ((anyFulfillment > ZERO || anyReferral > ZERO) && !accounts.clearingId) {
    missing.push("1115 — Marketplace Receivable Clearing");
  }
  if (missing.length > 0) {
    const e = new Error(`Missing GL accounts: ${missing.join(", ")}`);
    e.code = "gl_accounts_missing";
    throw e;
  }

  // 6. Build + post JE.
  const payload = buildJournalEntryPayload({
    order,
    items: items || [],
    accounts,
    customerId,
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
    // JE is posted but invoice didn't write — surface error so operator can
    // manually clean up. Stamp je_id on fba_orders so we know which JE is
    // dangling.
    await adminClient
      .from("fba_orders")
      .update({ je_id: jeId })
      .eq("id", fbaOrderId);
    const e = new Error(
      `ar_invoices insert failed (JE ${jeId} posted but invoice not created): ${arInsErr.message}`,
    );
    e.code = "ar_invoice_insert_failed";
    e.je_id = jeId;
    throw e;
  }

  // 8. Stamp fba_orders with both pointers + customer.
  const updatePatch = { je_id: jeId, ar_invoice_id: arInvoice.id };
  if (!order.customer_id) updatePatch.customer_id = customerId;
  const { error: updErr } = await adminClient
    .from("fba_orders")
    .update(updatePatch)
    .eq("id", fbaOrderId);
  if (updErr) {
    const e = new Error(
      `fba_orders update failed (JE ${jeId} + invoice ${arInvoice.id} posted): ${updErr.message}`,
    );
    e.code = "fba_orders_update_failed";
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
