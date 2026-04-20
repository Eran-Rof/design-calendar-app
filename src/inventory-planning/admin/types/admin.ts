// Phase 7 — admin tooling types (integration health, freshness).

import type { IpIsoDateTime } from "../../types/entities";

export type IpIntegrationStatus = "healthy" | "warning" | "error" | "unknown";

export interface IpIntegrationHealth {
  id: string;
  system_name: string;
  endpoint: string;
  last_attempt_at: IpIsoDateTime | null;
  last_success_at: IpIsoDateTime | null;
  last_error_at: IpIsoDateTime | null;
  last_error_message: string | null;
  last_rows_synced: number | null;
  status: IpIntegrationStatus;
  notes: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export type IpFreshnessSeverity = "info" | "warning" | "critical";

export interface IpFreshnessThreshold {
  id: string;
  entity_type: string;
  max_age_hours: number;
  severity: IpFreshnessSeverity;
  note: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

// A computed "freshness signal" for a particular entity. Built by the
// service from the threshold + the observed last-update timestamp.
export interface IpFreshnessSignal {
  entity_type: string;
  last_updated_at: IpIsoDateTime | null;
  age_hours: number | null;
  threshold_hours: number;
  severity: IpFreshnessSeverity | "fresh";
  note: string | null;
}
