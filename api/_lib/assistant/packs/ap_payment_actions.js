// P28-4-4 capability pack — AP payment (the second MONEY draft action; CEO
// decision D3 = AP payments ARE in v1).
//
// ONE action: draft_ap_payment. The assistant proposes paying a specific,
// posted, still-open AP invoice. On operator Confirm the payment routes through
// the EXACT existing human AP-pay path (api/_handlers/internal/ap-invoices/
// pay.js): it runs the SAME requestIfRequired({kind:"ap_payment"}) gate, so
// anything at or above the approval threshold is HELD as a pending approval for
// a DIFFERENT authorized user to approve (maker-checker), and only below-
// threshold payments execute immediately via the shared executeApPayment
// service. No new payment engine, no second approvals path, threshold never
// lowered — arch doc §7 action (b/AP) / §5.3.
//
// Two house rules are structural here:
//   1. NEVER propose paying a settled or nonexistent invoice. The invoice must
//      exist, be gl_status='posted' (payable — 'paid' is rejected), and have a
//      positive open balance; otherwise there is NO commit_payload, so there is
//      nothing to confirm.
//   2. The payment body is built + validated by REUSING the real handler
//      validator (validatePay), not a re-implementation; commit re-loads +
//      re-guards the invoice and calls the shared executeApPayment.
// created_by = the confirming operator (ctx.userId), so self-approval is
// structurally impossible (decide() refuses approve when created_by == approver).

import { requestIfRequired, resolveSteps } from "../../approvals/index.js";
import { resolveEntityId } from "../context.js";
import {
  validatePay,
  executeApPayment,
} from "../../../_handlers/internal/ap-invoices/pay.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v.trim());
const METHODS = ["ach", "wire", "check", "credit_card", "cash"];

/** Dollars from integer cents, US format. */
function usd(cents) {
  const n = (Number(cents) || 0) / 100;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Coerce a possibly-string/bigint cents value to a Number (0 on garbage). */
function centsNum(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}

/** Human method label (no decorative styling). */
function methodLabel(m) {
  switch (m) {
    case "ach": return "ACH";
    case "wire": return "wire";
    case "check": return "check";
    case "credit_card": return "credit card";
    case "cash": return "cash";
    default: return String(m || "");
  }
}

/** YYYY-MM-DD → MM/DD/YYYY for operator-facing text (guide-wide convention). */
function usDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || "");
}

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    invoice_number: { type: "string", description: "The AP bill / invoice NUMBER to pay (preferred — e.g. 'BILL-4471'). Give this or invoice_id." },
    invoice_id: { type: "string", description: "The invoice's id, if you already have it from a prior lookup (a uuid). Prefer invoice_number." },
    amount_cents: { type: "integer", minimum: 1, description: "Amount to pay, in integer cents. Omit to pay the full open balance." },
    method: { type: "string", enum: METHODS, description: "Payment method (defaults to ACH)." },
    payment_date: { type: "string", description: "Payment date, YYYY-MM-DD (defaults to today)." },
  },
  required: [],
};

// Columns we need from an AP invoice (the invoices table is the AP register).
const INV_COLS =
  "id, entity_id, invoice_number, vendor_id, gl_status, total_amount_cents, paid_amount_cents";

/** Load the target invoice by id (preferred if a uuid was given) or number,
 *  scoped to the entity. Returns the row or null. */
async function loadInvoice(admin, entityId, { invoiceId, invoiceNumber }) {
  if (isUuid(invoiceId)) {
    const { data, error } = await admin
      .from("invoices").select(INV_COLS).eq("id", invoiceId.trim()).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }
  if (invoiceNumber) {
    const { data, error } = await admin
      .from("invoices").select(INV_COLS)
      .eq("entity_id", entityId).eq("invoice_number", invoiceNumber).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }
  return null;
}

const draftApPayment = {
  name: "draft_ap_payment",
  label: "Draft an AP payment",
  // The human pay route is /api/internal/ap-invoices/:id/pay → routePermissionFor
  // resolves segment "ap-invoices" → module "ap_invoices" and the /pay suffix →
  // action "post" (ap_invoices is POSTABLE: read/write/post/void/export). Paying
  // an AP invoice is a post-grade action, so this action gates on
  // ap_invoices:post — the honest gate the real route resolves to (mirrors how
  // je_actions chose je_post:post). Re-checked authoritatively at confirm.
  module_key: "ap_invoices",
  required_action: "post",
  mode: "write_confirm",
  description:
    "Propose paying a specific, posted, still-open AP invoice (by its invoice number). " +
    "Confirming pays it through the normal AP path — anything at or above the approval threshold is held " +
    "for a different authorized user to approve. Never proposes paying a settled or nonexistent invoice.",
  input_schema: INPUT_SCHEMA,

  // MODEL-REACHABLE, read-only. Resolves + guards the invoice; returns a
  // commit_payload ONLY when the invoice is real, payable and has open balance.
  async preview(admin, input, ctx) {
    const entityId = await resolveEntityId(admin, ctx?.entityId || null);
    if (!entityId) {
      return { summary: "No active accounting entity is configured, so a payment cannot be drafted.", warnings: ["no_entity"] };
    }

    const invoiceNumber = (input?.invoice_number || "").toString().trim();
    const invoiceId = (input?.invoice_id || "").toString().trim();
    if (!invoiceNumber && !invoiceId) {
      return { summary: "Which bill should I pay? Give me the invoice number.", warnings: ["missing_invoice"] };
    }
    if (invoiceId && !isUuid(invoiceId)) {
      return { summary: "That does not look like a valid invoice reference — give me the invoice number.", warnings: ["bad_input"] };
    }

    const invoice = await loadInvoice(admin, entityId, { invoiceId, invoiceNumber });
    // NEVER invent an invoice: unknown → propose nothing.
    if (!invoice) {
      const ref = invoiceNumber || "that invoice";
      return { summary: `I can't find AP invoice ${ref} — nothing was drafted (I won't invent a bill to pay).`, warnings: ["not_found"] };
    }

    const ref = invoice.invoice_number || "this bill";

    // NEVER propose paying a settled invoice.
    if (invoice.gl_status === "paid") {
      return { summary: `Invoice ${ref} is already fully paid — nothing to pay.`, warnings: ["already_paid"] };
    }
    // The human pay handler only pays invoices in gl_status='posted' (it also
    // accepts 'paid' but immediately rejects it). Anything else (draft,
    // pending_approval, void) is not payable.
    if (invoice.gl_status !== "posted") {
      return { summary: `Invoice ${ref} is not payable yet (status ${invoice.gl_status}). It has to be posted first.`, warnings: ["not_payable"] };
    }

    const total = centsNum(invoice.total_amount_cents);
    const paid = centsNum(invoice.paid_amount_cents);
    const openBalance = total - paid;
    if (openBalance <= 0) {
      return { summary: `Invoice ${ref} has no open balance left — nothing to pay.`, warnings: ["already_settled"] };
    }

    // Amount: operator override (must be > 0 and within the open balance), else
    // the full open balance. Never propose an overpayment (the DB trigger would
    // reject it anyway — we refuse it up front).
    let amountCents = openBalance;
    if (input?.amount_cents != null && input.amount_cents !== "") {
      const a = centsNum(input.amount_cents);
      if (!Number.isInteger(a) || a <= 0) {
        return { summary: `The amount to pay must be a whole number of cents greater than zero.`, warnings: ["invalid_amount"] };
      }
      if (a > openBalance) {
        return { summary: `That amount (${usd(a)}) is more than the ${usd(openBalance)} open on invoice ${ref} — I won't overpay a bill.`, warnings: ["overpayment"] };
      }
      amountCents = a;
    }

    const method = (input?.method || "ach").toString().trim();
    if (!METHODS.includes(method)) {
      return { summary: `Payment method must be one of ${METHODS.join(", ")}.`, warnings: ["bad_method"] };
    }

    const paymentDate = (input?.payment_date || "").toString().trim() || (ctx?.todayISO || "").toString().trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      return { summary: "Payment date must be a real date (YYYY-MM-DD).", warnings: ["bad_payment_date"] };
    }

    // Reuse the REAL handler validator so a malformed payment is caught HERE.
    const v = validatePay({
      payment_date: paymentDate,
      amount_cents: amountCents,
      method,
    });
    if (v.error) {
      return { summary: `That payment can't be recorded: ${v.error}. Nothing was drafted.`, warnings: ["invalid_payment"] };
    }

    // Vendor name for the operator-facing summary (never its id).
    let vendorName = "";
    if (invoice.vendor_id) {
      try {
        const { data: vend } = await admin
          .from("vendors").select("name, vendor_code").eq("id", invoice.vendor_id).maybeSingle();
        vendorName = (vend?.name || vend?.vendor_code || "").toString().trim();
      } catch { vendorName = ""; }
    }
    const vendorClause = vendorName ? `${vendorName} ` : "";

    // Predict whether the approval threshold will hold this — SAME matcher the
    // commit routes through (kind ap_payment, source_kind ap_payment). Advisory
    // only; commit does the authoritative routing.
    let willHold = null;
    let thresholdCents = null;
    try {
      const { data: rules } = await admin
        .from("approval_rules")
        .select("id, match, steps")
        .eq("entity_id", entityId)
        .eq("kind", "ap_payment")
        .eq("is_active", true);
      const { matched } = resolveSteps(rules || [], { amount_cents: amountCents, source_kind: "ap_payment" });
      willHold = matched.length > 0;
      const mins = (rules || [])
        .map((r) => Number(r?.match?.min_amount_cents))
        .filter((x) => Number.isFinite(x));
      if (mins.length) thresholdCents = Math.min(...mins);
    } catch { willHold = null; }

    const thr = thresholdCents != null ? usd(thresholdCents) : "$5,000";
    let approvalClause;
    if (willHold === true) {
      approvalClause = `This is at or above the ${thr} approval threshold, so confirming submits it for approval — a different authorized user must approve it before it pays.`;
    } else if (willHold === false) {
      approvalClause = `This is below the ${thr} approval threshold, so confirming pays it immediately.`;
    } else {
      approvalClause = `Anything at or above the ${thr} approval threshold is held for a different authorized user to approve.`;
    }

    return {
      summary: `Pay invoice ${vendorClause}#${ref} — ${usd(amountCents)} via ${methodLabel(method)} on ${usDate(paymentDate)}. ${approvalClause}`,
      commit_payload: {
        invoice_id: invoice.id,
        payment_date: v.data.payment_date,
        amount_cents: v.data.amount_cents, // decimal-free integer-cents STRING
        method: v.data.method,
        bank_account_id: v.data.bank_account_id, // null → server default at execute
      },
      warnings: willHold === true ? ["requires_approval"] : [],
    };
  },

  // NEVER model-reachable. Runs only behind the authenticated confirm endpoint,
  // after token verify + authoritative RBAC + single-use jti reserve. Routes the
  // payment through the EXACT human AP-pay gate + service.
  async commit(admin, commitPayload, ctx) {
    const entityId = ctx?.entityId;
    if (!entityId) return { status: 400, body: { error: "missing_entity" } };

    const invoiceId = (commitPayload?.invoice_id || "").toString().trim();
    if (!isUuid(invoiceId)) return { status: 400, body: { error: "bad_commit_payload" } };

    // Re-load + re-guard the invoice (guards a race where it was paid, voided,
    // or reopened between preview and confirm). The invoice must STILL be a
    // posted, open payable belonging to this entity.
    const { data: invoice, error } = await admin
      .from("invoices").select("*").eq("id", invoiceId).maybeSingle();
    if (error) return { status: 500, body: { error: error.message } };
    if (!invoice) return { status: 404, body: { error: "invoice_not_found" } };
    if (invoice.entity_id !== entityId) return { status: 409, body: { error: "invoice_entity_mismatch" } };
    if (invoice.gl_status === "paid") return { status: 409, body: { error: "invoice_already_paid" } };
    if (invoice.gl_status !== "posted") return { status: 409, body: { error: `invoice_not_payable` } };

    // The confirming operator is the MAKER. created_by = ctx.userId ⇒ decide()
    // refuses to let them approve their own request (self_approval_forbidden).
    const makerAuthId = ctx?.userId || null;

    // Re-validate the payment body via the REAL handler validator, injecting the
    // maker identity. preview==commit is already enforced by the token hash, but
    // we never hand an unvalidated body to the payment path.
    const v = validatePay({
      payment_date: commitPayload?.payment_date,
      amount_cents: commitPayload?.amount_cents,
      method: commitPayload?.method,
      bank_account_id: commitPayload?.bank_account_id || undefined,
      created_by_user_id: makerAuthId || undefined,
    });
    if (v.error) return { status: 400, body: { error: v.error } };

    // Never overpay: the amount must still fit inside the open balance.
    const openBalance = centsNum(invoice.total_amount_cents) - centsNum(invoice.paid_amount_cents);
    if (openBalance <= 0) return { status: 409, body: { error: "invoice_already_settled" } };
    if (centsNum(v.data.amount_cents) > openBalance) {
      return { status: 409, body: { error: "amount_exceeds_open_balance" } };
    }

    // Maker/checker gate — the EXACT ctx the human AP pay handler passes. If an
    // active rule matches the payment amount, HOLD the payment and open an
    // approval_request instead of writing invoice_payments or the ledger; the
    // payment executes only once a DIFFERENT authorized user approves (decide.js
    // ap_payment hook replays this snapshot). We do NOT lower or bypass the
    // threshold. The payload mirrors pay.js exactly so the decide hook can
    // execute the held payment on approval.
    let gate;
    try {
      gate = await requestIfRequired(admin, {
        kind: "ap_payment",
        entity_id: invoice.entity_id,
        context_table: "invoices",
        context_id: invoice.id,
        amount_cents: centsNum(v.data.amount_cents),
        currency: "USD",
        source_kind: "ap_payment",
        payload: {
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number ?? null,
          vendor_id: invoice.vendor_id ?? null,
          payment_date: v.data.payment_date,
          amount_cents: v.data.amount_cents,
          bank_account_id: v.data.bank_account_id,
          method: v.data.method,
          reference: v.data.reference,
          notes: v.data.notes,
          created_by_user_id: makerAuthId,
        },
        created_by_user_id: makerAuthId,
      });
    } catch (e) {
      return { status: 500, body: { error: `Approval routing failed: ${e instanceof Error ? e.message : String(e)}` } };
    }

    if (gate.required) {
      return {
        status: 202,
        body: {
          requires_approval: true,
          approval_request_id: gate.request_id,
          status: "pending_approval",
          message:
            "This payment is at or above the approval threshold. It was submitted for approval — a different authorized user must approve it before it pays.",
        },
      };
    }

    // Below threshold — pay immediately through the shared service (identical to
    // the human handler's below-threshold branch).
    const result = await executeApPayment(admin, { invoice, params: v.data });
    return { status: result.status, body: result.body };
  },
};

export default {
  key: "ap_payment_actions",
  label: "AP payment actions",
  module_keys: ["ap_invoices"],
  panels: {},
  actions: [draftApPayment],
};
