// api/_lib/marketplaces/faire/post-order-je.js
//
// Tangerine P12c-3 — Faire wholesale AR invoice JE posting service.
//
// Pure(-ish) function: given a faire_orders.id + an admin Supabase client,
// build + post the AR invoice + marketplace receivable + commission JE
// atomically, and stamp the faire_orders row with je_id + ar_invoice_id.
//
// Idempotency:
//   - If faire_orders.je_id IS NOT NULL → already posted → return
//     { status: 'already_posted', je_id }.
//   - All writes go through the gl_post_journal_entry RPC + scoped
//     post-RPC stamps. If a downstream stamp fails after the JE persists,
//     the function surfaces an error but the JE row is the authoritative
//     truth — operator can re-stamp via the manual backfill handler.
//
// JE shape (per P12 arch §3.6 + D6):
//   DR 1115 Marketplace Receivable Clearing = net_payout_cents
//   DR 6520 Marketplace Fees                = commission_cents
//   CR 4000 Revenue                         = subtotal_cents
//
// Faire is WHOLESALE so:
//   - No facilitator tax. Buyers remit tax themselves; we never see it.
//   - No shipping breakout — shipping flows through subtotal in faire_orders'
//     net_payout calc (subtotal + shipping - commission). Revenue here =
//     subtotal_cents only; shipping rides into the receivable side of the
//     ledger via net_payout. Total debits = net_payout + commission =
//     (subtotal + shipping - commission) + commission = subtotal + shipping.
//     Total credits = subtotal. To balance we credit revenue for
//     subtotal + shipping (i.e. "subtotal" in the wholesale sense includes
//     shipping reimbursement); the schema stores them split but the JE
//     collapses them into one revenue credit so debits == credits.
//
// source='faire' is stamped on the ar_invoices row per
// feedback_source_tagging_enforcement.
//
// BigInt cents throughout per project_tangerine_progress money handling.

const ZERO = 0n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the JE payload (no DB writes). Exported for unit tests.
 *
 * @param {Object} args
 * @param {Object} args.order       faire_orders row (snake_case columns).
 * @param {Object} args.accounts    { receivableId, revenueId, feeId }.
 * @param {string} args.customerId  Resolved customers.id.
 * @returns {Object}                payload for gl_post_journal_entry RPC.
 */
export function buildJournalEntryPayload({ order, accounts, customerId }) {
  const subtotal   = toBigInt(order.subtotal_cents);
  const shipping   = toBigInt(order.shipping_cents);
  const commission = toBigInt(order.commission_cents);
  const netPayout  = toBigInt(order.net_payout_cents);

  if (commission < ZERO) {
    throw new Error(
      `Faire order ${order.id}: commission_cents (${commission}) is negative`,
    );
  }
  if (netPayout < ZERO) {
    throw new Error(
      `Faire order ${order.id}: net_payout_cents (${netPayout}) is negative`,
    );
  }

  // Revenue line = subtotal + shipping (wholesale total to operator before
  // commission). net_payout + commission must equal this.
  const revenue = subtotal + shipping;

  // Balance check (BigInt cents). DR = net_payout + commission. CR = revenue.
  const drSum = netPayout + commission;
  const crSum = revenue;
  if (drSum !== crSum) {
    throw new Error(
      `Faire order ${order.id}: unbalanced JE — debits=${drSum}, credits=${crSum} ` +
      `(subtotal=${subtotal}, shipping=${shipping}, commission=${commission}, net_payout=${netPayout})`,
    );
  }

  const desc = `Faire order ${order.faire_order_id}`;
  const lines = [];
  let lineNo = 0;

  // DR 1115 Marketplace Receivable Clearing (held by Faire until monthly remit)
  lines.push({
    line_number: ++lineNo,
    account_id: accounts.receivableId,
    debit: centsToDecimal(netPayout),
    credit: "0",
    memo: `Faire receivable — ${desc}`,
    subledger_type: "customer",
    subledger_id: customerId,
  });

  // DR 6520 Marketplace Fees (commission — 25% first order / 15% recurring)
  if (commission > ZERO) {
    lines.push({
      line_number: ++lineNo,
      account_id: accounts.feeId,
      debit: centsToDecimal(commission),
      credit: "0",
      memo: `Faire commission @ ${formatRate(order.commission_rate)} — ${desc}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // CR 4000 Revenue (subtotal + shipping)
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

  return {
    entity_id: order.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_invoice",
    posting_date: toDateString(order.placed_at),
    source_module: "faire",
    source_table: "faire_orders",
    source_id: order.id,
    description: desc,
    sibling_je_id: null,
    created_by_user_id: null,
    lines,
  };
}

/**
 * Resolve GL account ids by code for the Faire order JE.
 *
 * @returns {Promise<{
 *   receivableId:string|null, revenueId:string|null, feeId:string|null
 * }>}
 */
export async function resolveGlAccounts(adminClient, entityId) {
  const codes = ["1115", "4000", "6520"];
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
    receivableId: byCode["1115"] || null,
    revenueId:    byCode["4000"] || null,
    feeId:        byCode["6520"] || null,
  };
}

/**
 * Resolve (or create) the customer id for a Faire order.
 *
 * Strategy (Faire-specific — wholesale buyers, not DTC emails):
 *   1. If order.customer_id IS NOT NULL → return it.
 *   2. If order.faire_buyer_id IS NOT NULL → read faire_buyers; if
 *      faire_buyers.customer_id is set → return it.
 *   3. Else fall through to upsert-by-code path keyed on the buyer's
 *      brand_token. The code is `FAIRE-${brand_token}` and the name is
 *      buyer_name (or buyer_email when unset). customer_type='wholesale'.
 *
 * Returns the customer id.
 */
export async function resolveCustomerId(adminClient, order) {
  if (order.customer_id) return order.customer_id;

  // Look up the buyer row to resolve customer_id + buyer name/email.
  let buyer = null;
  if (order.faire_buyer_id) {
    const { data: br, error } = await adminClient
      .from("faire_buyers")
      .select("id, customer_id, buyer_name, buyer_email, faire_brand_token")
      .eq("id", order.faire_buyer_id)
      .maybeSingle();
    if (error) {
      throw new Error(`faire_buyers lookup failed: ${error.message}`);
    }
    buyer = br;
    if (buyer?.customer_id) return buyer.customer_id;
  }

  // Need a brand_token to derive a stable customer code.
  const brandToken = buyer?.faire_brand_token || order.faire_brand_token;
  if (!brandToken) {
    throw new Error(
      `Faire order ${order.id} has no customer_id and no buyer brand_token — cannot resolve customer`,
    );
  }

  const code = `FAIRE-${brandToken}`.slice(0, 64);
  const namePart =
    buyer?.buyer_name ||
    buyer?.buyer_email ||
    `Faire buyer ${brandToken}`;

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
  if (byCode?.id) {
    // Back-fill faire_buyers.customer_id so subsequent orders short-circuit.
    if (buyer?.id) {
      await adminClient
        .from("faire_buyers")
        .update({ customer_id: byCode.id, updated_at: new Date().toISOString() })
        .eq("id", buyer.id);
    }
    return byCode.id;
  }

  // Insert a new wholesale customer. Best-effort source tag — silently
  // ignored if column doesn't exist (we retry without it on failure).
  const insertRow = {
    entity_id: order.entity_id,
    code,
    name: namePart,
    customer_type: "wholesale",
    status: "active",
    source: "faire",
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
    if (retry?.id) {
      if (buyer?.id) {
        await adminClient
          .from("faire_buyers")
          .update({ customer_id: retry.id, updated_at: new Date().toISOString() })
          .eq("id", buyer.id);
      }
      return retry.id;
    }

    // Strip the source column and retry insert.
    if (insertRow.source) {
      const retryRow = { ...insertRow };
      delete retryRow.source;
      const { data: retry2, error: insErr2 } = await adminClient
        .from("customers")
        .insert(retryRow)
        .select("id")
        .single();
      if (!insErr2 && retry2?.id) {
        if (buyer?.id) {
          await adminClient
            .from("faire_buyers")
            .update({ customer_id: retry2.id, updated_at: new Date().toISOString() })
            .eq("id", buyer.id);
        }
        return retry2.id;
      }
    }

    throw new Error(`customers upsert failed: ${insErr.message}`);
  }
  // Back-fill faire_buyers.customer_id.
  if (buyer?.id) {
    await adminClient
      .from("faire_buyers")
      .update({ customer_id: inserted.id, updated_at: new Date().toISOString() })
      .eq("id", buyer.id);
  }
  return inserted.id;
}

/**
 * Build the ar_invoices insert row from a faire_orders row + a freshly
 * posted JE id. Exported for tests.
 */
export function buildArInvoiceRow({ order, customerId, accounts, jeId }) {
  // Total billed to receivable side = subtotal + shipping (wholesale).
  const subtotal = toBigInt(order.subtotal_cents);
  const shipping = toBigInt(order.shipping_cents);
  const total = subtotal + shipping;
  return {
    entity_id: order.entity_id,
    customer_id: customerId,
    invoice_number: `FAIRE-${order.faire_order_id}`,
    invoice_kind: "customer_invoice",
    gl_status: "sent",
    invoice_date: toDateString(order.placed_at),
    posting_date: toDateString(order.placed_at),
    ar_account_id: accounts.receivableId,
    revenue_account_id: accounts.revenueId,
    accrual_je_id: jeId,
    total_amount_cents: total.toString(),
    paid_amount_cents: "0",
    description: `Faire order ${order.faire_order_id}`,
    source: "faire",
  };
}

/**
 * Main entry point — post the AR JE for a faire_orders row.
 *
 * @param {Object} args
 * @param {string} args.faireOrderId        UUID of faire_orders.id.
 * @param {Object} args.adminClient         Supabase service-role client.
 * @returns {Promise<
 *   {status:'already_posted', je_id:string} |
 *   {status:'posted', je_id:string, ar_invoice_id:string}
 * >}
 */
export async function postFaireOrderJe({ faireOrderId, adminClient }) {
  if (!faireOrderId || !UUID_RE.test(String(faireOrderId))) {
    throw new Error("faireOrderId must be a uuid");
  }
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }

  // 1. Read faire_orders row.
  const { data: order, error: orderErr } = await adminClient
    .from("faire_orders")
    .select("*")
    .eq("id", faireOrderId)
    .maybeSingle();
  if (orderErr) {
    throw new Error(`faire_orders lookup failed: ${orderErr.message}`);
  }
  if (!order) {
    const e = new Error(`faire_orders ${faireOrderId} not found`);
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
  if (!accounts.receivableId) missing.push("1115 — Marketplace Receivable Clearing");
  if (!accounts.revenueId)    missing.push("4000 — Revenue");
  if (toBigInt(order.commission_cents) > ZERO && !accounts.feeId) {
    missing.push("6520 — Marketplace Fees");
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
    // operator can manually clean up. Stamp je_id on faire_orders so we know
    // which JE is dangling.
    await adminClient
      .from("faire_orders")
      .update({ je_id: jeId, updated_at: new Date().toISOString() })
      .eq("id", faireOrderId);
    const e = new Error(
      `ar_invoices insert failed (JE ${jeId} posted but invoice not created): ${arInsErr.message}`,
    );
    e.code = "ar_invoice_insert_failed";
    e.je_id = jeId;
    throw e;
  }

  // 7. Stamp faire_orders with both pointers.
  const { error: updErr } = await adminClient
    .from("faire_orders")
    .update({
      je_id: jeId,
      ar_invoice_id: arInvoice.id,
      customer_id: customerId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", faireOrderId);
  if (updErr) {
    const e = new Error(
      `faire_orders update failed (JE ${jeId} + invoice ${arInvoice.id} posted): ${updErr.message}`,
    );
    e.code = "faire_orders_update_failed";
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
 * Coerce a value into a BigInt cents amount. Accepts
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

/**
 * Format a numeric(5,4) commission rate (0.2500 or 0.1500) as a percent
 * string for the JE memo. Exported for tests.
 */
export function formatRate(rate) {
  if (rate == null) return "0%";
  const n = typeof rate === "number" ? rate : Number(rate);
  if (!Number.isFinite(n)) return "0%";
  return `${(n * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
