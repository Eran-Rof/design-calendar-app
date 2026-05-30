// Tests for Tangerine P13-3 — procurement receipts handler validators
// + the D19 receipt-rollup save-rollups validator.

import { describe, it, expect } from "vitest";
import {
  validateReceiptInsert,
  validateRollup,
} from "../../_handlers/internal/procurement/receipts/index.js";
import { validateReceiptPatch } from "../../_handlers/internal/procurement/receipts/[id].js";
import { validateSaveRollupsBody } from "../../_handlers/internal/procurement/receipts/save-rollups.js";

const UUID  = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";
const UUID3 = "00000000-0000-0000-0000-000000000003";
const UUID4 = "00000000-0000-0000-0000-000000000004";

describe("procurement validateReceiptInsert", () => {
  it("rejects missing tanda_po_id", () => {
    expect(validateReceiptInsert({}).error).toMatch(/tanda_po_id/);
  });
  it("rejects non-uuid tanda_po_id", () => {
    expect(validateReceiptInsert({ tanda_po_id: "x" }).error).toMatch(/tanda_po_id/);
  });
  it("defaults receipt_date to today and rejects nothing for missing date", () => {
    const v = validateReceiptInsert({
      tanda_po_id: UUID,
      lines: [{ po_line_item_id: UUID2, qty_received: 5, qty_accepted: 5, unit_cost_cents: 100 }],
    });
    expect(v.error).toBeUndefined();
    expect(/^\d{4}-\d{2}-\d{2}$/.test(v.data.receipt_date)).toBe(true);
  });
  it("rejects malformed receipt_date", () => {
    expect(validateReceiptInsert({
      tanda_po_id: UUID, receipt_date: "5/29/2026", lines: [],
    }).error).toMatch(/receipt_date/);
  });
  it("rejects empty lines", () => {
    expect(validateReceiptInsert({ tanda_po_id: UUID, lines: [] }).error).toMatch(/lines/);
  });
  it("rejects line with non-uuid po_line_item_id", () => {
    expect(validateReceiptInsert({
      tanda_po_id: UUID,
      lines: [{ po_line_item_id: "x", qty_received: 1, qty_accepted: 1, unit_cost_cents: 100 }],
    }).error).toMatch(/po_line_item_id/);
  });
  it("rejects qty_received <= 0", () => {
    expect(validateReceiptInsert({
      tanda_po_id: UUID,
      lines: [{ po_line_item_id: UUID2, qty_received: 0, qty_accepted: 0, unit_cost_cents: 100 }],
    }).error).toMatch(/qty_received/);
  });
  it("rejects qty_accepted + qty_rejected > qty_received", () => {
    expect(validateReceiptInsert({
      tanda_po_id: UUID,
      lines: [{ po_line_item_id: UUID2, qty_received: 10, qty_accepted: 8, qty_rejected: 5, unit_cost_cents: 100 }],
    }).error).toMatch(/cannot exceed qty_received/);
  });
  it("rejects negative unit_cost_cents", () => {
    expect(validateReceiptInsert({
      tanda_po_id: UUID,
      lines: [{ po_line_item_id: UUID2, qty_received: 5, qty_accepted: 5, unit_cost_cents: -1 }],
    }).error).toMatch(/unit_cost_cents/);
  });
  it("accepts a full valid receipt with rollups", () => {
    const v = validateReceiptInsert({
      tanda_po_id: UUID,
      receipt_date: "2026-05-29",
      received_by_employee_id: UUID2,
      notes: "container ABC1234",
      lines: [
        { po_line_item_id: UUID3, qty_received: 600, qty_accepted: 600, qty_rejected: 0, unit_cost_cents: 450 },
      ],
      rollups: [
        { expense_gl_account_id: UUID4, amount_cents: 125000, vendor_id: UUID2, description: "Inbound freight", capitalized_to_inventory: true },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(1);
    expect(v.data.rollups).toHaveLength(1);
    expect(v.data.rollups[0].capitalized_to_inventory).toBe(true);
  });
});

describe("procurement validateRollup", () => {
  it("rejects missing expense_gl_account_id", () => {
    expect(validateRollup({}, 1).error).toMatch(/expense_gl_account_id/);
  });
  it("rejects amount_cents <= 0", () => {
    expect(validateRollup({
      expense_gl_account_id: UUID, amount_cents: 0, description: "X",
    }, 1).error).toMatch(/amount_cents/);
  });
  it("rejects non-uuid vendor_id", () => {
    expect(validateRollup({
      expense_gl_account_id: UUID, amount_cents: 100, vendor_id: "x", description: "X",
    }, 1).error).toMatch(/vendor_id/);
  });
  it("rejects empty description", () => {
    expect(validateRollup({
      expense_gl_account_id: UUID, amount_cents: 100, description: "  ",
    }, 1).error).toMatch(/description/);
  });
  it("defaults capitalized_to_inventory to true", () => {
    const v = validateRollup({
      expense_gl_account_id: UUID, amount_cents: 100, description: "X",
    }, 1);
    expect(v.error).toBeUndefined();
    expect(v.data.capitalized_to_inventory).toBe(true);
  });
  it("respects capitalized_to_inventory=false", () => {
    const v = validateRollup({
      expense_gl_account_id: UUID, amount_cents: 100, description: "X", capitalized_to_inventory: false,
    }, 1);
    expect(v.error).toBeUndefined();
    expect(v.data.capitalized_to_inventory).toBe(false);
  });
});

describe("procurement validateReceiptPatch (status transitions)", () => {
  it("allows draft → pending_approval", () => {
    const v = validateReceiptPatch({ status: "pending_approval" }, "draft");
    expect(v.error).toBeUndefined();
    expect(v.data.header.status).toBe("pending_approval");
  });
  it("rejects draft → posted", () => {
    expect(validateReceiptPatch({ status: "posted" }, "draft").error).toMatch(/Cannot transition/);
  });
  it("allows approved → posted", () => {
    const v = validateReceiptPatch({ status: "posted" }, "approved");
    expect(v.error).toBeUndefined();
  });
  it("rejects transition from terminal posted", () => {
    expect(validateReceiptPatch({ status: "draft" }, "posted").error).toMatch(/Cannot transition/);
  });
  it("blocks notes edit when status != draft", () => {
    expect(validateReceiptPatch({ notes: "x" }, "approved").error).toMatch(/Cannot edit notes/);
  });
  it("accepts notes edit while in draft", () => {
    const v = validateReceiptPatch({ notes: "test" }, "draft");
    expect(v.error).toBeUndefined();
    expect(v.data.header.notes).toBe("test");
  });
  it("blocks lines replace when status != draft", () => {
    expect(validateReceiptPatch({
      lines: [{ po_line_item_id: UUID, qty_received: 1, qty_accepted: 1, unit_cost_cents: 0 }],
    }, "approved").error).toMatch(/Cannot replace lines/);
  });
  it("accepts lines replace while draft", () => {
    const v = validateReceiptPatch({
      lines: [{ po_line_item_id: UUID, qty_received: 5, qty_accepted: 5, unit_cost_cents: 100 }],
    }, "draft");
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(1);
  });
});

describe("procurement validateSaveRollupsBody", () => {
  it("rejects rollups not an array", () => {
    expect(validateSaveRollupsBody({}).error).toMatch(/rollups must be an array/);
  });
  it("accepts empty array (clears rollups)", () => {
    const v = validateSaveRollupsBody({ rollups: [] });
    expect(v.error).toBeUndefined();
    expect(v.data.rollups).toEqual([]);
  });
  it("rejects rollup with bad amount_cents", () => {
    expect(validateSaveRollupsBody({
      rollups: [{ expense_gl_account_id: UUID, amount_cents: 0, description: "X" }],
    }).error).toMatch(/amount_cents/);
  });
  it("accepts multi-rollup body with capitalize mix", () => {
    const v = validateSaveRollupsBody({
      rollups: [
        { expense_gl_account_id: UUID, amount_cents: 100, description: "Freight", capitalized_to_inventory: true },
        { expense_gl_account_id: UUID2, amount_cents: 50,  description: "Inspection", capitalized_to_inventory: false },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.rollups).toHaveLength(2);
    expect(v.data.rollups[0].capitalized_to_inventory).toBe(true);
    expect(v.data.rollups[1].capitalized_to_inventory).toBe(false);
  });
  it("propagates rollup numbering in error message", () => {
    const v = validateSaveRollupsBody({
      rollups: [
        { expense_gl_account_id: UUID, amount_cents: 100, description: "X" },
        { expense_gl_account_id: "bad", amount_cents: 50, description: "Y" },
      ],
    });
    expect(v.error).toMatch(/rollup 2/);
  });
});
