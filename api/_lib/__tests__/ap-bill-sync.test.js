import { describe, it, expect } from "vitest";
import {
  toCents,
  toMoney,
  toIsoDate,
  mapPaymentStatus,
  parseBillRows,
  buildInvoicePayload,
  buildLineRows,
} from "../ap-bill-sync.js";

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

  it("builds line rows keyed by invoice_id + line_index, no inventory_item_id", () => {
    const lines = buildLineRows(bill, "inv-uuid");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      invoice_id: "inv-uuid",
      line_index: 0,
      description: "Freight",
      quantity: 1,
      unit_price: 250,
      line_total: 250,
    });
    expect(lines[0]).not.toHaveProperty("inventory_item_id");
  });
});
