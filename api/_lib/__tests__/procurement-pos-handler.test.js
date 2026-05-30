// Tests for Tangerine P13-3 — procurement PO handler validators.
// Exercises validatePoInsert + validatePoPatch from
// api/_handlers/internal/procurement/pos/{index.js,[id].js}.

import { describe, it, expect } from "vitest";
import { validatePoInsert } from "../../_handlers/internal/procurement/pos/index.js";
import { validatePoPatch } from "../../_handlers/internal/procurement/pos/[id].js";

const UUID  = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";

describe("procurement validatePoInsert", () => {
  it("rejects missing vendor_id", () => {
    expect(validatePoInsert({}).error).toMatch(/vendor_id/);
  });
  it("rejects non-uuid vendor_id", () => {
    expect(validatePoInsert({ vendor_id: "abc" }).error).toMatch(/vendor_id/);
  });
  it("rejects missing expected_landed_cost_cents (D9 strict)", () => {
    expect(validatePoInsert({ vendor_id: UUID, lines: [] }).error).toMatch(/expected_landed_cost_cents/);
  });
  it("rejects negative expected_landed_cost_cents", () => {
    expect(validatePoInsert({
      vendor_id: UUID, expected_landed_cost_cents: -100, lines: [],
    }).error).toMatch(/expected_landed_cost_cents/);
  });
  it("accepts zero expected_landed_cost_cents", () => {
    const v = validatePoInsert({
      vendor_id: UUID, expected_landed_cost_cents: 0, lines: [],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.expected_landed_cost_cents).toBe("0");
  });
  it("rejects malformed date_order", () => {
    expect(validatePoInsert({
      vendor_id: UUID, expected_landed_cost_cents: 100, date_order: "5/26/2026", lines: [],
    }).error).toMatch(/date_order/);
  });
  it("rejects line with non-positive qty_ordered", () => {
    expect(validatePoInsert({
      vendor_id: UUID, expected_landed_cost_cents: 100,
      lines: [{ qty_ordered: 0, unit_price_dollars: 5 }],
    }).error).toMatch(/qty_ordered/);
  });
  it("rejects line with negative unit_price_dollars", () => {
    expect(validatePoInsert({
      vendor_id: UUID, expected_landed_cost_cents: 100,
      lines: [{ qty_ordered: 1, unit_price_dollars: -1 }],
    }).error).toMatch(/unit_price_dollars/);
  });
  it("rejects non-uuid originated_by_employee_id", () => {
    expect(validatePoInsert({
      vendor_id: UUID, expected_landed_cost_cents: 100,
      originated_by_employee_id: "abc", lines: [],
    }).error).toMatch(/originated_by_employee_id/);
  });
  it("rejects empty-string po_number", () => {
    expect(validatePoInsert({
      vendor_id: UUID, expected_landed_cost_cents: 100, po_number: "   ", lines: [],
    }).error).toMatch(/po_number/);
  });
  it("accepts a valid full insert", () => {
    const v = validatePoInsert({
      vendor_id: UUID,
      po_number: "ROF-P000123",
      vendor_name: "Test Vendor",
      date_order: "2026-05-29",
      date_expected: "2026-08-01",
      expected_landed_cost_cents: 270000,
      pilot_vendor_flag: true,
      lines: [
        { item_number: "SKU1", description: "Test item", qty_ordered: 600, unit_price_dollars: 4.5 },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.vendor_id).toBe(UUID);
    expect(v.data.po_number).toBe("ROF-P000123");
    expect(v.data.expected_landed_cost_cents).toBe("270000");
    expect(v.data.pilot_vendor_flag).toBe(true);
    expect(v.data.lines).toHaveLength(1);
    expect(v.data.lines[0].qty_ordered).toBe(600);
    expect(v.data.lines[0].unit_price).toBe(4.5);
  });
});

describe("procurement validatePoPatch (status transitions)", () => {
  it("allows draft → pending_approval", () => {
    const v = validatePoPatch({ procurement_status: "pending_approval" }, "draft");
    expect(v.error).toBeUndefined();
    expect(v.data.header.procurement_status).toBe("pending_approval");
  });
  it("rejects draft → approved (must go through pending_approval)", () => {
    expect(validatePoPatch({ procurement_status: "approved" }, "draft").error).toMatch(/Cannot transition/);
  });
  it("allows pending_approval → approved", () => {
    const v = validatePoPatch({ procurement_status: "approved" }, "pending_approval");
    expect(v.error).toBeUndefined();
  });
  it("allows approved → open", () => {
    const v = validatePoPatch({ procurement_status: "open" }, "approved");
    expect(v.error).toBeUndefined();
  });
  it("allows open → received", () => {
    const v = validatePoPatch({ procurement_status: "received" }, "open");
    expect(v.error).toBeUndefined();
  });
  it("rejects transition from terminal status received", () => {
    expect(validatePoPatch({ procurement_status: "open" }, "received").error).toMatch(/Cannot transition/);
  });
  it("rejects transition from terminal status closed", () => {
    expect(validatePoPatch({ procurement_status: "open" }, "closed").error).toMatch(/Cannot transition/);
  });
  it("rejects transition from terminal status cancelled", () => {
    expect(validatePoPatch({ procurement_status: "draft" }, "cancelled").error).toMatch(/Cannot transition/);
  });
  it("requires cancel_reason when cancelling", () => {
    expect(validatePoPatch({ procurement_status: "cancelled" }, "draft").error).toMatch(/cancel_reason/);
  });
  it("accepts cancellation with reason and stamps cancelled_at", () => {
    const v = validatePoPatch({ procurement_status: "cancelled", cancel_reason: "vendor unreachable" }, "draft");
    expect(v.error).toBeUndefined();
    expect(v.data.header.cancel_reason).toBe("vendor unreachable");
    expect(v.data.header.cancelled_at).toBeDefined();
  });
  it("allows header edits while in draft", () => {
    const v = validatePoPatch({ expected_landed_cost_cents: 50000, date_order: "2026-06-01" }, "draft");
    expect(v.error).toBeUndefined();
    expect(v.data.header.expected_landed_cost_cents).toBe("50000");
    expect(v.data.header.date_order).toBe("2026-06-01");
  });
  it("blocks header edits once past draft", () => {
    expect(validatePoPatch({ expected_landed_cost_cents: 50000 }, "open").error).toMatch(/draft/);
  });
  it("rejects negative expected_landed_cost_cents in patch", () => {
    expect(validatePoPatch({ expected_landed_cost_cents: -1 }, "draft").error).toMatch(/expected_landed_cost_cents/);
  });
  it("rejects malformed date_expected in patch", () => {
    expect(validatePoPatch({ date_expected: "tomorrow" }, "draft").error).toMatch(/date_expected/);
  });
});

// Unused export silence for UUID2 — keep importable for future expansion.
void UUID2;
