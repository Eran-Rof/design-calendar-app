import { describe, it, expect } from "vitest";
import { scanDataQuality } from "../services/dataQuality";
import type {
  IpInventorySnapshot,
  IpItem,
  IpOpenPoRow,
  IpReceiptRow,
  IpSalesEcomRow,
  IpSalesWholesaleRow,
} from "../types/entities";

const baseItem = (overrides: Partial<IpItem> = {}): IpItem => ({
  id: "item-1",
  sku_code: "ABC-01",
  style_code: "ABC",
  description: "x",
  category_id: "cat-1",
  vendor_id: "v-1",
  color: null, size: null,
  uom: "each",
  unit_cost: null, unit_price: null,
  lead_time_days: 30, moq_units: null,
  lifecycle_status: null, planning_class: null,
  active: true,
  external_refs: {}, attributes: {},
  ...overrides,
});

describe("scanDataQuality", () => {
  it("flags duplicate skus, missing style, missing lead time", () => {
    const items = [
      baseItem({ id: "a", sku_code: "DUP-1" }),
      baseItem({ id: "b", sku_code: "DUP-1" }), // duplicate
      baseItem({ id: "c", sku_code: "NO-STYLE", style_code: null }),
      baseItem({ id: "d", sku_code: "NO-LT", lead_time_days: null }),
    ];
    const r = scanDataQuality({
      items,
      inventory: [], salesWholesale: [], salesEcom: [], receipts: [], openPos: [],
    });
    const cats = r.issues.map((i) => i.category);
    expect(cats).toContain("duplicate_sku");
    expect(cats).toContain("missing_style_mapping");
    expect(cats).toContain("missing_lead_time");
  });

  it("flags impossible inventory", () => {
    const snaps: IpInventorySnapshot[] = [
      { sku_id: "a", warehouse_code: "W", snapshot_date: "2026-01-01", qty_on_hand: -5, qty_available: null, qty_committed: null, qty_on_order: null, qty_in_transit: null, source: "xoro" },
      { sku_id: "a", warehouse_code: "W", snapshot_date: "2026-01-02", qty_on_hand: 10, qty_available: 20, qty_committed: null, qty_on_order: null, qty_in_transit: null, source: "xoro" },
    ];
    const r = scanDataQuality({
      items: [], inventory: snaps,
      salesWholesale: [], salesEcom: [], receipts: [], openPos: [],
    });
    expect(r.issues.filter((i) => i.category === "impossible_inventory")).toHaveLength(2);
  });

  it("flags orphan sales", () => {
    const item = baseItem({ id: "real", sku_code: "REAL" });
    const sale: IpSalesWholesaleRow = {
      sku_id: "ghost", customer_id: "c1", category_id: null, channel_id: null,
      order_number: "SO-1", invoice_number: null, txn_type: "order",
      txn_date: "2026-01-01", qty: 1,
      unit_price: null, gross_amount: null, discount_amount: null, net_amount: null,
      currency: "USD", source: "xoro", source_line_key: "xoro:ord:SO-1:1",
    };
    const r = scanDataQuality({
      items: [item], inventory: [], salesWholesale: [sale],
      salesEcom: [], receipts: [], openPos: [],
    });
    expect(r.issues.some((i) => i.category === "orphan_sales_row")).toBe(true);
  });

  it("flags date inconsistencies on open POs", () => {
    const po: IpOpenPoRow = {
      sku_id: "x", vendor_id: null, po_number: "PO-1", po_line_number: "1",
      order_date: "2026-03-10", expected_date: "2026-02-01",
      qty_ordered: 10, qty_received: 0, qty_open: 10,
      unit_cost: null, currency: null, status: "open",
      source: "xoro", source_line_key: "xoro:po:PO-1:1", last_seen_at: "2026-04-01T00:00:00Z",
    };
    const r = scanDataQuality({
      items: [], inventory: [], salesWholesale: [], salesEcom: [], receipts: [],
      openPos: [po],
    });
    expect(r.issues.some((i) => i.category === "date_inconsistency")).toBe(true);
  });

  it("flags unmapped shopify skus and missing channel on ecom", () => {
    const ecom: IpSalesEcomRow = {
      sku_id: "a", channel_id: "", category_id: null,
      order_number: "#1001", order_date: "2026-01-01",
      qty: 1, returned_qty: 0, net_qty: 1,
      gross_amount: null, discount_amount: null, refund_amount: null, net_amount: null,
      currency: "USD", source: "shopify", source_line_key: "shopify:US:1:1",
    };
    const r = scanDataQuality({
      items: [], inventory: [], salesWholesale: [], salesEcom: [ecom],
      receipts: [], openPos: [],
      unmappedShopifySkus: ["abc-01", "ABC-01", "xyz-01"],
    });
    const cats = r.issues.map((i) => i.category);
    expect(cats).toContain("missing_channel");
    expect(cats).toContain("shopify_sku_unmapped");
    // Deduped by canonical sku → ABC-01 appears once, XYZ-01 once.
    expect(r.issues.filter((i) => i.category === "shopify_sku_unmapped")).toHaveLength(2);
  });

  it("returns zero-count structure when everything is clean", () => {
    const r = scanDataQuality({
      items: [baseItem()],
      inventory: [], salesWholesale: [], salesEcom: [], receipts: [], openPos: [],
    });
    expect(r.issue_count_by_severity.error).toBe(0);
    expect(r.issue_count_by_severity.warning).toBe(0);
  });
});
