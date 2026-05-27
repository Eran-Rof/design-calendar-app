// api/internal/ar-receipts/[id]
//
// GET    — fetch one AR receipt + applications (joined to ar_invoices for the
//          invoice_number + customer name).
// PATCH  — edit header fields only (receipt_date, customer_payment_method,
//          reference, notes, bank_account_id). Locked once any accrual_je_id
//          is set (posted) or is_void=true.
// DELETE — hard-delete a draft (un-applied, un-posted) receipt. Blocked when
//          any applications exist OR accrual_je_id set OR is_void=true.
//
// Tangerine P4-5 (arch §4.2).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ["ach", "wire", "check", "credit_card", "cash", "paypal", "stripe", "other"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
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

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: receipt, error: fetchErr } = await admin
    .from("ar_receipts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });

  if (req.method === "GET") {
    // Pull applications joined to ar_invoices for invoice_number context.
    const { data: apps, error: aErr } = await admin
      .from("ar_receipt_applications")
      .select(
        "id, ar_invoice_id, amount_applied_cents, applied_at, notes, " +
        "ar_invoices ( id, invoice_number, customer_id, total_amount_cents, paid_amount_cents, gl_status )",
      )
      .eq("ar_receipt_id", id)
      .order("applied_at", { ascending: true });
    if (aErr) return res.status(500).json({ error: aErr.message });

    // Resolve customer name for display.
    let customer = null;
    if (receipt.customer_id) {
      const { data: c } = await admin
        .from("customers")
        .select("id, code, name")
        .eq("id", receipt.customer_id)
        .maybeSingle();
      customer = c || null;
    }

    const appliedCents = (apps || []).reduce(
      (acc, a) => acc + BigInt(a.amount_applied_cents || 0),
      0n,
    );
    const unappliedCents = BigInt(receipt.amount_cents || 0) - appliedCents;

    return res.status(200).json({
      ...receipt,
      customer,
      applications: apps || [],
      applied_cents: appliedCents.toString(),
      unapplied_cents: unappliedCents.toString(),
    });
  }

  if (req.method === "PATCH") {
    if (receipt.is_void) {
      return res.status(409).json({ error: "Cannot edit a voided receipt" });
    }
    if (receipt.accrual_je_id || receipt.cash_je_id) {
      return res.status(409).json({
        error: "Cannot edit a posted receipt (accrual_je_id/cash_je_id is set). Void and re-create.",
      });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    if (Object.keys(v.data).length === 0) {
      return res.status(200).json(receipt);  // no-op
    }

    const { data: updated, error: upErr } = await admin
      .from("ar_receipts")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    if (receipt.is_void) {
      return res.status(409).json({ error: "Cannot delete a voided receipt (already terminal)" });
    }
    if (receipt.accrual_je_id || receipt.cash_je_id) {
      return res.status(409).json({
        error: "Cannot delete a posted receipt. Use /void instead.",
      });
    }
    // Block delete if any applications exist — operator must unapply first.
    const { data: apps } = await admin
      .from("ar_receipt_applications")
      .select("id")
      .eq("ar_receipt_id", id)
      .limit(1);
    if (Array.isArray(apps) && apps.length > 0) {
      return res.status(409).json({
        error: "Cannot delete a receipt with applications. Unapply first, or void.",
      });
    }
    const { error: delErr } = await admin.from("ar_receipts").delete().eq("id", id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

/**
 * Patch only header-fields. Reject server-controlled or
 * trigger-maintained columns.
 */
export function validatePatch(body) {
  // Reject locked / server-controlled keys with a precise message.
  const LOCKED = [
    "entity_id", "customer_id", "amount_cents",
    "accrual_je_id", "cash_je_id",
    "is_void", "voided_at", "voided_by_user_id", "void_reason",
  ];
  for (const k of LOCKED) {
    if (k in body) {
      return { error: `${k} is not patchable here` };
    }
  }

  const out = {};

  if ("receipt_date" in body) {
    if (!body.receipt_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.receipt_date)) {
      return { error: "receipt_date must be YYYY-MM-DD" };
    }
    out.receipt_date = body.receipt_date;
  }
  if ("customer_payment_method" in body) {
    if (!METHODS.includes(body.customer_payment_method)) {
      return { error: `customer_payment_method must be one of ${METHODS.join(", ")}` };
    }
    out.customer_payment_method = body.customer_payment_method;
  }
  if ("bank_account_id" in body) {
    if (body.bank_account_id == null) {
      return { error: "bank_account_id cannot be cleared (use a uuid)" };
    }
    if (!UUID_RE.test(body.bank_account_id)) {
      return { error: "bank_account_id must be a uuid" };
    }
    out.bank_account_id = body.bank_account_id;
  }
  if ("reference" in body) {
    out.reference = body.reference ? String(body.reference).trim() : null;
  }
  if ("notes" in body) {
    out.notes = body.notes ? String(body.notes).trim() : null;
  }

  return { data: out };
}
