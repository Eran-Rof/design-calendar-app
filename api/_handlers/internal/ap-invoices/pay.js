// api/internal/ap-invoices/:id/pay
//
// POST — record a payment against a posted AP invoice. Inserts a row into
//        invoice_payments (DB triggers maintain invoices.paid_amount_cents),
//        then dispatches apInvoicePaid to post the cash + sibling JEs.
//
// Body (all required unless marked):
//   {
//     payment_date: 'YYYY-MM-DD',
//     amount_cents: bigint string or integer,
//     bank_account_id?: <uuid> (defaults to entities.default_bank_account_id),
//     method: 'ach'|'wire'|'check'|'credit_card'|'cash',
//     reference?: string,
//     notes?: string,
//     created_by_user_id?: <uuid>,
//   }
//
// Tangerine P3 Chunk 2.

import { createClient } from "@supabase/supabase-js";
import { postEvent, PostingError } from "../../../_lib/accounting/posting/index.js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";
import { requestIfRequired } from "../../../_lib/approvals/index.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ["ach", "wire", "check", "credit_card", "cash"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function findAccountByCode(admin, entityId, code) {
  const { data } = await admin
    .from("gl_accounts")
    .select("id, code, name")
    .eq("entity_id", entityId)
    .eq("code", code)
    .maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validatePay(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Load invoice
  const { data: invoice, error: invErr } = await admin
    .from("invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (invoice.gl_status !== "posted" && invoice.gl_status !== "paid") {
    return res.status(409).json({
      error: `Can only pay invoices in gl_status='posted' or 'paid' (got ${invoice.gl_status})`,
    });
  }
  if (invoice.gl_status === "paid") {
    return res.status(409).json({ error: "Invoice is already fully paid" });
  }

  // Maker identity for the segregation-of-duties gate. Body wins; else the
  // SPA-injected X-Auth-User-Id header (src/utils/internalApiAuth.ts).
  const makerAuthId = v.data.created_by_user_id || headerStr(req.headers?.["x-auth-user-id"]);

  // ── Maker/checker gate (HUMAN AP payment path only) ─────────────────────
  // The Xoro AP paid-watcher, cron reconcilers and backfill sweeps post their
  // own cash JEs directly and never call this endpoint, so they are inherently
  // exempt. If an active approval_rule matches the payment amount, hold the
  // payment and open an approval_request — nothing is written to
  // invoice_payments or the ledger until a DIFFERENT authorized user approves
  // (see decide.js ap_payment hook).
  let gate = { required: false };
  try {
    gate = await requestIfRequired(admin, {
      kind: "ap_payment",
      entity_id: invoice.entity_id,
      context_table: "invoices",
      context_id: invoice.id,
      amount_cents: Number(v.data.amount_cents),
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
    return res.status(500).json({
      error: `Approval routing failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (gate.required) {
    return res.status(202).json({
      requires_approval: true,
      approval_request_id: gate.request_id,
      status: "pending_approval",
      message:
        "This payment is at or above the approval threshold and was submitted for approval. It will post once a different authorized user approves it.",
    });
  }

  // Below threshold — execute immediately (unchanged behavior).
  const result = await executeApPayment(admin, { invoice, params: v.data });
  return res.status(result.status).json(result.body);
}

// Execute a validated AP payment against a payable invoice: insert the payment
// row, post the cash + sibling JEs, stamp pointers, and enqueue a notification.
// Shared by the direct (below threshold) handler path AND the approvals
// decide-hook (once a gated payment has been approved). `params` is validatePay
// output. Returns { status, body } so both callers can relay it.
export async function executeApPayment(admin, { invoice, params }) {
  const v = { data: params };

  // 2. Resolve bank account (default if not supplied).
  const { data: entity } = await admin
    .from("entities")
    .select("default_bank_account_id")
    .eq("id", invoice.entity_id)
    .maybeSingle();
  const bankAccountId =
    v.data.bank_account_id || entity?.default_bank_account_id ||
    (await findAccountByCode(admin, invoice.entity_id, "1010"))?.id;
  if (!bankAccountId) {
    return { status: 400, body: {
      error: "No bank account configured (supply bank_account_id or seed entities.default_bank_account_id / gl_accounts.code='1010')",
    } };
  }

  // 3. Insert the invoice_payments row. The overpay trigger guards against
  //    paid+new > total at the DB level; surface its check_violation as 409.
  const { data: payment, error: pErr } = await admin
    .from("invoice_payments")
    .insert({
      entity_id: invoice.entity_id,
      invoice_id: invoice.id,
      payment_date: v.data.payment_date,
      amount_cents: v.data.amount_cents,
      bank_account_id: bankAccountId,
      method: v.data.method,
      reference: v.data.reference,
      notes: v.data.notes,
      created_by_user_id: v.data.created_by_user_id,
    })
    .select()
    .single();
  if (pErr) {
    if (pErr.code === "23514" || /overpayment/i.test(pErr.message || "")) {
      return { status: 409, body: { error: `Overpayment rejected: ${pErr.message}` } };
    }
    return { status: 500, body: { error: pErr.message } };
  }

  // 4. Resolve ap_account and a default expense_account for the cash-basis side.
  //    The cash JE needs an expense_account; default to the invoice header's
  //    expense_account_id, else fall back to '6000' (general expenses).
  const apAccountId =
    invoice.ap_account_id ||
    (await findAccountByCode(admin, invoice.entity_id, "2010"))?.id;
  if (!apAccountId) {
    // Rollback the payment row — we can't post.
    await admin.from("invoice_payments").delete().eq("id", payment.id);
    return { status: 400, body: { error: "AP account not configured for this invoice" } };
  }
  let expenseAccountId = invoice.expense_account_id;
  if (!expenseAccountId) {
    // Pick the first line's expense account, else fallback.
    const { data: firstLine } = await admin
      .from("invoice_line_items")
      .select("expense_account_id")
      .eq("invoice_id", invoice.id)
      .not("expense_account_id", "is", null)
      .limit(1)
      .maybeSingle();
    expenseAccountId = firstLine?.expense_account_id ||
      (await findAccountByCode(admin, invoice.entity_id, "6000"))?.id ||
      null;
  }
  if (!expenseAccountId) {
    await admin.from("invoice_payments").delete().eq("id", payment.id);
    return { status: 400, body: { error: "No expense_account_id available for cash-basis JE (seed gl_accounts.code='6000' or set invoice.expense_account_id)" } };
  }

  // 5. Dispatch apInvoicePaid via postEvent (produces accrual + cash sibling JEs).
  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "ap_invoice_paid",
      entity_id: invoice.entity_id,
      created_by_user_id: v.data.created_by_user_id,
      reason: `Pay AP bill ${invoice.invoice_number ?? invoice.id}`,
      data: {
        payment_id: payment.id,
        invoice_id: invoice.id,
        vendor_id: invoice.vendor_id,
        payment_date: v.data.payment_date,
        amount: centsToDecimalStr(BigInt(v.data.amount_cents)),
        ap_account_id: apAccountId,
        cash_account_id: bankAccountId,
        expense_account_id: expenseAccountId,
        payment_reference: v.data.reference,
      },
    });
  } catch (e) {
    // The payment row is left intact (the trigger has already updated
    // invoices.paid_amount_cents). The operator can void the payment via a
    // future credit-memo flow. We return 500 with the underlying message.
    if (e instanceof PostingError) {
      return { status: 400, body: {
        error: `Payment recorded (${payment.id}) but JE posting failed: ${e.message}`,
        payment_id: payment.id,
      } };
    }
    return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
  }

  // 6. Stamp the payment + invoice with the cash JE id.
  await admin
    .from("invoice_payments")
    .update({ cash_je_id: postResult.cash_je_id })
    .eq("id", payment.id);

  // Check if this payment fully covers the invoice — if so flip gl_status='paid'.
  // Re-read trigger-maintained paid_amount_cents.
  const { data: updatedInvoice } = await admin
    .from("invoices")
    .select("id, total_amount_cents, paid_amount_cents, gl_status")
    .eq("id", invoice.id)
    .maybeSingle();
  const isFullyPaid =
    updatedInvoice &&
    BigInt(updatedInvoice.paid_amount_cents || 0) >= BigInt(updatedInvoice.total_amount_cents || 0) &&
    BigInt(updatedInvoice.total_amount_cents || 0) > 0n;

  if (isFullyPaid && updatedInvoice.gl_status !== "paid") {
    await admin
      .from("invoices")
      .update({ gl_status: "paid", cash_je_id: postResult.cash_je_id })
      .eq("id", invoice.id);
  } else if (!invoice.cash_je_id) {
    // First payment, partial — record the cash JE pointer on the invoice
    // header for navigability.
    await admin
      .from("invoices")
      .update({ cash_je_id: postResult.cash_je_id })
      .eq("id", invoice.id);
  }

  // 7. Notification
  try {
    await enqueueNotification(admin, {
      entity_id: invoice.entity_id,
      kind: "ap_invoice_paid",
      severity: "info",
      subject: `AP payment ${formatCents(v.data.amount_cents)} on invoice ${invoice.invoice_number}`,
      body: isFullyPaid
        ? `Invoice ${invoice.invoice_number} is now fully paid (${formatCents(updatedInvoice.total_amount_cents)}).`
        : `Partial payment of ${formatCents(v.data.amount_cents)} recorded on invoice ${invoice.invoice_number} (${formatCents(updatedInvoice?.paid_amount_cents || 0)} / ${formatCents(updatedInvoice?.total_amount_cents || 0)}).`,
      context_table: "invoices",
      context_id: invoice.id,
      recipient_roles: ["accountant", "admin"],
      created_by_user_id: v.data.created_by_user_id,
    });
  } catch { /* non-fatal */ }

  return { status: 200, body: {
    payment_id: payment.id,
    accrual_je_id: postResult.accrual_je_id,
    cash_je_id: postResult.cash_je_id,
    invoice_gl_status: isFullyPaid ? "paid" : "posted",
    fully_paid: !!isFullyPaid,
    paid_amount_cents: updatedInvoice?.paid_amount_cents?.toString?.() || String(updatedInvoice?.paid_amount_cents || 0),
    total_amount_cents: updatedInvoice?.total_amount_cents?.toString?.() || String(updatedInvoice?.total_amount_cents || 0),
  } };
}

// Coerce a possibly-array header value to a trimmed string (or null).
function headerStr(v) {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

export function validatePay(body) {
  if (!body.payment_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.payment_date)) {
    return { error: "payment_date must be YYYY-MM-DD" };
  }
  const amt = parseCents(body.amount_cents);
  if (amt.error) return { error: `amount_cents — ${amt.error}` };
  if (amt.value <= 0n) return { error: "amount_cents must be > 0" };
  if (!METHODS.includes(body.method)) {
    return { error: `method must be one of ${METHODS.join(", ")}` };
  }
  if (body.bank_account_id && !UUID_RE.test(String(body.bank_account_id))) {
    return { error: "bank_account_id must be a uuid" };
  }
  if (body.created_by_user_id && !UUID_RE.test(String(body.created_by_user_id))) {
    return { error: "created_by_user_id must be a uuid" };
  }

  return {
    data: {
      payment_date: body.payment_date,
      amount_cents: amt.value.toString(),
      bank_account_id: body.bank_account_id || null,
      method: body.method,
      reference: body.reference ? String(body.reference).trim() : null,
      notes: body.notes ? String(body.notes).trim() : null,
      created_by_user_id: body.created_by_user_id || null,
    },
  };
}

function parseCents(raw) {
  if (raw === null || raw === undefined || raw === "") return { error: "required" };
  if (typeof raw === "bigint") return { value: raw };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { error: "not finite" };
    if (!Number.isInteger(raw)) return { error: "must be integer cents" };
    return { value: BigInt(raw) };
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!/^-?\d+$/.test(s)) return { error: `invalid integer: ${raw}` };
    try { return { value: BigInt(s) }; } catch { return { error: "parse failed" }; }
  }
  return { error: "unsupported type" };
}

function centsToDecimalStr(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

function formatCents(c) {
  if (c == null) return "$0.00";
  const bi = typeof c === "bigint" ? c : BigInt(c);
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}$${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}
