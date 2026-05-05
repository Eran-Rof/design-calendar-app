// Cross-workbench banner that surfaces operational signals living
// outside the per-page StaleDataBanner: recent failed jobs and
// broken integrations. The point is that a planner working in
// /planning/wholesale would otherwise be blind to "Xoro sync just
// failed" or "3 anomaly-detection jobs failed in last hour" until
// they navigate to /planning/admin.
//
// Renders nothing when the system is clean. Otherwise: red bar on
// any error, with inline list of broken systems / failed job types
// and a link to the admin dashboard. Dismissable per session
// (sessionStorage) so the banner doesn't keep blocking the page
// while the planner finishes their current task. Same dismissal
// pattern as StaleDataBanner.

import { useEffect, useMemo, useState } from "react";
import { loadSystemHealthSummary, type SystemHealthSummary } from "../../admin/services/systemHealthSummary";
import { PAL } from "../../components/styles";

const DISMISS_KEY = "ip_system_health_dismiss";

export default function SystemHealthBanner() {
  const [summary, setSummary] = useState<SystemHealthSummary | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  });

  useEffect(() => {
    let cancelled = false;
    loadSystemHealthSummary()
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch(() => { /* fail-open: no banner beats a broken banner */ });
    return () => { cancelled = true; };
  }, []);

  const hasIssue = useMemo(() => {
    if (!summary) return false;
    return summary.failedJobs24h > 0 || summary.brokenIntegrations.length > 0;
  }, [summary]);

  if (dismissed || !summary || !hasIssue) return null;

  const color = "#EF4444";
  function dismiss() {
    setDismissed(true);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    }
  }

  return (
    <div style={{
      background: color + "15",
      border: `1px solid ${color}`,
      borderRadius: 8,
      padding: "10px 14px",
      color,
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      marginBottom: 12,
      fontSize: 13,
    }}>
      <span style={{ fontSize: 16, lineHeight: 1 }}>⚠</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, marginBottom: 2 }}>System health</div>
        <div style={{ color: PAL.textDim, fontSize: 12 }}>
          {summary.brokenIntegrations.length > 0 && (
            <span style={{ marginRight: 12 }}>
              <strong>{summary.brokenIntegrations.length} integration{summary.brokenIntegrations.length === 1 ? "" : "s"} down:</strong>
              {" "}
              {summary.brokenIntegrations.slice(0, 4).map((i) => `${i.system_name}/${i.endpoint}`).join(", ")}
              {summary.brokenIntegrations.length > 4 && ` +${summary.brokenIntegrations.length - 4} more`}
            </span>
          )}
          {summary.failedJobs24h > 0 && (
            <span>
              <strong>{summary.failedJobs24h} failed job{summary.failedJobs24h === 1 ? "" : "s"} in last 24 h:</strong>
              {" "}
              {summary.failedJobsByType.slice(0, 3).map((j) => `${j.job_type} (${j.count})`).join(", ")}
              {summary.failedJobsByType.length > 3 && ` +${summary.failedJobsByType.length - 3} more`}
            </span>
          )}
        </div>
      </div>
      <a href="/planning/admin" style={{ color, textDecoration: "underline", fontSize: 12 }}>Admin →</a>
      <button onClick={dismiss}
              style={{ background: "transparent", border: `1px solid ${color}44`, color, borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 12 }}>
        Dismiss
      </button>
    </div>
  );
}
