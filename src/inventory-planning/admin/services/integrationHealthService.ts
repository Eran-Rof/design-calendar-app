// Integration health: list + derive a status from observed timestamps
// and the freshness thresholds in ip_data_freshness_thresholds.
//
// The status computation is idempotent — calling `refreshStatuses()`
// will patch rows whose computed status differs from what's stored.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type {
  IpFreshnessSignal,
  IpIntegrationHealth,
  IpIntegrationStatus,
} from "../types/admin";

const HOUR = 1000 * 60 * 60;

async function sbGet<T>(path: string): Promise<T[]> {
  if (!SB_URL) return [];
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) return [];
  return r.json();
}
async function sbPatch(path: string, body: unknown): Promise<void> {
  if (!SB_URL) return;
  await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

export async function listIntegrationHealth(): Promise<IpIntegrationHealth[]> {
  return sbGet<IpIntegrationHealth>("ip_integration_health?select=*&order=system_name.asc,endpoint.asc&limit=500");
}

// Pure: given the raw row + a threshold, compute the status.
export function computeStatus(row: IpIntegrationHealth, thresholdHours: number): IpIntegrationStatus {
  if (!row.last_attempt_at) return "unknown";
  const now = Date.now();
  if (row.last_error_at && (!row.last_success_at || row.last_error_at > row.last_success_at)) {
    // last attempt failed
    return "error";
  }
  if (row.last_success_at) {
    const age = (now - Date.parse(row.last_success_at)) / HOUR;
    if (age > thresholdHours) return "warning";
    return "healthy";
  }
  return "unknown";
}

// Sync statuses in-place. Returns the updated rows.
export async function refreshStatuses(
  rows: IpIntegrationHealth[],
  thresholds: Map<string, number>,
): Promise<IpIntegrationHealth[]> {
  const out: IpIntegrationHealth[] = [];
  for (const row of rows) {
    const entityKey = `${row.system_name}_${row.endpoint.replace(/-/g, "_")}`;
    const threshold = thresholds.get(entityKey) ?? 24;
    const newStatus = computeStatus(row, threshold);
    if (newStatus !== row.status) {
      await sbPatch(`ip_integration_health?id=eq.${row.id}`, { status: newStatus });
      out.push({ ...row, status: newStatus });
    } else {
      out.push(row);
    }
  }
  return out;
}

// Record a sync attempt from the app (e.g. when a planner clicks Ingest).
// success → updates last_success_at + last_rows_synced; failure → sets
// last_error_at + last_error_message. The UI then refreshes statuses.
export async function recordSyncAttempt(args: {
  system_name: string;
  endpoint: string;
  success: boolean;
  rows_synced?: number | null;
  error_message?: string | null;
  notes?: string | null;
}): Promise<void> {
  if (!SB_URL) return;
  const now = new Date().toISOString();
  const body: Record<string, unknown> = {
    last_attempt_at: now,
  };
  if (args.success) {
    body.last_success_at = now;
    body.last_rows_synced = args.rows_synced ?? null;
    body.last_error_at = null;
    body.last_error_message = null;
  } else {
    body.last_error_at = now;
    body.last_error_message = args.error_message ?? null;
  }
  if (args.notes != null) body.notes = args.notes;
  await fetch(`${SB_URL}/rest/v1/ip_integration_health?system_name=eq.${encodeURIComponent(args.system_name)}&endpoint=eq.${encodeURIComponent(args.endpoint)}`, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

// Freshness helpers used by both this service and the UI banner.
export function ageHours(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / HOUR;
}
