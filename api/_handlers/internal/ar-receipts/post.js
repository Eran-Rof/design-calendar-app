// api/internal/ar-receipts/:id/post
//
// POST — promote a draft AR receipt to posted. Flow:
//   1. Load the receipt + applications + parent invoices' ar_account /
//      revenue_account ids (per-invoice routing).
//   2. Block if already posted (accrual_je_id set) or voided.
//   3. Build the arPaymentReceived event in multi-application shape
//      (one accrual JE + one cash JE per receipt; each carries
//       1 + N lines = DR bank header + per-app CR).
//   4. Call postEvent — emits both JEs, sibling-linked inside
//      persistRuleOutput via gl_link_sibling_je.
//   5. Stamp the receipt with accrual_je_id + cash_je_id.
//   6. Enqueue ar_receipt_posted notification to admin + accountant.
//
// The trigger on ar_receipt_applications maintains ar_invoices.paid_amount_cents
// when each application was inserted — so by the time we post, the invoices
// already have their paid totals + auto-flipped gl_status (sent →
// partial_paid → paid). Posting just emits the JE side.
//
// Tangerine P4-5 (arch §4.2).

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
    catch { body = {}; }
  }
  const created_by_user_id =
    (body?.created_by_user_id && UUID_RE.test(String(body.created_by_user_id)))
      ? String(body.created_by_user_id)
      : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Load receipt + applications.
  const { data: receipt, error: rErr } = await admin
    .from("ar_receipts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });

  if (receipt.is_void) {
    return res.status(409).json({ error: "Cannot post a voided receipt" });
  }
  if (receipt.accrual_je_id || receipt.cash_je_id) {
    return res.status(409).json({ error: "Receipt is already posted" });
  }

  const { data: apps, error: aErr } = await admin
    .from("ar_receipt_applications")
    .select("id, ar_invoice_id, amount_applied_cents")
    .eq("ar_receipt_id", id);
  if (aErr) return res.status(500).json({ error: aErr.message });

  if (!apps || apps.length === 0) {
    return res.status(409).json({
      error: "Cannot post a receipt with zero applications. Apply to at least one invoice first (unapplied receipts cannot be posted to a specific revenue account).",
    });
  }

  // 2. Load the parent ar_invoices to pull ar_account_id + revenue_account_id
  //    for per-application JE routing.
  const invoiceIds = apps.map((a) => a.ar_invoice_id);
  const { data: invoices, error: iErr } = await admin
    .from("ar_invoices")
    .select("id, invoice_number, ar_account_id, revenue_account_id")
    .in("id", invoiceIds);
  if (iErr) return res.status(500).json({ error: iErr.message });

  const invoiceMap = {};
  for (const inv of (invoices || [])) {
    invoiceMap[inv.id] = inv;
  }

  // Fallback for any invoice missing ar_account_id / revenue_account_id —
  // use entity defaults (account codes '1200' / '4000' per arch §3.7).
  const { data: entity } = await admin
    .from("entities")
    .select("default_ar_account_id, default_revenue_account_id")
    .eq("id", receipt.entity_id)
    .maybeSingle();
  const fallbackArAcct =
    entity?.default_ar_account_id ||
    (await findAccountByCode(admin, receipt.entity_id, "1200"))?.id;
  const fallbackRevAcct =
    entity?.default_revenue_account_id ||
    (await findAccountByCode(admin, receipt.entity_id, "4000"))?.id;

  const ruleApplications = [];
  for (let i = 0; i < apps.length; i++) {
    const a = apps[i];
    const inv = invoiceMap[a.ar_invoice_id];
    const arAcct = (inv && inv.ar_account_id) || fallbackArAcct;
    const revAcct = (inv && inv.revenue_account_id) || fallbackRevAcct;
    if (!arAcct) {
      return res.status(400).json({
        error: `Application ${i + 1} (invoice ${a.ar_invoice_id}): no ar_account_id on invoice and no entity default (set entities.default_ar_account_id or gl_accounts.code='1200')`,
      });
    }
    if (!revAcct) {
      return res.status(400).json({
        error: `Application ${i + 1} (invoice ${a.ar_invoice_id}): no revenue_account_id on invoice and no entity default (set entities.default_revenue_account_id or gl_accounts.code='4000')`,
      });
    }
    ruleApplications.push({
      ar_invoice_id: a.ar_invoice_id,
      invoice_number: inv?.invoice_number || null,
      ar_account_id: arAcct,
      revenue_account_id: revAcct,
      amount_cents: a.amount_applied_cents,
    });
  }

  // 3. Compute the applied-cents total (for the rule's optional cross-check).
  const totalAppliedCents = ruleApplications
    .reduce((acc, a) => acc + BigInt(a.amount_cents || 0), 0n);

  // 4. Post (multi-application path). persistRuleOutput sibling-links.
  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "ar_payment_received",
      entity_id: receipt.entity_id,
      created_by_user_id,
      reason: `AR payment received ${receipt.reference ?? receipt.id}`,
      data: {
        receipt_id: receipt.id,
        customer_id: receipt.customer_id,
        receipt_date: receipt.receipt_date,
        bank_account_id: receipt.bank_account_id,
        payment_reference: receipt.reference,
        applications: ruleApplications,
        total_amount_cents: totalAppliedCents.toString(),
      },
    });
  } catch (e) {
    if (e instanceof PostingError) {
      return res.status(400).json({ error: `AR receipt posting failed: ${e.message}` });
    }
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }

  // 5. Stamp the receipt with both JE pointers.
  const { error: upErr } = await admin
    .from("ar_receipts")
    .update({
      accrual_je_id: postResult.accrual_je_id,
      cash_je_id: postResult.cash_je_id,
    })
    .eq("id", receipt.id);
  if (upErr) {
    return res.status(500).json({
      error: `JEs posted (accrual=${postResult.accrual_je_id}, cash=${postResult.cash_je_id}) but receipt stamp failed: ${upErr.message}`,
    });
  }

  // 6. Notification — fire and forget.
  try {
    await enqueueNotification(admin, {
      entity_id: receipt.entity_id,
      kind: "ar_receipt_posted",
      severity: "info",
      subject: `AR receipt ${formatCents(receipt.amount_cents)} posted (customer ${receipt.customer_id})`,
      body:
        `AR receipt for ${formatCents(receipt.amount_cents)} applied across ${apps.length} invoice${apps.length === 1 ? "" : "s"} ` +
        `has been posted (accrual JE ${postResult.accrual_je_id}, cash JE ${postResult.cash_je_id}).`,
      context_table: "ar_receipts",
      context_id: receipt.id,
      recipient_roles: ["admin", "accountant"],
      created_by_user_id,
    });
  } catch { /* non-fatal */ }

  return res.status(200).json({
    accrual_je_id: postResult.accrual_je_id,
    cash_je_id: postResult.cash_je_id,
    applications_count: apps.length,
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
