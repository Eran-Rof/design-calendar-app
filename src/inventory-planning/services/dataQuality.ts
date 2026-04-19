// Data-quality scanner. Pure functions — take already-loaded arrays of
// normalized rows and return issues. Kept separate from the admin UI so
// the same logic can run from a server cron in Phase 1 without dragging
// React along.
//
// Every check builds a deterministic `entity_key` so a subsequent run
// can de-dupe via the partial unique index on ip_data_quality_issues.

import type {
  IpDataQualityIssue,
  IpDataQualityReport,
  IpDqSeverity,
  IpDqCategory,
} from "../types/dataQuality";
import type {
  IpInventorySnapshot,
  IpItem,
  IpOpenPoRow,
  IpReceiptRow,
  IpSalesEcomRow,
  IpSalesWholesaleRow,
} from "../types/entities";
import { canonicalizeSku } from "../mapping/canonicalKeys";

export interface DqInput {
  items: IpItem[];
  inventory: IpInventorySnapshot[];
  salesWholesale: IpSalesWholesaleRow[];
  salesEcom: IpSalesEcomRow[];
  receipts: IpReceiptRow[];
  openPos: IpOpenPoRow[];
  // External SKU strings we've seen on the Shopify side that didn't
  // resolve during reconciliation (emitted by the normalizer pipeline).
  unmappedShopifySkus?: string[];
}

function issue(
  severity: IpDqSeverity,
  category: IpDqCategory,
  message: string,
  entityKey: string,
  details: Record<string, unknown> = {},
  entity: { type?: string; id?: string | null } = {},
): IpDataQualityIssue {
  return {
    severity,
    category,
    message,
    entity_type: entity.type ?? null,
    entity_id: entity.id ?? null,
    entity_key: entityKey,
    details,
  };
}

// ── Individual checks ──────────────────────────────────────────────────────
export function checkDuplicateSkus(items: IpItem[]): IpDataQualityIssue[] {
  const seen = new Map<string, IpItem[]>();
  for (const it of items) {
    const key = canonicalizeSku(it.sku_code);
    if (!key) continue;
    const bucket = seen.get(key) ?? [];
    bucket.push(it);
    seen.set(key, bucket);
  }
  const out: IpDataQualityIssue[] = [];
  for (const [sku, group] of seen) {
    if (group.length > 1) {
      out.push(
        issue(
          "error",
          "duplicate_sku",
          `SKU ${sku} has ${group.length} rows in item_master`,
          `duplicate_sku:${sku}`,
          { sku, item_ids: group.map((g) => g.id) },
          { type: "ip_item_master" },
        ),
      );
    }
  }
  return out;
}

export function checkMissingStyle(items: IpItem[]): IpDataQualityIssue[] {
  return items
    .filter((it) => !it.style_code)
    .map((it) =>
      issue(
        "warning",
        "missing_style_mapping",
        `SKU ${it.sku_code} has no style_code`,
        `missing_style_mapping:${it.sku_code}`,
        { sku: it.sku_code },
        { type: "ip_item_master", id: it.id },
      ),
    );
}

export function checkMissingLeadTime(items: IpItem[]): IpDataQualityIssue[] {
  return items
    .filter((it) => it.active && (it.lead_time_days == null || it.lead_time_days <= 0))
    .map((it) =>
      issue(
        "warning",
        "missing_lead_time",
        `SKU ${it.sku_code} has no lead_time_days`,
        `missing_lead_time:${it.sku_code}`,
        { sku: it.sku_code },
        { type: "ip_item_master", id: it.id },
      ),
    );
}

export function checkMissingCategory(items: IpItem[]): IpDataQualityIssue[] {
  return items
    .filter((it) => it.active && !it.category_id)
    .map((it) =>
      issue(
        "warning",
        "missing_category",
        `SKU ${it.sku_code} has no category_id`,
        `missing_category:${it.sku_code}`,
        { sku: it.sku_code },
        { type: "ip_item_master", id: it.id },
      ),
    );
}

export function checkMissingCustomerOnWholesaleSales(
  sales: IpSalesWholesaleRow[],
): IpDataQualityIssue[] {
  return sales
    .filter((r) => !r.customer_id)
    .map((r) =>
      issue(
        "warning",
        "missing_customer",
        `Wholesale sale on ${r.txn_date} (order ${r.order_number ?? "?"}) has no customer_id`,
        `missing_customer:${r.source}:${r.source_line_key}`,
        { source_line_key: r.source_line_key },
        { type: "ip_sales_history_wholesale", id: r.id ?? null },
      ),
    );
}

export function checkMissingChannelOnEcomSales(
  sales: IpSalesEcomRow[],
): IpDataQualityIssue[] {
  return sales
    .filter((r) => !r.channel_id)
    .map((r) =>
      issue(
        "error",
        "missing_channel",
        `Ecom sale on ${r.order_date} (${r.order_number ?? "?"}) has no channel_id`,
        `missing_channel:${r.source}:${r.source_line_key}`,
        { source_line_key: r.source_line_key },
        { type: "ip_sales_history_ecom", id: r.id ?? null },
      ),
    );
}

export function checkMissingVendorOnReceipts(
  receipts: IpReceiptRow[],
): IpDataQualityIssue[] {
  return receipts
    .filter((r) => !r.vendor_id)
    .map((r) =>
      issue(
        "warning",
        "missing_vendor",
        `Receipt ${r.receipt_number ?? "?"} on ${r.received_date} has no vendor_id`,
        `missing_vendor:receipt:${r.source_line_key}`,
        { source_line_key: r.source_line_key },
        { type: "ip_receipts_history", id: r.id ?? null },
      ),
    );
}

export function checkDateInconsistencies(
  openPos: IpOpenPoRow[],
): IpDataQualityIssue[] {
  // Any expected_date that falls before order_date is suspect.
  return openPos
    .filter((p) => p.order_date && p.expected_date && p.expected_date < p.order_date)
    .map((p) =>
      issue(
        "warning",
        "date_inconsistency",
        `PO ${p.po_number} line ${p.po_line_number ?? "?"} has expected_date ${p.expected_date} before order_date ${p.order_date}`,
        `date_inconsistency:po:${p.po_number}:${p.po_line_number ?? p.source_line_key}`,
        { po_number: p.po_number, order_date: p.order_date, expected_date: p.expected_date },
        { type: "ip_open_purchase_orders", id: p.id ?? null },
      ),
    );
}

export function checkImpossibleInventory(
  snapshots: IpInventorySnapshot[],
): IpDataQualityIssue[] {
  const out: IpDataQualityIssue[] = [];
  for (const s of snapshots) {
    if (s.qty_on_hand < 0) {
      out.push(
        issue(
          "error",
          "impossible_inventory",
          `Negative qty_on_hand ${s.qty_on_hand} for sku ${s.sku_id} at ${s.warehouse_code} on ${s.snapshot_date}`,
          `impossible_inventory:${s.sku_id}:${s.warehouse_code}:${s.snapshot_date}`,
          { ...s },
          { type: "ip_inventory_snapshot", id: s.id ?? null },
        ),
      );
    } else if (
      s.qty_available != null &&
      s.qty_on_hand != null &&
      s.qty_available > s.qty_on_hand
    ) {
      out.push(
        issue(
          "warning",
          "impossible_inventory",
          `qty_available (${s.qty_available}) exceeds qty_on_hand (${s.qty_on_hand}) for sku ${s.sku_id}`,
          `impossible_inventory_avail:${s.sku_id}:${s.warehouse_code}:${s.snapshot_date}`,
          { ...s },
          { type: "ip_inventory_snapshot", id: s.id ?? null },
        ),
      );
    }
  }
  return out;
}

export function checkUnmappedShopifySkus(
  unmapped: string[] | undefined,
): IpDataQualityIssue[] {
  if (!unmapped || unmapped.length === 0) return [];
  const unique = Array.from(new Set(unmapped.map((s) => canonicalizeSku(s)).filter((s): s is string => s != null)));
  return unique.map((sku) =>
    issue(
      "warning",
      "shopify_sku_unmapped",
      `Shopify SKU ${sku} does not map to any internal sku_code`,
      `shopify_sku_unmapped:${sku}`,
      { sku },
    ),
  );
}

export function checkOrphanSales(
  sales: IpSalesWholesaleRow[] | IpSalesEcomRow[],
  items: IpItem[],
  kind: "wholesale" | "ecom",
): IpDataQualityIssue[] {
  const knownIds = new Set(items.map((i) => i.id));
  return sales
    .filter((r) => !knownIds.has(r.sku_id))
    .map((r) =>
      issue(
        "error",
        "orphan_sales_row",
        `${kind} sale row references unknown sku_id ${r.sku_id}`,
        `orphan_sales_row:${kind}:${r.source}:${r.source_line_key}`,
        { source_line_key: r.source_line_key, sku_id: r.sku_id },
      ),
    );
}

// ── Top-level runner ───────────────────────────────────────────────────────
export function scanDataQuality(input: DqInput): IpDataQualityReport {
  const issues: IpDataQualityIssue[] = [
    ...checkDuplicateSkus(input.items),
    ...checkMissingStyle(input.items),
    ...checkMissingLeadTime(input.items),
    ...checkMissingCategory(input.items),
    ...checkMissingCustomerOnWholesaleSales(input.salesWholesale),
    ...checkMissingChannelOnEcomSales(input.salesEcom),
    ...checkMissingVendorOnReceipts(input.receipts),
    ...checkDateInconsistencies(input.openPos),
    ...checkImpossibleInventory(input.inventory),
    ...checkUnmappedShopifySkus(input.unmappedShopifySkus),
    ...checkOrphanSales(input.salesWholesale, input.items, "wholesale"),
    ...checkOrphanSales(input.salesEcom, input.items, "ecom"),
  ];

  const bySeverity: Record<IpDqSeverity, number> = { info: 0, warning: 0, error: 0 };
  const byCategory: Partial<Record<IpDqCategory, number>> = {};
  for (const i of issues) {
    bySeverity[i.severity]++;
    byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  }
  return {
    scanned_at: new Date().toISOString(),
    issue_count_by_severity: bySeverity,
    issue_count_by_category: byCategory,
    issues,
  };
}
