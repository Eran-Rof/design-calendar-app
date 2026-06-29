// Unified audit explorer across ip_change_audit_log + ip_execution_audit_log.

import { useEffect, useState } from "react";
import { searchAudit, type IpAuditRow } from "../../governance/services/auditExplorerService";
import { S, PAL, formatDateTime } from "../../components/styles";
import { AppDatePicker } from "../../../shared/components/AppDatePicker";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";

const TABLE_KEY = "ip.audit_explorer";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "when", label: "When" },
  { key: "source", label: "Source" },
  { key: "actor", label: "Actor" },
  { key: "entity", label: "Entity" },
  { key: "event_field", label: "Event / Field" },
  { key: "old_new", label: "Old → New" },
  { key: "message", label: "Message" },
];

export default function AuditExplorer() {
  const [rows, setRows] = useState<IpAuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [actor, setActor] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function run() {
    setLoading(true);
    try {
      const r = await searchAudit({
        search: q || undefined,
        actor: actor || undefined,
        entity_type: entity || undefined,
        from: from || undefined,
        to: to || undefined,
        limit: 500,
      });
      setRows(r);
    } finally { setLoading(false); }
  }
  useEffect(() => { void run(); }, []);

  // Additive per-column sort over the fetched audit rows. Sortable columns map
  // to direct scalar fields (or a trivially-correct accessor); Old → New is a
  // computed composite and stays inert.
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "ip:audit_explorer:sort",
    accessors: {
      when: (r) => r.created_at ?? "",
      actor: (r) => r.actor ?? "",
      entity: (r) => r.entity_type ?? "",
      event_field: (r) => r.event_or_field ?? "",
      message: (r) => r.message ?? "",
    },
  });

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr) auto", gap: 8 }}>
          <div>
            <label style={S.label}>Search</label>
            <input style={{ ...S.input, width: "100%" }} value={q} onChange={(e) => setQ(e.target.value)}
                   onFocus={(e) => e.currentTarget.select()}
                   placeholder="message / field / value…" />
          </div>
          <div>
            <label style={S.label}>Actor</label>
            <input style={{ ...S.input, width: "100%" }} value={actor} onChange={(e) => setActor(e.target.value)}
                   placeholder="email" />
          </div>
          <div>
            <label style={S.label}>Entity type</label>
            <input style={{ ...S.input, width: "100%" }} value={entity} onChange={(e) => setEntity(e.target.value)}
                   placeholder="scenario / approval / override…" />
          </div>
          <div>
            <label style={S.label}>From</label>
            <AppDatePicker style={{ ...S.input, width: "100%" }} value={from} onCommit={setFrom} />
          </div>
          <div>
            <label style={S.label}>To</label>
            <AppDatePicker style={{ ...S.input, width: "100%" }} value={to} onCommit={setTo} />
          </div>
          <div style={{ alignSelf: "end" }}>
            <button style={S.btnPrimary} onClick={run} disabled={loading}>{loading ? "Searching…" : "Search"}</button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <TablePrefsButton tableKey={TABLE_KEY} columns={ALL_COLUMNS} visibleColumns={visibleColumns}
                          onToggle={toggleColumn} onReset={resetToDefault} onSetAll={setAllVisible} />
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <SortableTh label="When" sortKey="when" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("when")} />
              <SortableTh label="Source" sortKey="source" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("source")} />
              <SortableTh label="Actor" sortKey="actor" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("actor")} />
              <SortableTh label="Entity" sortKey="entity" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("entity")} />
              <SortableTh label="Event / Field" sortKey="event_field" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("event_field")} />
              <th hidden={!visibleColumns.has("old_new")} style={S.th}>Old → New</th>
              <SortableTh label="Message" sortKey="message" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("message")} />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => (
              <tr key={`${r.source}:${r.id}`}>
                <td hidden={!visibleColumns.has("when")} style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{formatDateTime(r.created_at)}</td>
                <td hidden={!visibleColumns.has("source")} style={S.td}>
                  <span style={{ ...S.chip, background: r.source === "planning" ? PAL.accent + "33" : PAL.accent2 + "33",
                                 color: r.source === "planning" ? PAL.accent : PAL.accent2 }}>
                    {r.source}
                  </span>
                </td>
                <td hidden={!visibleColumns.has("actor")} style={{ ...S.td, fontFamily: "monospace", fontSize: 11 }}>{r.actor ?? ""}</td>
                <td hidden={!visibleColumns.has("entity")} style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>
                  {r.entity_type}
                </td>
                <td hidden={!visibleColumns.has("event_field")} style={S.td}>{r.event_or_field}</td>
                <td hidden={!visibleColumns.has("old_new")} style={{ ...S.td, fontFamily: "monospace", fontSize: 11, color: PAL.textDim }}>
                  {r.old_value == null && r.new_value == null ? "" : `${r.old_value ?? "∅"} → ${r.new_value ?? "∅"}`}
                </td>
                <td hidden={!visibleColumns.has("message")} style={{ ...S.td, fontSize: 12, color: PAL.textDim }}>{r.message ?? ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 24 }}>
                {loading ? "Searching…" : "No audit entries match."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
