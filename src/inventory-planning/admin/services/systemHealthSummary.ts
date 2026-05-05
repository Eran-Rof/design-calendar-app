// Aggregates the two operational signals planners working OUTSIDE
// the admin dashboard need to see at a glance:
//
//   • Failed jobs in the last 24 h (any job_type) — surfaces broken
//     ingests, broken recompute passes, broken writeback batches.
//   • Integrations whose computed status is "error" — surfaces
//     outright-down sources before a planner builds a forecast on
//     stale data.
//
// Both numbers feed SystemHealthBanner. Reads only — never writes.
// Tolerates failure: if either fetch errors, the count comes back
// as 0 rather than blowing up the host page.

import { listRecentJobs } from "../../jobs/services/jobRunService";
import { listIntegrationHealth } from "./integrationHealthService";

export interface SystemHealthSummary {
  failedJobs24h: number;
  failedJobsByType: Array<{ job_type: string; count: number }>;
  // Integration rows whose status is "error" — keep names so the
  // banner can show "Xoro sync, Shopify sync" inline.
  brokenIntegrations: Array<{ system_name: string; endpoint: string }>;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export async function loadSystemHealthSummary(): Promise<SystemHealthSummary> {
  // Parallel fetches; failures of either don't block the other.
  const [jobs, integrations] = await Promise.all([
    listRecentJobs({ status: "failed", limit: 200 }).catch(() => []),
    listIntegrationHealth().catch(() => []),
  ]);

  const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;
  const recentFailed = jobs.filter((j) => {
    const t = Date.parse(j.created_at);
    return Number.isFinite(t) && t >= cutoff;
  });

  const byType = new Map<string, number>();
  for (const j of recentFailed) {
    byType.set(j.job_type, (byType.get(j.job_type) ?? 0) + 1);
  }
  const failedJobsByType = Array.from(byType, ([job_type, count]) => ({ job_type, count }))
    .sort((a, b) => b.count - a.count);

  const brokenIntegrations = integrations
    .filter((i) => i.status === "error")
    .map((i) => ({ system_name: i.system_name, endpoint: i.endpoint }));

  return {
    failedJobs24h: recentFailed.length,
    failedJobsByType,
    brokenIntegrations,
  };
}
