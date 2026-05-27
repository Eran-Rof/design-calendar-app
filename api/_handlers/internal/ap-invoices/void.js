// api/internal/ap-invoices/:id/void
//
// POST — void an AP invoice. Dispatches apInvoiceVoided which reverses the
//        accrual JE (and cash JE if any). Flips gl_status to 'void' regardless
//        of whether posting reversal was needed.
//
// Body (optional): { created_by_user_id?, reason?, posting_date? }
//
// Tangerine P3 Chunk 2.

import { createClient } from "@supabase/supabase-js";
import { postEvent, PostingError } from "../../../_lib/accounting/posting/index.js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { body = {}; }
  }
  const created_by_user_id =
    (body?.created_by_user_id && UUID_RE.test(String(body.created_by_user_id)))
      ? String(body.created_by_user_id)
      : null;
  const reason = body?.reason ? String(body.reason).trim() : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: invoice, error: invErr } = await admin
    .from("invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (invoice.gl_status === "void") {
    return res.status(409).json({ error: "Invoice is already void" });
  }

  // Dispatch apInvoiceVoided — for unposted/draft this is a clean no-op.
  let reversedJeIds = [];
  try {
    const result = await postEvent(admin, {
      kind: "ap_invoice_voided",
      entity_id: invoice.entity_id,
      created_by_user_id,
      data: {
        invoice_id: invoice.id,
        accrual_je_id: invoice.accrual_je_id,
        cash_je_id: invoice.cash_je_id,
        gl_status: invoice.gl_status,
      },
    });
    reversedJeIds = result.reversed_je_ids || [];
  } catch (e) {
    if (e instanceof PostingError) {
      return res.status(400).json({ error: `Void failed: ${e.message}` });
    }
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }

  // Flip gl_status to 'void' regardless.
  const { error: upErr } = await admin
    .from("invoices")
    .update({ gl_status: "void" })
    .eq("id", invoice.id);
  if (upErr) return res.status(500).json({ error: upErr.message });

  // Notification
  try {
    await enqueueNotification(admin, {
      entity_id: invoice.entity_id,
      kind: "ap_invoice_voided",
      severity: "warn",
      subject: `AP invoice ${invoice.invoice_number} voided`,
      body: `AP invoice ${invoice.invoice_number} has been voided.${reason ? ` Reason: ${reason}` : ""}${reversedJeIds.length > 0 ? ` Reversed ${reversedJeIds.length} JE(s).` : ""}`,
      context_table: "invoices",
      context_id: invoice.id,
      recipient_roles: ["accountant", "admin"],
      created_by_user_id,
    });
  } catch { /* non-fatal */ }

  return res.status(200).json({
    gl_status: "void",
    reversed_je_ids: reversedJeIds,
  });
}
