// Normalized planning entities — the internal typed contract that every
// downstream planner reads. Normalization code (src/inventory-planning/
// normalize/*) produces these; mapping code (src/inventory-planning/
// mapping/*) resolves their canonical keys.
//
// Naming convention:
//   • `Ip*` prefix distinguishes planning entities from look-alike types
//     elsewhere in the codebase (e.g. tandaTypes `XoroPO`).
//   • Fields suffixed `_id` are internal uuids; `_code` are canonical
//     human-readable keys; `external_refs` holds third-party ids.

export type IpCurrencyCode = string; // ISO 4217, e.g. "USD"
export type IpIsoDate = string;      // "YYYY-MM-DD"
export type IpIsoDateTime = string;  // RFC3339 timestamp

export type IpChannelType =
  | "wholesale"
  | "ecom"
  | "marketplace"
  | "retail"
  | "other";

export type IpSalesTxnType = "order" | "ship" | "invoice";

export type IpSource = "xoro" | "shopify" | "manual";

export interface IpExternalRefs {
  // Xoro-side identifiers. Most are item-level; StoreId/LocationId when
  // inventory is snapshotted at a specific warehouse.
  xoro_item_id?: string;
  xoro_item_number?: string;
  xoro_customer_id?: string;
  xoro_vendor_id?: string;
  xoro_store_id?: string;
  // Shopify-side identifiers. Numeric ids are normalized to strings so we
  // don't lose precision across the wire.
  shopify_product_id?: string;
  shopify_variant_id?: string;
  shopify_inventory_item_id?: string;
  shopify_customer_id?: string;
  shopify_collection_id?: string;
  shopify_sku?: string;
  // Internal cross-links.
  plm_style_id?: string;
  ats_line_id?: string;
  // Catch-all so we don't need a migration for a new upstream field.
  [key: string]: string | undefined;
}

// ── Core masters ────────────────────────────────────────────────────────────
export interface IpVendor {
  id: string;
  vendor_code: string;
  name: string;
  country: string | null;
  default_lead_time_days: number | null;
  moq_units: number | null;
  active: boolean;
  portal_vendor_id: string | null;
  external_refs: IpExternalRefs;
  notes: string | null;
}

export interface IpCategory {
  id: string;
  category_code: string;
  name: string;
  segment: string | null;
  active: boolean;
  external_refs: IpExternalRefs;
}

export interface IpChannel {
  id: string;
  channel_code: string;
  name: string;
  channel_type: IpChannelType;
  storefront_key: string | null;
  currency: IpCurrencyCode | null;
  timezone: string | null;
  active: boolean;
  external_refs: IpExternalRefs;
}

export interface IpCustomer {
  id: string;
  customer_code: string;
  name: string;
  parent_customer_id: string | null;
  customer_tier: string | null;
  country: string | null;
  channel_id: string | null;
  active: boolean;
  external_refs: IpExternalRefs;
}

export interface IpItem {
  id: string;
  sku_code: string;
  style_code: string | null;
  description: string | null;
  category_id: string | null;
  vendor_id: string | null;
  color: string | null;
  size: string | null;
  uom: string;
  unit_cost: number | null;
  unit_price: number | null;
  lead_time_days: number | null;
  moq_units: number | null;
  lifecycle_status: string | null;
  planning_class: string | null;
  active: boolean;
  external_refs: IpExternalRefs;
  attributes: Record<string, unknown>;
}

// All-SKU avg cost lookup (table: ip_item_avg_cost). Loaded via Xoro API
// or Excel upload — the planning grid's static "Avg Cost" column reads
// from this so it covers SKUs not currently in stock (which the ATS
// snapshot's avgCost misses).
export interface IpItemAvgCost {
  sku_code: string;
  avg_cost: number;
  source: "xoro" | "excel" | "manual";
  source_ref: string | null;
  updated_at: string;
}

// ── Delivery / planning period ──────────────────────────────────────────────
// A planning period is an inclusive date window with a granularity label.
// We don't store these as rows in Phase 0 — they're computed on read — but
// the shape is codified here so every caller agrees.
export type IpPeriodGranularity = "day" | "week" | "month" | "quarter" | "season";

export interface IpPlanningPeriod {
  granularity: IpPeriodGranularity;
  // "2026-W17", "2026-04", "SS-26", etc. Stable human key.
  period_code: string;
  start_date: IpIsoDate;
  end_date: IpIsoDate;
}

// ── Facts ───────────────────────────────────────────────────────────────────
export interface IpInventorySnapshot {
  id?: string;
  sku_id: string;
  warehouse_code: string;
  snapshot_date: IpIsoDate;
  qty_on_hand: number;
  qty_available: number | null;
  qty_committed: number | null;
  qty_on_order: number | null;
  qty_in_transit: number | null;
  source: IpSource;
  raw_payload_id?: string | null;
}

export interface IpSalesWholesaleRow {
  id?: string;
  sku_id: string;
  customer_id: string | null;
  category_id: string | null;
  channel_id: string | null;
  order_number: string | null;
  invoice_number: string | null;
  txn_type: IpSalesTxnType;
  txn_date: IpIsoDate;
  qty: number;
  unit_price: number | null;
  gross_amount: number | null;
  discount_amount: number | null;
  net_amount: number | null;
  currency: IpCurrencyCode | null;
  source: IpSource;
  raw_payload_id?: string | null;
  source_line_key: string;
}

export interface IpSalesEcomRow {
  id?: string;
  sku_id: string;
  channel_id: string;
  category_id: string | null;
  order_number: string | null;
  order_date: IpIsoDate;
  qty: number;
  returned_qty: number;
  net_qty: number;
  gross_amount: number | null;
  discount_amount: number | null;
  refund_amount: number | null;
  net_amount: number | null;
  currency: IpCurrencyCode | null;
  source: IpSource;
  raw_payload_id?: string | null;
  source_line_key: string;
}

export interface IpReceiptRow {
  id?: string;
  sku_id: string;
  vendor_id: string | null;
  po_number: string | null;
  receipt_number: string | null;
  received_date: IpIsoDate;
  qty: number;
  warehouse_code: string | null;
  source: IpSource;
  raw_payload_id?: string | null;
  source_line_key: string;
}

export interface IpOpenPoRow {
  id?: string;
  sku_id: string;
  vendor_id: string | null;
  // Customer the PO is allocated to. Stock POs (TandA BuyerName = "ROF
  // Stock" / "PT Stock" / blank) are routed to the (Supply Only)
  // placeholder customer so the grid can show them under one row.
  customer_id?: string | null;
  buyer_name?: string | null;
  po_number: string;
  po_line_number: string | null;
  order_date: IpIsoDate | null;
  expected_date: IpIsoDate | null;
  qty_ordered: number;
  qty_received: number;
  qty_open: number;
  unit_cost: number | null;
  currency: IpCurrencyCode | null;
  status: string | null;
  source: IpSource;
  raw_payload_id?: string | null;
  source_line_key: string;
  last_seen_at: IpIsoDateTime;
}

// Open SO line as ingested from the ATS app's Excel snapshot. Each row
// is one customer + style+color combo with a ship_date so the planning
// grid can bucket "On SO" by period instead of showing a SKU-wide total.
export interface IpOpenSoRow {
  id?: string;
  sku_id: string;
  customer_id: string | null;
  customer_name: string | null;
  so_number: string | null;
  ship_date: IpIsoDate | null;
  cancel_date: IpIsoDate | null;
  qty_ordered: number;
  qty_shipped: number;
  qty_open: number;
  unit_price: number | null;
  currency: IpCurrencyCode | null;
  status: string | null;
  store: string | null;
  source: string;
  source_line_key: string;
  last_seen_at: IpIsoDateTime;
}

export interface IpProductChannelStatus {
  id?: string;
  sku_id: string;
  channel_id: string;
  status: string | null;
  listed: boolean;
  price: number | null;
  compare_at_price: number | null;
  currency: IpCurrencyCode | null;
  published_at: IpIsoDateTime | null;
  unpublished_at: IpIsoDateTime | null;
  source: IpSource;
  raw_payload_id?: string | null;
  observed_at: IpIsoDateTime;
}
