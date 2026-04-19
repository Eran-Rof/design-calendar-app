// Shopify → normalized planning rows.
//
// Shopify is the source of truth for ecom demand. One order can produce
// multiple normalized rows (one per line item) and refunds fold into the
// same row via returned_qty / refund_amount.

import type {
  ShopifyCollection,
  ShopifyInventoryLevel,
  ShopifyLineItem,
  ShopifyOrder,
  ShopifyProduct,
  ShopifyRefund,
  ShopifyVariant,
} from "../types/rawPayloads";
import type {
  IpInventorySnapshot,
  IpItem,
  IpProductChannelStatus,
  IpSalesEcomRow,
} from "../types/entities";
import {
  canonicalizeSku,
  deriveStyleFromSku,
} from "../mapping/canonicalKeys";
import {
  toIsoDate,
  toIsoDateTime,
  toNumberOrZero,
  toOptionalNumber,
  toOptionalString,
} from "../mapping/parsers";

// ── Products / variants → item master ──────────────────────────────────────
export interface ShopifyNormalizedItem
  extends Omit<IpItem, "id" | "category_id" | "vendor_id"> {
  _src: {
    shopify_product_id: string | null;
    shopify_variant_id: string | null;
    vendor_name: string | null;
    product_type: string | null;
  };
}

export function normalizeShopifyVariant(
  product: ShopifyProduct,
  variant: ShopifyVariant,
): ShopifyNormalizedItem | null {
  const sku = canonicalizeSku(variant.sku);
  if (!sku) return null;
  // Style derivation: prefer product.handle as a style_code when present
  // (it's Shopify-stable across variants); otherwise derive from SKU.
  const style = toOptionalString(product.handle)?.toUpperCase() ?? deriveStyleFromSku(sku);
  const color = toOptionalString(variant.option2) ?? toOptionalString(variant.option1);
  const size = toOptionalString(variant.option3) ?? toOptionalString(variant.option1);

  return {
    sku_code: sku,
    style_code: style ?? null,
    description: toOptionalString(product.title),
    color,
    size,
    uom: "each",
    unit_cost: null, // Shopify REST doesn't expose unit cost on variants.
    unit_price: toOptionalNumber(variant.price),
    lead_time_days: null,
    moq_units: null,
    lifecycle_status: toOptionalString(product.status),
    planning_class: null,
    active: toOptionalString(product.status) !== "archived",
    external_refs: {
      shopify_product_id: toOptionalString(product.id) ?? undefined,
      shopify_variant_id: toOptionalString(variant.id) ?? undefined,
      shopify_inventory_item_id: toOptionalString(variant.inventory_item_id) ?? undefined,
      shopify_sku: toOptionalString(variant.sku) ?? undefined,
    },
    attributes: {
      shopify_tags: toOptionalString(product.tags),
      shopify_vendor: toOptionalString(product.vendor),
    },
    _src: {
      shopify_product_id: toOptionalString(product.id),
      shopify_variant_id: toOptionalString(variant.id),
      vendor_name: toOptionalString(product.vendor),
      product_type: toOptionalString(product.product_type),
    },
  };
}

export function normalizeShopifyProduct(product: ShopifyProduct): ShopifyNormalizedItem[] {
  return (product.variants ?? [])
    .map((v) => normalizeShopifyVariant(product, v))
    .filter((r): r is ShopifyNormalizedItem => r != null);
}

// ── Order lines → sales_history_ecom ───────────────────────────────────────
export interface ShopifyNormalizedSalesRow
  extends Omit<IpSalesEcomRow, "id" | "sku_id" | "channel_id" | "category_id"> {
  _src: {
    sku: string | null;
    shopify_variant_id: string | null;
    shopify_product_id: string | null;
  };
}

// Compute the returned qty & refund amount for a given order line by
// summing refund_line_items that reference it. Shopify sends these at
// the refund level, not the line level, so we aggregate.
function refundsForLine(
  line: ShopifyLineItem,
  refunds: ShopifyRefund[] | undefined,
): { qty: number; amount: number } {
  if (!refunds?.length || line.id == null) return { qty: 0, amount: 0 };
  const lineId = String(line.id);
  let qty = 0;
  let amount = 0;
  for (const r of refunds) {
    for (const rl of r.refund_line_items ?? []) {
      if (String(rl.line_item_id) !== lineId) continue;
      qty += toNumberOrZero(rl.quantity);
      amount += toNumberOrZero(rl.subtotal);
    }
  }
  return { qty, amount };
}

export function normalizeShopifyOrder(
  order: ShopifyOrder,
  opts: { storefront_code: string; raw_payload_id?: string | null },
): ShopifyNormalizedSalesRow[] {
  const orderDate = toIsoDate(order.processed_at ?? order.created_at);
  if (!orderDate) return [];
  const orderNumber = toOptionalString(order.name ?? order.order_number);
  const currency = toOptionalString(order.currency);
  const refunds = order.refunds ?? [];
  const rows: ShopifyNormalizedSalesRow[] = [];

  for (const line of order.line_items ?? []) {
    const sku = canonicalizeSku(line.sku);
    const variantId = toOptionalString(line.variant_id);
    // Shopify can emit line items with no SKU (gift cards, tips). Skip
    // them — they're not planning-relevant — but a data-quality issue gets
    // raised upstream if SKU is genuinely missing for a real product.
    if (!sku && !variantId) continue;

    const qty = toNumberOrZero(line.quantity);
    const unitPrice = toOptionalNumber(line.price);
    const gross = unitPrice != null ? unitPrice * qty : null;
    const discount = toOptionalNumber(line.total_discount);
    const { qty: returnedQty, amount: refundAmount } = refundsForLine(line, refunds);
    const netQty = Math.max(qty - returnedQty, 0);

    const lineId = toOptionalString(line.id);
    const source_line_key =
      `shopify:${opts.storefront_code}:${toOptionalString(order.id) ?? orderNumber ?? "nil"}:${lineId ?? variantId ?? sku ?? "nil"}`;

    rows.push({
      order_number: orderNumber,
      order_date: orderDate,
      qty,
      returned_qty: returnedQty,
      net_qty: netQty,
      gross_amount: gross,
      discount_amount: discount,
      refund_amount: refundAmount || null,
      net_amount: gross != null ? gross - (discount ?? 0) - (refundAmount ?? 0) : null,
      currency,
      source: "shopify",
      raw_payload_id: opts.raw_payload_id ?? null,
      source_line_key,
      _src: {
        sku,
        shopify_variant_id: variantId,
        shopify_product_id: toOptionalString(line.product_id),
      },
    });
  }
  return rows;
}

// ── Product → product_channel_status ───────────────────────────────────────
export interface ShopifyNormalizedChannelStatus
  extends Omit<IpProductChannelStatus, "id" | "sku_id" | "channel_id"> {
  _src: {
    sku: string | null;
    shopify_variant_id: string | null;
    shopify_product_id: string | null;
    storefront_code: string;
  };
}

export function normalizeShopifyProductChannelStatus(
  product: ShopifyProduct,
  variant: ShopifyVariant,
  opts: { storefront_code: string; raw_payload_id?: string | null },
): ShopifyNormalizedChannelStatus | null {
  const sku = canonicalizeSku(variant.sku);
  if (!sku) return null;
  return {
    status: toOptionalString(product.status),
    listed: toOptionalString(product.published_at) != null,
    price: toOptionalNumber(variant.price),
    compare_at_price: toOptionalNumber(variant.compare_at_price),
    currency: null, // Shopify returns shop-level currency on the order, not on the variant.
    published_at: toIsoDateTime(product.published_at),
    unpublished_at: null,
    source: "shopify",
    raw_payload_id: opts.raw_payload_id ?? null,
    observed_at: new Date().toISOString(),
    _src: {
      sku,
      shopify_variant_id: toOptionalString(variant.id),
      shopify_product_id: toOptionalString(product.id),
      storefront_code: opts.storefront_code,
    },
  };
}

// ── Collections — kept for reference / category hints ──────────────────────
// Collections don't become a planning entity on their own in Phase 0; we
// just surface them for the data-quality report ("products not in any
// collection") and to inform category reconciliation.
export interface ShopifyNormalizedCollection {
  collection_id: string;
  handle: string | null;
  title: string | null;
  products_count: number | null;
}

export function normalizeShopifyCollection(col: ShopifyCollection): ShopifyNormalizedCollection | null {
  const id = toOptionalString(col.id);
  if (!id) return null;
  return {
    collection_id: id,
    handle: toOptionalString(col.handle),
    title: toOptionalString(col.title),
    products_count: toOptionalNumber(col.products_count),
  };
}

// ── Inventory levels → inventory_snapshot (ecom) ───────────────────────────
// Requires a variant lookup so we can resolve inventory_item_id → SKU. The
// handler passes that mapping in via `variantsByInventoryItemId`.
export interface ShopifyNormalizedInventoryRow
  extends Omit<IpInventorySnapshot, "id" | "sku_id"> {
  _src: { sku: string | null; inventory_item_id: string };
}

export function normalizeShopifyInventoryLevel(
  level: ShopifyInventoryLevel,
  variantsByInventoryItemId: Map<string, ShopifyVariant>,
  opts: { snapshot_date: string; raw_payload_id?: string | null },
): ShopifyNormalizedInventoryRow | null {
  const invItemId = toOptionalString(level.inventory_item_id);
  if (!invItemId) return null;
  const variant = variantsByInventoryItemId.get(invItemId);
  const sku = variant ? canonicalizeSku(variant.sku) : null;
  return {
    warehouse_code: toOptionalString(level.location_id) ?? "SHOPIFY",
    snapshot_date: opts.snapshot_date,
    qty_on_hand: toNumberOrZero(level.available),
    qty_available: toNumberOrZero(level.available),
    qty_committed: null,
    qty_on_order: null,
    qty_in_transit: null,
    source: "shopify",
    raw_payload_id: opts.raw_payload_id ?? null,
    _src: { sku, inventory_item_id: invItemId },
  };
}
