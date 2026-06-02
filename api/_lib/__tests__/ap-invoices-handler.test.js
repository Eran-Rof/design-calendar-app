// Tests for P3-2 AP invoices handler validation + status guards.
//
// We exercise the pure validator exports here. The actual posting/approval
// flows are exercised by ap-invoices-post.test.js (mocked Supabase + libs).

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/ap-invoices/index.js";
import { validatePatch } from "../../_handlers/internal/ap-invoices/[id].js";

const UUID = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";
const UUID3 = "00000000-0000-0000-0000-000000000003";

describe("ap-invoices validateInsert", () => {
  it("rejects missing vendor_id", () => {
    expect(validateInsert({}).error).toMatch(/vendor_id/);
  });
  it("rejects non-uuid vendor_id", () => {
    expect(validateInsert({ vendor_id: "abc" }).error).toMatch(/vendor_id/);
  });
  it("rejects missing invoice_number", () => {
    expect(validateInsert({ vendor_id: UUID, posting_date: "2026-05-26", lines: [] }).error)
      .toMatch(/invoice_number/);
  });
  it("rejects bad posting_date format", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "5/26/2026", lines: [],
    }).error).toMatch(/posting_date/);
  });
  it("rejects invoice_kind not in enum", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26", invoice_kind: "nope",
      lines: [{ expense_account_id: UUID2, amount_cents: 1000 }],
    }).error).toMatch(/invoice_kind/);
  });
  it("rejects due_date before posting_date", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1",
      posting_date: "2026-05-26", due_date: "2026-04-01",
      lines: [{ expense_account_id: UUID2, amount_cents: 1000 }],
    }).error).toMatch(/due_date/);
  });
  it("rejects empty lines array", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26", lines: [],
    }).error).toMatch(/lines/);
  });
  it("rejects missing lines key", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
    }).error).toMatch(/lines/);
  });
  it("rejects line with neither inventory nor expense+amount", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
      lines: [{ description: "no amount" }],
    }).error).toMatch(/inventory.*expense/);
  });
  it("rejects expense line with non-positive amount", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
      lines: [{ expense_account_id: UUID2, amount_cents: 0 }],
    }).error).toMatch(/amount_cents must be > 0/);
  });
  it("rejects expense line with non-uuid expense_account_id", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
      lines: [{ expense_account_id: "not-uuid", amount_cents: 1000 }],
    }).error).toMatch(/expense_account_id/);
  });
  it("rejects inventory line missing quantity", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
      lines: [{ inventory_item_id: UUID3, unit_cost_cents: 500 }],
    }).error).toMatch(/quantity/);
  });
  it("rejects inventory line with negative unit_cost_cents", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
      lines: [{ inventory_item_id: UUID3, quantity: 5, unit_cost_cents: -100 }],
    }).error).toMatch(/unit_cost_cents/);
  });
  it("rejects non-uuid inventory_item_id", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
      lines: [{ inventory_item_id: "abc", quantity: 5, unit_cost_cents: 100 }],
    }).error).toMatch(/inventory_item_id/);
  });
  it("rejects expense_account_id at header that's non-uuid", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
      expense_account_id: "abc",
      lines: [{ expense_account_id: UUID2, amount_cents: 100 }],
    }).error).toMatch(/expense_account_id/);
  });
  it("rejects ap_account_id at header that's non-uuid", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X1", posting_date: "2026-05-26",
      ap_account_id: "abc",
      lines: [{ expense_account_id: UUID2, amount_cents: 100 }],
    }).error).toMatch(/ap_account_id/);
  });

  it("accepts a single expense line", () => {
    const v = validateInsert({
      vendor_id: UUID, invoice_number: "INV-001", posting_date: "2026-05-26",
      lines: [{ expense_account_id: UUID2, amount_cents: 12500, description: "consulting" }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(1);
    expect(v.data.lines[0].quantity).toBe(1);
    expect(v.data.lines[0].unit_cost_cents).toBe("12500");
    expect(v.data.lines[0].inventory_item_id).toBeNull();
  });

  it("accepts a mix of expense and inventory lines", () => {
    const v = validateInsert({
      vendor_id: UUID, invoice_number: "INV-002", posting_date: "2026-05-26",
      lines: [
        { expense_account_id: UUID2, amount_cents: 5000 },
        { inventory_item_id: UUID3, quantity: 10, unit_cost_cents: 1000 },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(2);
    expect(v.data.lines[0].inventory_item_id).toBeNull();
    expect(v.data.lines[1].inventory_item_id).toBe(UUID3);
    expect(v.data.lines[1].quantity).toBe(10);
  });

  it("defaults invoice_kind to vendor_bill", () => {
    const v = validateInsert({
      vendor_id: UUID, invoice_number: "X", posting_date: "2026-05-26",
      lines: [{ expense_account_id: UUID2, amount_cents: 100 }],
    });
    expect(v.data.invoice_kind).toBe("vendor_bill");
  });

  it("accepts amount_cents as a string of digits", () => {
    const v = validateInsert({
      vendor_id: UUID, invoice_number: "X", posting_date: "2026-05-26",
      lines: [{ expense_account_id: UUID2, amount_cents: "999999999" }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines[0].unit_cost_cents).toBe("999999999");
  });

  it("rejects amount_cents that's a non-integer string", () => {
    expect(validateInsert({
      vendor_id: UUID, invoice_number: "X", posting_date: "2026-05-26",
      lines: [{ expense_account_id: UUID2, amount_cents: "12.50" }],
    }).error).toMatch(/amount_cents/);
  });
});

describe("ap-invoices validatePatch", () => {
  it("rejects entity_id change", () => {
    expect(validatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });
  it("rejects gl_status change", () => {
    expect(validatePatch({ gl_status: "posted" }).error).toMatch(/gl_status/);
  });
  it("rejects total_amount_cents direct write", () => {
    expect(validatePatch({ total_amount_cents: 9999 }).error).toMatch(/amount fields/);
  });
  it("rejects paid_amount_cents direct write", () => {
    expect(validatePatch({ paid_amount_cents: 9999 }).error).toMatch(/amount fields/);
  });
  it("rejects accrual_je_id direct write", () => {
    expect(validatePatch({ accrual_je_id: UUID }).error).toMatch(/JE pointers/);
  });

  it("accepts vendor_id change with valid uuid", () => {
    const v = validatePatch({ vendor_id: UUID });
    expect(v.error).toBeUndefined();
    expect(v.data.header.vendor_id).toBe(UUID);
  });
  it("rejects non-uuid vendor_id", () => {
    expect(validatePatch({ vendor_id: "x" }).error).toMatch(/vendor_id/);
  });
  it("rejects bad invoice_kind", () => {
    expect(validatePatch({ invoice_kind: "garbage" }).error).toMatch(/invoice_kind/);
  });
  it("accepts invoice_number trim", () => {
    expect(validatePatch({ invoice_number: "  X-1  " }).data.header.invoice_number).toBe("X-1");
  });
  it("rejects empty invoice_number", () => {
    expect(validatePatch({ invoice_number: "  " }).error).toMatch(/invoice_number/);
  });
  it("rejects bad posting_date", () => {
    expect(validatePatch({ posting_date: "tomorrow" }).error).toMatch(/posting_date/);
  });
  it("accepts due_date null", () => {
    expect(validatePatch({ due_date: null }).data.header.due_date).toBeNull();
  });
  it("rejects lines as empty array", () => {
    expect(validatePatch({ lines: [] }).error).toMatch(/lines/);
  });
  it("accepts lines replacement", () => {
    const v = validatePatch({
      lines: [{ expense_account_id: UUID, amount_cents: 100 }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(1);
    expect(v.data.lines[0].unit_cost_cents).toBe("100");
  });
  it("returns empty header + null lines for {}", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(v.data.header).toEqual({});
    expect(v.data.lines).toBeNull();
  });
});
