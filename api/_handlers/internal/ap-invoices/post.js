// api/internal/ap-invoices/:id/post
//
// POST — promote a draft AP invoice to posted. The full flow:
//   1. Verify gl_status is draft/unposted (else 409).
//   2. Call approvalsAPI.requestIfRequired with kind='ap_invoice'.
//        - If required: flip gl_status='pending_approval', enqueue
//          ap_invoice_approval_requested notification, return 202 with
//          { requires_approval: true, approval_request_id }.
//        - If not: skip approval gate and continue.
//   3. Build the posting event (multi-line shape per apInvoiceReceived rule).
//      Inventory lines need an inventory_account_id (resolved via gl_accounts
//      by code '1310' as the default inventory asset account; that's the
//      operator's documented sub-decision §11.1 for P3-2).
//   4. Call postEvent — produces the accrual JE.
//   5. Update invoices.accrual_je_id + gl_status='posted'.
//   6. Enqueue ap_invoice_posted notification.
//
// Body (optional): { created_by_user_id: <uuid> } — propagated into the JE
//                  + the approval request audit. May be null.
//
// Tangerine P3 Chunk 2.

import { createClient } from "@supabase/supabase-js";
import { requestIfRequired, ApprovalsError } from "../../../_lib/approvals/index.js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";
import { postEvent, PostingError } from "../../../_lib/accounting/posting/index.js";
import { expandApExpenseLines } from "../../../_lib/glAllocation.js";
import { resolveReceivingPartition } from "../../../_lib/brandContext.js";

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

/**
 * Resolve a GL account row by code in this entity.
 * Returns null if not found.
 */
async function findAccountByCode(admin, entityId, code) {
  const { data } = await admin
    .from("gl_accounts")
    .select("id, code, name")
    .eq("entity_id", entityId)
    .eq("code", code)
    .maybeSingle();
  return data || null;
}

/**
 * Build the event.data payload for apInvoiceReceived (multi-line shape).
 * Inventory lines need an inventory_account_id. We use the default inventory
 * GL account (code '1310' by convention; operator can override later).
 */
async function buildPostingEventData(admin, entityId, invoice, lines) {
  const apAccountId =
    invoice.ap_account_id ||
    (await findAccountByCode(admin, entityId, "2010"))?.id;
  if (!apAccountId) {
    throw new Error("AP account is not configured (set ap_account_id on the invoice or seed gl_accounts.code='2010').");
  }

  // Lazy-resolve the inventory default account only if any inventory lines exist.
  let inventoryAccountId = null;
  const hasInventoryLine = lines.some((l) => l.inventory_item_id);
  if (hasInventoryLine) {
    inventoryAccountId = (await findAccountByCode(admin, entityId, "1310"))?.id || null;
    if (!inventoryAccountId) {
      throw new Error("Inventory has lines but no inventory GL account is configured (seed gl_accounts.code='1310').");
    }
  }

  const ruleLines = lines.map((l) => {
    if (l.inventory_item_id) {
      // amount = quantity * unit_cost_cents (in cents), converted to decimal string
      const totalCents = BigInt(l.unit_cost_cents || "0") * BigInt(Math.round(Number(l.quantity) || 0));
      return {
        amount: centsToDecimalStr(totalCents),
        expense_account_id: null,
        inventory_item_id: l.inventory_item_id,
        inventory_account_id: inventoryAccountId,
        memo: l.description || null,
      };
    }
    // Expense line: amount = quantity * unit_cost_cents (qty is 1)
    const totalCents = BigInt(l.unit_cost_cents || "0") * BigInt(Math.round(Number(l.quantity) || 0));
    const expenseAcct = l.expense_account_id || invoice.expense_account_id;
    if (!expenseAcct) {
      throw new Error(`Line ${l.line_number}: missing expense_account_id and no header default set`);
    }
    return {
      amount: centsToDecimalStr(totalCents),
      expense_account_id: expenseAcct,
      memo: l.description || null,
    };
  });

  // M50 C-2: split expense lines targeting a brand-rollup account into per-brand
  // child lines (gated on BRAND_SCOPE_MODE=enforce; no-op otherwise). Inventory
  // lines pass through untouched. The rule re-sums the debits into the CR AP
  // line, so the bill stays balanced.
  const expandedLines = await expandApExpenseLines(admin, ruleLines);

  // P15 stock-pool: resolve which brand pool received inventory lands in, from
  // the invoice's brand + chosen receiving side (WS/EC). Stamped on each FIFO
  // layer the apInvoiceReceived rule queues. Null when no inventory lines or no
  // pool configured for the brand (layer stays unpartitioned).
  let receivingPartitionId = null;
  if (hasInventoryLine && invoice.brand_id) {
    receivingPartitionId = await resolveReceivingPartition(
      admin, invoice.brand_id, invoice.receiving_channel === "EC" ? "EC" : "WS",
    );
  }

  return {
    invoice_id: invoice.id,
    vendor_id: invoice.vendor_id,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.posting_date,
    invoice_kind: invoice.invoice_kind, // #3B — vendor_credit_memo reverses DR/CR
    ap_account_id: apAccountId,
    receiving_partition_id: receivingPartitionId,
    lines: expandedLines,
  };
}

function centsToDecimalStr(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
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

  // 1. Load invoice + lines
  const { data: invoice, error: invErr } = await admin
    .from("invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (invoice.gl_status === "posted" || invoice.gl_status === "paid") {
    return res.status(409).json({ error: `Already posted (gl_status=${invoice.gl_status})` });
  }
  if (invoice.gl_status === "void" || invoice.gl_status === "reversed") {
    return res.status(409).json({ error: `Cannot post a ${invoice.gl_status} invoice` });
  }

  // 2. Resolve vendor metadata for the approval payload.
  const { data: vendor } = await admin
    .from("vendors")
    .select("id, vendor_code, name, created_at")
    .eq("id", invoice.vendor_id)
    .maybeSingle();
  const vendor_new = vendor?.created_at
    ? (Date.now() - new Date(vendor.created_at).getTime()) < 90 * 86400 * 1000
    : false;

  const result = await postInvoice(admin, {
    invoice,
    vendor,
    vendor_new,
    created_by_user_id,
    fromApprovalHook: false,
  });

  if (result.error) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  return res.status(result.status || 200).json(result.body);
}

/**
 * Shared post-flow used by both the direct POST endpoint and the
 * approval-decide hook (when an approver clicks Approve and we
 * automatically retry posting).
 *
 * Returns { status, body? , error? }.
 */
export async function postInvoice(admin, opts) {
  const { invoice, vendor, vendor_new, created_by_user_id, fromApprovalHook } = opts;

  // Already pending_approval and we're NOT coming from the hook → just re-emit
  // the original approval and bail.
  if (invoice.gl_status === "pending_approval" && !fromApprovalHook) {
    const { data: pending } = await admin
      .from("approval_requests")
      .select("id")
      .eq("context_table", "invoices")
      .eq("context_id", invoice.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return {
      status: 202,
      body: {
        requires_approval: true,
        approval_request_id: pending?.id || null,
        message: "Invoice already pending approval",
      },
    };
  }

  // 1. Load lines
  const { data: lines, error: lErr } = await admin
    .from("invoice_line_items")
    .select("*")
    .eq("invoice_id", invoice.id)
    .order("line_number", { ascending: true });
  if (lErr) return { status: 500, error: lErr.message };
  if (!lines || lines.length === 0) {
    return { status: 400, error: "Cannot post an invoice with no lines" };
  }

  // 2. Approval gate (skip when re-entering from the hook)
  if (!fromApprovalHook) {
    let check;
    try {
      check = await requestIfRequired(admin, {
        kind: "ap_invoice",
        entity_id: invoice.entity_id,
        context_table: "invoices",
        context_id: invoice.id,
        amount_cents: Number(invoice.total_amount_cents) || 0,
        source_kind: "ap_invoice",
        vendor_new,
        payload: {
          vendor_id: invoice.vendor_id,
          vendor_code: vendor?.vendor_code || null,
          vendor_name: vendor?.name || null,
          invoice_number: invoice.invoice_number,
          total_amount_cents: invoice.total_amount_cents,
        },
        created_by_user_id,
      });
    } catch (e) {
      if (e instanceof ApprovalsError) {
        return { status: 500, error: `Approvals gate failed: ${e.message}` };
      }
      return { status: 500, error: e instanceof Error ? e.message : String(e) };
    }

    if (check.required) {
      await admin
        .from("invoices")
        .update({ gl_status: "pending_approval" })
        .eq("id", invoice.id);

      // Fire-and-forget approval-requested notification.
      try {
        await enqueueNotification(admin, {
          entity_id: invoice.entity_id,
          kind: "ap_invoice_approval_requested",
          severity: "warn",
          subject: `AP invoice ${invoice.invoice_number} needs approval`,
          body: `AP invoice ${invoice.invoice_number} from ${vendor?.name || vendor?.vendor_code || invoice.vendor_id} (total ${formatCents(invoice.total_amount_cents)}) is pending approval.`,
          context_table: "invoices",
          context_id: invoice.id,
          recipient_roles: ["admin"],
          created_by_user_id,
        });
      } catch { /* non-fatal */ }

      return {
        status: 202,
        body: {
          requires_approval: true,
          approval_request_id: check.request_id,
        },
      };
    }
  }

  // 3. Build event + post
  let eventData;
  try {
    eventData = await buildPostingEventData(admin, invoice.entity_id, invoice, lines);
  } catch (e) {
    return { status: 400, error: e instanceof Error ? e.message : String(e) };
  }

  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "ap_invoice_received",
      entity_id: invoice.entity_id,
      created_by_user_id,
      reason: `Post AP bill ${invoice.invoice_number ?? invoice.id}`,
      data: eventData,
    });
  } catch (e) {
    if (e instanceof PostingError) {
      return { status: 400, error: `Posting failed: ${e.message}` };
    }
    return { status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  // 4. Stamp invoice with the new JE id + flip gl_status='posted'
  const { error: upErr } = await admin
    .from("invoices")
    .update({
      accrual_je_id: postResult.accrual_je_id,
      gl_status: "posted",
    })
    .eq("id", invoice.id);
  if (upErr) return { status: 500, error: `JE posted (${postResult.accrual_je_id}) but invoice update failed: ${upErr.message}` };

  // 5. Notification
  try {
    await enqueueNotification(admin, {
      entity_id: invoice.entity_id,
      kind: "ap_invoice_posted",
      severity: "info",
      subject: `AP invoice ${invoice.invoice_number} posted`,
      body: `AP invoice ${invoice.invoice_number} (total ${formatCents(invoice.total_amount_cents)}) has been posted to the GL.`,
      context_table: "invoices",
      context_id: invoice.id,
      recipient_roles: ["accountant", "admin"],
      created_by_user_id,
    });
  } catch { /* non-fatal */ }

  return {
    status: 200,
    body: {
      requires_approval: false,
      accrual_je_id: postResult.accrual_je_id,
      gl_status: "posted",
    },
  };
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
