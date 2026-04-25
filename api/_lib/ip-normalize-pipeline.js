// api/_lib/ip-normalize-pipeline.js
//
// Server-side normalization pipeline: reads raw_xoro_payloads /
// raw_shopify_payloads, runs endpoint-specific normalizers, reconciles
// upstream strings to internal master UUIDs, and upserts into ip_* tables.
//
// Called by api/cron/ip-normalize.js and available to on-demand routes.
// Masters are loaded once per pipeline invocation so individual row
// processing is purely in-memory (no per-row Supabase round trips for
// master lookups).
//
// JS mirror of the TS normalizers in src/inventory-planning/normalize/*.
// When you update the TS versions, update these in tandem.

// ── Canonical key helpers ─────────────────────────────────────────────────────
// Mirrors src/inventory-planning/mapping/canonicalKeys.ts

const CORP_SUFFIX = /\b(INC|LLC|LTD|LIMITED|CORP|CO|GMBH|S\.?A\.?|PTE|PTY)\b\.?/gi;

function canonicalizeSku(s) {
  if (!s) return null;
  const t = String(s).trim().toUpperCase();
  return t || null;
}

function canonicalizeVendorName(s) {
  if (!s) return null;
  const cleaned = String(s).replace(CORP_SUFFIX, "").replace(/[,.]+/g, "").trim().toUpperCase().replace(/\s+/g, " ");
  return cleaned || null;
}

function canonicalizeCategory(s) {
  if (!s) return null;
  const t = String(s).trim().toUpperCase().replace(/\s+/g, " ");
  return t || null;
}

function canonicalizeChannelCode(s) {
  if (!s) return null;
  const t = String(s).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return t || null;
}

function canonicalizeCustomerName(s) {
  if (!s) return null;
  // Matches TS canonicalKeys.ts: strips punctuation (no corp-suffix stripping for customers).
  const cleaned = String(s).replace(/['']/g, "").replace(/[^A-Za-z0-9&\s]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  return cleaned || null;
}

function deriveStyleFromSku(sku) {
  if (!sku) return null;
  const parts = sku.split("-");
  if (parts.length <= 2) return sku;
  return parts.slice(0, -2).join("-") || null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────
// Mirrors src/inventory-planning/mapping/parsers.ts

function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function toNumberOrZero(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

function toOptionalNumber(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

function toOptionalString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ── Master data loader ────────────────────────────────────────────────────────

export async function loadMasters(admin) {
  const [vendors, categories, channels, customers, items] = await Promise.all([
    admin.from("ip_vendor_master").select("id,vendor_code,name,external_refs"),
    admin.from("ip_category_master").select("id,category_code,name"),
    admin.from("ip_channel_master").select("id,channel_code,name,storefront_key"),
    admin.from("ip_customer_master").select("id,customer_code,name,external_refs"),
    admin.from("ip_item_master").select("id,sku_code,external_refs"),
  ]);
  return {
    vendors: vendors.data ?? [],
    categories: categories.data ?? [],
    channels: channels.data ?? [],
    customers: customers.data ?? [],
    items: items.data ?? [],
  };
}

// ── Reconciliation ────────────────────────────────────────────────────────────
// 3-tier: external_ref > code > name. Returns internal uuid or null.

function reconcileVendorId(src, vendors) {
  if (!src) return null;
  if (src.vendor_code) {
    const r = vendors.find((v) => v.vendor_code === src.vendor_code);
    if (r) return r.id;
  }
  const canon = canonicalizeVendorName(src.vendor_name);
  if (canon) {
    const r = vendors.find((v) => canonicalizeVendorName(v.name) === canon);
    if (r) return r.id;
  }
  return null;
}

function reconcileCategoryId(name, categories) {
  const canon = canonicalizeCategory(name);
  if (!canon) return null;
  const byCode = categories.find((c) => c.category_code?.toUpperCase() === canon);
  if (byCode) return byCode.id;
  const byName = categories.find((c) => canonicalizeCategory(c.name) === canon);
  return byName?.id ?? null;
}

function reconcileChannelId(storefrontCode, channels) {
  if (!storefrontCode) return null;
  const byStore = channels.find((c) => c.storefront_key === storefrontCode);
  if (byStore) return byStore.id;
  const canon = canonicalizeChannelCode(storefrontCode);
  if (!canon) return null;
  const byCode = channels.find((c) => c.channel_code?.toUpperCase() === canon);
  return byCode?.id ?? null;
}

function reconcileCustomerId(src, customers) {
  if (!src) return null;
  if (src.customer_code) {
    const r = customers.find((c) => c.customer_code === src.customer_code);
    if (r) return r.id;
  }
  const canon = canonicalizeCustomerName(src.customer_name);
  if (canon) {
    const r = customers.find((c) => canonicalizeCustomerName(c.name) === canon);
    if (r) return r.id;
  }
  return null;
}

function reconcileItemId(src, items) {
  if (!src?.sku) return null;
  if (src.xoro_item_id) {
    const r = items.find((i) => i.external_refs?.xoro_item_id === String(src.xoro_item_id));
    if (r) return r.id;
  }
  if (src.shopify_variant_id) {
    const r = items.find((i) => i.external_refs?.shopify_variant_id === String(src.shopify_variant_id));
    if (r) return r.id;
  }
  const sku = canonicalizeSku(src.sku);
  if (!sku) return null;
  const byCode = items.find((i) => i.sku_code === sku);
  return byCode?.id ?? null;
}

// ── Xoro normalizers ──────────────────────────────────────────────────────────

function normalizeXoroItem(row) {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;
  const style = toOptionalString(row.StyleNumber)?.toUpperCase() || deriveStyleFromSku(sku);
  const leadTimeDays = toOptionalNumber(row.LeadTimeDays);
  const moqUnits = toOptionalNumber(row.Moq);
  return {
    sku_code: sku,
    style_code: style ?? null,
    description: toOptionalString(row.Description),
    color: toOptionalString(row.Color),
    size: toOptionalString(row.Size),
    uom: toOptionalString(row.Uom) ?? "each",
    unit_cost: toOptionalNumber(row.UnitCost),
    unit_price: toOptionalNumber(row.UnitPrice),
    lead_time_days: leadTimeDays != null ? Math.round(leadTimeDays) : null,
    moq_units: moqUnits != null ? Math.round(moqUnits) : null,
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

function normalizeXoroSalesLine(row, txnType, rawPayloadId) {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;
  const txnDate = toIsoDate(
    txnType === "invoice" ? row.InvoiceDate ?? row.TxnDate :
    txnType === "ship"    ? row.ShipDate    ?? row.TxnDate :
                            row.OrderDate   ?? row.TxnDate,
  );
  if (!txnDate) return null;
  const qty =
    txnType === "invoice" ? toNumberOrZero(row.QtyInvoiced ?? row.Qty) :
    txnType === "ship"    ? toNumberOrZero(row.QtyShipped  ?? row.Qty) :
                            toNumberOrZero(row.Qty);
  const gross = toOptionalNumber(row.LineAmount);
  const discount = toOptionalNumber(row.DiscountAmount);
  const net = toOptionalNumber(row.NetAmount) ?? (gross != null ? gross - (discount ?? 0) : null);
  const baseId = toOptionalString(row.Id);
  const invoice = toOptionalString(row.InvoiceNumber);
  const order = toOptionalString(row.OrderNumber);
  const source_line_key =
    invoice && baseId ? `xoro:inv:${invoice}:${baseId}` :
    order   && baseId ? `xoro:ord:${order}:${baseId}` :
                        `xoro:${sku}:${txnDate}:${baseId ?? "nil"}`;
  return {
    txn_type: txnType,
    txn_date: txnDate,
    order_number: order,
    invoice_number: invoice,
    qty,
    unit_price: toOptionalNumber(row.UnitPrice),
    gross_amount: gross,
    discount_amount: discount,
    net_amount: net,
    currency: toOptionalString(row.Currency),
    source: "xoro",
    raw_payload_id: rawPayloadId ?? null,
    source_line_key,
    _src: {
      sku,
      xoro_item_id: baseId,
      customer_name: toOptionalString(row.CustomerName),
      customer_code: toOptionalString(row.CustomerNumber),
      category_name: canonicalizeCategory(row.CategoryName),
    },
  };
}

function normalizeXoroInventoryLine(row, rawPayloadId, defaultSnapshotDate) {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;
  const snapshotDate = toIsoDate(row.SnapshotDate ?? row.AsOfDate) ?? defaultSnapshotDate ?? null;
  if (!snapshotDate) return null;
  return {
    warehouse_code: toOptionalString(row.WarehouseCode ?? row.LocationName) ?? "DEFAULT",
    snapshot_date: snapshotDate,
    qty_on_hand: toNumberOrZero(row.QtyOnHand),
    qty_available: toOptionalNumber(row.QtyAvailable),
    qty_committed: toOptionalNumber(row.QtyCommitted),
    qty_on_order: toOptionalNumber(row.QtyOnOrder),
    qty_in_transit: toOptionalNumber(row.QtyInTransit),
    source: "xoro",
    raw_payload_id: rawPayloadId ?? null,
    _src: { sku },
  };
}

function normalizeXoroReceiptLine(row, rawPayloadId) {
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
    raw_payload_id: rawPayloadId ?? null,
    source_line_key,
    _src: {
      sku,
      vendor_name: canonicalizeVendorName(row.VendorName),
      vendor_code: toOptionalString(row.VendorNumber),
    },
  };
}

function normalizeXoroOpenPoLine(row, rawPayloadId) {
  const sku = canonicalizeSku(row.Sku ?? row.ItemNumber);
  if (!sku) return null;
  const po = toOptionalString(row.PoNumber);
  if (!po) return null;
  const qtyOrdered = toNumberOrZero(row.QtyOrdered ?? row.QtyOrder);
  const qtyReceived = toNumberOrZero(row.QtyReceived);
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
    raw_payload_id: rawPayloadId ?? null,
    source_line_key,
    _src: {
      sku,
      vendor_name: canonicalizeVendorName(row.VendorName),
      vendor_code: toOptionalString(row.VendorNumber),
    },
  };
}

// ── Shopify normalizers ───────────────────────────────────────────────────────

function normalizeShopifyOrderLine(lineItem, order, storefrontCode, rawPayloadId) {
  const sku = canonicalizeSku(lineItem.sku);
  if (!sku) return null;
  const orderDate = toIsoDate(order.created_at ?? order.processed_at);
  if (!orderDate) return null;
  const qty = toNumberOrZero(lineItem.quantity);
  const returnedQty = toNumberOrZero(lineItem.refunded_quantity ?? 0);
  const unitPrice = toOptionalNumber(lineItem.price) ?? 0;
  const gross = unitPrice * qty;
  const discount = (lineItem.discount_allocations ?? []).reduce(
    (s, d) => s + (parseFloat(d.amount) || 0), 0,
  ) || toOptionalNumber(lineItem.total_discount) || 0;
  const net = gross - discount;
  const lineId = toOptionalString(lineItem.id);
  const orderId = toOptionalString(order.id ?? order.name);
  const source_line_key = `shopify:${storefrontCode}:${orderId}:${lineId ?? sku}`;
  return {
    order_number: toOptionalString(order.name),
    order_date: orderDate,
    qty,
    returned_qty: returnedQty,
    net_qty: qty - returnedQty,
    gross_amount: gross || null,
    discount_amount: discount || null,
    refund_amount: null,
    net_amount: net || null,
    currency: toOptionalString(order.currency),
    source: "shopify",
    raw_payload_id: rawPayloadId ?? null,
    source_line_key,
    _src: {
      sku,
      shopify_variant_id: toOptionalString(lineItem.variant_id),
      storefront_code: storefrontCode,
    },
  };
}

function normalizeShopifyVariant(variant, product, storefrontCode, rawPayloadId) {
  const sku = canonicalizeSku(variant.sku);
  if (!sku) return null;
  return {
    sku_code: sku,
    style_code: null,
    description: toOptionalString(product.title),
    color: toOptionalString(variant.option2) ?? toOptionalString(variant.option1),
    size: toOptionalString(variant.option3) ?? toOptionalString(variant.option1),
    uom: "each",
    unit_cost: null,
    unit_price: toOptionalNumber(variant.price),
    lead_time_days: null,
    moq_units: null,
    lifecycle_status: toOptionalString(product.status),
    planning_class: null,
    active: product.status !== "archived",
    external_refs: {
      shopify_variant_id: toOptionalString(variant.id),
      shopify_product_id: toOptionalString(product.id),
      shopify_storefront: storefrontCode,
    },
    attributes: {},
    _src: {
      category_name: canonicalizeCategory(product.product_type),
      vendor_name: canonicalizeVendorName(product.vendor),
      vendor_code: null,
    },
  };
}

// ── DB upsert helpers ─────────────────────────────────────────────────────────
// Each helper builds the full rows array (reconciling _src in-memory), then
// sends a single bulk upsert rather than one HTTP call per row.

async function upsertItems(admin, norms, masters, ignoreDuplicates = false) {
  const out = { inserted: 0, skipped: 0, errors: [] };
  const rows = norms.map((norm) => {
    const { _src, ...row } = norm;
    row.category_id = reconcileCategoryId(_src.category_name, masters.categories);
    row.vendor_id = reconcileVendorId(
      { vendor_name: _src.vendor_name, vendor_code: _src.vendor_code },
      masters.vendors,
    );
    return row;
  });
  if (rows.length === 0) return out;
  const { error } = await admin
    .from("ip_item_master")
    .upsert(rows, { onConflict: "sku_code", ignoreDuplicates });
  if (error) out.errors.push({ error: error.message });
  else out.inserted = rows.length;
  return out;
}

async function upsertWholesaleSales(admin, norms, masters) {
  const out = { inserted: 0, skipped: 0, errors: [] };
  const rows = [];
  for (const norm of norms) {
    const { _src, ...row } = norm;
    const itemId = reconcileItemId(_src, masters.items);
    if (!itemId) { out.skipped++; continue; }
    row.sku_id = itemId;
    row.customer_id = reconcileCustomerId(
      { customer_code: _src.customer_code, customer_name: _src.customer_name },
      masters.customers,
    );
    row.category_id = reconcileCategoryId(_src.category_name, masters.categories);
    row.channel_id = null;
    rows.push(row);
  }
  if (rows.length === 0) return out;
  const { error } = await admin
    .from("ip_sales_history_wholesale")
    .upsert(rows, { onConflict: "source,source_line_key", ignoreDuplicates: true });
  if (error) out.errors.push({ error: error.message });
  else out.inserted = rows.length;
  return out;
}

async function upsertInventorySnapshot(admin, norms, masters) {
  const out = { inserted: 0, skipped: 0, errors: [] };
  const rows = [];
  for (const norm of norms) {
    const { _src, ...row } = norm;
    const itemId = reconcileItemId(_src, masters.items);
    if (!itemId) { out.skipped++; continue; }
    row.sku_id = itemId;
    rows.push(row);
  }
  if (rows.length === 0) return out;
  const { error } = await admin
    .from("ip_inventory_snapshot")
    .upsert(rows, { onConflict: "sku_id,warehouse_code,snapshot_date,source", ignoreDuplicates: false });
  if (error) out.errors.push({ error: error.message });
  else out.inserted = rows.length;
  return out;
}

async function upsertReceipts(admin, norms, masters) {
  const out = { inserted: 0, skipped: 0, errors: [] };
  const rows = [];
  for (const norm of norms) {
    const { _src, ...row } = norm;
    const itemId = reconcileItemId(_src, masters.items);
    if (!itemId) { out.skipped++; continue; }
    row.sku_id = itemId;
    row.vendor_id = reconcileVendorId(_src, masters.vendors);
    rows.push(row);
  }
  if (rows.length === 0) return out;
  const { error } = await admin
    .from("ip_receipts_history")
    .upsert(rows, { onConflict: "source,source_line_key", ignoreDuplicates: true });
  if (error) out.errors.push({ error: error.message });
  else out.inserted = rows.length;
  return out;
}

async function upsertOpenPos(admin, norms, masters) {
  const out = { inserted: 0, skipped: 0, errors: [] };
  const now = new Date().toISOString();
  const rows = [];
  for (const norm of norms) {
    const { _src, ...row } = norm;
    const itemId = reconcileItemId(_src, masters.items);
    if (!itemId) { out.skipped++; continue; }
    row.sku_id = itemId;
    row.vendor_id = reconcileVendorId(_src, masters.vendors);
    row.last_seen_at = now;
    rows.push(row);
  }
  if (rows.length === 0) return out;
  const { error } = await admin
    .from("ip_open_purchase_orders")
    .upsert(rows, { onConflict: "source,source_line_key", ignoreDuplicates: false });
  if (error) out.errors.push({ error: error.message });
  else out.inserted = rows.length;
  return out;
}

async function upsertEcomSales(admin, norms, masters) {
  const out = { inserted: 0, skipped: 0, errors: [] };
  const rows = [];
  for (const norm of norms) {
    const { _src, ...row } = norm;
    const itemId = reconcileItemId(_src, masters.items);
    if (!itemId) { out.skipped++; continue; }
    row.sku_id = itemId;
    row.channel_id = reconcileChannelId(_src.storefront_code, masters.channels);
    if (!row.channel_id) { out.skipped++; continue; } // channel_id NOT NULL
    row.category_id = null;
    rows.push(row);
  }
  if (rows.length === 0) return out;
  const { error } = await admin
    .from("ip_sales_history_ecom")
    .upsert(rows, { onConflict: "source,source_line_key", ignoreDuplicates: true });
  if (error) out.errors.push({ error: error.message });
  else out.inserted = rows.length;
  return out;
}

// ── Public pipeline entry points ──────────────────────────────────────────────

export async function processXoroPayload(admin, raw, masters) {
  const data = Array.isArray(raw.payload?.data) ? raw.payload.data : [];
  if (data.length === 0) return { inserted: 0, skipped: 0, errors: [] };

  const txnType = raw.payload?.txn_type ?? "invoice";
  const defaultDate = raw.period_end ?? null;

  switch (raw.endpoint) {
    case "items":
      return upsertItems(
        admin,
        data.map(normalizeXoroItem).filter(Boolean),
        masters,
        false, // Xoro is authoritative — overwrite on conflict
      );
    case "sales-history":
      return upsertWholesaleSales(
        admin,
        data.map((r) => normalizeXoroSalesLine(r, txnType, raw.id)).filter(Boolean),
        masters,
      );
    case "inventory-snapshot":
      return upsertInventorySnapshot(
        admin,
        data.map((r) => normalizeXoroInventoryLine(r, raw.id, defaultDate)).filter(Boolean),
        masters,
      );
    case "receipts":
      return upsertReceipts(
        admin,
        data.map((r) => normalizeXoroReceiptLine(r, raw.id)).filter(Boolean),
        masters,
      );
    case "open-pos":
      return upsertOpenPos(
        admin,
        data.map((r) => normalizeXoroOpenPoLine(r, raw.id)).filter(Boolean),
        masters,
      );
    default:
      return { inserted: 0, skipped: data.length, errors: [`unknown xoro endpoint: ${raw.endpoint}`] };
  }
}

export async function processShopifyPayload(admin, raw, masters) {
  const data = Array.isArray(raw.payload?.data) ? raw.payload.data : [];
  if (data.length === 0) return { inserted: 0, skipped: 0, errors: [] };
  const storefrontCode = raw.storefront_code ?? "default";

  switch (raw.endpoint) {
    case "orders": {
      const rows = [];
      for (const order of data) {
        for (const li of order.line_items ?? []) {
          const r = normalizeShopifyOrderLine(li, order, storefrontCode, raw.id);
          if (r) rows.push(r);
        }
      }
      return upsertEcomSales(admin, rows, masters);
    }
    case "products": {
      const rows = [];
      for (const product of data) {
        for (const variant of product.variants ?? []) {
          const r = normalizeShopifyVariant(variant, product, storefrontCode, raw.id);
          if (r) rows.push(r);
        }
      }
      // Shopify is secondary — skip if Xoro already owns this SKU.
      return upsertItems(admin, rows, masters, true);
    }
    default:
      return { inserted: 0, skipped: data.length, errors: [`unknown shopify endpoint: ${raw.endpoint}`] };
  }
}
