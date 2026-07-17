// Types for the planning Vendors screen (ip_vendor_master management).
//
// A planning vendor (ip_vendor_master) is the buy-plan's vendor: an execution
// action's vendor_id points at one of these rows, and its portal_vendor_id
// links it to a Tangerine `vendors` row so buy-plan → PO can route the line.

export interface PlanningVendor {
  id: string;
  vendor_code: string;
  name: string;
  country: string | null;
  default_lead_time_days: number | null;
  moq_units: number | null;
  active: boolean;
  portal_vendor_id: string | null;
  // Joined from `vendors` when portal_vendor_id is set (null when unlinked).
  tangerine_vendor_name: string | null;
  tangerine_vendor_code: string | null;
  created_at: string;
  updated_at: string;
}

// Lightweight option for the "Link to Tangerine" picker.
export interface TangerineVendorOption {
  id: string;
  name: string;
  code: string | null;
}

export interface SeedResult {
  created: number;
  skipped: number;
  vendors: PlanningVendor[];
  message: string;
}
