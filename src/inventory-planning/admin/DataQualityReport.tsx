// Admin surface: runs the data-quality scanner against the current
// planning tables and shows a grouped view. Read-only in Phase 0 —
// resolving issues writes to ip_data_quality_issues in Phase 1.

import { useEffect, useMemo, useState } from "react";
import type { IpDataQualityIssue, IpDataQualityReport, IpDqSeverity } from "../types/dataQuality";
import { scanDataQuality } from "../services/dataQuality";
import { loadPlanningSnapshot } from "../services/planningClient";

const SEVERITY_COLOR: Record<IpDqSeverity, string> = {
  error: "#c53030",
  warning: "#b7791f",
  info: "#2b6cb0",
};

export default function DataQualityReport() {
  const [report, setReport] = useState<IpDataQualityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<IpDqSeverity | "all">("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");

  async function runScan() {
    setLoading(true);
    setError(null);
    try {
      const snap = await loadPlanningSnapshot();
      const r = scanDataQuality(snap);
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void runScan();
  }, []);

  const issues = report?.issues ?? [];
  const visible = useMemo(() => {
    return issues.filter((i) => {
      if (filterSeverity !== "all" && i.severity !== filterSeverity) return false;
      if (filterCategory !== "all" && i.category !== filterCategory) return false;
      return true;
    });
  }, [issues, filterSeverity, filterCategory]);

  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const i of issues) s.add(i.category);
    return Array.from(s).sort();
  }, [issues]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Planning — Data Quality</h1>
        <button onClick={runScan} disabled={loading}
                style={{ padding: "6px 12px", cursor: "pointer" }}>
          {loading ? "Scanning…" : "Re-scan"}
        </button>
        {report && (
          <span style={{ fontSize: 13, color: "#4a5568" }}>
            Scanned {new Date(report.scanned_at).toLocaleString()}
          </span>
        )}
      </div>

      {error && <div style={{ color: "#c53030", marginBottom: 16 }}>Error: {error}</div>}

      {report && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            {(["error", "warning", "info"] as IpDqSeverity[]).map((sev) => (
              <SeverityPill
                key={sev}
                severity={sev}
                count={report.issue_count_by_severity[sev]}
                active={filterSeverity === sev}
                onClick={() => setFilterSeverity(filterSeverity === sev ? "all" : sev)}
              />
            ))}
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}
                    style={{ padding: 6 }}>
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c} ({report.issue_count_by_category[c as keyof typeof report.issue_count_by_category] ?? 0})</option>
              ))}
            </select>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                <th style={{ padding: 8 }}>Severity</th>
                <th style={{ padding: 8 }}>Category</th>
                <th style={{ padding: 8 }}>Message</th>
                <th style={{ padding: 8 }}>Entity</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <IssueRow key={i.entity_key ?? `${i.category}-${i.message}`} issue={i} />
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={4} style={{ padding: 16, color: "#718096" }}>No issues match the filter.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function SeverityPill({ severity, count, active, onClick }: {
  severity: IpDqSeverity; count: number; active: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 12px",
      border: `1px solid ${SEVERITY_COLOR[severity]}`,
      background: active ? SEVERITY_COLOR[severity] : "transparent",
      color: active ? "#fff" : SEVERITY_COLOR[severity],
      cursor: "pointer",
      borderRadius: 999,
      fontSize: 13,
    }}>
      {severity.toUpperCase()}: {count}
    </button>
  );
}

function IssueRow({ issue }: { issue: IpDataQualityIssue }) {
  return (
    <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
      <td style={{ padding: 8, color: SEVERITY_COLOR[issue.severity], fontWeight: 600 }}>
        {issue.severity}
      </td>
      <td style={{ padding: 8 }}>{issue.category}</td>
      <td style={{ padding: 8 }}>{issue.message}</td>
      <td style={{ padding: 8, color: "#4a5568" }}>
        {issue.entity_type ?? "-"}
        {issue.entity_id ? ` / ${issue.entity_id.slice(0, 8)}` : ""}
      </td>
    </tr>
  );
}
