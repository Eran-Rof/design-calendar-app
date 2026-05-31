// Costing Module — TypeScript types
// Mirror the column shapes from supabase/migrations/20260621000000_costing_module.sql.

export type CostingStatus =
  | "draft"
  | "in_progress"
  | "quoted"
  | "awarded"
  | "closed"
  | "cancelled";

export type CostingQuoteStatus =
  | "pending"
  | "received"
  | "selected"
  | "rejected"
  | "expired";

export type CostingComplianceStatus =
  | "na"
  | "required"
  | "submitted"
  | "approved"
  | "rejected";

export type CostingStyleState = "cad" | "tech_pack" | "sample" | "none";

export interface CostingProject {
  id: string;
  entity_id: string;
  project_name: string;
  brand: string | null;
  gender_code: string | null;
  sales_rep_id: string | null;
  customer_id: string | null;
  request_date: string | null;
  due_date: string | null;
  projected_delivery_date: string | null;
  status: CostingStatus;
  notes: string | null;
  grid_state: Record<string, unknown>;
  user_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  // join hints
  customer?: { id: string; code: string | null; billing_address: Record<string, unknown> | null } | null;
  sales_rep?: { id: string; display_name: string } | null;
}

export interface CostingLine {
  id: string;
  entity_id: string;
  project_id: string;
  sort_order: number;
  style_master_id: string | null;
  style_code: string | null;
  style_name: string | null;
  description: string | null;
  picture_url: string | null;
  size_scale_id: string | null;
  size_scale_label: string | null;
  fabric_code: string | null;
  fit: string | null;
  color: string | null;
  bottom_closure: string | null;
  waist_type: string | null;
  waste_type: string | null;
  category_id: string | null;
  sub_category_id: string | null;
  style_state: CostingStyleState | null;
  comment: string | null;
  remarks: string | null;
  target_qty: number | null;
  target_cost: number | null;
  /** Read-only historical reference, written once on style pick from ip_item_avg_cost. */
  avg_cost: number | null;
  /** LY weighted-avg sales price, stamped by /api/internal/costing/comp/ly. */
  ly_unit_price: number | null;
  /** T3 weighted-avg sales price, stamped by /api/internal/costing/comp/t3. */
  t3_unit_price: number | null;
  sell_target: number | null;
  sell_price: number | null;
  priced_date: string | null;
  fob_cost: number | null;
  duty_rate: number | null;
  freight: number | null;
  insurance: number | null;
  other_costs: number | null;
  landed_cost: number | null;
  margin_pct: number | null;
  selected_vendor_quote_id: string | null;
  ly_qty: number | null;
  ly_unit_cost: number | null;
  ly_total_margin: number | null;
  ly_margin_pct: number | null;
  t3_qty: number | null;
  t3_unit_cost: number | null;
  t3_total_cost: number | null;
  t3_margin_pct: number | null;
  comp_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CostingLineVendor {
  id: string;
  entity_id: string;
  costing_line_id: string;
  vendor_id: string;
  quoted_cost: number;
  currency: string;
  lead_time_days: number | null;
  moq: number | null;
  quoted_date: string;
  valid_until: string | null;
  status: CostingQuoteStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  vendor?: { id: string; code: string | null; legal_name: string | null } | null;
}

export interface CostingLineCompliance {
  id: string;
  entity_id: string;
  costing_line_id: string;
  requirement_code: string;
  status: CostingComplianceStatus;
  notes: string | null;
  attachment_url: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CostingProjectDetail {
  project: CostingProject;
  lines: CostingLine[];
  vendor_quotes_by_line_id: Record<string, CostingLineVendor[]>;
  compliance_by_line_id: Record<string, CostingLineCompliance[]>;
}

export interface CostingProjectDraft {
  project_name: string;
  brand?: string | null;
  gender_code?: string | null;
  sales_rep_id?: string | null;
  customer_id?: string | null;
  request_date?: string | null;
  due_date?: string | null;
  projected_delivery_date?: string | null;
  status?: CostingStatus;
  notes?: string | null;
}

export interface CostingProjectPatch extends Partial<CostingProjectDraft> {
  grid_state?: Record<string, unknown>;
}

export type CostingView = "list" | "edit";

// ── Chunk 5 — comp aggregation response ────────────────────────────────────
// LY (/api/internal/costing/comp/ly) and T3 (/api/internal/costing/comp/t3)
// return Record<style_code, CompResult>. The shared shape covers both:
//   • LY uses `total_margin` (sum of margin_amount) + `weighted_margin_pct`.
//   • T3 uses `total_cost` (sum of qty*unit_cost_at_sale) + `weighted_margin_pct`.
// Both fields are optional so each endpoint can populate only what it cares
// about without the other dimension polluting the snapshot.
// `comp_grain_warning` is set when every sales-history row for the style in
// the requested window was pack-grain — the PPK guard zeroes the aggregates
// to avoid double-counting (see project_ppk_grain_rule_CANONICAL).
export interface CompResult {
  qty: number;
  weighted_unit_cost: number | null;
  /** Weighted avg sales price = sum(net_amount) / sum(qty). Both LY + T3. */
  weighted_unit_price: number | null;
  weighted_margin_pct: number | null;
  txn_count: number;
  window_from?: string;
  window_to?: string;
  total_margin?: number;       // LY endpoint
  total_cost?: number;         // T3 endpoint
  comp_grain_warning?: boolean;
}

export type CompResultMap = Record<string, CompResult>;

export interface CompWindow {
  from: string; // ISO YYYY-MM-DD
  to: string;
}

// ── RFQ list / edit ─────────────────────────────────────────────────────────
// Mirrors the existing rfqs / rfq_line_items / rfq_invitations Tangerine
// procurement tables (phase8 schema). source_costing_project_id is the
// back-pointer that lets the list view join through to the customer.

export type RfqStatus = "draft" | "published" | "closed" | "awarded";

export interface RfqListRow {
  id: string;
  entity_id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: RfqStatus;
  submission_deadline: string | null;
  delivery_required_by: string | null;
  estimated_quantity: number | null;
  estimated_budget: number | null;
  currency: string;
  source_costing_project_id: string | null;
  created_at: string;
  updated_at: string;
  // Denormalized for the list table (computed server-side).
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_code: string | null;
  customer_id: string | null;
  customer_name: string | null;
  project_name: string | null;
  line_count: number;
  preview_lines: string[];
}

export interface RfqLineItem {
  id: string;
  rfq_id: string;
  line_index: number;
  description: string;
  quantity: number;
  unit_of_measure: string | null;
  specifications: string | null;
  created_at: string;
}

export interface RfqInvitation {
  id: string;
  vendor_id: string;
  status: string;
  vendors?: {
    id: string;
    code: string | null;
    name: string | null;
    legal_name: string | null;
    country: string | null;
    default_currency: string | null;
  } | null;
}

export interface RfqDetail {
  rfq: RfqListRow;
  line_items: RfqLineItem[];
  invitations: RfqInvitation[];
  source_project: {
    id: string;
    project_name: string;
    customer: { id: string; code: string | null; billing_address: Record<string, unknown> | null } | null;
  } | null;
}

export interface RfqPatch {
  title?: string;
  description?: string | null;
  category?: string | null;
  status?: RfqStatus;
  submission_deadline?: string | null;
  delivery_required_by?: string | null;
  estimated_quantity?: number | null;
  estimated_budget?: number | null;
  currency?: string;
}
