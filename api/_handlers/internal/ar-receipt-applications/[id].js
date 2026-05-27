// api/internal/ar-receipt-applications/[id]
//
// DELETE — unapply a single ar_receipt_application row. Blocked when the
//          parent receipt has accrual_je_id set (posted) or is_void=true.
//          The trigger on ar_receipt_applications maintains
//          ar_invoices.paid_amount_cents automatically — deleting the row
//          will refresh the parent invoice's paid total and (via the
//          status-from-paid trigger) flip gl_status back from paid →
//          partial_paid → sent as appropriate.
//
// Tangerine P4-5 (arch §4.2).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
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
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Load the application + the parent receipt — block if posted/voided.
  const { data: app, error: aErr } = await admin
    .from("ar_receipt_applications")
    .select(
      "id, ar_receipt_id, ar_invoice_id, amount_applied_cents, " +
      "ar_receipts ( id, is_void, accrual_je_id, cash_je_id )",
    )
    .eq("id", id)
    .maybeSingle();
  if (aErr) return res.status(500).json({ error: aErr.message });
  if (!app) return res.status(404).json({ error: "Application not found" });

  const v = validateDelete(app);
  if (v.error) return res.status(409).json({ error: v.error });

  const { error: dErr } = await admin
    .from("ar_receipt_applications")
    .delete()
    .eq("id", id);
  if (dErr) return res.status(500).json({ error: dErr.message });

  return res.status(204).end();
}

/**
 * Block unapply when the parent receipt is posted (accrual_je_id set) or
 * voided. Pure-function check exported for tests.
 *
 * Accepts a record where `ar_receipts` is the embedded parent (the join shape
 * returned by Supabase). If the parent embed is missing, the application is
 * orphaned (shouldn't happen — RESTRICT FK guarantees parent exists) and we
 * also block to be safe.
 */
export function validateDelete(app) {
  const parent = app?.ar_receipts;
  if (!parent) {
    return { error: "Parent receipt not found (orphan application)" };
  }
  if (parent.is_void) {
    return {
      error: "Cannot unapply: parent receipt is voided (applications stay as audit history)",
    };
  }
  if (parent.accrual_je_id || parent.cash_je_id) {
    return {
      error: "Cannot unapply: parent receipt is posted. Void the entire receipt instead.",
    };
  }
  return { ok: true };
}
