// api/internal/ar-receipts/:id/void
//
// POST — void an AR receipt. Reverses BOTH the accrual_je_id and the
//        cash_je_id by calling reverseJournalEntry() directly (the
//        arInvoiceVoided / arPaymentReceived rules are not registered for
//        this path; we use the lower-level reverse primitive). Then flips
//        is_void=true + voided_at=now() + voided_by_user_id + void_reason.
//
//        The applications stay in the DB — they're audit history. The
//        paid_amount_cents maintainer on ar_invoices SUMs WHERE
//        r.is_void=false (see migration 20260528100000 §12), so the parent
//        invoices' paid totals automatically back out when is_void flips.
//        The status-from-paid trigger then auto-flips the invoices from
//        paid → partial_paid → sent as appropriate.
//
// Body (optional):
//   { created_by_user_id?: uuid, void_reason?: string }
//
// Tangerine P4-5 (arch §4.2).

import { createClient } from "@supabase/supabase-js";
import { reverseJournalEntry } from "../../../_lib/accounting/posting/index.js";
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
  const void_reason = body?.void_reason ? String(body.void_reason).trim() : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: receipt, error: rErr } = await admin
    .from("ar_receipts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });

  if (receipt.is_void) {
    return res.status(409).json({ error: "Receipt is already void" });
  }

  // 1. Reverse both JEs (if set). For an unposted receipt (no JEs), this is a
  //    soft-delete-flag flip only — the applications still back out via the
  //    is_void=false filter in the paid maintainer.
  const reversedJeIds = [];
  for (const jeId of [receipt.accrual_je_id, receipt.cash_je_id]) {
    if (!jeId) continue;
    try {
      const newId = await reverseJournalEntry(admin, jeId, {
        created_by_user_id,
      });
      reversedJeIds.push(newId);
    } catch (e) {
      return res.status(400).json({
        error: `Failed to reverse JE ${jeId}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // 2. Flip is_void + stamp audit fields.
  const { error: upErr } = await admin
    .from("ar_receipts")
    .update({
      is_void: true,
      voided_at: new Date().toISOString(),
      voided_by_user_id: created_by_user_id,
      void_reason,
    })
    .eq("id", id);
  if (upErr) {
    return res.status(500).json({
      error: `Reversal JEs created (${reversedJeIds.length}) but is_void flip failed: ${upErr.message}`,
    });
  }

  // 3. Notification — fire and forget.
  try {
    await enqueueNotification(admin, {
      entity_id: receipt.entity_id,
      kind: "ar_receipt_voided",
      severity: "warn",
      subject: `AR receipt ${formatCents(receipt.amount_cents)} voided`,
      body:
        `AR receipt has been voided.${void_reason ? ` Reason: ${void_reason}` : ""}` +
        (reversedJeIds.length > 0 ? ` Reversed ${reversedJeIds.length} JE(s).` : ""),
      context_table: "ar_receipts",
      context_id: receipt.id,
      recipient_roles: ["admin", "accountant"],
      created_by_user_id,
    });
  } catch { /* non-fatal */ }

  return res.status(200).json({
    is_void: true,
    reversed_je_ids: reversedJeIds,
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
