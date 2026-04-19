// Typed shapes of upstream responses. These are narrower than reality —
// upstream systems return many more fields — but they cover what the
// normalizers read. If the normalizer needs a new field, add it here and
// update the mapper together so the compiler catches callers.

// ── Xoro ────────────────────────────────────────────────────────────────────
// Xoro endpoints share a common envelope: `{ Result: boolean, Data: T[], TotalPages?, Message? }`.
// Fields use PascalCase and are often string-encoded numbers — normalize
// carefully at the edge.
export interface XoroEnvelope<T> {
  Result: boolean;
  Data: T[];
  TotalPages?: number;
  Message?: string;
}

export interface XoroItem {
  Id?: string | number;
  ItemNumber?: string;
  Sku?: string;
  StyleNumber?: string;
  Description?: string;
  CategoryName?: string;
  VendorName?: string;
  VendorNumber?: string;
  Color?: string;
  Size?: string;
  Uom?: string;
  UnitPrice?: string | number;
  UnitCost?: string | number;
  LeadTimeDays?: string | number;
  Moq?: string | number;
  Status?: string;
  IsActive?: boolean | string;
}

export interface XoroSalesLine {
  Id?: string | number;
  OrderNumber?: string;
  InvoiceNumber?: string;
  TxnDate?: string;
  InvoiceDate?: string;
  ShipDate?: string;
  OrderDate?: string;
  CustomerName?: string;
  CustomerNumber?: string;
  ItemNumber?: string;
  Sku?: string;
  Qty?: string | number;
  QtyShipped?: string | number;
  QtyInvoiced?: string | number;
  UnitPrice?: string | number;
  LineAmount?: string | number;
  DiscountAmount?: string | number;
  NetAmount?: string | number;
  Currency?: string;
  CategoryName?: string;
}

export interface XoroInventoryLine {
  Id?: string | number;
  ItemNumber?: string;
  Sku?: string;
  WarehouseCode?: string;
  LocationName?: string;
  SnapshotDate?: string;
  AsOfDate?: string;
  QtyOnHand?: string | number;
  QtyAvailable?: string | number;
  QtyCommitted?: string | number;
  QtyOnOrder?: string | number;
  QtyInTransit?: string | number;
}

export interface XoroReceiptLine {
  Id?: string | number;
  ReceiptNumber?: string;
  ReceiptId?: string | number;
  TxnId?: string | number;
  ReceivedDate?: string;
  TxnDate?: string;
  PoNumber?: string;
  PurchaseOrderNumber?: string;
  ItemNumber?: string;
  Sku?: string;
  QtyReceived?: string | number;
  Qty?: string | number;
  VendorName?: string;
  VendorNumber?: string;
  LocationName?: string;
  WarehouseCode?: string;
}

export interface XoroOpenPoLine {
  Id?: string | number;
  PoNumber?: string;
  PoLineNumber?: string | number;
  OrderDate?: string;
  ExpectedDate?: string;
  DateExpectedDelivery?: string;
  ItemNumber?: string;
  Sku?: string;
  QtyOrdered?: string | number;
  QtyOrder?: string | number;
  QtyReceived?: string | number;
  QtyRemaining?: string | number;
  UnitCost?: string | number;
  Currency?: string;
  StatusName?: string;
  Status?: string;
  VendorName?: string;
  VendorNumber?: string;
}

// ── Shopify ────────────────────────────────────────────────────────────────
// REST Admin shapes (the /api/shopify/* handlers normalize GraphQL responses
// into the REST shape for simplicity; if we switch to GraphQL in Phase 1,
// add a transform at the handler level, not here).
export interface ShopifyMoney {
  amount?: string;
  currency_code?: string;
}

export interface ShopifyLineItem {
  id?: number | string;
  sku?: string;
  variant_id?: number | string;
  product_id?: number | string;
  quantity?: number;
  price?: string | number;
  total_discount?: string | number;
  price_set?: { shop_money?: ShopifyMoney };
  taxable?: boolean;
}

export interface ShopifyRefundLineItem {
  line_item_id?: number | string;
  quantity?: number;
  subtotal?: string | number;
  total_tax?: string | number;
  line_item?: { sku?: string; variant_id?: number | string };
}

export interface ShopifyRefund {
  id?: number | string;
  order_id?: number | string;
  created_at?: string;
  refund_line_items?: ShopifyRefundLineItem[];
  transactions?: Array<{ amount?: string | number; kind?: string; status?: string }>;
}

export interface ShopifyOrder {
  id?: number | string;
  name?: string;
  order_number?: number | string;
  created_at?: string;
  processed_at?: string;
  currency?: string;
  line_items?: ShopifyLineItem[];
  refunds?: ShopifyRefund[];
  cancelled_at?: string | null;
  financial_status?: string;
  fulfillment_status?: string;
  customer?: { id?: number | string };
}

export interface ShopifyVariant {
  id?: number | string;
  product_id?: number | string;
  sku?: string;
  title?: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  price?: string | number;
  compare_at_price?: string | number | null;
  inventory_item_id?: number | string;
  inventory_quantity?: number;
}

export interface ShopifyProduct {
  id?: number | string;
  title?: string;
  handle?: string;
  product_type?: string;
  vendor?: string;
  status?: string;
  published_at?: string | null;
  variants?: ShopifyVariant[];
  tags?: string;
}

export interface ShopifyCollection {
  id?: number | string;
  handle?: string;
  title?: string;
  published_at?: string | null;
  products_count?: number;
}

export interface ShopifyInventoryLevel {
  inventory_item_id?: number | string;
  location_id?: number | string;
  available?: number;
  updated_at?: string;
}
