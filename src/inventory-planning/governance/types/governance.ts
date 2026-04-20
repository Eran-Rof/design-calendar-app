// Phase 7 — governance / roles / permissions types.

import type { IpIsoDateTime } from "../../types/entities";

// Whitelisted permission keys. A role's `permissions` JSONB blob is
// checked against this set when reading — unknown keys are ignored, new
// keys only add capabilities (never remove).
export const PERMISSION_KEYS = [
  "read_forecasts",
  "edit_forecasts",
  "edit_buyer_requests",
  "edit_ecom_overrides",
  "manage_scenarios",
  "approve_plans",
  "view_audit_logs",
  "create_execution_batches",
  "approve_execution",
  "run_exports",
  "run_writeback",
  "manage_integrations",
  "manage_allocation_rules",
  "manage_ai_suggestions",
  "manage_users_or_roles",
] as const;
export type IpPermissionKey = (typeof PERMISSION_KEYS)[number];

export interface IpRole {
  id: string;
  role_name: string;
  description: string | null;
  permissions: Partial<Record<IpPermissionKey, boolean>>;
  is_system: boolean;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpUserRole {
  id: string;
  user_email: string;
  role_id: string;
  granted_by: string | null;
  granted_at: IpIsoDateTime;
  active: boolean;
  note: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

// Consolidated view used throughout the UI.
export interface IpUserWithPermissions {
  user_email: string;
  roles: Array<{ role_name: string; description: string | null }>;
  permissions: Partial<Record<IpPermissionKey, boolean>>;
}
