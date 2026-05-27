// Tests for P4-4 AR invoices handler validation + status guards.
//
// We exercise the pure validator exports here. The actual posting/approval
// flows are exercised by ar-invoices-post.test.js (mocked Supabase + libs)
// and ar-invoices-void.test.js.

import { describe, it, expect } from "vitest";
import { validateInsert, parseListQuery, isUuid } from "../../_handlers/internal/ar-invoices/index.js";
import { validatePatch } from "../../_handlers/internal/ar-invoices/[id].js";

const UUID  = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";
const UUID3 = "00000000-0000-0000-0000-000000000003";

describe("ar-invoices isUuid", () => {
  it("accepts valid uuid", () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it("rejects non-string", () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
  it("rejects malformed string", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

describe("ar-invoices parseListQuery", () => {
  function pq(qs) {
    return parseListQuery("/api/internal/ar-invoices" + (qs ? `?${qs}` : ""), "x");
  }
  it("defaults limit to 100", () => {
    const v = pq("");
    expect(v.data.limit).toBe(100);
  });
  it("caps limit at 500", () => {
    expect(pq("limit=9999").data.limit).toBe(500);
  });
  it("clamps limit floor to 100 when junk", () => {
    expect(pq("limit=abc").data.limit).toBe(100);
  });
  it("rejects bad status", () => {
    expect(pq("status=foo").error).toMatch(/status/);
  });
  it("accepts each valid status", () => {
    for (const s of ["draft","unposted","pending_approval","sent","partial_paid","paid","void","reversed","posted_historical"]) {
      expect(pq(`status=${s}`).data.status).toBe(s);
    }
  });
  it("rejects non-uuid customer_id", () => {
    expect(pq("customer_id=abc").error).toMatch(/customer_id/);
  });
  it("accepts uuid customer_id", () => {
    expect(pq(`customer_id=${UUID}`).data.customerId).toBe(UUID);
  });
  it("rejects bad from / to format", () => {
    expect(pq("from=2026/05/01").error).toMatch(/from/);
    expect(pq("to=tomorrow").error).toMatch(/to/);
  });
  it("accepts well-formed dates", () => {
    expect(pq("from=2026-01-01&to=2026-12-31").data).toMatchObject({
      from: "2026-01-01", to: "2026-12-31",
    });
  });
  it("toggles include_void only on literal 'true'", () => {
    expect(pq("include_void=true").data.includeVoid).toBe(true);
    expect(pq("include_void=1").data.includeVoid).toBe(false);
  });
});

describe("ar-invoices validateInsert", () => {
  it("rejects missing customer_id", () => {
    expect(validateInsert({}).error).toMatch(/customer_id/);
  });
  it("rejects non-uuid customer_id", () => {
    expect(validateInsert({ customer_id: "abc" }).error).toMatch(/customer_id/);
  });
  it("rejects bad invoice_date format", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "5/26/2026",
      lines: [{ line_total_cents: 1000 }],
    }).error).toMatch(/invoice_date/);
  });
  it("rejects missing invoice_date", () => {
    expect(validateInsert({
      customer_id: UUID,
      lines: [{ line_total_cents: 1000 }],
    }).error).toMatch(/invoice_date/);
  });
  it("rejects invoice_kind not in enum", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", invoice_kind: "nope",
      lines: [{ line_total_cents: 1000 }],
    }).error).toMatch(/invoice_kind/);
  });
  it("defaults invoice_kind to customer_invoice", () => {
    const v = validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ line_total_cents: 100 }],
    });
    expect(v.data.invoice_kind).toBe("customer_invoice");
  });
  it("rejects due_date before invoice_date", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", due_date: "2026-04-01",
      lines: [{ line_total_cents: 100 }],
    }).error).toMatch(/due_date/);
  });
  it("rejects bad due_date format", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", due_date: "next month",
      lines: [{ line_total_cents: 100 }],
    }).error).toMatch(/due_date/);
  });
  it("rejects bad payment_terms_id", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", payment_terms_id: "abc",
      lines: [{ line_total_cents: 100 }],
    }).error).toMatch(/payment_terms_id/);
  });
  it("rejects bad ar_account_id", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", ar_account_id: "abc",
      lines: [{ line_total_cents: 100 }],
    }).error).toMatch(/ar_account_id/);
  });
  it("rejects bad revenue_account_id", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", revenue_account_id: "abc",
      lines: [{ line_total_cents: 100 }],
    }).error).toMatch(/revenue_account_id/);
  });
  it("rejects bad cogs_account_id", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", cogs_account_id: "abc",
      lines: [{ line_total_cents: 100 }],
    }).error).toMatch(/cogs_account_id/);
  });
  it("rejects bad inventory_asset_account_id", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", inventory_asset_account_id: "abc",
      lines: [{ line_total_cents: 100 }],
    }).error).toMatch(/inventory_asset_account_id/);
  });
  it("rejects empty lines array", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", lines: [],
    }).error).toMatch(/lines/);
  });
  it("rejects missing lines key", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
    }).error).toMatch(/lines/);
  });
  it("rejects line with no total path", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ description: "no amounts" }],
    }).error).toMatch(/line_total_cents/);
  });
  it("rejects line with non-positive line_total_cents", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ line_total_cents: 0 }],
    }).error).toMatch(/line_total_cents/);
  });
  it("rejects negative unit_price_cents", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ quantity: 5, unit_price_cents: -100 }],
    }).error).toMatch(/unit_price_cents/);
  });
  it("rejects qty zero on unit-price path", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ quantity: 0, unit_price_cents: 1000 }],
    }).error).toMatch(/quantity/);
  });
  it("rejects non-uuid inventory_item_id", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ inventory_item_id: "abc", quantity: 5, unit_price_cents: 100 }],
    }).error).toMatch(/inventory_item_id/);
  });
  it("rejects inventory line missing quantity", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ inventory_item_id: UUID3, unit_price_cents: 500 }],
    }).error).toMatch(/quantity/);
  });
  it("rejects per-line revenue_account_id non-uuid", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ line_total_cents: 100, revenue_account_id: "abc" }],
    }).error).toMatch(/revenue_account_id/);
  });

  it("accepts explicit line_total_cents path", () => {
    const v = validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ line_total_cents: 12500, description: "consulting" }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(1);
    expect(v.data.lines[0].line_total_cents).toBe("12500");
    expect(v.data.lines[0].unit_price_cents).toBeNull();
    expect(v.data.lines[0].quantity).toBeNull();
  });

  it("computes line_total from qty * unit_price when both supplied", () => {
    const v = validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ quantity: 5, unit_price_cents: 250 }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines[0].quantity).toBe(5);
    expect(v.data.lines[0].unit_price_cents).toBe("250");
    expect(v.data.lines[0].line_total_cents).toBe("1250");
  });

  it("accepts inventory line with quantity + unit price", () => {
    const v = validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ inventory_item_id: UUID3, quantity: 10, unit_price_cents: 1000 }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines[0].inventory_item_id).toBe(UUID3);
    expect(v.data.lines[0].line_total_cents).toBe("10000");
  });

  it("accepts unit_price_cents as string of digits (BigInt-safe)", () => {
    const v = validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ quantity: 1, unit_price_cents: "999999999" }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines[0].unit_price_cents).toBe("999999999");
  });

  it("rejects unit_price_cents that's a non-integer string", () => {
    expect(validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [{ quantity: 1, unit_price_cents: "12.50" }],
    }).error).toMatch(/unit_price_cents/);
  });

  it("accepts a mix of inventory and flat-total lines", () => {
    const v = validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26",
      lines: [
        { line_total_cents: 5000, description: "service" },
        { inventory_item_id: UUID3, quantity: 2, unit_price_cents: 4000 },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(2);
    expect(v.data.lines[0].inventory_item_id).toBeNull();
    expect(v.data.lines[1].inventory_item_id).toBe(UUID3);
    expect(v.data.lines[1].line_total_cents).toBe("8000");
  });

  it("trims invoice_number whitespace + treats blank as null (auto-gen)", () => {
    const v = validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", invoice_number: "  ",
      lines: [{ line_total_cents: 100 }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.invoice_number).toBeNull();
  });

  it("preserves an explicit invoice_number trimmed", () => {
    const v = validateInsert({
      customer_id: UUID, invoice_date: "2026-05-26", invoice_number: "  AR-1  ",
      lines: [{ line_total_cents: 100 }],
    });
    expect(v.data.invoice_number).toBe("AR-1");
  });
});

describe("ar-invoices validatePatch", () => {
  it("rejects entity_id change", () => {
    expect(validatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });
  it("rejects gl_status change", () => {
    expect(validatePatch({ gl_status: "sent" }).error).toMatch(/gl_status/);
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
  it("rejects cash_je_id direct write", () => {
    expect(validatePatch({ cash_je_id: UUID }).error).toMatch(/JE pointers/);
  });

  it("accepts customer_id change with valid uuid", () => {
    const v = validatePatch({ customer_id: UUID });
    expect(v.error).toBeUndefined();
    expect(v.data.header.customer_id).toBe(UUID);
  });
  it("rejects non-uuid customer_id", () => {
    expect(validatePatch({ customer_id: "x" }).error).toMatch(/customer_id/);
  });
  it("rejects bad invoice_kind", () => {
    expect(validatePatch({ invoice_kind: "garbage" }).error).toMatch(/invoice_kind/);
  });
  it("accepts invoice_number trim", () => {
    expect(validatePatch({ invoice_number: "  AR-1  " }).data.header.invoice_number).toBe("AR-1");
  });
  it("rejects empty invoice_number", () => {
    expect(validatePatch({ invoice_number: "  " }).error).toMatch(/invoice_number/);
  });
  it("rejects bad invoice_date", () => {
    expect(validatePatch({ invoice_date: "tomorrow" }).error).toMatch(/invoice_date/);
  });
  it("invoice_date change updates posting_date in tandem", () => {
    const v = validatePatch({ invoice_date: "2026-06-01" });
    expect(v.data.header.invoice_date).toBe("2026-06-01");
    expect(v.data.header.posting_date).toBe("2026-06-01");
  });
  it("accepts due_date null", () => {
    expect(validatePatch({ due_date: null }).data.header.due_date).toBeNull();
  });
  it("accepts payment_terms_id null", () => {
    expect(validatePatch({ payment_terms_id: null }).data.header.payment_terms_id).toBeNull();
  });
  it("rejects payment_terms_id non-uuid", () => {
    expect(validatePatch({ payment_terms_id: "x" }).error).toMatch(/payment_terms_id/);
  });
  it("accepts ar_account_id change", () => {
    expect(validatePatch({ ar_account_id: UUID }).data.header.ar_account_id).toBe(UUID);
  });
  it("rejects bad ar_account_id", () => {
    expect(validatePatch({ ar_account_id: "x" }).error).toMatch(/ar_account_id/);
  });
  it("rejects bad revenue_account_id", () => {
    expect(validatePatch({ revenue_account_id: "x" }).error).toMatch(/revenue_account_id/);
  });
  it("rejects bad cogs_account_id", () => {
    expect(validatePatch({ cogs_account_id: "x" }).error).toMatch(/cogs_account_id/);
  });
  it("rejects bad inventory_asset_account_id", () => {
    expect(validatePatch({ inventory_asset_account_id: "x" }).error).toMatch(/inventory_asset_account_id/);
  });
  it("rejects lines as empty array", () => {
    expect(validatePatch({ lines: [] }).error).toMatch(/lines/);
  });
  it("accepts lines replacement", () => {
    const v = validatePatch({
      lines: [{ line_total_cents: 100 }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(1);
    expect(v.data.lines[0].line_total_cents).toBe("100");
  });
  it("computes line_total from qty * unit_price on patch lines", () => {
    const v = validatePatch({
      lines: [{ quantity: 4, unit_price_cents: 250 }],
    });
    expect(v.data.lines[0].line_total_cents).toBe("1000");
  });
  it("rejects lines patch with inventory line missing quantity", () => {
    expect(validatePatch({
      lines: [{ inventory_item_id: UUID3, unit_price_cents: 100 }],
    }).error).toMatch(/quantity/);
  });
  it("returns empty header + null lines for {}", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(v.data.header).toEqual({});
    expect(v.data.lines).toBeNull();
  });
});
