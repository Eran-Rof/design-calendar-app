import { describe, it, expect } from "vitest";
import {
  toCents,
  toMoney,
  toIsoDate,
  mapPaymentStatus,
  parseBillRows,
  buildInvoicePayload,
  buildLineRows,
  makeItemResolver,
  billSinglePoNumber,
} from "../ap-bill-sync.js";

describe("billSinglePoNumber", () => {
  it("returns the PO number when all lines share one", () => {
    expect(billSinglePoNumber({ lines: [{ po_number: "ROF-P000080" }, { po_number: "ROF-P000080" }] })).toBe("ROF-P000080");
  });
  it("returns null when lines span multiple POs", () => {
    expect(billSinglePoNumber({ lines: [{ po_number: "A" }, { po_number: "B" }] })).toBe(null);
  });
  it("returns null when no line has a PO", () => {
    expect(billSinglePoNumber({ lines: [{ po_number: "" }, { po_number: null }] })).toBe(null);
    expect(billSinglePoNumber({ lines: [] })).toBe(null);
    expect(billSinglePoNumber({})).toBe(null);
  });
  it("ignores blank PO lines when one real PO is present", () => {
    expect(billSinglePoNumber({ lines: [{ po_number: "PT-P000620" }, { po_number: "" }] })).toBe("PT-P000620");
  });
});

describe("toCents / toMoney", () => {
  it("rounds money to integer cents", () => {
    expect(toCents("6.18")).toBe(618);
    expect(toCents("6229.44")).toBe(622944);
    expect(toCents("$1,234.50")).toBe(123450);
  });
  it("blank/NaN -> 0 (never NULLs a NOT NULL cents column)", () => {
    expect(toCents("")).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(toCents("abc")).toBe(0);
  });
  it("toMoney is the cents inverse to 2dp", () => {
    expect(toMoney(622944)).toBe(6229.44);
    expect(toMoney(618)).toBe(6.18);
  });
});

describe("toIsoDate", () => {
  it("parses MM/DD/YYYY", () => {
    expect(toIsoDate("06/02/2026")).toBe("2026-06-02");
    expect(toIsoDate("11/29/2026")).toBe("2026-11-29");
  });
  it("handles JS Date objects from XLSX cellDates:true", () => {
    expect(toIsoDate(new Date("2026-06-03T00:00:00Z"))).toBe("2026-06-03");
    expect(toIsoDate(new Date("2026-11-30T00:00:00Z"))).toBe("2026-11-30");
    expect(toIsoDate(new Date("invalid"))).toBeNull();
  });
  it("handles the 0001 sentinel + blanks as null", () => {
    expect(toIsoDate("01/01/0001")).toBeNull();
    expect(toIsoDate("")).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });
});

describe("mapPaymentStatus", () => {
  it("Paid -> status paid + full paid amount", () => {
    expect(mapPaymentStatus("Paid", 622944)).toEqual({ status: "paid", paid_amount_cents: 622944 });
  });
  it("Unpaid/Partial -> approved + 0 paid (CSV carries no paid amount)", () => {
    expect(mapPaymentStatus("Unpaid", 622944)).toEqual({ status: "approved", paid_amount_cents: 0 });
    expect(mapPaymentStatus("Partial", 100)).toEqual({ status: "approved", paid_amount_cents: 0 });
  });
});

describe("parseBillRows", () => {
  const rows = [
    { "Bill Number": "ROF-B006452", "Bill Date": "06/02/2026", "Due Date": "11/29/2026", "Vendor Code": "1224", "Vendor Name": "FASHION DESIGN, LLC", Currency: "USD", "Item Number": "BRMB0010T-BLACK-SML", Description: "Jogger", Qty: "1008", "Unit Price": "6.1800", Amount: "6229.44", "Bill Status": "Open", "Payment Status": "Unpaid" },
    { "Bill Number": "ROF-B006452", "Bill Date": "06/02/2026", "Due Date": "11/29/2026", "Vendor Code": "1224", "Vendor Name": "FASHION DESIGN, LLC", Currency: "USD", "Item Number": "BRMB0010T-BLACK-MED", Description: "Jogger", Qty: "2016", "Unit Price": "6.1800", Amount: "12458.88", "Bill Status": "Open", "Payment Status": "Unpaid" },
    { "Bill Number": "ROF-B006001", "Bill Date": "05/01/2026", "Due Date": "", "Vendor Code": "9", "Vendor Name": "ACME", Currency: "USD", "Item Number": "", Description: "Freight", Qty: "", "Unit Price": "", Amount: "250.00", "Bill Status": "Posted", "Payment Status": "Paid" },
  ];

  it("groups line rows into one bill per Bill Number and sums total_cents", () => {
    const bills = parseBillRows(rows);
    expect(bills).toHaveLength(2);
    const b = bills.find((x) => x.invoice_number === "ROF-B006452");
    expect(b.lines).toHaveLength(2);
    expect(b.total_cents).toBe(622944 + 1245888);
    expect(b.invoice_date).toBe("2026-06-02");
    expect(b.due_date).toBe("2026-11-29");
    expect(b.vendor_name).toBe("FASHION DESIGN, LLC");
    expect(b.lines[1].line_index).toBe(1);
  });

  it("keeps an expense/freight line (no item number but has amount)", () => {
    const bills = parseBillRows(rows);
    const b = bills.find((x) => x.invoice_number === "ROF-B006001");
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].item_number).toBeNull();
    expect(b.total_cents).toBe(25000);
    expect(b.payment_status).toBe("Paid");
  });

  it("skips rows with no Bill Number", () => {
    expect(parseBillRows([{ "Bill Number": "", Amount: "5" }])).toHaveLength(0);
  });
});

describe("buildInvoicePayload / buildLineRows", () => {
  const bill = parseBillRows([
    { "Bill Number": "ROF-B006001", "Bill Date": "05/01/2026", "Due Date": "", "Vendor Name": "ACME", Currency: "USD", "Item Number": "X", Description: "Freight", Qty: "1", "Unit Price": "250", Amount: "250.00", "Bill Status": "Posted", "Payment Status": "Paid" },
  ])[0];

  it("maps the header to the invoices payload (source xoro_ap, paid)", () => {
    const p = buildInvoicePayload(bill, "vendor-uuid", "2026-06-04T12:00:00.000Z");
    expect(p.source).toBe("xoro_ap");
    expect(p.invoice_kind).toBe("vendor_bill");
    expect(p.vendor_id).toBe("vendor-uuid");
    expect(p.invoice_number).toBe("ROF-B006001");
    expect(p.total_amount_cents).toBe(25000);
    expect(p.total).toBe(250);
    expect(p.status).toBe("paid");
    expect(p.paid_amount_cents).toBe(25000);
    expect(p.paid_at).toBe("2026-06-04T12:00:00.000Z");
    expect(p.xoro_ap_id).toBe("ROF-B006001");
    expect(p.xoro_last_synced_at).toBe("2026-06-04T12:00:00.000Z");
    expect(p).not.toHaveProperty("entity_id"); // relies on column default
  });

  it("builds line rows keyed by invoice_id + line_index; unit_cost_cents + null inventory_item_id without a resolver", () => {
    const lines = buildLineRows(bill, "inv-uuid");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      invoice_id: "inv-uuid",
      line_index: 0,
      description: "Freight",
      quantity: 1,
      unit_price: 250,
      unit_cost_cents: 25000, // P3-grain cost mirrors unit_price
      line_total: 250,
      inventory_item_id: null, // no resolver supplied
    });
  });

  it("links a bill line to its SKU via the Item Number resolver + captures PO number", () => {
    const sized = parseBillRows([
      { "Bill Number": "ROF-B006029", "Bill Date": "06/03/2026", "Due Date": "", "Vendor Name": "ZJ", Currency: "USD", "Item Number": "RYB0412-AUTUMN GRIZZLY CAMO-32", "PO Number": "ROF-P000080", Description: "Cargo Short", Qty: "100", "Unit Price": "5.90", Amount: "590.00", "Bill Status": "Posted", "Payment Status": "Unpaid" },
    ])[0];
    const resolveId = makeItemResolver([
      { id: "sku-1", sku_code: "RYB0412-AUTUMNGRIZZLYCAMO-32", style_code: "RYB0412", color: "Autumn Grizzly Camo", size: "32" },
    ]);
    const lines = buildLineRows(sized, "inv-uuid", resolveId);
    expect(lines[0].inventory_item_id).toBe("sku-1");
    expect(lines[0].unit_cost_cents).toBe(590);
    expect(lines[0].po_number).toBe("ROF-P000080");
  });

  it("falls back to a colour-grain SKU when the Item Number has no size", () => {
    const colorGrain = parseBillRows([
      { "Bill Number": "ROF-B006030", "Bill Date": "06/03/2026", "Due Date": "", "Vendor Name": "ZJ", Currency: "USD", "Item Number": "RYB0412-AUTUMN GRIZZLY CAMO", Description: "Cargo Short", Qty: "3732", "Unit Price": "5.90", Amount: "22018.80", "Bill Status": "Posted", "Payment Status": "Unpaid" },
    ])[0];
    const resolveId = makeItemResolver([
      { id: "sku-30", sku_code: "RYB0412-AUTUMNGRIZZLYCAMO-30", style_code: "RYB0412", color: "Autumn Grizzly Camo", size: "30" },
    ]);
    const lines = buildLineRows(colorGrain, "inv-uuid", resolveId);
    expect(lines[0].inventory_item_id).toBe("sku-30"); // representative SKU of the colour
  });
});
