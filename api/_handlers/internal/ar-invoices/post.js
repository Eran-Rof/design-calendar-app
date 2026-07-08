// api/internal/ar-invoices/:id/post
//
// POST — promote a draft AR invoice to sent. Full flow:
//   1. Verify gl_status is draft/unposted (else 409).
//   2. Resolve default GL accounts from entities (with COA code fallbacks
//      1200=AR, 4000=revenue, 5000=COGS, 1300=inventory).
//   3. Call approvalsAPI.requestIfRequired with kind='ar_invoice'
//        - If required: flip gl_status='pending_approval', notify, return 202.
//        - If not: continue.
//   4. Build the posting event (multi-line shape per arInvoiceSent rule)
//      with consumePlan for any inventory_item_id lines.
//   5. Call postEvent — runs FIFO consume() per inventory line, then persists
//      the accrual JE with rewritten COGS amounts.
//   6. Write back per-line cogs_cents from result.consume_results keyed by
//      target_line_id, set cogs_resolved_at.
//   7. Stamp ar_invoices.accrual_je_id + gl_status='sent'.
//   8. Enqueue ar_invoice_posted notification → ['admin','accountant'].
//
// Body (optional): { created_by_user_id?: <uuid> }.
//
// Tangerine P4 Chunk 4.

import { createClient } from "@supabase/supabase-js";
import { requestIfRequired, ApprovalsError } from "../../../_lib/approvals/index.js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";
import { postEvent, PostingError } from "../../../_lib/accounting/posting/index.js";
import { checkCreditLimit } from "../../../_lib/customers/creditCheck.js";
import { brandScopeMode, resolveReceivingPartition } from "../../../_lib/brandContext.js";

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
 * Resolve a GL account row by code in this entity. Returns null if not found.
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
 * Resolve default account ids with fallbacks:
 *   ar:        invoice.ar_account_id        → entity.default_ar_account_id        → code 1200
 *   revenue:   invoice.revenue_account_id   → entity.default_revenue_account_id   → code 4000
 *   cogs:      invoice.cogs_account_id      → entity.default_cogs_account_id      → code 5000
 *   inventory: invoice.inventory_asset_account_id → entity.default_inventory_account_id → code 1300
 * Inventory + cogs are only enforced when at least one line carries inventory_item_id.
 */
async function resolveAccounts(admin, entityId, invoice, hasInventoryLine) {
  const { data: entity } = await admin
    .from("entities")
    .select(
      "default_ar_account_id, default_revenue_account_id, " +
      "default_cogs_account_id, default_inventory_account_id",
    )
    .eq("id", entityId)
    .maybeSingle();

  // Code fallbacks realigned to the 2026-07-07 COA restructure: 1200 is now the
  // NON-postable Inventory header (house AR = 1108), 4000/5000 became pure
  // section headers (catch-all revenue/COGS = 4005/5010), inventory = 1201.
  // The old codes would fail the posting engine's accountPostable guard.
  const arId =
    invoice.ar_account_id ||
    entity?.default_ar_account_id ||
    (await findAccountByCode(admin, entityId, "1108"))?.id;
  if (!arId) {
    throw new Error("AR account not configured (set ar_account_id on invoice or seed gl_accounts.code='1108').");
  }

  const revenueId =
    invoice.revenue_account_id ||
    entity?.default_revenue_account_id ||
    (await findAccountByCode(admin, entityId, "4005"))?.id;
  if (!revenueId) {
    throw new Error("Revenue account not configured (set revenue_account_id on invoice or seed gl_accounts.code='4005').");
  }

  let cogsId = null;
  let inventoryId = null;
  if (hasInventoryLine) {
    cogsId =
      invoice.cogs_account_id ||
      entity?.default_cogs_account_id ||
      (await findAccountByCode(admin, entityId, "5010"))?.id ||
      null;
    if (!cogsId) {
      throw new Error("Inventory lines present but no COGS account configured (seed gl_accounts.code='5010').");
    }
    inventoryId =
      invoice.inventory_asset_account_id ||
      entity?.default_inventory_account_id ||
      (await findAccountByCode(admin, entityId, "1201"))?.id ||
      null;
    if (!inventoryId) {
      throw new Error("Inventory lines present but no inventory asset account configured (seed gl_accounts.code='1201').");
    }
  }

  return { arId, revenueId, cogsId, inventoryId };
}

/**
 * Build event.data payload for arInvoiceSent (multi-line shape).
 * lines carry { id, line_index, description, inventory_item_id?, quantity?,
 *               revenue_account_id?, unit_price_cents?, line_total_cents }.
 */
function buildPostingEventData(invoice, lines, accounts) {
  return {
    invoice_id: invoice.id,
    customer_id: invoice.customer_id,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date || invoice.posting_date,
    ar_account_id: accounts.arId,
    revenue_account_id: accounts.revenueId,
    cogs_account_id: accounts.cogsId,
    inventory_account_id: accounts.inventoryId,
    lines: lines.map((l) => ({
      id: l.id,
      line_index: l.line_number,
      description: l.description || null,
      inventory_item_id: l.inventory_item_id || null,
      quantity: l.quantity,
      revenue_account_id: l.revenue_account_id || null,
      cogs_account_id: l.cogs_account_id || null,
      unit_price_cents: l.unit_price_cents,
      line_total_cents: String(l.line_total_cents),
    })),
  };
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

  const { data: invoice, error: invErr } = await admin
    .from("ar_invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (invoice.gl_status === "sent" || invoice.gl_status === "paid" || invoice.gl_status === "partial_paid") {
    return res.status(409).json({ error: `Already posted (gl_status=${invoice.gl_status})` });
  }
  if (invoice.gl_status === "void" || invoice.gl_status === "reversed") {
    return res.status(409).json({ error: `Cannot post a ${invoice.gl_status} invoice` });
  }
  if (invoice.gl_status === "posted_historical") {
    return res.status(409).json({ error: "posted_historical is a terminal backfill status" });
  }

  const { data: customer } = await admin
    .from("customers")
    .select("id, customer_code, name, created_at")
    .eq("id", invoice.customer_id)
    .maybeSingle();
  const customer_new = customer?.created_at
    ? (Date.now() - new Date(customer.created_at).getTime()) < 90 * 86400 * 1000
    : false;

  const result = await postInvoice(admin, {
    invoice,
    customer,
    customer_new,
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
 * approval-decide hook. Returns { status, body? , error? }.
 */
export async function postInvoice(admin, opts) {
  const { invoice, customer, created_by_user_id, fromApprovalHook } = opts;

  // Already pending_approval and we're NOT coming from the hook → re-emit
  // the original approval and bail.
  if (invoice.gl_status === "pending_approval" && !fromApprovalHook) {
    const { data: pending } = await admin
      .from("approval_requests")
      .select("id")
      .eq("context_table", "ar_invoices")
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
    .from("ar_invoice_lines")
    .select("*")
    .eq("ar_invoice_id", invoice.id)
    .order("line_number", { ascending: true });
  if (lErr) return { status: 500, error: lErr.message };
  if (!lines || lines.length === 0) {
    return { status: 400, error: "Cannot post an invoice with no lines" };
  }
  const hasInventoryLine = lines.some((l) => l.inventory_item_id);

  // 2. Resolve account chain
  let accounts;
  try {
    accounts = await resolveAccounts(admin, invoice.entity_id, invoice, hasInventoryLine);
  } catch (e) {
    return { status: 400, error: e instanceof Error ? e.message : String(e) };
  }

  // 3. Approval gate (skip when re-entering from hook)
  if (!fromApprovalHook) {
    let check;
    try {
      check = await requestIfRequired(admin, {
        kind: "ar_invoice",
        entity_id: invoice.entity_id,
        context_table: "ar_invoices",
        context_id: invoice.id,
        amount_cents: Number(invoice.total_amount_cents) || 0,
        source_kind: "ar_invoice",
        payload: {
          customer_id: invoice.customer_id,
          customer_code: customer?.customer_code || null,
          customer_name: customer?.name || null,
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
        .from("ar_invoices")
        .update({ gl_status: "pending_approval" })
        .eq("id", invoice.id);

      try {
        await enqueueNotification(admin, {
          entity_id: invoice.entity_id,
          kind: "ar_invoice_approval_requested",
          severity: "warn",
          subject: `AR invoice ${invoice.invoice_number} needs approval`,
          body: `AR invoice ${invoice.invoice_number} for ${customer?.name || customer?.customer_code || invoice.customer_id} (total ${formatCents(invoice.total_amount_cents)}) is pending approval.`,
          context_table: "ar_invoices",
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

    // 3b. Customer credit-limit gate (P4-7). Computes the customer's open AR
    // balance (excluding this in-flight invoice) and checks whether posting
    // this invoice would push the projected balance past credit_limit_cents.
    // No-op when the customer has credit_limit_cents IS NULL or 0 (= no limit).
    let creditCheck;
    try {
      creditCheck = await checkCreditLimit(admin, {
        customer_id: invoice.customer_id,
        exclude_invoice_id: invoice.id,
        proposed_amount_cents: Number(invoice.total_amount_cents) || 0,
      });
    } catch (e) {
      return { status: 500, error: `Credit check failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (creditCheck.would_breach) {
      let creditApproval;
      try {
        creditApproval = await requestIfRequired(admin, {
          kind: "customer_credit_extension",
          entity_id: invoice.entity_id,
          context_table: "ar_invoices",
          context_id: invoice.id,
          amount_cents: creditCheck.breach_amount_cents,
          source_kind: "customer_credit_extension",
          payload: {
            customer_id: invoice.customer_id,
            customer_name: customer?.name || null,
            invoice_number: invoice.invoice_number,
            invoice_total_cents: invoice.total_amount_cents,
            credit_limit_cents: creditCheck.credit_limit_cents,
            current_open_cents: creditCheck.current_open_cents,
            projected_balance_cents: creditCheck.projected_balance_cents,
            breach_amount_cents: creditCheck.breach_amount_cents,
          },
          created_by_user_id,
        });
      } catch (e) {
        if (e instanceof ApprovalsError) {
          return { status: 500, error: `Credit approval gate failed: ${e.message}` };
        }
        return { status: 500, error: e instanceof Error ? e.message : String(e) };
      }

      if (creditApproval.required) {
        await admin
          .from("ar_invoices")
          .update({ gl_status: "pending_approval" })
          .eq("id", invoice.id);

        try {
          await enqueueNotification(admin, {
            entity_id: invoice.entity_id,
            kind: "customer_credit_extension_requested",
            severity: "warn",
            subject: `Credit-limit breach: ${customer?.name || invoice.customer_id}`,
            body: `Posting AR invoice ${invoice.invoice_number} (${formatCents(invoice.total_amount_cents)}) would push ${customer?.name || customer?.customer_code || invoice.customer_id}'s open balance to ${formatCents(creditCheck.projected_balance_cents)}, exceeding the credit limit of ${formatCents(creditCheck.credit_limit_cents)} by ${formatCents(creditCheck.breach_amount_cents)}.`,
            context_table: "ar_invoices",
            context_id: invoice.id,
            recipient_roles: ["admin"],
            created_by_user_id,
          });
        } catch { /* non-fatal */ }

        return {
          status: 202,
          body: {
            requires_approval: true,
            approval_request_id: creditApproval.request_id,
            credit_check: creditCheck,
          },
        };
      }
    }
  }

  // 4. Build + post
  const eventData = buildPostingEventData(invoice, lines, accounts);

  // P15 — under enforcement, consume inventory from the sale's brand pool
  // (AR = wholesale channel). Inert otherwise: null → FIFO draws across all
  // layers exactly as before.
  if (brandScopeMode() === "enforce" && invoice.brand_id) {
    eventData.consume_partition_id = await resolveReceivingPartition(admin, invoice.brand_id, "WS");
  }

  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "ar_invoice_sent",
      entity_id: invoice.entity_id,
      created_by_user_id,
      reason: `Post AR invoice ${invoice.invoice_number ?? invoice.id}`,
      data: eventData,
    });
  } catch (e) {
    if (e instanceof PostingError) {
      return { status: 400, error: `Posting failed: ${e.message}` };
    }
    return { status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  // 5. Write back per-line cogs_cents from consume_results, keyed by target_line_id.
  if (Array.isArray(postResult.consume_results) && postResult.consume_results.length > 0) {
    const nowIso = new Date().toISOString();
    for (const cr of postResult.consume_results) {
      if (!cr.target_line_id) continue;
      try {
        await admin
          .from("ar_invoice_lines")
          .update({
            cogs_cents: cr.cogs_cents,
            cogs_resolved_at: nowIso,
          })
          .eq("id", cr.target_line_id);
      } catch { /* non-fatal — operator can reconcile via consume_results audit */ }
    }
  }

  // 6. Stamp invoice with accrual_je_id + flip gl_status='sent'
  const { error: upErr } = await admin
    .from("ar_invoices")
    .update({
      accrual_je_id: postResult.accrual_je_id,
      gl_status: "sent",
    })
    .eq("id", invoice.id);
  if (upErr) {
    return {
      status: 500,
      error: `JE posted (${postResult.accrual_je_id}) but invoice update failed: ${upErr.message}`,
    };
  }

  // 7. Notification
  try {
    await enqueueNotification(admin, {
      entity_id: invoice.entity_id,
      kind: "ar_invoice_posted",
      severity: "info",
      subject: `AR invoice ${invoice.invoice_number} sent`,
      body: `AR invoice ${invoice.invoice_number} (total ${formatCents(invoice.total_amount_cents)}) has been posted to the GL.`,
      context_table: "ar_invoices",
      context_id: invoice.id,
      recipient_roles: ["admin", "accountant"],
      created_by_user_id,
    });
  } catch { /* non-fatal */ }

  return {
    status: 200,
    body: {
      requires_approval: false,
      accrual_je_id: postResult.accrual_je_id,
      gl_status: "sent",
      consume_results: postResult.consume_results || [],
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
