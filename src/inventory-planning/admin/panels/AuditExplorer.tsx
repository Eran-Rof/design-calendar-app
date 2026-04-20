// Unified audit explorer across ip_change_audit_log + ip_execution_audit_log.

import { useEffect, useState } from "react";
import { searchAudit, type IpAuditRow } from "../../governance/services/auditExplorerService";
import { S, PAL, formatDateTime } from "../../components/styles";

export default function AuditExplorer() {
  const [rows, setRows] = useState<IpAuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [actor, setActor] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

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

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr) auto", gap: 8 }}>
          <div>
            <label style={S.label}>Search</label>
            <input style={{ ...S.input, width: "100%" }} value={q} onChange={(e) => setQ(e.target.value)}
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
            <input type="date" style={{ ...S.input, width: "100%" }} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label style={S.label}>To</label>
            <input type="date" style={{ ...S.input, width: "100%" }} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div style={{ alignSelf: "end" }}>
            <button style={S.btnPrimary} onClick={run} disabled={loading}>{loading ? "Searching…" : "Search"}</button>
          </div>
        </div>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>When</th>
              <th style={S.th}>Source</th>
              <th style={S.th}>Actor</th>
              <th style={S.th}>Entity</th>
              <th style={S.th}>Event / Field</th>
              <th style={S.th}>Old → New</th>
              <th style={S.th}>Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.source}:${r.id}`}>
                <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{formatDateTime(r.created_at)}</td>
                <td style={S.td}>
                  <span style={{ ...S.chip, background: r.source === "planning" ? PAL.accent + "33" : PAL.accent2 + "33",
                                 color: r.source === "planning" ? PAL.accent : PAL.accent2 }}>
                    {r.source}
                  </span>
                </td>
                <td style={{ ...S.td, fontFamily: "monospace", fontSize: 11 }}>{r.actor ?? ""}</td>
                <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>
                  {r.entity_type}{r.entity_id ? ` · ${r.entity_id.slice(0, 8)}` : ""}
                </td>
                <td style={S.td}>{r.event_or_field}</td>
                <td style={{ ...S.td, fontFamily: "monospace", fontSize: 11, color: PAL.textDim }}>
                  {r.old_value == null && r.new_value == null ? "" : `${r.old_value ?? "∅"} → ${r.new_value ?? "∅"}`}
                </td>
                <td style={{ ...S.td, fontSize: 12, color: PAL.textDim }}>{r.message ?? ""}</td>
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
