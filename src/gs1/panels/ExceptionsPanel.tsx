import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import type { DataQualityIssue, DQSeverity, ExceptionGroup } from "../types";

// ── Severity colours ──────────────────────────────────────────────────────────

const SEV_STYLE: Record<DQSeverity, { bg: string; border: string; badge: string; text: string; dot: string }> = {
  error:   { bg: "#FFF5F5", border: "#FEB2B2", badge: "#FFF5F5", text: "#C53030", dot: "#E53E3E" },
  warning: { bg: "#FFFBEB", border: "#FCD34D", badge: "#FFFBEB", text: "#92400E", dot: "#D97706" },
  info:    { bg: "#EBF8FF", border: "#90CDF4", badge: "#EBF8FF", text: "#2B6CB0", dot: "#3182CE" },
};

function SeverityBadge({ sev }: { sev: DQSeverity }) {
  const s = SEV_STYLE[sev];
  return (
    <span style={{ background: s.badge, color: s.text, border: `1px solid ${s.border}`, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
      {sev}
    </span>
  );
}

// ── Exception group card ──────────────────────────────────────────────────────

function ExceptionCard({ group, issues, onNavigate, onResolveAll }: {
  group: ExceptionGroup;
  issues: DataQualityIssue[];
  onNavigate: (tab: string) => void;
  onResolveAll: (ids: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [resolving, setResolving] = useState<string | null>(null);
  const s = SEV_STYLE[group.severity];
  const openIssues = issues.filter(i => i.status === "open" && i.issue_type === group.key);

  const handleResolveAll = async () => {
    const ids = openIssues.map(i => i.id);
    setResolving("all");
    await onResolveAll(ids);
    setResolving(null);
    setExpanded(false);
  };

  return (
    <div style={{ border: `1px solid ${s.border}`, borderRadius: 10, background: s.bg, marginBottom: 12 }}>
      {/* Card header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", cursor: "pointer" }}
           onClick={() => setExpanded(e => !e)}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: s.dot, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: s.text }}>{group.label}</span>
            <SeverityBadge sev={group.severity} />
            <span style={{ background: s.text, color: "#fff", fontSize: 12, fontWeight: 700, padding: "1px 8px", borderRadius: 12 }}>
              {group.count}
            </span>
          </div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 2 }}>{group.description}</div>
          {group.newest_at && (
            <div style={{ fontSize: 11, color: TH.textSub2, marginTop: 2 }}>
              Latest: {new Date(group.newest_at).toLocaleDateString()}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {group.tab && (
            <button
              onClick={e => { e.stopPropagation(); onNavigate(group.tab!); }}
              style={{ background: "transparent", border: `1px solid ${s.text}`, color: s.text, borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>
              View records
            </button>
          )}
          <span style={{ fontSize: 18, color: s.text }}>{expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      {/* Expanded issue list */}
      {expanded && openIssues.length > 0 && (
        <div style={{ borderTop: `1px solid ${s.border}`, padding: "0 18px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0 8px" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: TH.textMuted }}>
              {openIssues.length} open issue{openIssues.length !== 1 ? "s" : ""}
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                placeholder="Resolution note (optional)"
                value={resolveNote}
                onChange={e => setResolveNote(e.target.value)}
                onClick={e => e.stopPropagation()}
                style={{ fontSize: 12, padding: "3px 8px", border: `1px solid ${TH.border}`, borderRadius: 5, width: 200 }}
              />
              <button
                onClick={e => { e.stopPropagation(); handleResolveAll(); }}
                disabled={resolving === "all"}
                style={{ background: s.text, color: "#fff", border: "none", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                {resolving === "all" ? "Resolving…" : "Resolve All"}
              </button>
            </div>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {openIssues.map(issue => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: DataQualityIssue }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 0", borderBottom: `1px solid rgba(0,0,0,0.06)` }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: TH.text }}>{issue.message}</div>
        {issue.entity_id && (
          <div style={{ fontSize: 11, color: TH.textMuted, fontFamily: "monospace", marginTop: 2 }}>
            {issue.entity_type}: {issue.entity_id}
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, color: TH.textSub2, flexShrink: 0 }}>
        {new Date(issue.created_at).toLocaleDateString()}
      </div>
    </div>
  );
}

// ── Resolved issues drawer ────────────────────────────────────────────────────

function ResolvedIssueRow({ issue }: { issue: DataQualityIssue }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: `1px solid ${TH.border}`, fontSize: 12 }}>
      <div style={{ flex: 1, color: TH.textMuted }}>{issue.message}</div>
      <div style={{ color: "#276749", fontWeight: 600, whiteSpace: "nowrap" }}>resolved</div>
      {issue.resolution_note && (
        <div style={{ color: TH.textSub2, fontStyle: "italic", maxWidth: 200 }}>{issue.resolution_note}</div>
      )}
      <div style={{ color: TH.textSub2, whiteSpace: "nowrap" }}>
        {issue.resolved_at ? new Date(issue.resolved_at).toLocaleDateString() : ""}
      </div>
    </div>
  );
}

// ── Audit log table ───────────────────────────────────────────────────────────

function AuditLogTable() {
  const { auditLogs, auditLoading, loadAuditLogs } = useGS1Store(s => ({
    auditLogs: s.auditLogs,
    auditLoading: s.auditLoading,
    loadAuditLogs: s.loadAuditLogs,
  }));

  useEffect(() => { loadAuditLogs(); }, []);

  const TH_S: React.CSSProperties = { padding: "6px 10px", fontSize: 11, fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase" };
  const TD_S: React.CSSProperties = { padding: "6px 10px", fontSize: 12, color: TH.text, borderBottom: `1px solid ${TH.border}` };

  return (
    <div>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: TH.text, margin: "0 0 12px" }}>Audit Trail</h3>
      {auditLoading && <div style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</div>}
      {!auditLoading && auditLogs.length === 0 && (
        <div style={{ color: TH.textMuted, fontSize: 13, padding: "16px 0" }}>No audit events recorded yet. Actions like GTIN creation, label prints, and receiving will appear here.</div>
      )}
      {auditLogs.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={TH_S}>Time</th>
                <th style={TH_S}>Entity</th>
                <th style={TH_S}>Action</th>
                <th style={TH_S}>ID</th>
                <th style={TH_S}>Details</th>
                <th style={TH_S}>Source</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.map(log => (
                <tr key={log.id}>
                  <td style={TD_S}>{new Date(log.created_at).toLocaleString()}</td>
                  <td style={TD_S}><span style={{ background: TH.surfaceHi, padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>{log.entity_type}</span></td>
                  <td style={TD_S}>{log.action}</td>
                  <td style={{ ...TD_S, fontFamily: "monospace", fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.entity_id ?? "—"}</td>
                  <td style={TD_S}>
                    {log.new_values && <span style={{ color: TH.textMuted, fontFamily: "monospace", fontSize: 11 }}>{JSON.stringify(log.new_values).slice(0, 80)}</span>}
                  </td>
                  <td style={{ ...TD_S, color: TH.textMuted }}>{log.source ?? "gs1_app"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function ExceptionsPanel() {
  const {
    dataQualityIssues, exceptionGroups, dqLoading, dqError, dqLastRunAt,
    runDataQualityChecks, loadDataQualityIssues, resolveDataQualityIssue,
    packGtins, upcItems, scales, batchLines, allCartons, receivingSessions,
    loadAllCartons, loadPackGtins, loadUpcItems, loadScales,
    setActiveTab,
  } = useGS1Store(s => ({
    dataQualityIssues:     s.dataQualityIssues,
    exceptionGroups:       s.exceptionGroups,
    dqLoading:             s.dqLoading,
    dqError:               s.dqError,
    dqLastRunAt:           s.dqLastRunAt,
    runDataQualityChecks:  s.runDataQualityChecks,
    loadDataQualityIssues: s.loadDataQualityIssues,
    resolveDataQualityIssue: s.resolveDataQualityIssue,
    packGtins:             s.packGtins,
    upcItems:              s.upcItems,
    scales:                s.scales,
    batchLines:            s.batchLines,
    allCartons:            s.allCartons,
    receivingSessions:     s.receivingSessions,
    loadAllCartons:        s.loadAllCartons,
    loadPackGtins:         s.loadPackGtins,
    loadUpcItems:          s.loadUpcItems,
    loadScales:            s.loadScales,
    setActiveTab:          s.setActiveTab,
  }));

  const [activeView, setActiveView] = useState<"open" | "resolved" | "audit">("open");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    loadDataQualityIssues();
  }, []);

  const handleRun = async () => {
    setRunning(true);
    // Ensure data is loaded before running checks
    await Promise.all([
      packGtins.length === 0    ? loadPackGtins()  : Promise.resolve(),
      upcItems.length === 0     ? loadUpcItems()    : Promise.resolve(),
      scales.length === 0       ? loadScales()      : Promise.resolve(),
      allCartons.length === 0   ? loadAllCartons()  : Promise.resolve(),
    ]);
    await runDataQualityChecks();
    setRunning(false);
  };

  const handleResolveAll = async (ids: string[]) => {
    for (const id of ids) await resolveDataQualityIssue(id);
  };

  const openIssues     = dataQualityIssues.filter(i => i.status === "open");
  const resolvedIssues = dataQualityIssues.filter(i => i.status === "resolved");

  const errorCount   = exceptionGroups.filter(g => g.severity === "error").reduce((s, g) => s + g.count, 0);
  const warningCount = exceptionGroups.filter(g => g.severity === "warning").reduce((s, g) => s + g.count, 0);

  return (
    <div style={{ padding: 28, maxWidth: 920, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 700, color: TH.text }}>
            Exceptions &amp; Audit Trail
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: TH.textMuted }}>
            Data quality checks, exception review, and a full audit log of GS1 actions.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <button
            onClick={handleRun}
            disabled={running || dqLoading}
            style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {running || dqLoading ? "Running checks…" : "Run Data Quality Checks"}
          </button>
          {dqLastRunAt && (
            <span style={{ fontSize: 11, color: TH.textMuted }}>
              Last run: {new Date(dqLastRunAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {dqError && (
        <div style={{ background: "#FFF5F5", border: "1px solid #FEB2B2", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#C53030", fontSize: 13 }}>
          {dqError}
        </div>
      )}

      {/* Summary badges */}
      {openIssues.length > 0 && (
        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          {errorCount > 0 && (
            <div style={{ background: "#FFF5F5", border: "1px solid #FEB2B2", borderRadius: 8, padding: "8px 16px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: "#C53030" }}>{errorCount}</span>
              <span style={{ fontSize: 12, color: "#C53030" }}>Errors</span>
            </div>
          )}
          {warningCount > 0 && (
            <div style={{ background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 8, padding: "8px 16px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: "#92400E" }}>{warningCount}</span>
              <span style={{ fontSize: 12, color: "#92400E" }}>Warnings</span>
            </div>
          )}
          {openIssues.length === 0 && (
            <div style={{ background: "#F0FFF4", border: "1px solid #9AE6B4", borderRadius: 8, padding: "8px 16px", color: "#276749", fontSize: 13, fontWeight: 600 }}>
              All clear — no open issues
            </div>
          )}
        </div>
      )}

      {/* View tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: `2px solid ${TH.border}`, marginBottom: 20 }}>
        {([
          { id: "open",     label: `Open Issues (${openIssues.length})` },
          { id: "resolved", label: `Resolved (${resolvedIssues.length})` },
          { id: "audit",    label: "Audit Log" },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveView(tab.id)}
            style={{
              background: "none", border: "none", padding: "8px 16px", fontSize: 13, cursor: "pointer",
              fontWeight: activeView === tab.id ? 700 : 400,
              color:      activeView === tab.id ? TH.primary : TH.textMuted,
              borderBottom: activeView === tab.id ? `2px solid ${TH.primary}` : "2px solid transparent",
              marginBottom: -2,
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Open issues */}
      {activeView === "open" && (
        <div>
          {openIssues.length === 0 && !dqLoading && (
            <div style={{ textAlign: "center", padding: "40px 0", color: TH.textMuted }}>
              {dataQualityIssues.length === 0
                ? "No checks have been run yet. Click \"Run Data Quality Checks\" to scan for issues."
                : "No open issues. Run checks again to refresh."
              }
            </div>
          )}
          {exceptionGroups.map(group => (
            <ExceptionCard
              key={group.key}
              group={group}
              issues={dataQualityIssues}
              onNavigate={tab => setActiveTab(tab as import("../store/gs1Store").GS1Tab)}
              onResolveAll={handleResolveAll}
            />
          ))}
        </div>
      )}

      {/* Resolved issues */}
      {activeView === "resolved" && (
        <div>
          {resolvedIssues.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 0", color: TH.textMuted }}>No resolved issues yet.</div>
          )}
          {resolvedIssues.map(i => <ResolvedIssueRow key={i.id} issue={i} />)}
        </div>
      )}

      {/* Audit log */}
      {activeView === "audit" && <AuditLogTable />}
    </div>
  );
}
