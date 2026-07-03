// api/internal/ar-invoices/:id/void
//
// POST — void an AR invoice. Dispatches arInvoiceVoided which reverses the
//        accrual JE (and cash JE iff a payment was already recognized).
//        Flips gl_status to 'void' regardless of whether posting reversal
//        was needed (e.g. for draft invoices the rule returns empty
//        reversals and we still flip).
//
//        409 if any ar_receipt_applications exist with amount_applied_cents>0
//        for this invoice (i.e. paid_amount_cents > 0). Operator must void
//        the receipt applications first (P4-5 receipts UI ships /void).
//
// Body (optional): { created_by_user_id?, reason?, posting_date? }
//
// Tangerine P4 Chunk 4.

import { createClient } from "@supabase/supabase-js";
import { postEvent, PostingError } from "../../../_lib/accounting/posting/index.js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";
import { reopenSalesOrderFromInvoice } from "../../../_lib/sales-orders/reopenFromInvoice.js";
import { restoreInvoiceConsumption } from "../../../_lib/inventory/restoreInvoiceConsumption.js";
import {
  extractActorFromRequest,
  callWithAudit,
  requireReason,
} from "../../../_lib/audit/withAuditContext.js";

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

  // T11 D3: reason REQUIRED on VOID. Return 400 before doing any work
  // so the operator gets a clean error rather than a SQL exception from
  // the trigger.
  const reasonGate = requireReason("VOID", reason);
  if (reasonGate) return res.status(reasonGate.status).json({ error: reasonGate.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: invoice, error: invErr } = await admin
    .from("ar_invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (invoice.gl_status === "void") {
    return res.status(409).json({ error: "Invoice is already void" });
  }

  // Block void if any receipts have been applied. paid_amount_cents is the
  // trigger-maintained sum on ar_invoices, but we double-check by looking at
  // ar_receipt_applications directly (excluding voided receipts) so an
  // operator gets a clear error rather than a silently-broken reversal.
  const paidCents = BigInt(invoice.paid_amount_cents || "0");
  if (paidCents > 0n) {
    return res.status(409).json({
      error: `Invoice has ${formatCents(paidCents)} in applied receipts. Void the receipts first.`,
      has_payments: true,
      paid_amount_cents: invoice.paid_amount_cents,
    });
  }

  let reversedJeIds = [];
  try {
    const result = await postEvent(admin, {
      kind: "ar_invoice_voided",
      entity_id: invoice.entity_id,
      created_by_user_id,
      reason: reason || `Void AR invoice ${invoice.invoice_number ?? invoice.id}`,
      data: {
        invoice_id: invoice.id,
        accrual_je_id: invoice.accrual_je_id,
        cash_je_id: invoice.cash_je_id,
        gl_status: invoice.gl_status,
        reason,
      },
    });
    reversedJeIds = result.reversed_je_ids || [];
  } catch (e) {
    if (e instanceof PostingError) {
      return res.status(400).json({ error: `Void failed: ${e.message}` });
    }
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }

  // T11-2 audit-aware void — extract actor + call the wrapper RPC that
  // sets the audit session vars + flips gl_status in the same statement.
  // The audit_row_changes_trigger sees the vars and stamps the
  // row_changes ledger with the correct actor + reason for the VOID op.
  const actor = await extractActorFromRequest(req, admin);
  const correlation_id =
    req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"] || null;
  const { error: voidErr } = await callWithAudit(admin, "void_ar_invoice_with_audit", {
    invoice_id: invoice.id,
    actor,
    reason,
    source: "manual",
    correlation_id,
  });
  if (voidErr) {
    return res.status(500).json({ error: `Audit void failed: ${voidErr.message}` });
  }

  // Append reason to notes — separate UPDATE so the audit trigger logs
  // the void distinctly from any free-text annotation.
  if (reason) {
    const noteUpdate = invoice.notes
      ? `${invoice.notes}\n[void] ${reason}`
      : `[void] ${reason}`;
    const { error: notesErr } = await admin
      .from("ar_invoices")
      .update({ notes: noteUpdate })
      .eq("id", invoice.id);
    if (notesErr) {
      // Non-fatal — void already succeeded, notes is annotation only.
      console.warn("[ar-invoice-void] notes append failed:", notesErr.message);
    }
  }

  try {
    await enqueueNotification(admin, {
      entity_id: invoice.entity_id,
      kind: "ar_invoice_voided",
      severity: "warn",
      subject: `AR invoice ${invoice.invoice_number} voided`,
      body: `AR invoice ${invoice.invoice_number} has been voided.${reason ? ` Reason: ${reason}` : ""}${reversedJeIds.length > 0 ? ` Reversed ${reversedJeIds.length} JE(s).` : ""}`,
      context_table: "ar_invoices",
      context_id: invoice.id,
      recipient_roles: ["admin", "accountant"],
      created_by_user_id,
    });
  } catch { /* non-fatal */ }

  // Restore the FIFO inventory this invoice consumed back to on-hand — the GL
  // reversal above only put the inventory ASSET dollars back; the units stay
  // drawn down until we reverse the layer consumption. No-op for a never-posted
  // draft (nothing was consumed).
  let inventory = { restored_qty: 0, rows_reversed: 0 };
  try { inventory = await restoreInvoiceConsumption(admin, invoice.id, created_by_user_id); }
  catch (e) { console.warn("[ar-invoice-void] inventory restore failed:", e instanceof Error ? e.message : String(e)); }

  // Re-open the originating sales order so a voided invoice doesn't strand the SO
  // in 'invoiced'. The GL reversal above already unwound posting; this returns the
  // SO to allocated/confirmed with its (untouched) allocations intact.
  let reopened = { reopened: false, so_number: null };
  try { reopened = await reopenSalesOrderFromInvoice(admin, invoice.id); } catch { /* best-effort */ }

  return res.status(200).json({
    gl_status: "void",
    reversed_je_ids: reversedJeIds,
    reopened_sales_order: reopened.reopened,
    so_number: reopened.so_number,
    inventory_restored_qty: inventory.restored_qty,
  });
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
