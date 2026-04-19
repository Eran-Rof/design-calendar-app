// Xoro → normalized planning rows.
//
// Each function takes one Xoro record and returns a partial normalized row
// carrying the *upstream* strings it resolved — callers merge in internal
// ids via the reconciliation layer (mapping/reconcile.ts). This split
// means normalizers are pure and unit-testable without Supabase.

import type {
  XoroInventoryLine,
  XoroItem,
  XoroOpenPoLine,
  XoroReceiptLine,
  XoroSalesLine,
} from "../types/rawPayloads";
import type {
  IpInventorySnapshot,
  IpItem,
  IpOpenPoRow,
  IpReceiptRow,
  IpSalesTxnType,
  IpSalesWholesaleRow,
} from "../types/entities";
import {
  canonicalizeCategory,
  canonicalizeSku,
  canonicalizeVendorName,
  deriveStyleFromSku,
} from "../mapping/canonicalKeys";
import {
  toIsoDate,
  toNumberOrZero,
  toOptionalNumber,
  toOptionalString,
} from "../mapping/parsers";

// Rows returned by normalizers before reconciliation. The `_src` block
// carries the upstream strings so the reconciler can look up internal ids.
export interface XoroNormalizedItem extends Omit<IpItem, "id" | "category_id" | "vendor_id"> {
  _src: {
    category_name: string | null;
    vendor_name: string | null;
    vendor_code: string | null;
  };
}

export function normalizeXoroItem(row: XoroItem): XoroNormalizedItem | null {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;
  const style =
    toOptionalString(row.StyleNumber)?.toUpperCase() ||
    deriveStyleFromSku(sku);

  return {
    sku_code: sku,
    style_code: style ?? null,
    description: toOptionalString(row.Description),
    color: toOptionalString(row.Color),
    size: toOptionalString(row.Size),
    uom: toOptionalString(row.Uom) ?? "each",
    unit_cost: toOptionalNumber(row.UnitCost),
    unit_price: toOptionalNumber(row.UnitPrice),
    lead_time_days: toOptionalNumber(row.LeadTimeDays),
    moq_units: toOptionalNumber(row.Moq),
    lifecycle_status: toOptionalString(row.Status),
    planning_class: null,
    active: true,
    external_refs: {
      xoro_item_id: toOptionalString(row.Id) ?? undefined,
      xoro_item_number: toOptionalString(row.ItemNumber) ?? undefined,
    },
    attributes: {},
    _src: {
      category_name: canonicalizeCategory(row.CategoryName),
      vendor_name: canonicalizeVendorName(row.VendorName),
      vendor_code: toOptionalString(row.VendorNumber),
    },
  };
}

// Sales line — Xoro shapes vary between order/invoice endpoints, so we
// accept either and let the caller tell us which `txn_type` to stamp.
export interface XoroNormalizedSalesRow
  extends Omit<IpSalesWholesaleRow, "id" | "sku_id" | "customer_id" | "category_id" | "channel_id"> {
  _src: {
    sku: string | null;
    customer_name: string | null;
    customer_code: string | null;
    category_name: string | null;
  };
}

export function normalizeXoroSalesLine(
  row: XoroSalesLine,
  opts: { txn_type: IpSalesTxnType; raw_payload_id?: string | null },
): XoroNormalizedSalesRow | null {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;

  const txnDate =
    toIsoDate(
      opts.txn_type === "invoice" ? row.InvoiceDate ?? row.TxnDate :
      opts.txn_type === "ship"    ? row.ShipDate    ?? row.TxnDate :
      /* order */                   row.OrderDate   ?? row.TxnDate,
    );
  if (!txnDate) return null;

  const qty =
    opts.txn_type === "invoice" ? toNumberOrZero(row.QtyInvoiced ?? row.Qty) :
    opts.txn_type === "ship"    ? toNumberOrZero(row.QtyShipped  ?? row.Qty) :
                                  toNumberOrZero(row.Qty);

  const unitPrice = toOptionalNumber(row.UnitPrice);
  const gross = toOptionalNumber(row.LineAmount);
  const discount = toOptionalNumber(row.DiscountAmount);
  const net = toOptionalNumber(row.NetAmount) ??
    (gross != null ? gross - (discount ?? 0) : null);

  // Deterministic line key: invoice line > order line > fallback to
  // (sku + txn_date + xoro id). The key is per-source so Xoro's own ids
  // don't collide with Shopify's.
  const baseId = toOptionalString(row.Id);
  const invoice = toOptionalString(row.InvoiceNumber);
  const order = toOptionalString(row.OrderNumber);
  const source_line_key =
    invoice && baseId ? `xoro:inv:${invoice}:${baseId}` :
    order   && baseId ? `xoro:ord:${order}:${baseId}` :
                        `xoro:${sku}:${txnDate}:${baseId ?? "nil"}`;

  return {
    txn_type: opts.txn_type,
    txn_date: txnDate,
    order_number: order,
    invoice_number: invoice,
    qty,
    unit_price: unitPrice,
    gross_amount: gross,
    discount_amount: discount,
    net_amount: net,
    currency: toOptionalString(row.Currency),
    source: "xoro",
    raw_payload_id: opts.raw_payload_id ?? null,
    source_line_key,
    _src: {
      sku,
      customer_name: toOptionalString(row.CustomerName),
      customer_code: toOptionalString(row.CustomerNumber),
      category_name: canonicalizeCategory(row.CategoryName),
    },
  };
}

// Inventory snapshot.
export interface XoroNormalizedInventoryRow
  extends Omit<IpInventorySnapshot, "id" | "sku_id"> {
  _src: { sku: string | null };
}

export function normalizeXoroInventoryLine(
  row: XoroInventoryLine,
  opts: { raw_payload_id?: string | null; default_snapshot_date?: string | null } = {},
): XoroNormalizedInventoryRow | null {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;
  const snapshotDate =
    toIsoDate(row.SnapshotDate ?? row.AsOfDate) ?? opts.default_snapshot_date ?? null;
  if (!snapshotDate) return null;

  return {
    warehouse_code:
      toOptionalString(row.WarehouseCode) ?? toOptionalString(row.LocationName) ?? "DEFAULT",
    snapshot_date: snapshotDate,
    qty_on_hand: toNumberOrZero(row.QtyOnHand),
    qty_available: toOptionalNumber(row.QtyAvailable),
    qty_committed: toOptionalNumber(row.QtyCommitted),
    qty_on_order: toOptionalNumber(row.QtyOnOrder),
    qty_in_transit: toOptionalNumber(row.QtyInTransit),
    source: "xoro",
    raw_payload_id: opts.raw_payload_id ?? null,
    _src: { sku },
  };
}

// Receipts.
export interface XoroNormalizedReceiptRow
  extends Omit<IpReceiptRow, "id" | "sku_id" | "vendor_id"> {
  _src: { sku: string | null; vendor_name: string | null; vendor_code: string | null };
}

export function normalizeXoroReceiptLine(
  row: XoroReceiptLine,
  opts: { raw_payload_id?: string | null } = {},
): XoroNormalizedReceiptRow | null {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;
  const receivedDate = toIsoDate(row.ReceivedDate ?? row.TxnDate);
  if (!receivedDate) return null;

  const baseId = toOptionalString(row.Id ?? row.ReceiptId ?? row.TxnId);
  const receiptNumber = toOptionalString(row.ReceiptNumber);
  const source_line_key = baseId
    ? `xoro:rcpt:${baseId}:${sku}`
    : `xoro:rcpt:${receiptNumber ?? "nil"}:${sku}:${receivedDate}`;

  return {
    po_number: toOptionalString(row.PoNumber ?? row.PurchaseOrderNumber),
    receipt_number: receiptNumber,
    received_date: receivedDate,
    qty: toNumberOrZero(row.QtyReceived ?? row.Qty),
    warehouse_code: toOptionalString(row.WarehouseCode ?? row.LocationName),
    source: "xoro",
    raw_payload_id: opts.raw_payload_id ?? null,
    source_line_key,
    _src: {
      sku,
      vendor_name: canonicalizeVendorName(row.VendorName),
      vendor_code: toOptionalString(row.VendorNumber),
    },
  };
}

// Open POs.
export interface XoroNormalizedOpenPoRow
  extends Omit<IpOpenPoRow, "id" | "sku_id" | "vendor_id" | "last_seen_at"> {
  _src: { sku: string | null; vendor_name: string | null; vendor_code: string | null };
}

export function normalizeXoroOpenPoLine(
  row: XoroOpenPoLine,
  opts: { raw_payload_id?: string | null } = {},
): XoroNormalizedOpenPoRow | null {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;
  const po = toOptionalString(row.PoNumber);
  if (!po) return null;

  const qtyOrdered = toNumberOrZero(row.QtyOrdered ?? row.QtyOrder);
  const qtyReceived = toNumberOrZero(row.QtyReceived);
  // QtyRemaining is Xoro-authoritative; fall back to computation only if
  // missing. Kept visible so reviewers can flip the preference later.
  const qtyOpenRaw = toOptionalNumber(row.QtyRemaining);
  const qtyOpen = qtyOpenRaw ?? Math.max(qtyOrdered - qtyReceived, 0);

  const lineNo = toOptionalString(row.PoLineNumber);
  const baseId = toOptionalString(row.Id);
  const source_line_key = baseId
    ? `xoro:po:${po}:${baseId}`
    : `xoro:po:${po}:${lineNo ?? sku}`;

  return {
    po_number: po,
    po_line_number: lineNo,
    order_date: toIsoDate(row.OrderDate),
    expected_date: toIsoDate(row.ExpectedDate ?? row.DateExpectedDelivery),
    qty_ordered: qtyOrdered,
    qty_received: qtyReceived,
    qty_open: qtyOpen,
    unit_cost: toOptionalNumber(row.UnitCost),
    currency: toOptionalString(row.Currency),
    status: toOptionalString(row.StatusName ?? row.Status),
    source: "xoro",
    raw_payload_id: opts.raw_payload_id ?? null,
    source_line_key,
    _src: {
      sku,
      vendor_name: canonicalizeVendorName(row.VendorName),
      vendor_code: toOptionalString(row.VendorNumber),
    },
  };
}
