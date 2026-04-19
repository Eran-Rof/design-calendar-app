// Data-quality contract. The scanner emits IpDataQualityIssue rows; the
// admin surface reads them and groups by category/severity.

export type IpDqSeverity = "info" | "warning" | "error";

export type IpDqCategory =
  | "duplicate_sku"
  | "missing_sku_mapping"
  | "missing_style_mapping"
  | "missing_lead_time"
  | "missing_category"
  | "missing_customer"
  | "missing_channel"
  | "missing_vendor"
  | "date_inconsistency"
  | "impossible_inventory"
  | "shopify_sku_unmapped"
  | "orphan_sales_row"
  | "orphan_receipt_row";

export interface IpDataQualityIssue {
  id?: string;
  severity: IpDqSeverity;
  category: IpDqCategory;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  // A deterministic key for upsert (e.g. `"duplicate_sku:ABC-01"`). Same
  // key used across runs, so a second scan updates `last_seen_at` instead
  // of creating a duplicate row.
  entity_key: string | null;
  details: Record<string, unknown>;
  first_seen_at?: string;
  last_seen_at?: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
  resolution_notes?: string | null;
}

export interface IpDataQualityReport {
  scanned_at: string;
  issue_count_by_severity: Record<IpDqSeverity, number>;
  issue_count_by_category: Partial<Record<IpDqCategory, number>>;
  issues: IpDataQualityIssue[];
}
