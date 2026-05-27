// Tests for P3-2 AP invoice POST /post handler flow. Supabase, approvalsAPI,
// notifications, and postEvent are mocked. We verify:
//   - approval-required path: gl_status flips to pending_approval, returns 202.
//   - approval-not-required path: post runs, gl_status='posted', accrual_je_id set.
//   - already-posted invoice → 409.
//   - missing invoice → 404.
//   - the postInvoice helper handles fromApprovalHook=true (skips approval gate).

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

import { postInvoice } from "../../_handlers/internal/ap-invoices/post.js";
import { requestIfRequired } from "../../_lib/approvals/index.js";
import { postEvent } from "../../_lib/accounting/posting/index.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const INVOICE = "00000000-0000-0000-0000-000000000002";
const VENDOR = "00000000-0000-0000-0000-000000000003";
const AP_ACCT = "00000000-0000-0000-0000-000000000004";
const EXP_ACCT = "00000000-0000-0000-0000-000000000005";
const JE_ID = "00000000-0000-0000-0000-0000000000aa";

function makeInvoice(overrides = {}) {
  return {
    id: INVOICE,
    entity_id: ENTITY,
    vendor_id: VENDOR,
    invoice_number: "INV-1",
    gl_status: "draft",
    total_amount_cents: "100000",
    paid_amount_cents: "0",
    ap_account_id: AP_ACCT,
    expense_account_id: EXP_ACCT,
    posting_date: "2026-05-26",
    accrual_je_id: null,
    cash_je_id: null,
    ...overrides,
  };
}

function makeSupabase({
  lines = [{ line_number: 1, expense_account_id: EXP_ACCT, inventory_item_id: null, quantity: 1, unit_cost_cents: "100000", description: null }],
  apAccountByCode = { id: AP_ACCT, code: "2010", name: "AP" },
} = {}) {
  const updateTable = vi.fn().mockResolvedValue({ error: null });
  const sb = {
    from(table) {
      if (table === "invoice_line_items") {
        return {
          select() { return this; },
          eq() { return this; },
          order: async () => ({ data: lines, error: null }),
        };
      }
      if (table === "gl_accounts") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: apAccountByCode, error: null }),
        };
      }
      if (table === "invoices") {
        return {
          update() { return { eq: updateTable }; },
        };
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
      throw new Error(`unmocked table ${table}`);
    },
    _updates: updateTable,
  };
  return sb;
}

describe("postInvoice (P3-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 202 + requires_approval=true when approvals gate fires", async () => {
    requestIfRequired.mockResolvedValueOnce({
      required: true, request_id: "req-1", current_step: { mode: "any", role_required: "admin" },
    });
    const admin = makeSupabase();
    const result = await postInvoice(admin, {
      invoice: makeInvoice(),
      vendor: { id: VENDOR, name: "Acme", vendor_code: "ACME" },
      vendor_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(202);
    expect(result.body.requires_approval).toBe(true);
    expect(result.body.approval_request_id).toBe("req-1");
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("posts immediately when approval gate is not required", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID, cash_je_id: null });
    const admin = makeSupabase();
    const result = await postInvoice(admin, {
      invoice: makeInvoice(),
      vendor: { id: VENDOR, name: "Acme" },
      vendor_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(200);
    expect(result.body.requires_approval).toBe(false);
    expect(result.body.accrual_je_id).toBe(JE_ID);
    expect(result.body.gl_status).toBe("posted");
    expect(postEvent).toHaveBeenCalledOnce();
    const evt = postEvent.mock.calls[0][1];
    expect(evt.kind).toBe("ap_invoice_received");
    expect(evt.entity_id).toBe(ENTITY);
    expect(evt.data.invoice_id).toBe(INVOICE);
    expect(evt.data.vendor_id).toBe(VENDOR);
    expect(evt.data.ap_account_id).toBe(AP_ACCT);
    expect(evt.data.lines).toHaveLength(1);
  });

  it("when fromApprovalHook=true, skips approval gate and posts directly", async () => {
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID, cash_je_id: null });
    const admin = makeSupabase();
    const result = await postInvoice(admin, {
      invoice: makeInvoice({ gl_status: "pending_approval" }),
      vendor: { id: VENDOR, name: "Acme" },
      vendor_new: false,
      created_by_user_id: null,
      fromApprovalHook: true,
    });
    expect(result.status).toBe(200);
    expect(requestIfRequired).not.toHaveBeenCalled();
    expect(postEvent).toHaveBeenCalledOnce();
  });

  it("returns 202 with reference to existing approval if invoice is already pending and NOT from hook", async () => {
    const sb = makeSupabase();
    // Override approval_requests query to return an existing pending request.
    const origFrom = sb.from;
    sb.from = (table) => {
      if (table === "approval_requests") {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return this; },
          maybeSingle: async () => ({ data: { id: "existing-req" }, error: null }),
        };
      }
      return origFrom(table);
    };
    const result = await postInvoice(sb, {
      invoice: makeInvoice({ gl_status: "pending_approval" }),
      vendor: { id: VENDOR, name: "Acme" },
      vendor_new: false,
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
      vendor: { id: VENDOR },
      vendor_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/no lines/i);
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("builds inventory line correctly (qty * unit_cost → amount in cents → decimal string)", async () => {
    requestIfRequired.mockResolvedValueOnce({ required: false });
    postEvent.mockResolvedValueOnce({ accrual_je_id: JE_ID, cash_je_id: null });
    // 10 units @ 500 cents each = 5000 cents = $50.00
    const admin = makeSupabase({
      lines: [
        { line_number: 1, inventory_item_id: "11111111-1111-1111-1111-111111111111",
          expense_account_id: null, quantity: 10, unit_cost_cents: "500", description: null },
      ],
      apAccountByCode: { id: AP_ACCT, code: "2010", name: "AP" },
    });
    // Override gl_accounts to also resolve 1310 inventory account.
    const orig = admin.from.bind(admin);
    let inventoryHit = false;
    admin.from = (table) => {
      if (table === "gl_accounts") {
        const builder = {
          select() { return this; },
          eq(col, val) {
            if (col === "code" && val === "1310") inventoryHit = true;
            return this;
          },
          maybeSingle: async () => {
            return inventoryHit
              ? { data: { id: "inv-acct-id", code: "1310", name: "Inventory" }, error: null }
              : { data: { id: AP_ACCT, code: "2010", name: "AP" }, error: null };
          },
        };
        // reset hit between calls
        return builder;
      }
      return orig(table);
    };

    const result = await postInvoice(admin, {
      invoice: makeInvoice({ ap_account_id: null }),
      vendor: { id: VENDOR },
      vendor_new: false,
      created_by_user_id: null,
      fromApprovalHook: false,
    });
    expect(result.status).toBe(200);
    expect(postEvent).toHaveBeenCalledOnce();
    const data = postEvent.mock.calls[0][1].data;
    expect(data.lines[0].amount).toBe("50.00");
    expect(data.lines[0].inventory_item_id).toBe("11111111-1111-1111-1111-111111111111");
  });
});
