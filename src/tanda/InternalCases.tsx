// src/tanda/InternalCases.tsx
//
// Tangerine P7-9 — Cases admin panel (Customer Service / M47).
// List + filters + detail modal with comment thread + create-new modal.
//
// Hits /api/internal/cases, /api/internal/cases/:id, /api/internal/cases/:id/comments.

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import { readDrillParam, consumeDrillParams } from "./scorecardDrill";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
// Cross-cutter T11-3 — audit-trail drop-in for the case detail modal.
import RowHistory from "./components/RowHistory";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useEmployeeOptions } from "./hooks/useEmployeeOptions";

// Universal column-visibility registry for this panel (operator ask #1).
const CASES_TABLE_KEY = "tangerine:cases:columns";
const CASE_COLUMNS: ColumnDef[] = [
  { key: "case_number",   label: "Case #" },
  { key: "subject",       label: "Subject" },
  { key: "customer",      label: "Customer" },
  { key: "status",        label: "Status" },
  { key: "severity",      label: "Severity" },
  { key: "assignee",      label: "Assignee" },
  { key: "created",       label: "Created" },
  { key: "last_activity", label: "Last activity" },
];

type Case = {
  id: string;
  entity_id: string;
  case_number: string;
  customer_id: string | null;
  ar_invoice_id: string | null;
  rma_id: string | null;
  sales_order_id: string | null;
  status: "open" | "in_progress" | "resolved" | "closed";
  severity: "low" | "normal" | "high" | "urgent";
  subject: string;
  body: string | null;
  assignee_user_id: string | null;
  external_email: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  customer?: { id: string; code: string | null; name: string } | null;
  last_activity_at?: string;
};

type Comment = {
  id: string;
  case_id: string;
  author_user_id: string | null;
  body: string;
  is_internal: boolean;
  external_email: string | null;
  created_at: string;
};

type CaseDetail = Case & { comments: Comment[] };

type CustomerLite = { id: string; code: string | null; name: string };

const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
  primaryDim: "#1d4ed8",
  success: "#10B981",
  warn: "#F59E0B",
  danger: "#EF4444",
};

const STATUS_VALUES = ["open", "in_progress", "resolved", "closed"] as const;
const SEVERITY_VALUES = ["low", "normal", "high", "urgent"] as const;

const STATUS_COLOR: Record<Case["status"], { bg: string; color: string }> = {
  open:         { bg: "#1e3a8a", color: "#93c5fd" },
  in_progress:  { bg: "#78350f", color: "#fcd34d" },
  resolved:     { bg: "#064e3b", color: "#6ee7b7" },
  closed:       { bg: "#374151", color: "#d1d5db" },
};

const SEVERITY_COLOR: Record<Case["severity"], { bg: string; color: string }> = {
  low:    { bg: "#374151", color: "#d1d5db" },
  normal: { bg: "#1f2937", color: "#cbd5e1" },
  high:   { bg: "#7c2d12", color: "#fdba74" },
  urgent: { bg: "#7f1d1d", color: "#fca5a5" },
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13, verticalAlign: "top",
};

function pill(label: string, palette: { bg: string; color: string }): React.CSSProperties {
  return {
    display: "inline-block", padding: "2px 8px", borderRadius: 10,
    background: palette.bg, color: palette.color, fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "2-digit", day: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function truncate(s: string | null, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Universal export uses the shared canonical ExportButton (T3 cross-cutter,
// xlsx-only after T8). Flattens the joined customer fields so they appear
// as their own columns in the export.

export default function InternalCases() {
  const [rows, setRows] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Employee picker options + id→name map (no raw user UUIDs anywhere).
  const { employees, options: employeeOptions } = useEmployeeOptions();
  const assigneeName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of employees) {
      const name = [e.first_name, e.last_name].filter(Boolean).join(" ").trim();
      m[e.id] = (e.code && name) ? `${e.code} — ${name}` : (name || e.code || e.email || e.id);
    }
    return m;
  }, [employees]);

  // Today drills seed these on mount (one-shot):
  //   cases.mine_open       → ?assignee=me&status=open  (my open cases)
  //   cases.unassigned_open → ?assignee=none&status=open (no owner yet)
  // "me" resolves to the signed-in user; "none" can't be a server filter
  // (assignee_user_id must be a uuid), so it's applied client-side + bannered.
  const [statusFilter, setStatusFilter] = useState<string>(() => readDrillParam("status"));
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>(() => {
    if (readDrillParam("assignee") === "me") {
      const me = getCachedAuthUserId();
      return /^[0-9a-f-]{36}$/i.test(me) ? me : "";
    }
    return "";
  });
  const [unassignedOnly, setUnassignedOnly] = useState<boolean>(() => readDrillParam("assignee") === "none");
  const [q, setQ] = useState<string>("");
  useEffect(() => { consumeDrillParams(["assignee", "status"]); }, []);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [customers, setCustomers] = useState<CustomerLite[]>([]);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    CASES_TABLE_KEY,
    CASE_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter)   params.set("status", statusFilter);
      if (severityFilter) params.set("severity", severityFilter);
      if (assigneeFilter) params.set("assignee_user_id", assigneeFilter);
      if (q.trim())       params.set("q", q.trim());
      params.set("limit", "500");
      const r = await fetch(`/api/internal/cases?${params.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadCustomers() {
    try {
      const r = await fetch("/api/internal/customer-master?limit=5000");
      if (!r.ok) return;
      const data = await r.json();
      const list = Array.isArray(data)
        ? data
        : (data?.rows && Array.isArray(data.rows) ? data.rows : []);
      setCustomers(
        list.map((c: { id: string; code?: string | null; customer_code?: string | null; name: string }) => ({
          id: c.id,
          code: c.code ?? c.customer_code ?? null,
          name: c.name,
        })),
      );
    } catch { /* non-fatal */ }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { loadCustomers(); }, []);

  // Debounced reload when filters change.
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, severityFilter, assigneeFilter, q]);

  // "Unassigned" is not a server filter (assignee_user_id must be a uuid), so
  // the ?assignee=none drill is applied here over the server-returned set.
  const displayRows = useMemo(
    () => (unassignedOnly ? rows.filter((r) => !r.assignee_user_id) : rows),
    [rows, unassignedOnly],
  );

  const filterBarStyle: React.CSSProperties = {
    display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
    marginBottom: 14,
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.text }}>
          Cases
        </h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Customer service tickets (M47)
        </span>
        <div style={{ flex: 1 }} />
        <ExportButton
          rows={displayRows.map((r) => ({
            case_number: r.case_number,
            status: r.status,
            severity: r.severity,
            subject: r.subject,
            customer_code: r.customer?.code ?? null,
            customer_name: r.customer?.name ?? null,
            assignee_user_id: r.assignee_user_id,
            external_email: r.external_email,
            created_at: r.created_at,
            updated_at: r.updated_at,
            last_activity_at: r.last_activity_at,
          })) as unknown as Array<Record<string, unknown>>}
          filename="cases"
          sheetName="Cases"
          columns={[
            { key: "case_number",      header: "Case #" },
            { key: "status",           header: "Status" },
            { key: "severity",         header: "Severity" },
            { key: "subject",          header: "Subject" },
            { key: "customer_code",    header: "Customer Code" },
            { key: "customer_name",    header: "Customer" },
            { key: "assignee_user_id", header: "Assignee" },
            { key: "external_email",   header: "External Email" },
            { key: "created_at",       header: "Created",  format: "datetime" },
            { key: "updated_at",       header: "Updated",  format: "datetime" },
            { key: "last_activity_at", header: "Last Activity", format: "datetime" },
          ]}
        />
        <button type="button" style={btnPrimary} onClick={() => setAddOpen(true)}>
          + New case
        </button>
      </div>

      <div style={filterBarStyle}>
        <div style={{ minWidth: 140 }}>
          <Select label="Status" value={statusFilter} onChange={setStatusFilter} options={[...STATUS_VALUES]} />
        </div>
        <div style={{ minWidth: 140 }}>
          <Select label="Severity" value={severityFilter} onChange={setSeverityFilter} options={[...SEVERITY_VALUES]} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label style={labelStyle}>Assignee</label>
          <SearchableSelect
            value={assigneeFilter || null}
            onChange={(v) => setAssigneeFilter(v || "")}
            options={[{ value: "", label: "All" }, ...employeeOptions]}
            placeholder="All"
            emptyText="No matching employees"
          />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label style={labelStyle}>Search subject</label>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. shipment"
            style={inputStyle}
          />
        </div>
        <div style={{ alignSelf: "flex-end" }}>
          <TablePrefsButton
            tableKey={CASES_TABLE_KEY}
            columns={CASE_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
          />
        </div>
      </div>

      {unassignedOnly && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, marginBottom: 12,
          background: "rgba(59,130,246,0.12)", border: `1px solid ${C.primary}`,
          borderRadius: 8, padding: "8px 12px", fontSize: 13, color: C.text,
        }}>
          <span style={{ fontWeight: 600 }}>Showing {displayRows.length.toLocaleString()} unassigned case{displayRows.length === 1 ? "" : "s"}</span>
          <span style={{ color: C.textMuted }}>— triage and assign an owner.</span>
          <button
            onClick={() => setUnassignedOnly(false)}
            style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${C.cardBdr}`, color: C.textSub, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}
          >
            ✕ Clear filter
          </button>
        </div>
      )}

      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>
          {err}
        </div>
      )}

      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`,
        borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)",
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th} hidden={!isVisible("case_number")}>Case #</th>
              <th style={th} hidden={!isVisible("subject")}>Subject</th>
              <th style={th} hidden={!isVisible("customer")}>Customer</th>
              <th style={th} hidden={!isVisible("status")}>Status</th>
              <th style={th} hidden={!isVisible("severity")}>Severity</th>
              <th style={th} hidden={!isVisible("assignee")}>Assignee</th>
              <th style={th} hidden={!isVisible("created")}>Created</th>
              <th style={th} hidden={!isVisible("last_activity")}>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={8}>Loading…</td></tr>
            )}
            {!loading && displayRows.length === 0 && (
              <tr><td style={td} colSpan={8}>No cases match.</td></tr>
            )}
            {!loading && displayRows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setDetailId(r.id)}
                style={{ cursor: "pointer" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "#0b1220"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
              >
                <td style={{ ...td, fontFamily: "monospace", fontSize: 12, color: C.textSub }} hidden={!isVisible("case_number")}>{r.case_number}</td>
                <td style={td} hidden={!isVisible("subject")}>{truncate(r.subject, 80)}</td>
                <td style={td} hidden={!isVisible("customer")}>{r.customer ? `${r.customer.code ?? ""} ${r.customer.name}`.trim() : (r.external_email || "—")}</td>
                <td style={td} hidden={!isVisible("status")}><span style={pill(r.status, STATUS_COLOR[r.status])}>{r.status.replace("_", " ")}</span></td>
                <td style={td} hidden={!isVisible("severity")}><span style={pill(r.severity, SEVERITY_COLOR[r.severity])}>{r.severity}</span></td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!isVisible("assignee")}>
                  {r.assignee_user_id ? (assigneeName[r.assignee_user_id] || truncate(r.assignee_user_id, 12)) : "—"}
                </td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!isVisible("created")}>{fmtDate(r.created_at)}</td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!isVisible("last_activity")}>{fmtDate(r.last_activity_at || r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detailId && (
        <CaseDetailModal
          id={detailId}
          onClose={() => { setDetailId(null); load(); }}
          customers={customers}
        />
      )}
      {addOpen && (
        <CreateCaseModal
          customers={customers}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); load(); }}
        />
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, color: C.textMuted, marginBottom: 4,
  textTransform: "uppercase", letterSpacing: 0.5,
};

function Select({ label, value, onChange, options, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <SearchableSelect
        value={value || null}
        onChange={(v) => onChange(v)}
        options={[{ value: "", label: placeholder || "All" }, ...options.map((o) => ({ value: o, label: o.replace("_", " ") }))]}
        placeholder={placeholder || "All"}
        inputStyle={inputStyle}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail modal — view + edit case + comment thread
// ─────────────────────────────────────────────────────────────────────────────
function CaseDetailModal({ id, onClose, customers }: {
  id: string;
  onClose: () => void;
  customers: CustomerLite[];
}) {
  const [data, setData] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { options: employeeOptions } = useEmployeeOptions();
  const [newComment, setNewComment] = useState("");
  const [commentInternal, setCommentInternal] = useState(true);

  // Local pending edits — applied on save.
  const [status, setStatus] = useState<Case["status"] | "">("");
  const [severity, setSeverity] = useState<Case["severity"] | "">("");
  const [assignee, setAssignee] = useState<string>("");
  const [subject, setSubject] = useState<string>("");
  const [bodyText, setBodyText] = useState<string>("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/cases/${id}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const d: CaseDetail = await r.json();
      setData(d);
      setStatus(d.status);
      setSeverity(d.severity);
      setAssignee(d.assignee_user_id || "");
      setSubject(d.subject);
      setBodyText(d.body || "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const customerById = useMemo(() => {
    const m = new Map<string, CustomerLite>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  async function save() {
    if (!data) return;
    setSaving(true);
    setErr(null);
    try {
      const patch: Record<string, string | null> = {};
      if (status && status !== data.status) patch.status = status;
      if (severity && severity !== data.severity) patch.severity = severity;
      if ((assignee || null) !== (data.assignee_user_id || null)) patch.assignee_user_id = assignee || null;
      if (subject !== data.subject) patch.subject = subject;
      if ((bodyText || null) !== (data.body || null)) patch.body = bodyText || null;

      if (Object.keys(patch).length === 0) { setSaving(false); return; }

      const r = await fetch(`/api/internal/cases/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function addComment() {
    if (!newComment.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const author = getCachedAuthUserId();
      const r = await fetch(`/api/internal/cases/${id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: newComment,
          is_internal: commentInternal,
          author_user_id: author || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      setNewComment("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title={data ? data.case_number : "Loading…"}>
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
            <Field label="Status">
              <SearchableSelect
                value={status}
                onChange={(v) => setStatus(v as Case["status"])}
                options={STATUS_VALUES.map((s) => ({ value: s, label: s.replace("_", " ") }))}
                inputStyle={inputStyle}
              />
            </Field>
            <Field label="Severity">
              <SearchableSelect
                value={severity}
                onChange={(v) => setSeverity(v as Case["severity"])}
                options={SEVERITY_VALUES.map((s) => ({ value: s, label: s }))}
                inputStyle={inputStyle}
              />
            </Field>
            <Field label="Assignee">
              <SearchableSelect
                value={assignee || null}
                onChange={(v) => setAssignee(v || "")}
                options={[{ value: "", label: "Unassigned" }, ...employeeOptions]}
                placeholder="Unassigned"
                emptyText="No matching employees"
              />
            </Field>
            <Field label="Customer">
              <div style={{ ...inputStyle, padding: "6px 10px", color: C.textSub, fontSize: 12 }}>
                {data.customer
                  ? `${data.customer.code ?? ""} ${data.customer.name}`.trim()
                  : (customerById.get(data.customer_id || "")?.name || data.external_email || "—")}
              </div>
            </Field>
          </div>
          <Field label="Subject">
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Body">
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={5}
              style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
            />
          </Field>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={save} disabled={saving} style={btnPrimary}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={onClose} style={btnSecondary}>Close</button>
            <div style={{ flex: 1 }} />
            <span style={{ color: C.textMuted, fontSize: 11, alignSelf: "center" }}>
              Created {fmtDate(data.created_at)} · Updated {fmtDate(data.updated_at)}
              {data.resolved_at && <> · Resolved {fmtDate(data.resolved_at)}</>}
            </span>
          </div>

          <hr style={{ border: 0, borderTop: `1px solid ${C.cardBdr}`, margin: "20px 0 14px" }} />

          <h3 style={{ margin: "0 0 8px", fontSize: 13, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
            Comments ({data.comments.length})
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {data.comments.length === 0 && (
              <div style={{ color: C.textMuted, fontSize: 12 }}>No comments yet.</div>
            )}
            {data.comments.map((c) => (
              <div key={c.id} style={{
                background: c.is_internal ? "#0b1220" : "#1a2332",
                border: `1px solid ${C.cardBdr}`,
                borderRadius: 6, padding: "8px 10px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: C.textMuted }}>
                    {c.external_email ? `From ${c.external_email}` : (c.author_user_id ? truncate(c.author_user_id, 12) : "system")}
                    {" · "}
                    {fmtDate(c.created_at)}
                  </span>
                  <span style={pill(c.is_internal ? "internal" : "customer", c.is_internal ? STATUS_COLOR.closed : STATUS_COLOR.open)}>
                    {c.is_internal ? "internal" : "customer-visible"}
                  </span>
                </div>
                <div style={{ color: C.text, fontSize: 13, whiteSpace: "pre-wrap" }}>{c.body}</div>
              </div>
            ))}
          </div>

          <Field label="Add comment">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              rows={3}
              placeholder="Comment…"
              style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
            />
          </Field>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
            <label style={{ color: C.textSub, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={commentInternal} onChange={(e) => setCommentInternal(e.target.checked)} />
              Internal only
            </label>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={addComment} disabled={saving || !newComment.trim()} style={btnPrimary}>
              {saving ? "Posting…" : "Post comment"}
            </button>
          </div>

          {/* Cross-cutter T11-3 — audit trail timeline */}
          <RowHistory source_table="cases" source_id={id} />
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create modal
// ─────────────────────────────────────────────────────────────────────────────
function CreateCaseModal({ customers, onClose, onCreated }: {
  customers: CustomerLite[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { options: employeeOptions } = useEmployeeOptions();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [severity, setSeverity] = useState<Case["severity"]>("normal");
  const [assignee, setAssignee] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!subject.trim()) {
      setErr("Subject is required.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const author = getCachedAuthUserId();
      const r = await fetch("/api/internal/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject,
          body: body || null,
          customer_id: customerId || null,
          severity,
          assignee_user_id: assignee || null,
          created_by_user_id: author || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title="New case">
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      <Field label="Subject *">
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} style={inputStyle} />
      </Field>
      <Field label="Body">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
        />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
        <Field label="Customer">
          <SearchableSelect
            value={customerId || null}
            onChange={(v) => setCustomerId(v)}
            options={[
              { value: "", label: "(select)" },
              ...customers.map((c) => ({
                value: c.id,
                label: (c.code ? `${c.code} — ` : "") + c.name,
              })),
            ]}
            placeholder="(select)"
          />
        </Field>
        <Field label="Severity">
          <SearchableSelect
            value={severity}
            onChange={(v) => setSeverity(v as Case["severity"])}
            options={SEVERITY_VALUES.map((s) => ({ value: s, label: s }))}
            inputStyle={inputStyle}
          />
        </Field>
        <Field label="Assignee">
          <SearchableSelect
            value={assignee || null}
            onChange={(v) => setAssignee(v || "")}
            options={[{ value: "", label: "Unassigned" }, ...employeeOptions]}
            placeholder="Unassigned"
            emptyText="No matching employees"
          />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={create} disabled={saving} style={btnPrimary}>
          {saving ? "Creating…" : "Create case"}
        </button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic modal shell
// ─────────────────────────────────────────────────────────────────────────────
function Modal({ title, children, onClose }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`,
          borderRadius: 10, width: "min(760px, 95vw)", maxHeight: "90vh",
          overflowY: "auto", boxSizing: "border-box", padding: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>{title}</h2>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={{ ...btnSecondary, padding: "4px 8px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}
