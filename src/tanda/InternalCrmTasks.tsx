// src/tanda/InternalCrmTasks.tsx
//
// Tangerine P8-3 — CRM Tasks admin panel (M25, arch §3 + §4).
// Task list with filters: assignee, status, due-before. Add modal + inline
// status toggle (open → in_progress → done). Mark-done shortcut.
//
// Hits /api/internal/crm/tasks, /api/internal/crm/tasks/:id.

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
import { confirmDialog } from "../shared/ui/warn";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useEmployeeOptions } from "./hooks/useEmployeeOptions";
import { fmtDateDisplay } from "../utils/tandaTypes";

// Universal column-visibility registry for this panel (operator ask #1).
const CRM_TASKS_TABLE_KEY = "tangerine:crmtasks:columns";
const CRM_TASK_COLUMNS: ColumnDef[] = [
  { key: "title",       label: "Title" },
  { key: "status",      label: "Status" },
  { key: "priority",    label: "Priority" },
  { key: "due",         label: "Due" },
  { key: "assignee",    label: "Assignee" },
  { key: "customer",    label: "Customer" },
  { key: "opportunity", label: "Opp" },
];

type Status = "open" | "in_progress" | "done" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";

type Task = {
  id: string;
  entity_id: string;
  customer_id: string | null;
  opportunity_id: string | null;
  title: string;
  description: string | null;
  due_date: string | null;
  status: Status;
  priority: Priority;
  assignee_user_id: string | null;
  completed_at: string | null;
  completed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
};

type CustomerLite = { id: string; code: string | null; name: string };
type OpportunityLite = { id: string; opportunity_number: string; title: string };

const C = {
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
};

const STATUS_VALUES: Status[] = ["open", "in_progress", "done", "cancelled"];
const PRIORITY_VALUES: Priority[] = ["low", "normal", "high", "urgent"];

const STATUS_COLOR: Record<Status, { bg: string; color: string }> = {
  open:         { bg: "#1e3a8a", color: "#93c5fd" },
  in_progress:  { bg: "#78350f", color: "#fcd34d" },
  done:         { bg: "#064e3b", color: "#6ee7b7" },
  cancelled:    { bg: "#374151", color: "#d1d5db" },
};
const PRIORITY_COLOR: Record<Priority, { bg: string; color: string }> = {
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
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, color: C.textMuted, marginBottom: 4,
  textTransform: "uppercase", letterSpacing: 0.5,
};

function pill(palette: { bg: string; color: string }): React.CSSProperties {
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

const fmtDateOnly = fmtDateDisplay;

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Next-status pick for the inline button: open → in_progress → done.
function nextStatus(s: Status): Status | null {
  if (s === "open") return "in_progress";
  if (s === "in_progress") return "done";
  return null;
}

export default function InternalCrmTasks() {
  const [rows, setRows] = useState<Task[]>([]);
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

  const [statusFilter, setStatusFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [dueBefore, setDueBefore] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");
  const [oppFilter, setOppFilter] = useState<string>("");

  const [editId, setEditId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityLite[]>([]);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    CRM_TASKS_TABLE_KEY,
    CRM_TASK_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  // Only the direct scalar columns are sortable. assignee/customer/opportunity
  // render resolved lookups (not the row's raw id), so they stay non-sortable.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:crmtasks:sort",
    accessors: { due: (t) => t.due_date },
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter)   params.set("status", statusFilter);
      if (assigneeFilter) params.set("assignee_user_id", assigneeFilter);
      if (dueBefore)      params.set("due_before", dueBefore);
      if (customerFilter) params.set("customer_id", customerFilter);
      if (oppFilter)      params.set("opportunity_id", oppFilter);
      params.set("limit", "500");
      const r = await fetch(`/api/internal/crm/tasks?${params.toString()}`);
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
      const list = Array.isArray(data) ? data : (data?.rows ?? []);
      setCustomers(list.map((c: { id: string; code?: string | null; customer_code?: string | null; name: string }) => ({
        id: c.id, code: c.code ?? c.customer_code ?? null, name: c.name,
      })));
    } catch { /* non-fatal */ }
  }

  async function loadOpps() {
    try {
      const r = await fetch("/api/internal/crm/opportunities?limit=500");
      if (!r.ok) return;
      const data = await r.json();
      const list = Array.isArray(data) ? data : [];
      setOpportunities(list.map((o: { id: string; opportunity_number: string; title: string }) => ({
        id: o.id, opportunity_number: o.opportunity_number, title: o.title,
      })));
    } catch { /* non-fatal */ }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { loadCustomers(); loadOpps(); }, []);
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, assigneeFilter, dueBefore, customerFilter, oppFilter]);

  const customerById = useMemo(() => {
    const m = new Map<string, CustomerLite>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  const oppById = useMemo(() => {
    const m = new Map<string, OpportunityLite>();
    for (const o of opportunities) m.set(o.id, o);
    return m;
  }, [opportunities]);

  async function advanceStatus(t: Task) {
    const next = nextStatus(t.status);
    if (!next) return;
    await patchStatus(t.id, next);
  }
  async function markDone(t: Task) {
    if (t.status === "done") return;
    await patchStatus(t.id, "done");
  }
  async function patchStatus(id: string, status: Status) {
    setErr(null);
    try {
      const actor = getCachedAuthUserId();
      const r = await fetch(`/api/internal/crm/tasks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, actor_user_id: actor || undefined }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.text }}>
          Tasks
        </h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          CRM follow-ups (M25)
        </span>
        <div style={{ flex: 1 }} />
        <ExportButton
          rows={rows.map((r) => ({
            title: r.title,
            description: r.description,
            status: r.status,
            priority: r.priority,
            due_date: r.due_date,
            assignee_user_id: r.assignee_user_id,
            customer_name: r.customer_id ? (customerById.get(r.customer_id)?.name ?? null) : null,
            opportunity_number: r.opportunity_id ? (oppById.get(r.opportunity_id)?.opportunity_number ?? null) : null,
            completed_at: r.completed_at,
            created_at: r.created_at,
          })) as unknown as Array<Record<string, unknown>>}
          filename="crm-tasks"
          sheetName="Tasks"
          columns={[
            { key: "title",              header: "Title" },
            { key: "description",        header: "Description" },
            { key: "status",             header: "Status" },
            { key: "priority",           header: "Priority" },
            { key: "due_date",           header: "Due",     format: "date" },
            { key: "assignee_user_id",   header: "Assignee" },
            { key: "customer_name",      header: "Customer" },
            { key: "opportunity_number", header: "Opp #" },
            { key: "completed_at",       header: "Completed", format: "datetime" },
            { key: "created_at",         header: "Created",  format: "datetime" },
          ]}
        />
        <button type="button" style={btnPrimary} onClick={() => setAddOpen(true)}>
          + New task
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ minWidth: 140 }}>
          <label style={labelStyle}>Status</label>
          <SearchableSelect
            value={statusFilter || null}
            onChange={(v) => setStatusFilter(v)}
            options={[{ value: "", label: "All" }, ...STATUS_VALUES.map((s) => ({ value: s, label: s.replace("_", " ") }))]}
            inputStyle={inputStyle}
          />
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
        <div style={{ minWidth: 160 }}>
          <label style={labelStyle}>Due before</label>
          <input type="date" value={dueBefore} onChange={(e) => setDueBefore(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label style={labelStyle}>Customer</label>
          <SearchableSelect
            value={customerFilter || null}
            onChange={(v) => setCustomerFilter(v)}
            options={[
              { value: "", label: "All" },
              ...customers.map((c) => ({ value: c.id, label: (c.code ? `${c.code} — ` : "") + c.name })),
            ]}
            placeholder="All"
          />
        </div>
        <div style={{ minWidth: 240, flex: 1 }}>
          <label style={labelStyle}>Opportunity</label>
          <SearchableSelect
            value={oppFilter || null}
            onChange={(v) => setOppFilter(v)}
            options={[
              { value: "", label: "All" },
              ...opportunities.map((o) => ({ value: o.id, label: `${o.opportunity_number} — ${truncate(o.title, 40)}` })),
            ]}
            placeholder="All"
          />
        </div>
        <div style={{ paddingTop: 18 }}>
          <TablePrefsButton
            tableKey={CRM_TASKS_TABLE_KEY}
            columns={CRM_TASK_COLUMNS}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onReset={resetToDefault}
          />
        </div>
      </div>

      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortableTh label="Title" sortKey="title" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("title")} />
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("status")} />
              <SortableTh label="Priority" sortKey="priority" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("priority")} />
              <SortableTh label="Due" sortKey="due" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("due")} />
              <th style={th} hidden={!isVisible("assignee")}>Assignee</th>
              <th style={th} hidden={!isVisible("customer")}>Customer</th>
              <th style={th} hidden={!isVisible("opportunity")}>Opp</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={8}>Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={8}>No tasks match.</td></tr>
            )}
            {!loading && sorted.map((t) => {
              const next = nextStatus(t.status);
              return (
                <tr
                  key={t.id}
                  style={{ cursor: "pointer", opacity: t.status === "cancelled" ? 0.6 : 1 }}
                  onClick={() => setEditId(t.id)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "#0b1220"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
                >
                  <td style={td} hidden={!isVisible("title")}>
                    <div style={{ color: C.text, fontWeight: 500 }}>{t.title}</div>
                    {t.description && (
                      <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>{truncate(t.description, 80)}</div>
                    )}
                  </td>
                  <td style={td} hidden={!isVisible("status")}><span style={pill(STATUS_COLOR[t.status])}>{t.status.replace("_", " ")}</span></td>
                  <td style={td} hidden={!isVisible("priority")}><span style={pill(PRIORITY_COLOR[t.priority])}>{t.priority}</span></td>
                  <td style={{ ...td, fontSize: 12 }} hidden={!isVisible("due")}>{fmtDateOnly(t.due_date)}</td>
                  <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!isVisible("assignee")}>
                    {t.assignee_user_id ? (assigneeName[t.assignee_user_id] || truncate(t.assignee_user_id, 12)) : "—"}
                  </td>
                  <td style={td} hidden={!isVisible("customer")}>
                    {t.customer_id
                      ? (customerById.get(t.customer_id)
                          ? `${customerById.get(t.customer_id)!.code ?? ""} ${customerById.get(t.customer_id)!.name}`.trim()
                          : truncate(t.customer_id, 12))
                      : "—"}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }} hidden={!isVisible("opportunity")}>
                    {t.opportunity_id
                      ? (oppById.get(t.opportunity_id)?.opportunity_number ?? truncate(t.opportunity_id, 12))
                      : "—"}
                  </td>
                  <td style={td} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: "flex", gap: 6 }}>
                      {next && (
                        <button type="button" onClick={() => advanceStatus(t)} style={btnSecondary}>
                          → {next.replace("_", " ")}
                        </button>
                      )}
                      {t.status !== "done" && t.status !== "cancelled" && (
                        <button type="button" onClick={() => markDone(t)} style={btnSecondary}>
                          Mark done
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editId && (
        <EditTaskModal
          id={editId}
          customers={customers}
          opportunities={opportunities}
          onClose={() => { setEditId(null); load(); }}
        />
      )}
      {addOpen && (
        <CreateTaskModal
          customers={customers}
          opportunities={opportunities}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit modal
// ─────────────────────────────────────────────────────────────────────────────
function EditTaskModal({ id, customers, opportunities, onClose }: {
  id: string;
  customers: CustomerLite[];
  opportunities: OpportunityLite[];
  onClose: () => void;
}) {
  const [data, setData] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { options: employeeOptions } = useEmployeeOptions();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>("open");
  const [priority, setPriority] = useState<Priority>("normal");
  const [dueDate, setDueDate] = useState<string>("");
  const [assignee, setAssignee] = useState<string>("");
  const [customerId, setCustomerId] = useState<string>("");
  const [oppId, setOppId] = useState<string>("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/crm/tasks/${id}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const d: Task = await r.json();
      setData(d);
      setTitle(d.title);
      setDescription(d.description || "");
      setStatus(d.status);
      setPriority(d.priority);
      setDueDate(d.due_date || "");
      setAssignee(d.assignee_user_id || "");
      setCustomerId(d.customer_id || "");
      setOppId(d.opportunity_id || "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function save() {
    if (!data) return;
    setSaving(true);
    setErr(null);
    try {
      const actor = getCachedAuthUserId();
      const patch: Record<string, string | null> = {};
      if (title !== data.title) patch.title = title;
      if ((description || null) !== (data.description || null)) patch.description = description || null;
      if (status !== data.status) patch.status = status;
      if (priority !== data.priority) patch.priority = priority;
      if ((dueDate || null) !== (data.due_date || null)) patch.due_date = dueDate || null;
      if ((assignee || null) !== (data.assignee_user_id || null)) patch.assignee_user_id = assignee || null;
      if ((customerId || null) !== (data.customer_id || null)) patch.customer_id = customerId || null;
      if ((oppId || null) !== (data.opportunity_id || null)) patch.opportunity_id = oppId || null;

      if (Object.keys(patch).length === 0) { setSaving(false); return; }

      const body: Record<string, unknown> = { ...patch };
      if (actor) body.actor_user_id = actor;

      const r = await fetch(`/api/internal/crm/tasks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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

  async function del() {
    if (!data) return;
    if (!(await confirmDialog(`Delete task "${data.title}"?`))) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/crm/tasks/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title={data ? `Task — ${truncate(data.title, 60)}` : "Loading…"}>
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      {data && (
        <>
          <Field label="Title">
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Status">
              <SearchableSelect
                value={status}
                onChange={(v) => setStatus(v as Status)}
                options={STATUS_VALUES.map((s) => ({ value: s, label: s.replace("_", " ") }))}
                inputStyle={inputStyle}
              />
            </Field>
            <Field label="Priority">
              <SearchableSelect
                value={priority}
                onChange={(v) => setPriority(v as Priority)}
                options={PRIORITY_VALUES.map((p) => ({ value: p, label: p }))}
                inputStyle={inputStyle}
              />
            </Field>
            <Field label="Due">
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={inputStyle} />
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Customer">
              <SearchableSelect
                value={customerId || null}
                onChange={(v) => setCustomerId(v)}
                options={[
                  { value: "", label: "(select)" },
                  ...customers.map((c) => ({ value: c.id, label: (c.code ? `${c.code} — ` : "") + c.name })),
                ]}
                placeholder="(select)"
              />
            </Field>
            <Field label="Opportunity">
              <SearchableSelect
                value={oppId || null}
                onChange={(v) => setOppId(v)}
                options={[
                  { value: "", label: "(select)" },
                  ...opportunities.map((o) => ({ value: o.id, label: `${o.opportunity_number} — ${truncate(o.title, 40)}` })),
                ]}
                placeholder="(select)"
              />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
            <button type="button" onClick={save} disabled={saving} style={btnPrimary}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={onClose} style={btnSecondary}>Close</button>
            <button type="button" onClick={del} disabled={saving} style={{ ...btnSecondary, color: "#fca5a5", borderColor: "#7f1d1d" }}>
              Delete
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ color: C.textMuted, fontSize: 11 }}>
              Created {fmtDate(data.created_at)} · Updated {fmtDate(data.updated_at)}
              {data.completed_at && <> · Completed {fmtDate(data.completed_at)}</>}
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create modal
// ─────────────────────────────────────────────────────────────────────────────
function CreateTaskModal({ customers, opportunities, onClose, onCreated }: {
  customers: CustomerLite[];
  opportunities: OpportunityLite[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { options: employeeOptions } = useEmployeeOptions();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [dueDate, setDueDate] = useState("");
  const [assignee, setAssignee] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [oppId, setOppId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!title.trim()) { setErr("Title is required."); return; }
    setSaving(true);
    setErr(null);
    try {
      const author = getCachedAuthUserId();
      const r = await fetch("/api/internal/crm/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || null,
          priority,
          due_date: dueDate || null,
          assignee_user_id: assignee || null,
          customer_id: customerId || null,
          opportunity_id: oppId || null,
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
    <Modal onClose={onClose} title="New task">
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      <Field label="Title *">
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
      </Field>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
        />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Field label="Priority">
          <SearchableSelect
            value={priority}
            onChange={(v) => setPriority(v as Priority)}
            options={PRIORITY_VALUES.map((p) => ({ value: p, label: p }))}
            inputStyle={inputStyle}
          />
        </Field>
        <Field label="Due">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={inputStyle} />
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Customer">
          <SearchableSelect
            value={customerId || null}
            onChange={(v) => setCustomerId(v)}
            options={[
              { value: "", label: "(select)" },
              ...customers.map((c) => ({ value: c.id, label: (c.code ? `${c.code} — ` : "") + c.name })),
            ]}
            placeholder="(select)"
          />
        </Field>
        <Field label="Opportunity">
          <SearchableSelect
            value={oppId || null}
            onChange={(v) => setOppId(v)}
            options={[
              { value: "", label: "(select)" },
              ...opportunities.map((o) => ({ value: o.id, label: `${o.opportunity_number} — ${truncate(o.title, 40)}` })),
            ]}
            placeholder="(select)"
          />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={create} disabled={saving} style={btnPrimary}>
          {saving ? "Creating…" : "Create task"}
        </button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell
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
          borderRadius: 10, width: "min(820px, 95vw)", maxHeight: "90vh",
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
