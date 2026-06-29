// Integration health + freshness overview.

import { useEffect, useState } from "react";
import type { IpFreshnessSignal, IpIntegrationHealth } from "../types/admin";
import {
  listIntegrationHealth,
  refreshStatuses,
} from "../services/integrationHealthService";
import {
  loadFreshnessSignals,
  thresholdsByEntity,
} from "../services/dataFreshnessService";
import { S, PAL, formatDateTime } from "../../components/styles";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";

const TABLE_KEY = "ip.integration_health";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "system", label: "System" },
  { key: "endpoint", label: "Endpoint" },
  { key: "status", label: "Status" },
  { key: "last_success", label: "Last success" },
  { key: "last_attempt", label: "Last attempt" },
  { key: "rows", label: "Rows" },
  { key: "error", label: "Error" },
];

const STATUS_COLOR: Record<string, string> = {
  healthy: "#10B981",
  warning: "#F59E0B",
  error:   "#EF4444",
  unknown: "#94A3B8",
};

const SEVERITY_COLOR: Record<string, string> = {
  fresh:    "#10B981",
  info:     "#3B82F6",
  warning:  "#F59E0B",
  critical: "#EF4444",
};

export default function IntegrationHealthDashboard() {
  const [rows, setRows] = useState<IpIntegrationHealth[]>([]);
  const [signals, setSignals] = useState<IpFreshnessSignal[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function refresh() {
    setRefreshing(true);
    try {
      const [health, sigs, thresholds] = await Promise.all([
        listIntegrationHealth(),
        loadFreshnessSignals(),
        thresholdsByEntity(),
      ]);
      const thresholdMap = new Map<string, number>();
      for (const [k, t] of thresholds) thresholdMap.set(k, t.max_age_hours);
      const updated = await refreshStatuses(health, thresholdMap);
      setRows(updated);
      setSignals(sigs);
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  // Per-column sort over the integration-health rows. Keys map to the
  // underlying scalar fields each cell renders.
  const { sorted: sortedRows, sortKey: hKey, sortDir: hDir, onHeaderClick: hClick } = useSort(rows, {
    persistKey: "ip:integration_health:sort",
    accessors: {
      system: (r) => r.system_name ?? "",
      last_success: (r) => r.last_success_at ?? "",
      last_attempt: (r) => r.last_attempt_at ?? "",
      rows: (r) => r.last_rows_synced ?? null,
      error: (r) => r.last_error_message ?? "",
    },
  });

  // Per-column sort over the freshness signals.
  const { sorted: sortedSignals, sortKey: fKey, sortDir: fDir, onHeaderClick: fClick } = useSort(signals, {
    persistKey: "ip:data_freshness:sort",
    accessors: {
      entity: (s) => s.entity_type ?? "",
      last_updated: (s) => s.last_updated_at ?? "",
      age: (s) => s.age_hours ?? null,
      threshold: (s) => s.threshold_hours ?? null,
    },
  });

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h3 style={S.cardTitle}>Integration health</h3>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <TablePrefsButton tableKey={TABLE_KEY} columns={ALL_COLUMNS} visibleColumns={visibleColumns}
                              onToggle={toggleColumn} onReset={resetToDefault} onSetAll={setAllVisible} />
            <button style={S.btnSecondary} onClick={refresh} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh status"}
            </button>
          </div>
        </div>
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                <SortableTh label="System" sortKey="system" activeKey={hKey} dir={hDir} onSort={hClick} style={S.th} hidden={!visibleColumns.has("system")} />
                <SortableTh label="Endpoint" sortKey="endpoint" activeKey={hKey} dir={hDir} onSort={hClick} style={S.th} hidden={!visibleColumns.has("endpoint")} />
                <SortableTh label="Status" sortKey="status" activeKey={hKey} dir={hDir} onSort={hClick} style={S.th} hidden={!visibleColumns.has("status")} />
                <SortableTh label="Last success" sortKey="last_success" activeKey={hKey} dir={hDir} onSort={hClick} style={S.th} hidden={!visibleColumns.has("last_success")} />
                <SortableTh label="Last attempt" sortKey="last_attempt" activeKey={hKey} dir={hDir} onSort={hClick} style={S.th} hidden={!visibleColumns.has("last_attempt")} />
                <SortableTh label="Rows" sortKey="rows" activeKey={hKey} dir={hDir} onSort={hClick} style={S.th} hidden={!visibleColumns.has("rows")} cellStyle={{ textAlign: "right" }} />
                <SortableTh label="Error" sortKey="error" activeKey={hKey} dir={hDir} onSort={hClick} style={S.th} hidden={!visibleColumns.has("error")} />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => (
                <tr key={r.id}>
                  <td hidden={!visibleColumns.has("system")} style={S.td}>{r.system_name}</td>
                  <td hidden={!visibleColumns.has("endpoint")} style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>{r.endpoint}</td>
                  <td hidden={!visibleColumns.has("status")} style={S.td}>
                    <span style={{ ...S.chip, background: STATUS_COLOR[r.status] + "33", color: STATUS_COLOR[r.status] }}>
                      {r.status}
                    </span>
                  </td>
                  <td hidden={!visibleColumns.has("last_success")} style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>
                    {r.last_success_at ? formatDateTime(r.last_success_at) : "—"}
                  </td>
                  <td hidden={!visibleColumns.has("last_attempt")} style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>
                    {r.last_attempt_at ? formatDateTime(r.last_attempt_at) : "—"}
                  </td>
                  <td hidden={!visibleColumns.has("rows")} style={S.tdNum}>{r.last_rows_synced ?? "—"}</td>
                  <td hidden={!visibleColumns.has("error")} style={{ ...S.td, fontSize: 11, color: PAL.red }}>{r.last_error_message ?? ""}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 24 }}>
                  No integration rows. Run a sync first — endpoints auto-populate.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={S.card}>
        <h3 style={S.cardTitle}>Data freshness</h3>
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                <SortableTh label="Entity" sortKey="entity" activeKey={fKey} dir={fDir} onSort={fClick} style={S.th} />
                <SortableTh label="Last updated" sortKey="last_updated" activeKey={fKey} dir={fDir} onSort={fClick} style={S.th} />
                <SortableTh label="Age (h)" sortKey="age" activeKey={fKey} dir={fDir} onSort={fClick} style={S.th} cellStyle={{ textAlign: "right" }} />
                <SortableTh label="Threshold (h)" sortKey="threshold" activeKey={fKey} dir={fDir} onSort={fClick} style={S.th} cellStyle={{ textAlign: "right" }} />
                <SortableTh label="Severity" sortKey="severity" activeKey={fKey} dir={fDir} onSort={fClick} style={S.th} />
                <SortableTh label="Note" sortKey="note" activeKey={fKey} dir={fDir} onSort={fClick} style={S.th} />
              </tr>
            </thead>
            <tbody>
              {sortedSignals.map((s) => (
                <tr key={s.entity_type}>
                  <td style={S.td}>{s.entity_type}</td>
                  <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>
                    {s.last_updated_at ? formatDateTime(s.last_updated_at) : "—"}
                  </td>
                  <td style={S.tdNum}>{s.age_hours ?? "—"}</td>
                  <td style={S.tdNum}>{s.threshold_hours}</td>
                  <td style={S.td}>
                    <span style={{
                      ...S.chip,
                      background: (SEVERITY_COLOR[s.severity] ?? PAL.textMuted) + "33",
                      color: SEVERITY_COLOR[s.severity] ?? PAL.textMuted,
                    }}>
                      {s.severity}
                    </span>
                  </td>
                  <td style={{ ...S.td, color: PAL.textMuted, fontSize: 11 }}>{s.note ?? ""}</td>
                </tr>
              ))}
              {signals.length === 0 && (
                <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 24 }}>
                  No freshness signals. Are the thresholds seeded?
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
