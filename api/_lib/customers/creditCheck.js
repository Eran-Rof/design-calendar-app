// api/_lib/customers/creditCheck.js
//
// Tangerine P4-7 — customer credit-limit check used by the AR posting gate.
//
// Given a customer + a proposed AR invoice amount (cents), compute:
//   - the customer's current open AR balance (excluding the in-flight invoice)
//   - whether (open + proposed) would exceed credit_limit_cents
//
// Treats credit_limit_cents IS NULL or 0 as "no limit".

const OPEN_STATUSES = ["sent", "partial_paid", "posted_historical"];

/**
 * @param {Object} supabase   service-role client
 * @param {Object} ctx
 * @param {string} ctx.customer_id
 * @param {string} [ctx.exclude_invoice_id]  Skip this invoice from the open-balance sum
 * @param {number|bigint|string} ctx.proposed_amount_cents
 * @returns {Promise<{
 *   would_breach: boolean,
 *   credit_limit_cents: number,            // 0 means no limit
 *   credit_limit_currency: string|null,
 *   current_open_cents: number,
 *   projected_balance_cents: number,       // open + proposed
 *   breach_amount_cents: number,           // projected - limit (or 0)
 * }>}
 */
export async function checkCreditLimit(supabase, ctx) {
  if (!supabase) throw new Error("checkCreditLimit: supabase client required");
  if (!ctx || typeof ctx !== "object") throw new Error("checkCreditLimit: ctx required");
  if (!ctx.customer_id) throw new Error("checkCreditLimit: customer_id required");

  const proposed = toIntCents(ctx.proposed_amount_cents, "proposed_amount_cents");
  if (proposed < 0) throw new Error("checkCreditLimit: proposed_amount_cents must be >= 0");

  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .select("id, credit_limit_cents, credit_limit_currency")
    .eq("id", ctx.customer_id)
    .maybeSingle();
  if (custErr) throw new Error(`checkCreditLimit: customer fetch failed: ${custErr.message}`);
  if (!customer) throw new Error(`checkCreditLimit: customer ${ctx.customer_id} not found`);

  const limit = Number(customer.credit_limit_cents ?? 0);
  const currency = customer.credit_limit_currency ?? null;

  // Sum open AR balance for this customer. Excludes drafts, voided, reversed.
  // Optionally excludes the in-flight invoice (so the check is "what would
  // happen if THIS invoice was added to the existing exposure").
  let q = supabase
    .from("ar_invoices")
    .select("id, total_amount_cents, paid_amount_cents", { count: "exact" })
    .eq("customer_id", ctx.customer_id)
    .in("gl_status", OPEN_STATUSES);
  if (ctx.exclude_invoice_id) q = q.neq("id", ctx.exclude_invoice_id);

  const { data: rows, error: invErr } = await q;
  if (invErr) throw new Error(`checkCreditLimit: open-balance query failed: ${invErr.message}`);

  let openCents = 0;
  for (const r of rows || []) {
    const total = Number(r.total_amount_cents ?? 0);
    const paid = Number(r.paid_amount_cents ?? 0);
    const balance = total - paid;
    if (balance > 0) openCents += balance;
  }

  return computeBreach({
    credit_limit_cents: limit,
    credit_limit_currency: currency,
    current_open_cents: openCents,
    proposed_amount_cents: proposed,
  });
}

/**
 * Pure-function breach computation. Exported separately for testing without
 * a supabase mock.
 *   credit_limit_cents === 0 or null → would_breach is always false
 *   projected_balance > limit       → would_breach=true
 */
export function computeBreach({
  credit_limit_cents,
  credit_limit_currency,
  current_open_cents,
  proposed_amount_cents,
}) {
  const limit = Number(credit_limit_cents ?? 0);
  const open = Number(current_open_cents ?? 0);
  const proposed = Number(proposed_amount_cents ?? 0);
  const projected = open + proposed;

  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      would_breach: false,
      credit_limit_cents: 0,
      credit_limit_currency: credit_limit_currency ?? null,
      current_open_cents: open,
      projected_balance_cents: projected,
      breach_amount_cents: 0,
    };
  }

  const breach = projected - limit;
  return {
    would_breach: breach > 0,
    credit_limit_cents: limit,
    credit_limit_currency: credit_limit_currency ?? null,
    current_open_cents: open,
    projected_balance_cents: projected,
    breach_amount_cents: breach > 0 ? breach : 0,
  };
}

function toIntCents(v, name) {
  if (v == null || v === "") return 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`checkCreditLimit: ${name} must be integer cents (got ${v})`);
    }
    return v;
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) {
      throw new Error(`checkCreditLimit: ${name} must be integer cents string (got ${v})`);
    }
    return Number(v);
  }
  throw new Error(`checkCreditLimit: ${name} must be number|string|bigint (got ${typeof v})`);
}
