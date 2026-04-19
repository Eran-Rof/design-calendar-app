import { describe, it, expect } from "vitest";
import {
  normalizeXoroItem,
  normalizeXoroSalesLine,
  normalizeXoroInventoryLine,
  normalizeXoroReceiptLine,
  normalizeXoroOpenPoLine,
} from "../normalize/xoro";

describe("normalizeXoroItem", () => {
  it("produces canonical sku + external refs", () => {
    const out = normalizeXoroItem({
      Id: 42,
      ItemNumber: "rof-001",
      Sku: "rof-001",
      StyleNumber: "rof-hoodie",
      Description: "Hoodie",
      CategoryName: "Mens Tops",
      VendorName: "Acme Ltd.",
      VendorNumber: "V100",
      Color: "Black",
      Size: "M",
      UnitPrice: "49.99",
      UnitCost: "12.00",
      LeadTimeDays: "45",
    });
    expect(out?.sku_code).toBe("ROF-001");
    expect(out?.style_code).toBe("ROF-HOODIE");
    expect(out?.unit_price).toBe(49.99);
    expect(out?.external_refs.xoro_item_id).toBe("42");
    expect(out?._src.vendor_name).toBe("ACME");
    expect(out?._src.vendor_code).toBe("V100");
  });
  it("returns null when sku missing", () => {
    expect(normalizeXoroItem({ Description: "x" })).toBeNull();
  });
});

describe("normalizeXoroSalesLine", () => {
  it("picks invoice qty/date for txn_type=invoice", () => {
    const out = normalizeXoroSalesLine(
      {
        Id: 1,
        InvoiceNumber: "INV-10",
        OrderNumber: "SO-5",
        InvoiceDate: "2026-03-02",
        OrderDate: "2026-03-01",
        Sku: "abc-01",
        QtyInvoiced: "4",
        UnitPrice: "10",
        LineAmount: "40",
        Currency: "USD",
      },
      { txn_type: "invoice" },
    );
    expect(out?.txn_type).toBe("invoice");
    expect(out?.txn_date).toBe("2026-03-02");
    expect(out?.qty).toBe(4);
    expect(out?.net_amount).toBe(40);
    expect(out?.source_line_key).toBe("xoro:inv:INV-10:1");
  });
  it("falls back to order fields when txn_type=order", () => {
    const out = normalizeXoroSalesLine(
      {
        Id: 2,
        OrderNumber: "SO-5",
        OrderDate: "2026-03-01",
        Sku: "abc-01",
        Qty: 2,
      },
      { txn_type: "order" },
    );
    expect(out?.txn_date).toBe("2026-03-01");
    expect(out?.qty).toBe(2);
    expect(out?.source_line_key).toBe("xoro:ord:SO-5:2");
  });
  it("returns null when sku or date missing", () => {
    expect(normalizeXoroSalesLine({ OrderNumber: "x" }, { txn_type: "order" })).toBeNull();
    expect(normalizeXoroSalesLine({ Sku: "x" }, { txn_type: "order" })).toBeNull();
  });
});

describe("normalizeXoroInventoryLine", () => {
  it("normalizes qty and warehouse", () => {
    const out = normalizeXoroInventoryLine({
      Sku: "abc-01",
      SnapshotDate: "2026-04-01",
      WarehouseCode: "MAIN",
      QtyOnHand: "100",
      QtyAvailable: "90",
    });
    expect(out?.qty_on_hand).toBe(100);
    expect(out?.qty_available).toBe(90);
    expect(out?.warehouse_code).toBe("MAIN");
    expect(out?.source).toBe("xoro");
  });
  it("uses default_snapshot_date when payload lacks a date", () => {
    const out = normalizeXoroInventoryLine(
      { Sku: "abc-01", QtyOnHand: "1" },
      { default_snapshot_date: "2026-04-19" },
    );
    expect(out?.snapshot_date).toBe("2026-04-19");
  });
});

describe("normalizeXoroReceiptLine", () => {
  it("flattens receipt id into source_line_key", () => {
    const out = normalizeXoroReceiptLine({
      Id: 99,
      ReceiptNumber: "RC-1",
      ReceivedDate: "2026-02-10",
      PoNumber: "PO-7",
      Sku: "abc-01",
      QtyReceived: "10",
      VendorName: "Acme LLC",
    });
    expect(out?.source_line_key).toBe("xoro:rcpt:99:ABC-01");
    expect(out?.po_number).toBe("PO-7");
    expect(out?.qty).toBe(10);
    expect(out?._src.vendor_name).toBe("ACME");
  });
});

describe("normalizeXoroOpenPoLine", () => {
  it("trusts QtyRemaining when present", () => {
    const out = normalizeXoroOpenPoLine({
      Id: 7,
      PoNumber: "PO-7",
      PoLineNumber: "1",
      Sku: "abc-01",
      QtyOrdered: 100,
      QtyReceived: 30,
      QtyRemaining: 65, // intentionally inconsistent → Xoro wins
    });
    expect(out?.qty_open).toBe(65);
    expect(out?.qty_ordered).toBe(100);
    expect(out?.qty_received).toBe(30);
  });
  it("computes qty_open when QtyRemaining missing", () => {
    const out = normalizeXoroOpenPoLine({
      PoNumber: "PO-8",
      Sku: "abc-01",
      QtyOrdered: 10,
      QtyReceived: 7,
    });
    expect(out?.qty_open).toBe(3);
  });
  it("returns null when PoNumber missing", () => {
    const out = normalizeXoroOpenPoLine({ Sku: "abc-01", QtyOrdered: 1 });
    expect(out).toBeNull();
  });
});
