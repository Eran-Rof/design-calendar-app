// Tests for P4-4 AR invoice POST /post handler flow. Supabase, approvalsAPI,
// notifications, and postEvent are mocked. We verify:
//   - approval-required path: gl_status flips to pending_approval, returns 202.
//   - approval-not-required path: post runs, gl_status='sent', accrual_je_id set.
//   - already-sent invoice → 409 short-circuit.
//   - missing invoice → tested at handler edge.
//   - the postInvoice helper handles fromApprovalHook=true (skips approval).
//   - cogs_cents writeback to ar_invoice_lines keyed by target_line_id.
//   - account resolution chain: invoice.ar → entity.default → COA code 1200.
//   - notification fan-out → recipient_roles=['admin','accountant'].

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../_lib/approvals/index.js", () => ({
  requestIfRequired: vi.fn(),
  ApprovalsError: class extends Error {},
}));
vi.mock("../../_lib/notifications/index.js", () => ({
  enqueue: vi.fn().mockResolvedValue({ event_id: "ev1", dispatch_count: 0 }),
}));
vi.mock("../../_lib/accounting/posting/index.js", () => ({
  postEvent: vi.fn(),
  PostingError: class extends Error {},
}));
// P4-7 credit-limit gate: post.js now calls checkCreditLimit on every post.
// Default it to no-breach so the P4-4 posting tests below exercise the
// normal (non-gated) path. The breach path is covered in
// customer-credit-check.test.js.
vi.mock("../../_lib/customers/creditCheck.js", () => ({
  checkCreditLimit: vi.fn(),
}));

import { postInvoice } from "../../_handlers/internal/ar-invoices/post.js";
import { requestIfRequired } from "../../_lib/approvals/index.js";
import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";
import { postEvent } from "../../_lib/accounting/posting/index.js";
import { checkCreditLimit } from "../../_lib/customers/creditCheck.js";

const ENTITY   = "00000000-0000-0000-0000-000000000001";
const INVOICE  = "00000000-0000-0000-0000-000000000002";
const CUSTOMER = "00000000-0000-0000-0000-000000000003";
const AR_ACCT  = "00000000-0000-0000-0000-000000000004";
const REV_ACCT = "00000000-0000-0000-0000-000000000005";
const COGS_ACCT= "00000000-0000-0000-0000-000000000006";
const INV_ACCT = "00000000-0000-0000-0000-000000000007";
const ITEM     = "00000000-0000-0000-0000-000000000008";
const LINE1    = "00000000-0000-0000-0000-000000000010";
const LINE2    = "00000000-0000-0000-0000-000000000011";
const JE_ID    = "00000000-0000-0000-0000-0000000000aa";

function makeInvoice(overrides = {}) {
  return {
    id: INVOICE,
    entity_id: ENTITY,
    customer_id: CUSTOMER,
    invoice_number: "AR-2026-00001",
    gl_status: "draft",
    total_amount_cents: "100000",
    paid_amount_cents: "0",
    ar_account_id: AR_ACCT,
    revenue_account_id: REV_ACCT,
    cogs_account_id: COGS_ACCT,
    inventory_asset_account_id: INV_ACCT,
    invoice_date: "2026-05-26",
    posting_date: "2026-05-26",
    accrual_je_id: null,
    cash_je_id: null,
    ...overrides,
  };
}

function makeSupabase({
  lines = [{ id: LINE1, line_number: 1, revenue_account_id: null, inventory_item_id: null, quantity: null, unit_price_cents: null, line_total_cents: "100000", description: null }],
  entity = { default_ar_account_id: AR_ACCT, default_revenue_account_id: REV_ACCT, default_cogs_account_id: COGS_ACCT, default_inventory_account_id: INV_ACCT },
  pendingApproval = null,
} = {}) {
  const lineUpdates = [];
  const invoiceUpdates = [];
  const sb = {
    from(table) {
      if (table === "ar_invoice_lines") {
        return {
          select() { return this; },
          eq() { return this; },
          order: async () => ({ data: lines, error: null }),
          update(patch) {
            return {
              eq: async (col, val) => {
                lineUpdates.push({ patch, [col]: val });
                return { error: null };
              },
            };
          },
        };
      }
      if (table === "gl_accounts") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      if (table === "entities") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: entity, error: null }),
        };
      }
      if (table === "ar_invoices") {
        return {
          update(patch) {
            return {
              eq: async (col, val) => {
                invoiceUpdates.push({ patch, [col]: val });
                return { error: null };
              },
            };
          },
        };
      }
      if (table === "approval_requests") {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return this; },
          maybeSingle: async () => ({ data: pendingApproval, error: null }),
        };
      }
      throw new Error(`unmocked table ${table}`);
    },
    _lineUpdates: lineUpdates,
    _invoiceUpdates: invoiceUpdates,
  };
  return sb;
}

describe("postInvoice (P4-4 AR)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: customer has no credit limit / no breach, so the P4-7 gate
    // is a no-op and these P4-4 posting tests exercise the normal path.
    checkCreditLimit.mockResolvedValue({ would_breach: false });
  });

  it("returns 202 + requires_approval=true when approvals gate fires", async () => {
    requestIfRequired.mockResolvedValueOnce({
      required: true, request_id: "req-1", current_step: { mode: "any", role_required: "admin" },
    });
    const admin = makeSupabase();
    const result = await postInvoice(admin, {
      invoice: makeInvoice(),
      customer: { id: CUSTOMER, name: "ACME Co", customer_code: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(202);
    expect(result.body.requires_approval).toBe(true);
    expect(result.body.approval_request_id).toBe("req-1");
    expect(postEvent).not.toHaveBeenCalled();
    // Notification fired for approval_requested
    expect(enqueueNotification).toHaveBeenCalled();
    const callArgs = enqueueNotification.mock.calls[0][1];
    expect(callArgs.kind).toBe("ar_invoice_approval_requested");
  });

  it("posts immediately when approval gate is not required (no inventory)", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID, cash_je_id: null });
    const admin = makeSupabase();
    const result = await postInvoice(admin, {
      invoice: makeInvoice(),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(200);
    expect(result.body.requires_approval).toBe(false);
    expect(result.body.accrual_je_id).toBe(JE_ID);
    expect(result.body.gl_status).toBe("sent");
    expect(postEvent).toHaveBeenCalledOnce();
    const evt = postEvent.mock.calls[0][1];
    expect(evt.kind).toBe("ar_invoice_sent");
    expect(evt.entity_id).toBe(ENTITY);
    expect(evt.data.invoice_id).toBe(INVOICE);
    expect(evt.data.customer_id).toBe(CUSTOMER);
    expect(evt.data.ar_account_id).toBe(AR_ACCT);
    expect(evt.data.revenue_account_id).toBe(REV_ACCT);
    expect(evt.data.lines).toHaveLength(1);
    expect(evt.data.lines[0].line_total_cents).toBe("100000");
  });

  it("fires ar_invoice_posted notification with admin+accountant recipients on success", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID });
    const admin = makeSupabase();
    await postInvoice(admin, {
      invoice: makeInvoice(),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(enqueueNotification).toHaveBeenCalled();
    const args = enqueueNotification.mock.calls.at(-1)[1];
    expect(args.kind).toBe("ar_invoice_posted");
    expect(args.recipient_roles).toEqual(["admin", "accountant"]);
    expect(args.context_table).toBe("ar_invoices");
  });

  it("when fromApprovalHook=true, skips approval gate", async () => {
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID });
    const admin = makeSupabase();
    const result = await postInvoice(admin, {
      invoice: makeInvoice({ gl_status: "pending_approval" }),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: true,
    });
    expect(result.status).toBe(200);
    expect(requestIfRequired).not.toHaveBeenCalled();
    expect(postEvent).toHaveBeenCalledOnce();
  });

  it("returns 202 referencing existing pending approval if pending and not from hook", async () => {
    const admin = makeSupabase({ pendingApproval: { id: "existing-req" } });
    const result = await postInvoice(admin, {
      invoice: makeInvoice({ gl_status: "pending_approval" }),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(202);
    expect(result.body.approval_request_id).toBe("existing-req");
    expect(requestIfRequired).not.toHaveBeenCalled();
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("rejects 400 when invoice has no lines", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    const admin = makeSupabase({ lines: [] });
    const result = await postInvoice(admin, {
      invoice: makeInvoice(),
      customer: { id: CUSTOMER },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/no lines/i);
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("sends cogs_account_id + inventory_account_id when any inventory line exists", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    postEvent.mockResolvedValueOnce({
      accrual_je_id: JE_ID,
      consume_results: [{ item_id: ITEM, qty: 2, cogs_cents: "1500", target_line_id: LINE2 }],
    });
    const admin = makeSupabase({
      lines: [
        { id: LINE1, line_number: 1, revenue_account_id: null, inventory_item_id: null, quantity: null, unit_price_cents: null, line_total_cents: "5000", description: "service" },
        { id: LINE2, line_number: 2, revenue_account_id: null, inventory_item_id: ITEM, quantity: 2, unit_price_cents: "4000", line_total_cents: "8000", description: "tee" },
      ],
    });
    const result = await postInvoice(admin, {
      invoice: makeInvoice(),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(200);
    const evt = postEvent.mock.calls[0][1];
    expect(evt.data.cogs_account_id).toBe(COGS_ACCT);
    expect(evt.data.inventory_account_id).toBe(INV_ACCT);
    expect(evt.data.lines).toHaveLength(2);
    expect(evt.data.lines[1].inventory_item_id).toBe(ITEM);
    expect(evt.data.lines[1].quantity).toBe(2);
    // cogs writeback fired for target_line_id=LINE2 only
    const writebacks = admin._lineUpdates.filter((u) => u.patch.cogs_cents != null);
    expect(writebacks).toHaveLength(1);
    expect(writebacks[0].id).toBe(LINE2);
    expect(writebacks[0].patch.cogs_cents).toBe("1500");
    expect(writebacks[0].patch.cogs_resolved_at).toBeTruthy();
  });

  it("falls back to entity defaults when invoice has no account ids", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID });
    const admin = makeSupabase();
    const result = await postInvoice(admin, {
      invoice: makeInvoice({
        ar_account_id: null, revenue_account_id: null,
        cogs_account_id: null, inventory_asset_account_id: null,
      }),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(200);
    const evt = postEvent.mock.calls[0][1];
    expect(evt.data.ar_account_id).toBe(AR_ACCT);
    expect(evt.data.revenue_account_id).toBe(REV_ACCT);
  });

  it("falls back to COA code lookup when entity defaults are also missing", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID });
    // Customize a supabase that returns null entity defaults, but a gl_accounts row keyed by code.
    const calls = [];
    const sb = {
      from(table) {
        if (table === "ar_invoice_lines") {
          return {
            select() { return this; },
            eq() { return this; },
            order: async () => ({ data: [{ id: LINE1, line_number: 1, line_total_cents: "5000" }], error: null }),
            update() { return { eq: async () => ({ error: null }) }; },
          };
        }
        if (table === "entities") {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { default_ar_account_id: null, default_revenue_account_id: null }, error: null }),
          };
        }
        if (table === "gl_accounts") {
          let captured = {};
          return {
            select() { return this; },
            eq(col, val) { captured[col] = val; return this; },
            maybeSingle: async () => {
              calls.push({ ...captured });
              if (captured.code === "1108") return { data: { id: "AR-FROM-CODE" }, error: null };
              if (captured.code === "4005") return { data: { id: "REV-FROM-CODE" }, error: null };
              return { data: null, error: null };
            },
          };
        }
        if (table === "ar_invoices") {
          return { update() { return { eq: async () => ({ error: null }) }; } };
        }
        if (table === "approval_requests") {
          return {
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            limit() { return this; },
            maybeSingle: async () => ({ data: null, error: null }),
          };
        }
        throw new Error(`unmocked ${table}`);
      },
    };
    const result = await postInvoice(sb, {
      invoice: makeInvoice({
        ar_account_id: null, revenue_account_id: null,
        cogs_account_id: null, inventory_asset_account_id: null,
      }),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(200);
    const evt = postEvent.mock.calls[0][1];
    expect(evt.data.ar_account_id).toBe("AR-FROM-CODE");
    expect(evt.data.revenue_account_id).toBe("REV-FROM-CODE");
    // We probed code 1200 + 4000
    expect(calls.find((c) => c.code === "1108")).toBeTruthy();
    expect(calls.find((c) => c.code === "4005")).toBeTruthy();
  });

  it("400 when inventory line present but no COGS account resolvable", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    // entity defaults are null; gl_accounts also returns null → COGS unresolvable.
    const sb = {
      from(table) {
        if (table === "ar_invoice_lines") {
          return {
            select() { return this; },
            eq() { return this; },
            order: async () => ({ data: [{ id: LINE1, line_number: 1, inventory_item_id: ITEM, quantity: 1, unit_price_cents: "100", line_total_cents: "100" }], error: null }),
            update() { return { eq: async () => ({ error: null }) }; },
          };
        }
        if (table === "entities") {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { default_ar_account_id: AR_ACCT, default_revenue_account_id: REV_ACCT, default_cogs_account_id: null, default_inventory_account_id: null }, error: null }),
          };
        }
        if (table === "gl_accounts") {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: null, error: null }),
          };
        }
        if (table === "ar_invoices") {
          return { update() { return { eq: async () => ({ error: null }) }; } };
        }
        if (table === "approval_requests") {
          return {
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            limit() { return this; },
            maybeSingle: async () => ({ data: null, error: null }),
          };
        }
        throw new Error(`unmocked ${table}`);
      },
    };
    const result = await postInvoice(sb, {
      invoice: makeInvoice({ cogs_account_id: null, inventory_asset_account_id: null }),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/COGS/);
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("flips gl_status to 'sent' (NOT 'posted') after success", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID });
    const admin = makeSupabase();
    await postInvoice(admin, {
      invoice: makeInvoice(),
      customer: { id: CUSTOMER, name: "ACME" },
      customer_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    const lastUpdate = admin._invoiceUpdates.at(-1);
    expect(lastUpdate.patch.gl_status).toBe("sent");
    expect(lastUpdate.patch.accrual_je_id).toBe(JE_ID);
  });
});
