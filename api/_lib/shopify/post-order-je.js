// api/_lib/shopify/post-order-je.js
//
// Tangerine P11-3 — Shopify AR invoice JE posting service.
//
// Pure(-ish) function: given a shopify_orders.id + an admin Supabase client,
// build + post the AR invoice + tax liability + merchant-fee JE atomically,
// and stamp the shopify_orders row with je_id + ar_invoice_id.
//
// Idempotency:
//   - If shopify_orders.je_id IS NOT NULL → already posted → return
//     { status: 'already_posted', je_id }.
//   - All writes go through the gl_post_journal_entry RPC + scoped
//     post-RPC stamps. If a downstream stamp fails after the JE persists,
//     the function surfaces an error but the JE row is the authoritative
//     truth — operator can re-stamp via the manual backfill handler.
//
// JE shape (per P11 arch §4.1 D5/D6):
//   DR 1200 AR                         = total_amount_cents
//   CR 4000 Revenue                    = subtotal - discount
//   CR 2200 Sales Tax Payable          = tax_amount_cents
//   DR 6510 Merchant Fees              = fee_cents          (optional — D6 deferred)
//   CR 1110 Payment Processor Clearing = fee_cents          (optional — D6 deferred)
//
// Per D6 the Shopify order webhook does NOT include the merchant fee — that
// only arrives on the payout webhook (P11-9). Fee posting here is therefore
// conditional: when the row has no fee_cents we skip the 6510/1110 pair and
// the JE remains balanced (DR AR vs CR Revenue + CR Tax). The payout
// reconciler later posts the offsetting clearing-to-bank JE.
//
// COGS (5000 / 1300 inventory):
//   D5 explicitly defers per-line COGS to a separate JE. After the AR JE
//   lands we invoke postShopifyOrderCogs (P11-5) as a best-effort follow-up.
//   COGS failures (insufficient inventory, missing 5000/1300 codes, etc)
//   are logged on the return shape but NOT thrown — the AR JE has already
//   persisted irreversibly and the operator can retry COGS manually via
//   POST /api/internal/shopify/post-cogs/:id.
//
// source='shopify' is stamped on the ar_invoices row per
// feedback_source_tagging_enforcement.
//
// BigInt cents throughout per project_tangerine_progress money handling.

import { postShopifyOrderCogs as defaultPostShopifyOrderCogs } from "./post-order-cogs.js";

const ZERO = 0n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the JE payload (no DB writes). Exported for unit tests.
 *
 * @param {Object} args
 * @param {Object} args.order       shopify_orders row (snake_case columns).
 * @param {Object} args.accounts    { arId, revenueId, taxId, feeId, clearingId }.
 * @param {string} args.customerId  Resolved customers.id.
 * @returns {Object}                payload for gl_post_journal_entry RPC.
 */
export function buildJournalEntryPayload({ order, accounts, customerId }) {
  const total    = toBigInt(order.total_amount_cents);
  const subtotal = toBigInt(order.subtotal_amount_cents);
  const tax      = toBigInt(order.tax_amount_cents);
  const discount = toBigInt(order.discount_amount_cents);
  const fee      = toBigInt(order.fee_amount_cents); // typically 0 from order webhook

  // Revenue = subtotal - discount (Shopify reports subtotal NET of discount
  // depending on the line shape, but their `subtotal_price` is line-level
  // net so discount may already be reflected — we treat discount as a
  // contra-revenue reduction either way).
  const revenue = subtotal - discount;
  if (revenue < ZERO) {
    throw new Error(
      `Shopify order ${order.id}: subtotal_amount_cents (${subtotal}) - ` +
      `discount_amount_cents (${discount}) is negative`,
    );
  }

  // Balance check (BigInt cents). DR = total + (fee?). CR = revenue + tax + (fee?).
  const drSum = total + (fee > ZERO ? fee : ZERO);
  const crSum = revenue + tax + (fee > ZERO ? fee : ZERO);
  if (drSum !== crSum) {
    throw new Error(
      `Shopify order ${order.id}: unbalanced JE — debits=${drSum}, credits=${crSum} ` +
      `(total=${total}, revenue=${revenue}, tax=${tax}, fee=${fee})`,
    );
  }

  const desc = `Shopify order ${order.order_number || order.shopify_order_id}`;
  const lines = [];
  let lineNo = 0;

  // DR AR
  lines.push({
    line_number: ++lineNo,
    account_id: accounts.arId,
    debit: centsToDecimal(total),
    credit: "0",
    memo: desc,
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
      memo: desc,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // CR Tax
  if (tax > ZERO) {
    if (!accounts.taxId) {
      throw new Error(
        `Shopify order ${order.id}: tax_amount_cents=${tax} but no 2200 account configured`,
      );
    }
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.taxId,
      debit: "0",
      credit: centsToDecimal(tax),
      memo: `Sales tax — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // DR Fee + CR Clearing (D6 — only when fee is known)
  if (fee > ZERO) {
    if (!accounts.feeId || !accounts.clearingId) {
      throw new Error(
        `Shopify order ${order.id}: fee_amount_cents=${fee} but 6510/1110 accounts not configured`,
      );
    }
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.feeId,
      debit: centsToDecimal(fee),
      credit: "0",
      memo: `Merchant fee — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.clearingId,
      debit: "0",
      credit: centsToDecimal(fee),
      memo: `Processor clearing — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  return {
    entity_id: order.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_invoice",
    posting_date: toDateString(order.processed_at),
    source_module: "shopify",
    source_table: "shopify_orders",
    source_id: order.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Resolve GL account ids by code. Returns a map keyed by code (string).
 * Codes that don't exist in the entity return null in the map (caller
 * decides whether that's fatal — 1200/4000 are required, the rest depend
 * on whether tax/fee are nonzero).
 *
 * @returns {Promise<{
 *   arId:string|null, revenueId:string|null, taxId:string|null,
 *   feeId:string|null, clearingId:string|null, cogsId:string|null
 * }>}
 */
export async function resolveGlAccounts(adminClient, entityId) {
  const codes = ["1200", "1201", "4000", "2200", "6510", "1110", "5000"];
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
    arId:       byCode["1200"] || byCode["1201"] || null,
    revenueId:  byCode["4000"] || null,
    taxId:      byCode["2200"] || null,
    feeId:      byCode["6510"] || null,
    clearingId: byCode["1110"] || null,
    cogsId:     byCode["5000"] || null,
  };
}

/**
 * Resolve (or create) the customer id for a shopify order.
 *
 * Strategy:
 *   1. If order.customer_id IS NOT NULL → return it.
 *   2. Else, if order.customer_email is set, try a case-insensitive match
 *      on customers.email (when the column exists). If found → return.
 *   3. Else, upsert a new customer with name = email local part,
 *      customer_type='ecom', source='shopify' (when those columns exist).
 *
 * Returns the customer id.
 */
export async function resolveCustomerId(adminClient, order) {
  if (order.customer_id) return order.customer_id;

  const email = (order.customer_email || "").trim().toLowerCase();
  if (!email) {
    throw new Error(
      `Shopify order ${order.id} has no customer_id and no customer_email — cannot resolve customer`,
    );
  }

  // Probe whether customers has an email column. We tolerate either schema;
  // the canonical Tangerine customers table (P1 promote) does NOT have email,
  // so this falls through to upsert-by-code.
  const code = `SHOPIFY-${email}`.slice(0, 64);
  const namePart = email.split("@")[0] || email;

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

  // Build the insert. Include 'source' only if the caller's schema accepts
  // it; the insert may reject unknown columns. We pass the full set and let
  // PostgREST surface 400 if it can't fit. The promoted customers table has
  // code, name, customer_type, status — those are guaranteed.
  const insertRow = {
    entity_id: order.entity_id,
    code,
    name: namePart,
    customer_type: "ecom",
    status: "active",
  };
  // Best-effort source tag — silently ignored if column doesn't exist
  // (Supabase / PostgREST will surface the error and we'll fall back).
  insertRow.source = "shopify";

  const { data: inserted, error: insErr } = await adminClient
    .from("customers")
    .insert(insertRow)
    .select("id")
    .single();
  if (insErr) {
    // Race: another concurrent call may have inserted the same code.
    // Retry the lookup once before bubbling.
    const { data: retry } = await adminClient
      .from("customers")
      .select("id")
      .eq("entity_id", order.entity_id)
      .eq("code", code)
      .maybeSingle();
    if (retry?.id) return retry.id;

    // Strip the source column and retry insert — covers the case where
    // T10-1 source-tagging hasn't reached customers yet. Build a fresh
    // object so the original (with source) is preserved for any test/log
    // that captured a reference.
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
 * Build the ar_invoices insert row from a shopify_orders row + a freshly
 * posted JE id. Exported for tests.
 */
export function buildArInvoiceRow({ order, customerId, accounts, jeId }) {
  return {
    entity_id: order.entity_id,
    customer_id: customerId,
    invoice_number: `SHOPIFY-${order.order_number || order.shopify_order_id}`,
    invoice_kind: "customer_invoice",
    gl_status: "sent",
    invoice_date: toDateString(order.processed_at),
    posting_date: toDateString(order.processed_at),
    ar_account_id: accounts.arId,
    revenue_account_id: accounts.revenueId,
    accrual_je_id: jeId,
    total_amount_cents: toBigInt(order.total_amount_cents).toString(),
    paid_amount_cents: "0",
    description: `Shopify order ${order.order_number || order.shopify_order_id}`,
    source: "shopify",
  };
}

/**
 * Main entry point — post the AR JE for a shopify_orders row.
 *
 * @param {Object} args
 * @param {string} args.shopifyOrderId      UUID of shopify_orders.id.
 * @param {Object} args.adminClient         Supabase service-role client.
 * @param {Object} [args.deps]              Test injection.
 *   @param {(a)=>Promise<*>} [args.deps.postShopifyOrderCogs]
 * @returns {Promise<
 *   {status:'already_posted', je_id:string} |
 *   {status:'posted', je_id:string, ar_invoice_id:string, cogs?:Object}
 * >}
 */
export async function postShopifyOrderJe({ shopifyOrderId, adminClient, deps = {} }) {
  if (!shopifyOrderId || !UUID_RE.test(String(shopifyOrderId))) {
    throw new Error("shopifyOrderId must be a uuid");
  }
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }

  // 1. Read shopify_orders row.
  const { data: order, error: orderErr } = await adminClient
    .from("shopify_orders")
    .select("*")
    .eq("id", shopifyOrderId)
    .maybeSingle();
  if (orderErr) {
    throw new Error(`shopify_orders lookup failed: ${orderErr.message}`);
  }
  if (!order) {
    const e = new Error(`shopify_orders ${shopifyOrderId} not found`);
    e.code = "not_found";
    throw e;
  }

  // 2. Idempotency.
  if (order.je_id) {
    return { status: "already_posted", je_id: order.je_id };
  }

  // 3. Resolve customer.
  let customerId;
  try {
    customerId = await resolveCustomerId(adminClient, order);
  } catch (e) {
    const wrapped = new Error(`customer resolution failed: ${e.message}`);
    wrapped.code = "customer_resolution_failed";
    throw wrapped;
  }

  // 4. Resolve GL accounts.
  const accounts = await resolveGlAccounts(adminClient, order.entity_id);
  const missing = [];
  if (!accounts.arId)      missing.push("1200 (or 1201) — AR");
  if (!accounts.revenueId) missing.push("4000 — Revenue");
  if (toBigInt(order.tax_amount_cents) > ZERO && !accounts.taxId) {
    missing.push("2200 — Sales Tax Payable");
  }
  if (toBigInt(order.fee_amount_cents) > ZERO) {
    if (!accounts.feeId)      missing.push("6510 — Merchant Fees");
    if (!accounts.clearingId) missing.push("1110 — Payment Processor Clearing");
  }
  if (missing.length > 0) {
    const e = new Error(`Missing GL accounts: ${missing.join(", ")}`);
    e.code = "gl_accounts_missing";
    throw e;
  }

  // 5. Build + post JE.
  const payload = buildJournalEntryPayload({ order, accounts, customerId });
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

  // 6. Create ar_invoices row.
  const arInvoiceRow = buildArInvoiceRow({ order, customerId, accounts, jeId });
  const { data: arInvoice, error: arInsErr } = await adminClient
    .from("ar_invoices")
    .insert(arInvoiceRow)
    .select("id")
    .single();
  if (arInsErr) {
    // JE is posted but invoice didn't write — surface the error so the
    // operator can manually clean up. Don't try to reverse the JE here
    // (operator decides). Stamp je_id on shopify_orders so we know which
    // JE is dangling.
    await adminClient
      .from("shopify_orders")
      .update({ je_id: jeId })
      .eq("id", shopifyOrderId);
    const e = new Error(
      `ar_invoices insert failed (JE ${jeId} posted but invoice not created): ${arInsErr.message}`,
    );
    e.code = "ar_invoice_insert_failed";
    e.je_id = jeId;
    throw e;
  }

  // 7. Stamp shopify_orders with both pointers.
  const { error: updErr } = await adminClient
    .from("shopify_orders")
    .update({ je_id: jeId, ar_invoice_id: arInvoice.id })
    .eq("id", shopifyOrderId);
  if (updErr) {
    // Same logic as above — JE + invoice both posted; only the back-pointer
    // failed. Surface but caller can treat as recoverable.
    const e = new Error(
      `shopify_orders update failed (JE ${jeId} + invoice ${arInvoice.id} posted): ${updErr.message}`,
    );
    e.code = "shopify_orders_update_failed";
    e.je_id = jeId;
    e.ar_invoice_id = arInvoice.id;
    throw e;
  }

  // 8. Best-effort COGS follow-up (P11-5). Failure here MUST NOT throw —
  //    the AR JE has already persisted and is irreversible at this point.
  //    Operator can retry via /api/internal/shopify/post-cogs/:id.
  const postCogs = deps.postShopifyOrderCogs || defaultPostShopifyOrderCogs;
  let cogsResult = null;
  let cogsError = null;
  try {
    cogsResult = await postCogs({
      shopifyOrderId,
      adminClient,
    });
  } catch (e) {
    cogsError = {
      message: e instanceof Error ? e.message : String(e),
      code: e?.code || null,
      line_errors: e?.line_errors || undefined,
    };
    // Best-effort log — console is the only surface available to a pure
    // service function. The cron / manual handler also surfaces the AR
    // success cleanly to the caller.
    // eslint-disable-next-line no-console
    console.warn(
      `[shopify P11-5] COGS post failed for ${shopifyOrderId} (AR JE ${jeId} already persisted):`,
      cogsError.message,
    );
  }

  return {
    status: "posted",
    je_id: jeId,
    ar_invoice_id: arInvoice.id,
    cogs: cogsResult || (cogsError ? { error: cogsError } : null),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (exported for unit tests).
// ────────────────────────────────────────────────────────────────────────

/**
 * Coerce a value into a non-negative BigInt cents amount. Accepts
 * bigint / number (must be safe integer) / string. Null/undefined → 0n.
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
