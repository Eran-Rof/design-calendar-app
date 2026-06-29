// Admin surface: runs the data-quality scanner against the current
// planning tables and shows a grouped view. Read-only in Phase 0 —
// resolving issues writes to ip_data_quality_issues in Phase 1.

import { useEffect, useMemo, useState } from "react";
import type { IpDataQualityIssue, IpDataQualityReport, IpDqSeverity } from "../types/dataQuality";
import { scanDataQuality } from "../services/dataQuality";
import { loadPlanningSnapshot } from "../services/planningClient";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../tanda/components/TablePrefs";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import { useSort } from "../../tanda/hooks/useSort";
import SortableTh from "../../tanda/components/SortableTh";

const TABLE_KEY = "ip.data_quality";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "severity", label: "Severity" },
  { key: "category", label: "Category" },
  { key: "message", label: "Message" },
  { key: "entity", label: "Entity" },
];

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
  const [truncated, setTruncated] = useState<string[]>([]);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function runScan() {
    setLoading(true);
    setError(null);
    try {
      const snap = await loadPlanningSnapshot();
      setTruncated(snap.truncatedTables);
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

  // Additive per-column sort over the filtered issues. Entity maps to the
  // looked-up entity_type the cell renders; the rest are direct scalars.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(visible, {
    persistKey: "ip:data_quality:sort",
    accessors: {
      entity: (i) => i.entity_type ?? "",
    },
  });

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

      {truncated.length > 0 && (
        <div style={{
          marginBottom: 16, padding: "8px 12px", borderRadius: 6,
          background: "#fffbeb", border: "1px solid #f6e05e", color: "#744210", fontSize: 13,
        }}>
          Partial scan: {truncated.join(", ")} exceeded the row ceiling, so cross-row
          checks (orphans, duplicates) may be incomplete. Treat results as indicative.
        </div>
      )}

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
            <div style={{ minWidth: 200 }}>
              <SearchableSelect
                value={filterCategory}
                onChange={(v) => setFilterCategory(v)}
                inputStyle={{ padding: 6 }}
                options={[
                  { value: "all", label: "All categories" },
                  ...categories.map((c) => ({
                    value: c,
                    label: `${c} (${report.issue_count_by_category[c as keyof typeof report.issue_count_by_category] ?? 0})`,
                  })),
                ]}
              />
            </div>
            <div style={{ marginLeft: "auto" }}>
              <TablePrefsButton tableKey={TABLE_KEY} columns={ALL_COLUMNS} visibleColumns={visibleColumns}
                                onToggle={toggleColumn} onReset={resetToDefault} onSetAll={setAllVisible} />
            </div>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                <SortableTh label="Severity" sortKey="severity" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ padding: 8 }} hidden={!visibleColumns.has("severity")} />
                <SortableTh label="Category" sortKey="category" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ padding: 8 }} hidden={!visibleColumns.has("category")} />
                <SortableTh label="Message" sortKey="message" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ padding: 8 }} hidden={!visibleColumns.has("message")} />
                <SortableTh label="Entity" sortKey="entity" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ padding: 8 }} hidden={!visibleColumns.has("entity")} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((i) => (
                <IssueRow key={i.entity_key ?? `${i.category}-${i.message}`} issue={i} visibleColumns={visibleColumns} />
              ))}
              {sorted.length === 0 && (
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

function IssueRow({ issue, visibleColumns }: { issue: IpDataQualityIssue; visibleColumns: Set<string> }) {
  return (
    <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
      <td hidden={!visibleColumns.has("severity")} style={{ padding: 8, color: SEVERITY_COLOR[issue.severity], fontWeight: 600 }}>
        {issue.severity}
      </td>
      <td hidden={!visibleColumns.has("category")} style={{ padding: 8 }}>{issue.category}</td>
      <td hidden={!visibleColumns.has("message")} style={{ padding: 8 }}>{issue.message}</td>
      <td hidden={!visibleColumns.has("entity")} style={{ padding: 8, color: "#4a5568" }}>
        {issue.entity_type ?? "—"}
      </td>
    </tr>
  );
}
