// src/tanda/InternalAuditLog.tsx
//
// Cross-cutter T11-3 — Internal Audit Log admin panel.
//
// Operator-facing surface that pages over the T11 `row_changes` ledger.
// Powered by GET /api/internal/audit/log (handler h486).
//
// Features:
//   - DateRangePresets (T7) sweep over changed_at
//   - Entity-type (source_table) dropdown — the 16-entity T11 coverage list
//   - Actor filter via SearchableSelect (T9) — employee list from
//     /api/internal/employees
//   - Operation filter — checkbox set for INSERT/UPDATE/DELETE/VOID/POST/REVERSE
//   - ExportButton (T3 / T8 — xlsx-only) over the visible rows
//   - Side panel: click a row → expanded changed_columns + before/after preview
//
// Visual contract matches the other Internal* admin panels: dark palette,
// sticky table head, pure inline styles, no external CSS.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
import DateRangePresets from "./components/DateRangePresets.tsx";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";

const TABLE_KEY = "tanda.audit_log";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "time",      label: "Time" },
  { key: "actor",     label: "Actor" },
  { key: "entity",    label: "Entity" },
  { key: "operation", label: "Operation" },
  { key: "row_id",    label: "Row ID" },
  { key: "reason",    label: "Reason" },
  { key: "source",    label: "Source" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type Operation = "INSERT" | "UPDATE" | "DELETE" | "VOID" | "POST" | "REVERSE";

type Change = {
  id: string;
  entity_id: string | null;
  source_table: string;
  source_id: string;
  operation: Operation;
  changed_at: string;
  actor_auth_id: string | null;
  actor_employee_id: string | null;
  actor_display_name: string | null;
  source: string | null;
  reason: string | null;
  correlation_id: string | null;
  changed_columns: string[];
  before_jsonb: Record<string, unknown> | null;
  after_jsonb: Record<string, unknown> | null;
};

type Employee = {
  id: string;
  full_name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  status?: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants (allowlist mirrors api/_handlers/internal/audit/row-history.js)
// ─────────────────────────────────────────────────────────────────────────────
export const T11_SOURCE_TABLES: ReadonlyArray<string> = [
  "ar_invoices",
  "ar_invoice_lines",
  "invoices",
  "invoice_line_items",
  "journal_entries",
  "journal_entry_lines",
  "gl_accounts",
  "gl_periods",
  "customers",
  "vendors",
  "employees",
  "cases",
  "sales_reps",
  "commission_payouts",
  "bank_accounts",
  "virtual_cards",
];

export const AUDIT_OPERATIONS: ReadonlyArray<Operation> = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "VOID",
  "POST",
  "REVERSE",
];

// ─────────────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
  danger: "#EF4444",
  insert: "#10B981",
  update: "#3B82F6",
  delete: "#EF4444",
  void: "#EF4444",
  post: "#F59E0B",
  reverse: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary,
  color: "white",
  border: `1px solid ${C.primary}`,
  padding: "6px 14px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220",
  color: C.text,
  border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px",
  borderRadius: 4,
  fontSize: 13,
};

const th: React.CSSProperties = {
  background: "#0b1220",
  color: C.textMuted,
  fontSize: 11,
  fontWeight: 600,
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  position: "sticky",
  top: 0,
  zIndex: 2,
};

const td: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text,
  fontSize: 13,
};

function opColor(op: Operation): string {
  switch (op) {
    case "INSERT":  return C.insert;
    case "UPDATE":  return C.update;
    case "DELETE":  return C.delete;
    case "VOID":    return C.void;
    case "POST":    return C.post;
    case "REVERSE": return C.reverse;
    default:        return C.textMuted;
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoMinusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper: convert filter state → URLSearchParams. Exported for tests.
// ─────────────────────────────────────────────────────────────────────────────
export function buildAuditLogQuery(state: {
  from: string;
  to: string;
  source_table: string | null;
  actor: string | null;
  operations: Operation[];
  limit?: number;
  offset?: number;
}): URLSearchParams {
  const p = new URLSearchParams();
  if (state.from) p.set("from", state.from);
  if (state.to) p.set("to", state.to);
  if (state.source_table) p.set("source_table", state.source_table);
  if (state.actor) p.set("actor", state.actor);
  if (state.operations.length > 0) p.set("operation", state.operations.join(","));
  if (state.limit) p.set("limit", String(state.limit));
  if (state.offset) p.set("offset", String(state.offset));
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper: flatten a Change into a row suitable for the xlsx export.
// ─────────────────────────────────────────────────────────────────────────────
export function flattenChangeForExport(c: Change): Record<string, unknown> {
  return {
    changed_at: c.changed_at,
    actor: c.actor_display_name || c.actor_employee_id || c.actor_auth_id || "",
    entity_id: c.entity_id || "",
    source_table: c.source_table,
    source_id: c.source_id,
    operation: c.operation,
    reason: c.reason || "",
    source_tag: c.source || "",
    correlation_id: c.correlation_id || "",
    changed_columns: (c.changed_columns || []).join(", "),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export default function InternalAuditLog() {
  // Filters
  const [fromDate, setFromDate] = useState<string>(isoMinusDays(7));
  const [toDate, setToDate] = useState<string>(todayISO());
  const [sourceTable, setSourceTable] = useState<string>("");
  const [actor, setActor] = useState<string>("");
  const [operations, setOperations] = useState<Operation[]>([]);

  // Data
  const [rows, setRows] = useState<Change[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const PAGE = 100;

  // Side panel
  const [selected, setSelected] = useState<Change | null>(null);

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  // Load employees once for the actor filter dropdown.
  useEffect(() => {
    fetch("/api/internal/employees?limit=500")
      .then((r) => r.json())
      .then((arr: Employee[]) => {
        if (!Array.isArray(arr)) return;
        const active = arr
          .filter((e) => (e.status ?? "active") === "active")
          .sort((a, b) =>
            String(a.full_name || a.email || "").localeCompare(
              String(b.full_name || b.email || ""),
            ),
          );
        setEmployees(active);
      })
      .catch(() => {});
  }, []);

  async function load(useOffset = 0) {
    setLoading(true);
    setErr(null);
    try {
      const params = buildAuditLogQuery({
        from: fromDate,
        to: toDate,
        source_table: sourceTable || null,
        actor: actor || null,
        operations,
        limit: PAGE,
        offset: useOffset,
      });
      const r = await fetch(`/api/internal/audit/log?${params.toString()}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { changes: Change[] };
      setRows(j.changes || []);
      setOffset(useOffset);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  // Auto-load on mount for the default 7-day window.
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleOp(op: Operation) {
    setOperations((prev) =>
      prev.includes(op) ? prev.filter((x) => x !== op) : [...prev, op],
    );
  }

  const exportRows = useMemo(() => rows.map(flattenChangeForExport), [rows]);

  const employeeOptions = useMemo(
    () => [
      { value: "", label: "— Any actor —" },
      ...employees.map((e) => ({
        value: e.id,
        label:
          e.full_name ||
          [e.first_name, e.last_name].filter(Boolean).join(" ") ||
          e.email ||
          e.id,
        searchHaystack: `${e.full_name || ""} ${e.email || ""} ${e.id}`,
      })),
    ],
    [employees],
  );

  return (
    <div style={{ color: C.text }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 16,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 22 }}>Audit Log</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {rows.length} change{rows.length === 1 ? "" : "s"} · page {Math.floor(offset / PAGE) + 1}
        </div>
      </div>

      {/* Filters row 1 — date range + presets */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 8,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: C.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
            data-testid="audit-from-date"
          />
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: C.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            style={{ ...inputStyle, width: 160 }}
            data-testid="audit-to-date"
          />
        </label>
        <DateRangePresets variant="dropdown"
          from={fromDate}
          to={toDate}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />
      </div>

      {/* Filters row 2 — entity type + actor */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 8,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: C.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Entity type
          <div style={{ width: 220 }} data-testid="audit-source-table">
            <SearchableSelect
              value={sourceTable || null}
              onChange={(v) => setSourceTable(v)}
              options={[
                { value: "", label: "— Any —" },
                ...T11_SOURCE_TABLES.map((t) => ({ value: t, label: t })),
              ]}
              placeholder="— Any —"
              inputStyle={inputStyle}
            />
          </div>
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: C.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Actor
          <div style={{ width: 280 }} data-testid="audit-actor-select">
            <SearchableSelect
              value={actor || null}
              onChange={(v) => setActor(v)}
              options={employeeOptions}
              placeholder="— Any actor —"
            />
          </div>
        </label>
      </div>

      {/* Filters row 3 — operations + load + export */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-testid="audit-op-filter">
          {AUDIT_OPERATIONS.map((op) => {
            const on = operations.includes(op);
            return (
              <label
                key={op}
                style={{
                  display: "inline-flex",
                  gap: 4,
                  alignItems: "center",
                  padding: "4px 8px",
                  borderRadius: 4,
                  border: `1px solid ${on ? opColor(op) : C.cardBdr}`,
                  background: on ? `${opColor(op)}22` : "transparent",
                  fontSize: 11,
                  color: on ? opColor(op) : C.textMuted,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleOp(op)}
                  data-testid={`audit-op-${op}`}
                />
                {op}
              </label>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void load(0)}
          style={btnPrimary}
          disabled={loading}
          data-testid="audit-load"
        >
          {loading ? "Loading…" : "Apply filters"}
        </button>
        <ExportButton
          rows={exportRows}
          filename="audit-log"
          sheetName="Audit Log"
          columns={[
            { key: "changed_at",     header: "Time" },
            { key: "actor",          header: "Actor" },
            { key: "entity_id",      header: "Entity" },
            { key: "source_table",   header: "Table" },
            { key: "source_id",      header: "Row ID" },
            { key: "operation",      header: "Op" },
            { key: "reason",         header: "Reason" },
            { key: "source_tag",     header: "Source" },
            { key: "changed_columns",header: "Changed columns" },
            { key: "correlation_id", header: "Correlation ID" },
          ]}
        />
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={ALL_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          <button
            type="button"
            onClick={() => void load(Math.max(0, offset - PAGE))}
            disabled={offset === 0 || loading}
            style={{ ...btnPrimary, background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}` }}
            data-testid="audit-prev"
          >
            ← Prev
          </button>
          <button
            type="button"
            onClick={() => void load(offset + PAGE)}
            disabled={rows.length < PAGE || loading}
            style={{ ...btnPrimary, background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}` }}
            data-testid="audit-next"
          >
            Next →
          </button>
        </div>
      </div>

      {err && (
        <div
          data-testid="audit-error"
          style={{
            background: "#7f1d1d",
            color: "white",
            padding: "8px 12px",
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          Error: {err}
        </div>
      )}

      <div
        style={{
          background: C.card,
          border: `1px solid ${C.cardBdr}`,
          borderRadius: 10,
          maxHeight: "calc(100vh - 360px)",
          overflowY: "auto",
        }}
      >
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No audit rows match the current filters.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!visibleColumns.has("time")}>Time</th>
                <th style={th} hidden={!visibleColumns.has("actor")}>Actor</th>
                <th style={th} hidden={!visibleColumns.has("entity")}>Entity</th>
                <th style={th} hidden={!visibleColumns.has("operation")}>Operation</th>
                <th style={th} hidden={!visibleColumns.has("row_id")}>Row ID</th>
                <th style={th} hidden={!visibleColumns.has("reason")}>Reason</th>
                <th style={th} hidden={!visibleColumns.has("source")}>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  style={{ cursor: "pointer" }}
                  data-testid="audit-row"
                  data-row-id={r.id}
                >
                  <td style={td} hidden={!visibleColumns.has("time")}>
                    <span title={r.changed_at}>{new Date(r.changed_at).toLocaleString()}</span>
                  </td>
                  <td style={td} hidden={!visibleColumns.has("actor")}>{r.actor_display_name || "—"}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }} hidden={!visibleColumns.has("entity")}>
                    {r.source_table}
                  </td>
                  <td style={td} hidden={!visibleColumns.has("operation")}>
                    <span
                      style={{
                        background: opColor(r.operation),
                        color: "white",
                        padding: "2px 6px",
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.5,
                      }}
                    >
                      {r.operation}
                    </span>
                  </td>
                  <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!visibleColumns.has("row_id")}>
                    {"—"}
                  </td>
                  <td style={{ ...td, fontStyle: r.reason ? "italic" : "normal", color: r.reason ? C.textSub : C.textMuted }} hidden={!visibleColumns.has("reason")}>
                    {r.reason || "—"}
                  </td>
                  <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!visibleColumns.has("source")}>{r.source || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <AuditSidePanel change={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Side panel showing the changed_columns + before/after for one row
// ─────────────────────────────────────────────────────────────────────────────
function AuditSidePanel({ change, onClose }: { change: Change; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      data-testid="audit-side-panel-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="audit-side-panel"
        style={{
          background: C.card,
          border: `1px solid ${C.cardBdr}`,
          width: "min(560px, 95vw)",
          padding: 20,
          color: C.text,
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 16,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16 }}>
            <span style={{ background: opColor(change.operation), color: "white", padding: "2px 6px", borderRadius: 4, fontSize: 11, marginRight: 8 }}>
              {change.operation}
            </span>
            {change.source_table}
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              color: C.textSub,
              border: `1px solid ${C.cardBdr}`,
              padding: "4px 10px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
            data-testid="audit-side-panel-close"
          >
            Close
          </button>
        </div>

        <DetailRow label="Time" value={new Date(change.changed_at).toLocaleString()} />
        <DetailRow label="Actor" value={change.actor_display_name || "—"} />
        <DetailRow label="Row ID" value={"—"} />
        {change.entity_id && (
          <DetailRow label="Entity ID" value={"—"} />
        )}
        {change.reason && <DetailRow label="Reason" value={<span style={{ fontStyle: "italic" }}>&ldquo;{change.reason}&rdquo;</span>} />}
        {change.source && <DetailRow label="Source tag" value={change.source} />}
        {change.correlation_id && (
          <DetailRow label="Correlation" value={"—"} />
        )}

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Changed columns
          </div>
          {(change.changed_columns || []).length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 12 }}>—</div>
          ) : (
            <div data-testid="audit-changed-cols">
              {change.changed_columns.map((col) => (
                <span
                  key={col}
                  style={{
                    display: "inline-block",
                    margin: "2px 4px 2px 0",
                    padding: "2px 8px",
                    background: "#0b1220",
                    color: C.textSub,
                    border: `1px solid ${C.cardBdr}`,
                    borderRadius: 4,
                    fontSize: 11,
                    fontFamily: "SFMono-Regular, Menlo, monospace",
                  }}
                >
                  {col}
                </span>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Before
          </div>
          <pre
            data-testid="audit-before-pre"
            style={{
              background: "#0b1220",
              border: `1px solid ${C.cardBdr}`,
              borderRadius: 6,
              padding: 10,
              fontSize: 11,
              color: C.textSub,
              maxHeight: 220,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {change.before_jsonb ? JSON.stringify(change.before_jsonb, null, 2) : "—"}
          </pre>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            After
          </div>
          <pre
            data-testid="audit-after-pre"
            style={{
              background: "#0b1220",
              border: `1px solid ${C.cardBdr}`,
              borderRadius: 6,
              padding: 10,
              fontSize: 11,
              color: C.textSub,
              maxHeight: 220,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {change.after_jsonb ? JSON.stringify(change.after_jsonb, null, 2) : "—"}
          </pre>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12, marginBottom: 4 }}>
      <span style={{ color: C.textMuted, minWidth: 90 }}>{label}</span>
      <span style={{ color: C.text }}>{value}</span>
    </div>
  );
}
