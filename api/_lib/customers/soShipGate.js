// api/_lib/customers/soShipGate.js
//
// Non-factor Sales-Order ship-gates. Two gates apply ONLY to NON-factored
// customers (factored customers are owned by the separate factor_approval_status
// gate — see api/_handlers/internal/sales-orders/[id].js + ship.js + the
// allocate_sales_order RPC — and are intentionally skipped here):
//
//   1. House-account gate (customer on net/credit terms, not factored):
//      activates when the customer has ANY open AR invoice past its due_date
//      (outstanding balance > 0 AND due_date < today). → capture-but-hold.
//
//   2. Credit-card gate (SO payment_terms.code === 'CREDIT_CARD'):
//      the order cannot ship until payment in full is recorded
//      (amount_paid_cents >= total_cents).
//
// HIGH-STAKES: these gates BLOCK shipping. They are written conservatively —
// a customer who matches NO gate (cash/COD, no overdue AR, fully paid card) is
// always cleared, and any data ambiguity errs toward NOT blocking the existing
// flow (the house-account query failing is surfaced, not silently treated as a
// breach).
//
// AR open-status set + outstanding/overdue definition mirror the AR aging views
// (v_ar_aging / ar_aging_as_of in 20260528100000_p4_chunk1_ar_schema.sql):
//   open  := gl_status IN ('sent','partial_paid','posted','posted_historical')
//   open balance := total_amount_cents - paid_amount_cents > 0
//   overdue := due_date IS NOT NULL AND due_date < today

// AR statuses that still carry a collectible balance (an un-cleared receivable).
// Drafts/unposted/pending_approval are not yet owed; paid/void/reversed are done.
export const OPEN_AR_STATUSES = ["sent", "partial_paid", "posted", "posted_historical"];

/**
 * Today's date as a YYYY-MM-DD string (UTC). Isolated so tests can stub it.
 * @returns {string}
 */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * House-account overdue-AR check. Returns whether the customer has any OPEN AR
 * invoice that is past due (outstanding balance > 0 AND due_date < today).
 *
 * This is an overdue-AR gate — it does NOT depend on a credit limit being set.
 *
 * @param {Object} admin   service-role supabase client
 * @param {Object} ctx
 * @param {string} ctx.customer_id
 * @param {string} [ctx.entity_id]   scope the AR lookup to one entity when known
 * @param {string} [ctx.today]       override "today" (YYYY-MM-DD); defaults to UTC now
 * @returns {Promise<{ overdue: boolean, count: number, overdue_cents: number, oldest_due_date: string|null }>}
 * @throws if the AR query errors (caller decides how to surface — we never
 *         silently treat a failed lookup as "no overdue").
 */
export async function houseAccountOverdue(admin, ctx) {
  if (!admin) throw new Error("houseAccountOverdue: admin client required");
  if (!ctx || !ctx.customer_id) throw new Error("houseAccountOverdue: customer_id required");
  const today = ctx.today || todayIso();

  let q = admin
    .from("ar_invoices")
    .select("id, total_amount_cents, paid_amount_cents, due_date")
    .eq("customer_id", ctx.customer_id)
    .in("gl_status", OPEN_AR_STATUSES)
    .not("due_date", "is", null)
    .lt("due_date", today);
  if (ctx.entity_id) q = q.eq("entity_id", ctx.entity_id);

  const { data: rows, error } = await q;
  if (error) throw new Error(`houseAccountOverdue: AR query failed: ${error.message}`);

  let count = 0;
  let overdueCents = 0;
  let oldest = null;
  for (const r of rows || []) {
    const balance = Number(r.total_amount_cents ?? 0) - Number(r.paid_amount_cents ?? 0);
    if (balance > 0) {
      count += 1;
      overdueCents += balance;
      if (r.due_date && (oldest === null || r.due_date < oldest)) oldest = r.due_date;
    }
  }

  return { overdue: count > 0, count, overdue_cents: overdueCents, oldest_due_date: oldest };
}

/**
 * Credit-card gate predicate (pure). True when the SO is on CREDIT_CARD terms
 * and has NOT yet been paid in full.
 *
 * @param {Object} so           sales_orders row (needs total_cents, amount_paid_cents)
 * @param {Object|null} term     payment_terms row (needs code) for the SO's payment_terms_id
 * @returns {boolean}
 */
export function creditCardUnpaid(so, term) {
  if (!so || !term) return false;
  if (term.code !== "CREDIT_CARD") return false;
  const paid = Number(so.amount_paid_cents ?? 0);
  const total = Number(so.total_cents ?? 0);
  return paid < total;
}

/**
 * Classify which (if any) non-factor credit gate applies to an SO.
 *
 *   "factor"        → factored customer; this module does NOT gate it (the
 *                      factor_approval_status gate owns it). Caller skips.
 *   "credit_card"   → SO on CREDIT_CARD terms; the pay-in-full gate applies.
 *   "house_account" → not factored, on net terms (due_days > 0); overdue-AR gate.
 *   "none"          → cash/COD/no terms and not factored; no credit gate.
 *
 * @param {Object} args
 * @param {boolean} args.is_factored   customer.is_factored
 * @param {Object|null} args.term      payment_terms row (code, due_days) or null
 * @returns {"factor"|"credit_card"|"house_account"|"none"}
 */
export function classifyGate({ is_factored, term }) {
  if (is_factored === true) return "factor";
  if (term && term.code === "CREDIT_CARD") return "credit_card";
  // Net/credit terms = a due_days > 0 term (Net 10/30/60…). COD / Due-on-receipt
  // (due_days 0) are pay-on-delivery and carry no house-account credit exposure.
  if (term && Number(term.due_days ?? 0) > 0) return "house_account";
  return "none";
}

/**
 * High-level evaluation used by the SO handlers. Resolves the customer's
 * is_factored flag and the SO's payment term, classifies the gate, and (for the
 * house-account gate) runs the overdue-AR lookup. Pure orchestration over the
 * helpers above so the wiring in the handlers stays terse.
 *
 * Returns a decision object — it never throws for "no gate"; it DOES propagate
 * a thrown error from the AR lookup so the caller can decide (the SO handlers
 * surface it rather than silently allowing a ship).
 *
 * @param {Object} admin     service-role client
 * @param {Object} so        sales_orders row (customer_id, entity_id, payment_terms_id, total_cents, amount_paid_cents)
 * @param {Object} [opts]
 * @param {string} [opts.today]
 * @returns {Promise<{
 *   gate: "factor"|"credit_card"|"house_account"|"none",
 *   blocked: boolean,                 // true = must not allocate/ship (unless overridden)
 *   target_status: "not_required"|"pending"|"on_hold",  // status this gate implies at confirm
 *   reason: string|null,              // human-readable hold reason
 *   detail: Object,                   // gate-specific extras (overdue counts, amounts)
 * }>}
 */
export async function evaluateSoCreditGate(admin, so, opts = {}) {
  const today = opts.today || todayIso();

  // Resolve the customer's factored flag.
  let isFactored = false;
  if (so.customer_id) {
    const { data: cust, error: custErr } = await admin
      .from("customers").select("is_factored").eq("id", so.customer_id).maybeSingle();
    if (custErr) throw new Error(`evaluateSoCreditGate: customer lookup failed: ${custErr.message}`);
    isFactored = cust?.is_factored === true;
  }

  // Resolve the SO's payment term (code + due_days).
  let term = null;
  if (so.payment_terms_id) {
    const { data: t, error: termErr } = await admin
      .from("payment_terms").select("code, due_days").eq("id", so.payment_terms_id).maybeSingle();
    if (termErr) throw new Error(`evaluateSoCreditGate: payment_terms lookup failed: ${termErr.message}`);
    term = t || null;
  }

  const gate = classifyGate({ is_factored: isFactored, term });

  if (gate === "factor" || gate === "none") {
    return { gate, blocked: false, target_status: "not_required", reason: null, detail: {} };
  }

  if (gate === "credit_card") {
    const unpaid = creditCardUnpaid(so, term);
    return {
      gate,
      blocked: unpaid,
      target_status: unpaid ? "pending" : "not_required",
      reason: unpaid
        ? `Credit-card order — payment in full must be recorded before shipping (paid $${(Number(so.amount_paid_cents ?? 0) / 100).toFixed(2)} of $${(Number(so.total_cents ?? 0) / 100).toFixed(2)}).`
        : null,
      detail: {
        amount_paid_cents: Number(so.amount_paid_cents ?? 0),
        total_cents: Number(so.total_cents ?? 0),
      },
    };
  }

  // house_account
  const od = await houseAccountOverdue(admin, {
    customer_id: so.customer_id, entity_id: so.entity_id, today,
  });
  return {
    gate,
    blocked: od.overdue,
    target_status: od.overdue ? "on_hold" : "not_required",
    reason: od.overdue
      ? `House account on hold — ${od.count} overdue AR invoice(s) totaling $${(od.overdue_cents / 100).toFixed(2)}${od.oldest_due_date ? ` (oldest due ${od.oldest_due_date})` : ""}. Clear the overdue balance or approve the credit override before shipping.`
      : null,
    detail: od,
  };
}
