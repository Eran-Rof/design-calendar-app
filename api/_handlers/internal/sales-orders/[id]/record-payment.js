// api/internal/sales-orders/:id/record-payment
//
// POST { amount_cents, method, reference?, created_by_user_id? }
//   → records a MANUAL payment against the sales order:
//       • amount_paid_cents += amount_cents
//       • when amount_paid_cents first reaches total_cents → paid_in_full_at = now
//       • if the SO is on CREDIT_CARD terms and now paid in full →
//           credit_approval_status = 'approved', credit_approval_source = 'payment'
//           (auto-releases the credit-card ship-gate)
//
// Processor integration (Stripe/hosted checkout/webhook) is DEFERRED. This
// endpoint is the manual record path; a future webhook handler can call the
// SAME column updates (amount_paid_cents / paid_in_full_at / credit_approval_*)
// to satisfy the gate identically — that's the clean seam.
//
// NOTE: this tracks payment ON THE SALES ORDER for the ship-gate only. It is
// NOT an AR receipt (ar_receipts) — the downstream AR invoice is still cleared
// via the AR receipts flow at posting time.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Payment methods accepted for the manual record path. Mirrors the
// ar_receipts.customer_payment_method enum so a future AR-receipt bridge is
// drop-in. 'other' is the catch-all.
const METHODS = ["credit_card", "ach", "wire", "check", "cash", "paypal", "stripe", "other"];

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

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};

  // Validate amount_cents — positive integer cents.
  const amount = typeof body.amount_cents === "number" ? body.amount_cents : parseInt(body.amount_cents, 10);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: "amount_cents must be a positive integer (cents)" });
  }
  const method = METHODS.includes(body.method) ? body.method : null;
  if (!method) return res.status(400).json({ error: `method must be one of ${METHODS.join(", ")}` });
  const reference = body.reference ? String(body.reference).trim() : null;
  const actor = (body.created_by_user_id && UUID_RE.test(String(body.created_by_user_id))) ? String(body.created_by_user_id) : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Load the SO + its payment term code (to know whether this is a card order).
  const { data: so, error: soErr } = await admin
    .from("sales_orders")
    .select("id, total_cents, amount_paid_cents, paid_in_full_at, payment_terms_id, credit_approval_status, notes")
    .eq("id", id).maybeSingle();
  if (soErr) return res.status(500).json({ error: soErr.message });
  if (!so) return res.status(404).json({ error: "Sales order not found" });

  let termCode = null;
  if (so.payment_terms_id) {
    const { data: term } = await admin.from("payment_terms").select("code").eq("id", so.payment_terms_id).maybeSingle();
    termCode = term?.code || null;
  }

  const prevPaid = Number(so.amount_paid_cents ?? 0);
  const total = Number(so.total_cents ?? 0);
  const newPaid = prevPaid + amount;
  const wasPaidInFull = prevPaid >= total && total > 0;
  const nowPaidInFull = newPaid >= total && total > 0;

  const patch = {
    amount_paid_cents: newPaid,
    credit_checked_at: new Date().toISOString(),
  };
  // Stamp paid_in_full_at the first time we cross the line.
  if (nowPaidInFull && !so.paid_in_full_at) patch.paid_in_full_at = new Date().toISOString();

  // Credit-card gate auto-release: a CREDIT_CARD order paid in full is approved
  // (source = payment). We only auto-approve cards — a house-account hold must be
  // cleared by paying down the overdue AR or by an explicit operator override.
  if (termCode === "CREDIT_CARD" && nowPaidInFull && so.credit_approval_status !== "approved") {
    patch.credit_approval_status = "approved";
    patch.credit_approval_source = "payment";
    patch.credit_hold_reason = null;
  }

  // Append a lightweight payment note to the SO (audit breadcrumb; the canonical
  // money lives in amount_paid_cents). Kept terse to avoid unbounded growth.
  const stamp = new Date().toISOString().slice(0, 10);
  const noteLine = `[${stamp}] payment $${(amount / 100).toFixed(2)} via ${method}${reference ? ` (ref ${reference})` : ""}`;
  patch.notes = so.notes ? `${so.notes}\n${noteLine}` : noteLine;

  const { data: updated, error: upErr } = await admin
    .from("sales_orders").update(patch).eq("id", id)
    .select("id, total_cents, amount_paid_cents, paid_in_full_at, credit_approval_status, credit_approval_source")
    .single();
  if (upErr) return res.status(500).json({ error: upErr.message });

  return res.status(201).json({
    ...updated,
    payment_recorded_cents: amount,
    method,
    reference,
    paid_in_full: nowPaidInFull,
    newly_paid_in_full: nowPaidInFull && !wasPaidInFull,
    credit_released: patch.credit_approval_status === "approved",
    created_by_user_id: actor,
    message: nowPaidInFull
      ? (patch.credit_approval_status === "approved"
          ? "Payment recorded — order paid in full, credit-card ship-gate released."
          : "Payment recorded — order paid in full.")
      : `Payment recorded — $${((total - newPaid) / 100).toFixed(2)} remaining.`,
  });
}
