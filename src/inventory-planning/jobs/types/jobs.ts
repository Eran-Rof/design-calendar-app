// Phase 7 — job runs types.

import type { IpIsoDateTime } from "../../types/entities";

export type IpJobStatus =
  | "queued" | "running" | "succeeded" | "failed"
  | "cancelled" | "partial_success";

export interface IpJobRun {
  id: string;
  job_type: string;
  job_scope: string | null;
  status: IpJobStatus;
  started_at: IpIsoDateTime | null;
  completed_at: IpIsoDateTime | null;
  initiated_by: string | null;
  input_json: Record<string, unknown>;
  output_json: Record<string, unknown> | null;
  error_message: string | null;
  retry_count: number;
  retry_of: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}
